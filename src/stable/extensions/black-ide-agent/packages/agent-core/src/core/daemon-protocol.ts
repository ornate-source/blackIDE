import { InboxItem } from './agent-inbox';

// ─── The local daemon's protocol (Phase 11, M65 · P11-3) ───────────────────
//
// A daemon drives headless runs while the editor is closed — an overnight refactor, a
// scheduled dependency bump, a queue somebody fills from a script. The phase's fourth
// gate clause is one sentence: **a daemon run's results appear in the inbox.**
//
// That sentence is the design constraint, and it rules out the obvious implementation.
// A daemon that logs to a file has "run" but not "reported": the user opens the editor
// the next morning and there is nothing to tell them the overnight run finished, failed,
// or has been waiting since 02:00 for something. F16 graded exactly that defect 🔴 for
// the in-editor lanes — "the state was always right, nobody was ever told about it" — and
// a daemon reintroduces it in a form where the user is *even less* likely to look.
//
// ── Files, not a socket ────────────────────────────────────────────────────
// The queue and the results are directories of JSON files. A socket would be faster and
// would be the wrong trade: a socket-based daemon that is not running loses the request,
// while a file in a queue directory is still there when it starts. It also means anything
// can enqueue — a cron line, a git hook, a shell script — without linking against us,
// which is most of the point of having a daemon at all.
//
// Everything here is pure. The daemon that reads these directories is
// `agent-core/daemon.ts`; this is the shape of what it reads and writes, and the
// projection into the inbox.

export const DAEMON_DIR = '.blackIDE/daemon';
export const QUEUE_DIR = `${DAEMON_DIR}/queue`;
export const RESULTS_DIR = `${DAEMON_DIR}/results`;
export const CLAIMED_DIR = `${DAEMON_DIR}/claimed`;

/** A run somebody wants done. Written into `queue/` by anything at all. */
export interface DaemonRequest {
    id: string;
    prompt: string;
    /** When it was enqueued. */
    at: number;
    /** Which mode to run in. Defaults to `agent`. */
    mode?: string;
    /** Model id override. */
    model?: string;
    /** Working directory. Defaults to the daemon's root. */
    cwd?: string;
    /** What the run may approve for itself. Same vocabulary as the CLI's `--approve`. */
    approve?: 'deny' | 'edits' | 'all';
}

export type DaemonStatus = 'completed' | 'failed' | 'refused';

/** What happened. Written into `results/` and read by the editor's inbox. */
export interface DaemonResult {
    id: string;
    prompt: string;
    status: DaemonStatus;
    startedAt: number;
    endedAt: number;
    summary: string;
    /** Files the run wrote, workspace-relative. */
    changed: string[];
    /** Branch the work landed on, when the run made one. */
    branch?: string;
    error?: string;
    /** True once the user has seen it. Read-and-acknowledged, so it stops nagging. */
    seen?: boolean;
}

/**
 * Validate a queued request.
 *
 * Anything may write into the queue directory — that is the feature — so nothing in it is
 * trusted. A request is rejected with a reason rather than partially honoured: a run with
 * a missing prompt and a defaulted mode is a run doing something nobody asked for.
 */
export function parseRequest(raw: unknown, fallbackId: string): { ok: true; request: DaemonRequest } | { ok: false; reason: string } {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not a JSON object' };
    const record = raw as Record<string, unknown>;

    const prompt = String(record.prompt ?? '').trim();
    if (!prompt) return { ok: false, reason: 'no "prompt"' };
    if (prompt.length > 20_000) return { ok: false, reason: 'the prompt is longer than 20 000 characters' };

    const approve = record.approve;
    if (approve !== undefined && approve !== 'deny' && approve !== 'edits' && approve !== 'all') {
        return { ok: false, reason: `"approve" must be deny, edits or all — got ${JSON.stringify(approve)}` };
    }

    return {
        ok: true,
        request: {
            id: String(record.id ?? fallbackId),
            prompt,
            at: Number.isFinite(Number(record.at)) ? Number(record.at) : Date.now(),
            mode: typeof record.mode === 'string' ? record.mode : undefined,
            model: typeof record.model === 'string' ? record.model : undefined,
            cwd: typeof record.cwd === 'string' ? record.cwd : undefined,
            /*
             * `deny` is the default, not `edits`.
             *
             * A daemon is the most unattended thing in the product: nobody is watching,
             * and the request may have been written by a cron line somebody forgot about.
             * G3's rule that unattended runs deny by default applies here more than
             * anywhere, so the permissive settings have to be stated per request.
             */
            approve: (approve as DaemonRequest['approve']) ?? 'deny',
        },
    };
}

