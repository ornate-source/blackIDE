import { ArtifactRecord, ArtifactType, groupForReview, isBinaryArtifact } from './artifacts';

// ─── The artifact review surface (Phase 7, M38's second half) ───────────────
//
// M38 shipped the typed store and the index; the panel that reads them was never built, so
// Phase 7 has carried a partial since it closed. Artifacts are written, typed, associated
// with a run and commented on by an API nothing calls.
//
// The consequence is not cosmetic. M39's steering path — a comment on an artifact region,
// injected into the running agent's next turn — has exactly one entry point today: a
// `window.prompt` behind a "Steer" button, which cannot carry an artifact or a region
// because a prompt box has no idea what the user is looking at. So the feature the phase
// describes ("comment on an artifact → the agent reads it") has only ever been reachable
// in its degraded, context-free form.
//
// This module is the decision layer for the panel: what to show, and where a comment goes.
// Pure, because both are worth testing and neither needs a filesystem.
//
// ── The decision that matters: a comment is never silently dropped ───────────
// An artifact belongs to a run, and a run may have finished. The tempting design refuses
// the comment box on a finished run — but the review surface's whole purpose is reading
// work after it lands, so most comments will be on finished runs, and a review tool that
// only accepts comments during the fifteen seconds an agent happens to be live is not one.
//
// So every comment is **stored on the artifact** (they outlive the run — see
// `ArtifactRecord.comments`), and separately, *if* the run is still live, it is also
// delivered as a steering note. The panel is told which happened, because a user who
// believes their correction reached the agent when it did not is the one failure this
// surface must never produce.

/** What the panel renders for one artifact. */
export interface ReviewItem {
    id: string;
    runId: string;
    type: ArtifactType;
    title: string;
    path: string;
    createdAt: number;
    size?: number;
    /** True for screenshots and recordings — the panel shows them rather than reading them. */
    binary: boolean;
    comments: { id: string; text: string; at: number; region?: string; delivered?: boolean }[];
}

/** One run's artifacts, which is the unit a review is actually done in. */
export interface ReviewGroup {
    runId: string;
    latestAt: number;
    /** True when an agent is still running under this id, so a comment can still steer it. */
    live: boolean;
    artifacts: ReviewItem[];
}

export interface ReviewViewOptions {
    /** Ids of runs that are still going, from the task-agent registry. */
    liveRunIds?: string[];
    /** Narrow to one type. `undefined` means all of them. */
    type?: ArtifactType;
    /** Narrow to one run. */
    runId?: string;
}

/**
 * The panel's view model: browse by run, filtered by type.
 *
 * Grouping is `groupForReview`'s — newest-first *within* a run, runs ordered by their most
 * recent artifact — rather than a second ordering that agrees with it today. Four
 * concurrent agents was the case that made a flat list unreadable, and it is normal since
 * Phase 6.
 */
export function buildReviewView(records: ArtifactRecord[], options: ReviewViewOptions = {}): ReviewGroup[] {
    const live = new Set(options.liveRunIds || []);
    const filtered = (records || []).filter(record =>
        (!options.type || record.type === options.type)
        && (!options.runId || record.runId === options.runId));

    return groupForReview(filtered).map(group => ({
        runId: group.runId,
        latestAt: group.latestAt,
        live: live.has(group.runId),
        artifacts: group.artifacts.map(toReviewItem),
    }));
}

function toReviewItem(record: ArtifactRecord): ReviewItem {
    return {
        id: record.id,
        runId: record.runId,
        type: record.type,
        title: record.title,
        path: record.path,
        createdAt: record.createdAt,
        size: record.size,
        binary: isBinaryArtifact(record.type),
        comments: (record.comments || []).map(c => ({
            id: c.id, text: c.text, at: c.at, region: c.region, delivered: c.delivered,
        })),
    };
}

/** The counts the tab shows, so a user knows there is something to look at. */
export function reviewCounts(records: ArtifactRecord[]): { total: number; runs: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {};
    const runs = new Set<string>();
    for (const record of records || []) {
        byType[record.type] = (byType[record.type] || 0) + 1;
        runs.add(record.runId);
    }
    return { total: (records || []).length, runs: runs.size, byType };
}

/**
 * How long a quoted region may be before it stops being a quote.
 *
 * A region goes into the agent's next turn verbatim. Someone selecting a whole 400-line
 * plan to say "this bit is wrong" would push the plan back into the context it came from,
 * displacing the very budget the correction needs to be acted on.
 */
export const MAX_REGION_CHARS = 600;

export interface CommentRouting {
    /** The comment always lands on the artifact; this is what *else* happened. */
    delivery: 'steered' | 'stored';
    /** The agent to steer, when `steered`. */
    runId?: string;
    /** The note's payload, when `steered`. */
    note?: { text: string; artifactPath: string; region?: string };
    /** What to tell the user. Always set — silence is what makes a review tool untrusted. */
    message: string;
}

/**
 * Decide what happens to a comment left on an artifact.
 *
 * The run id doubles as the agent id for the task lane (see `task-agent-registry.ts`),
 * which is what makes the routing a lookup rather than a mapping table that can drift.
 */
export function routeComment(input: {
    artifact: Pick<ArtifactRecord, 'runId' | 'path' | 'title'>;
    text: string;
    region?: string;
    liveRunIds?: string[];
}): CommentRouting {
    const text = String(input.text || '').trim();
    if (!text) {
        return { delivery: 'stored', message: 'An empty comment was not saved.' };
    }

    const region = clipRegion(input.region);

    if ((input.liveRunIds || []).includes(input.artifact.runId)) {
        return {
            delivery: 'steered',
            runId: input.artifact.runId,
            note: { text, artifactPath: input.artifact.path, region },
            message: 'Comment saved and sent — the agent reads it on its next turn.',
        };
    }

    return {
        delivery: 'stored',
        message: `Comment saved on "${input.artifact.title}". That run has finished, so nothing was steered.`,
    };
}

/**
 * Trim a selection to a quotable length, on a line boundary where there is one.
 *
 * Cutting mid-token produces a quote the model has to guess the end of; cutting at the
 * last newline inside the budget produces one it can read.
 */
export function clipRegion(region?: string): string | undefined {
    const text = String(region || '').trim();
    if (!text) return undefined;
    if (text.length <= MAX_REGION_CHARS) return text;

    const head = text.slice(0, MAX_REGION_CHARS);
    const lastBreak = head.lastIndexOf('\n');
    const cut = lastBreak > MAX_REGION_CHARS / 2 ? head.slice(0, lastBreak) : head;
    return `${cut.trimEnd()}\n… (selection truncated)`;
}
