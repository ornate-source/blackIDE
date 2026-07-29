import { execFile } from 'child_process';

// ─── Git-history intelligence (Phase 3, M22) ────────────────────────────────
//
// `grep -rn "git log\|blame"` over `src/` returned nothing before this: the agent
// could read the working tree but had no access to *why* it looks the way it does.
//
// That is the highest-signal context routinely thrown away. "This pattern was
// reverted in abc123 because it deadlocked under load" is the single most useful
// sentence anyone can hand an agent about a piece of code, and it exists, in the
// repository, for free.
//
// ── Why this shells out rather than indexing ────────────────────────────────
// The roadmap proposes indexing commits into the E2 store. Git already maintains a
// far better index of its own history than we would build, and `git log -S` (the
// "pickaxe") answers "when did this string appear or disappear" directly. Indexing
// would duplicate that, go stale, and cost a bounded-depth window's worth of
// embedding calls. What this module adds is *shaping the answers for a model* —
// bounded, deduplicated, and honest about uncertainty — which is the part git does
// not do.
//
// ── Safety ──────────────────────────────────────────────────────────────────
// Every call uses `execFile` with an argument array, never a shell string, so a
// branch, path or query containing shell metacharacters cannot become a command.
// All of these are read-only git subcommands; none can mutate the repository.

export interface GitHistoryOptions {
    cwd: string;
    /** Upper bound on commits scanned. Keeps a huge repo from producing a huge answer. */
    maxCommits?: number;
    timeoutMs?: number;
}

const DEFAULT_MAX_COMMITS = 25;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Field and record separators for `git log --pretty=format:`.
 *
 * Unit Separator and Record Separator, written as escapes rather than as literal
 * bytes: they cannot occur in a commit subject or body, so parsing is unambiguous
 * where splitting on a newline or a pipe would break on the first commit message
 * that contained one. (Written as `\u001f`/`\u001e` on purpose — a raw control byte
 * in source makes the file binary to grep and diff; see
 * `__tests__/source-hygiene.test.ts`.)
 */
const FIELD = '\u001f';
const RECORD = '\u001e';

export interface Commit {
    hash: string;
    shortHash: string;
    author: string;
    date: string;
    subject: string;
    body?: string;
}

export class GitUnavailableError extends Error {}

function run(args: string[], options: GitHistoryOptions): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            'git', args,
            { cwd: options.cwd, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) {
                    const message = (stderr || err.message || '').trim().split('\n')[0];
                    return reject(new GitUnavailableError(message || 'git failed'));
                }
                resolve(stdout);
            },
        );
    });
}

function parseCommits(raw: string): Commit[] {
    return raw
        .split(RECORD)
        .map(r => r.trim())
        .filter(Boolean)
        .map(record => {
            const [hash, shortHash, author, date, subject, body] = record.split(FIELD);
            return { hash, shortHash, author, date, subject, ...(body?.trim() ? { body: body.trim() } : {}) };
        });
}

const LOG_FORMAT = `--pretty=format:%H${FIELD}%h${FIELD}%an${FIELD}%ad${FIELD}%s${FIELD}%b${RECORD}`;

/**
 * Commits whose message or diff mentions `query`.
 *
 * Runs two searches and merges them, because they answer different questions and
 * either alone is misleading. `--grep` finds commits that *talk about* the thing —
 * good for intent, useless when nobody wrote a message. `-S` (pickaxe) finds commits
 * where the number of occurrences of the string *changed* — good for "when did this
 * actually appear", and blind to intent. Results are labelled with which found them
 * so a model can weigh them.
 */