/**
 * A filesystem-safe filename for a request or result.
 *
 * The same sanitiser `auditRelativePath` uses, and for the same stated reason: stripping
 * separators is what actually prevents traversal, but a remaining `..` is collapsed and a
 * leading dot removed anyway, because a filename that *looks* like a traversal attempt is
 * one a reviewer has to stop and reason about. The id here comes from a queue file that
 * anything at all may have written, so it gets more scrutiny than a run id, not less.
 */
export function resultFilename(id: string): string {
    const safe = String(id)
        .replace(/[^A-Za-z0-9._-]/g, '-')
        .replace(/\.{2,}/g, '.')
        .replace(/^[.-]+/, '')
        .slice(0, 80) || 'run';
    return `${safe}.json`;
}

export interface DaemonInboxOptions {
    now?: number;
    /** Results older than this are not surfaced. Defaults to seven days. */
    maxAgeMs?: number;
}

/** A week. Long enough to cover a holiday; short enough that the list stays a list. */
export const DEFAULT_RESULT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * Project daemon results into inbox items — the gate clause, made concrete.
 *
 * Two decisions worth stating:
 *
 * **A completed run is `review`, not nothing.** It ran while nobody was watching and
 * wrote files nobody has read. That is precisely `review`'s meaning in `agent-inbox.ts` —
 * "nothing is wrong, nothing is waiting on a timer, and the work quietly never lands" —
 * and it is the case a daemon makes most likely, because the alternative is that the user
 * discovers the change in `git status` three days later.
 *
 * **A seen result disappears.** Otherwise the first morning's four results are still at
 * the top of the inbox on Friday, and the inbox stops being a list of things to do.
 */
export function daemonInboxItems(results: DaemonResult[], options: DaemonInboxOptions = {}): InboxItem[] {
    const now = options.now ?? Date.now();
    const maxAge = options.maxAgeMs ?? DEFAULT_RESULT_MAX_AGE_MS;

    return (results || [])
        .filter(result => !result.seen && now - result.endedAt <= maxAge)
        .map(result => {
            const failed = result.status !== 'completed';
            return {
                id: `daemon:${result.id}`,
                // `task`, because that is the vocabulary the panel already renders and a
                // third kind would mean a third branch in every consumer for a row that
                // behaves identically.
                kind: 'task' as const,
                reason: failed ? ('failed' as const) : ('review' as const),
                title: truncate(result.prompt),
                detail: failed
                    ? `Ran in the background and ${result.status}: ${result.error || result.summary}`
                    : `Ran in the background${result.branch ? ` on ${result.branch}` : ''} and changed `
                        + `${result.changed.length} file(s). Nothing has looked at it yet.`,
                since: result.endedAt,
                // Matches `agent-inbox.ts`'s PRIORITY table: failed outranks review.
                priority: failed ? 2 : 3,
            };
        })
        .sort((a, b) => a.priority - b.priority || b.since - a.since);
}

function truncate(text: string, max = 80): string {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Merge daemon results into the inbox the editor already builds.
 *
 * A separate function rather than a parameter on `buildInbox`, because `buildInbox` is
 * about the two *in-editor* lanes and their live state. Daemon results are a different
 * kind of thing — durable, produced by another process, possibly while this one did not
 * exist — and folding them in would give `buildInbox` a filesystem dependency it has
 * carefully never had.
 */
export function mergeInbox(editorItems: InboxItem[], daemonItems: InboxItem[]): InboxItem[] {
    return [...editorItems, ...daemonItems].sort((a, b) =>
        a.priority - b.priority
        // Within blocked states the oldest is most urgent; within finished ones the
        // newest is. Same rule `buildInbox` applies, restated so the merged list does not
        // change its own ordering rule halfway down.
        || (a.priority <= 2 ? a.since - b.since : b.since - a.since));
}