export async function searchHistory(query: string, options: GitHistoryOptions): Promise<string> {
    const max = options.maxCommits ?? DEFAULT_MAX_COMMITS;
    if (!query.trim()) return 'searchHistory needs a non-empty query.';

    let byMessage: Commit[] = [];
    let byContent: Commit[] = [];
    try {
        [byMessage, byContent] = await Promise.all([
            run(['log', `-${max}`, '--grep', query, '-i', LOG_FORMAT, '--date=short'], options).then(parseCommits),
            run(['log', `-${max}`, '-S', query, LOG_FORMAT, '--date=short'], options).then(parseCommits),
        ]);
    } catch (e) {
        return unavailable(e);
    }

    if (byMessage.length === 0 && byContent.length === 0) {
        return `No commits mention "${query}" in their message, and none added or removed it in a diff.`;
    }

    const lines: string[] = [];
    if (byContent.length) {
        lines.push(`Commits that added or removed "${query}" (${byContent.length}):`);
        for (const c of byContent) lines.push(`  ${c.shortHash} ${c.date} ${c.author}: ${c.subject}`);
    }
    const messageOnly = byMessage.filter(m => !byContent.some(c => c.hash === m.hash));
    if (messageOnly.length) {
        if (lines.length) lines.push('');
        lines.push(`Commits whose message mentions "${query}" (${messageOnly.length}):`);
        for (const c of messageOnly) lines.push(`  ${c.shortHash} ${c.date} ${c.author}: ${c.subject}`);
    }
    return lines.join('\n');
}

export interface BlameLine {
    shortHash: string;
    author: string;
    date: string;
    summary: string;
    line: number;
    content: string;
}

/**
 * Who last changed each line of a range.
 *
 * A range is required rather than optional: blaming a whole file returns one row per
 * line, which for anything real is thousands of rows of mostly identical commits —
 * a context-budget accident rather than an answer.
 */
export async function blame(
    file: string,
    startLine: number,
    endLine: number,
    options: GitHistoryOptions,
): Promise<string> {
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || endLine < startLine) {
        return 'blame needs a valid line range, e.g. start_line 10, end_line 40.';
    }
    const span = Math.min(endLine - startLine + 1, 200);

    let raw: string;
    try {
        raw = await run(['blame', '-L', `${startLine},+${span}`, '--porcelain', '--', file], options);
    } catch (e) {
        return unavailable(e);
    }

    const lines = parsePorcelainBlame(raw);
    if (lines.length === 0) return `No blame information for ${file}:${startLine}-${endLine}.`;

    // Collapse consecutive lines sharing a commit: a block written in one commit is
    // one fact, and repeating the hash for forty lines buries it.
    const out: string[] = [`Blame for ${file}:${startLine}-${startLine + span - 1}`];
    let run_: BlameLine[] = [];
    const flush = () => {
        if (!run_.length) return;
        const first = run_[0];
        const range = run_.length === 1 ? `${first.line}` : `${first.line}-${run_[run_.length - 1].line}`;
        out.push(`  ${first.shortHash} ${first.date} ${first.author} — lines ${range}: ${first.summary}`);
        run_ = [];
    };
    for (const line of lines) {
        if (run_.length && run_[run_.length - 1].shortHash !== line.shortHash) flush();
        run_.push(line);
    }
    flush();
    return out.join('\n');
}

function parsePorcelainBlame(raw: string): BlameLine[] {
    const out: BlameLine[] = [];
    const meta = new Map<string, { author: string; date: string; summary: string }>();
    let current: { hash: string; line: number } | undefined;
    let pending: Partial<{ author: string; date: string; summary: string }> = {};

    for (const line of raw.split('\n')) {
        const header = /^([0-9a-f]{40})\s+\d+\s+(\d+)/.exec(line);
        if (header) {
            current = { hash: header[1], line: Number(header[2]) };
            pending = {};
            continue;
        }
        if (!current) continue;

        if (line.startsWith('author ')) pending.author = line.slice(7).trim();
        else if (line.startsWith('author-time ')) pending.date = new Date(Number(line.slice(12)) * 1000).toISOString().slice(0, 10);
        else if (line.startsWith('summary ')) pending.summary = line.slice(8).trim();
        else if (line.startsWith('\t')) {
            // A tab-prefixed line is the source itself, and ends this entry. Git only
            // repeats the metadata the first time a commit appears, so it is cached.
            const known = meta.get(current.hash) ?? {
                author: pending.author ?? 'unknown',
                date: pending.date ?? '',
                summary: pending.summary ?? '',
            };
            meta.set(current.hash, known);
            out.push({
                // 7 characters, matching git's own `%h` default, so a hash from `blame` and a
                // hash from `search_history` are the same string for the same commit.
                shortHash: current.hash.slice(0, 7),
                author: known.author,
                date: known.date,
                summary: known.summary,
                line: current.line,
                content: line.slice(1),
            });
            current = undefined;
        }
    }
    return out;
}

/**
 * Why a symbol looks the way it does: the commits that introduced, reworked or
 * discussed it, newest first, with their full messages.
 *
 * Unions three git signals, because each alone misses the common case:
 *  - `-S` (pickaxe) finds commits where the *number of occurrences* changed — it
 *    catches introduction and deletion, and misses every rework in between. A
 *    commit that rewrites a function's body without touching its name is invisible
 *    to it, which is exactly the commit a "why" question is usually about.
 *  - `-G` finds commits that added or removed a *line mentioning* the name — it
 *    catches call-site churn that `-S` cannot see.
 *  - `--grep` finds commits that *talk about* it, which is where an explicit
 *    rationale ("reverted because it deadlocked") is normally written.
 *
 * Full bodies are included, unlike `searchHistory` which lists subjects only: the
 * body is the reason, and surfacing reasons is this tool's entire purpose.
 */
export async function whyWasThisChanged(symbol: string, options: GitHistoryOptions): Promise<string> {
    const max = Math.min(options.maxCommits ?? DEFAULT_MAX_COMMITS, 10);
    if (!symbol.trim()) return 'why_was_this_changed needs a symbol name.';

    let found: Commit[][];
    try {
        found = await Promise.all([
            run(['log', `-${max}`, '-S', symbol, LOG_FORMAT, '--date=short'], options).then(parseCommits),
            run(['log', `-${max}`, '-G', escapeRegex(symbol), LOG_FORMAT, '--date=short'], options).then(parseCommits),
            run(['log', `-${max}`, '--grep', symbol, '-i', LOG_FORMAT, '--date=short'], options).then(parseCommits),
        ]);
    } catch (e) {
        return unavailable(e);
    }

    // `git log` emits newest-first, so concatenating preserves that; dedup keeps the
    // first (newest) sighting of each commit.
    const byHash = new Map<string, Commit>();
    for (const list of found) {
        for (const c of list) if (!byHash.has(c.hash)) byHash.set(c.hash, c);
    }
    const commits = Array.from(byHash.values()).slice(0, max);

    if (commits.length === 0) {
        return `No commit in the scanned history introduced, changed or mentioned "${symbol}". `
            + `It may predate the history depth, or the name may have changed — try search_history with a phrase from the surrounding code.`;
    }

    const earliest = commits[commits.length - 1];
    const lines = [
        `"${symbol}" appears in ${commits.length} commit(s); the earliest in this window is ${earliest.shortHash} (${earliest.date}).`,
        '',
    ];
    for (const c of commits) {
        lines.push(`${c.shortHash}  ${c.date}  ${c.author}`);
        lines.push(`  ${c.subject}`);
        if (c.body) for (const bodyLine of c.body.split('\n')) lines.push(`  ${bodyLine}`);
        lines.push('');
    }
    lines.push(
        'These commits either changed the number of occurrences of the name, changed a line '
        + 'mentioning it, or discussed it. That is a good proxy for "introduced or reworked" '
        + 'but not a proof: a pure rename shows up here too.',
    );
    return lines.join('\n');
}

/** Escapes a symbol for use as a `-G` regex, so `$scope` or `a.b` match literally. */
function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unavailable(e: unknown): string {
    const message = e instanceof Error ? e.message : String(e);
    // Naming the reason matters: "not a git repository" and "git not installed" and
    // "shallow clone" all produce no history, and only one of them is worth retrying.
    return `Git history is unavailable here: ${message}`;
}
