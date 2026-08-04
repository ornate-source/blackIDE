import { JournalDepth, JournalLine, atOrBelow } from './run-journal';

// ─── Reading a run journal ──────────────────────────────────────────────────
//
// Pure over an injected line source, so the paging and filtering are testable with an
// array of strings and no disk.
//
// ── Why paged rather than "read the file" ────────────────────────────────────
// A verbose run is hundreds of kilobytes and an unlucky one is megabytes. Handing that to
// a webview costs a structured clone of the whole thing on every open, and then React
// renders ten thousand rows. The tab asks for a page, scrolls, and asks for the next —
// which also means the same reader serves the `read_run_log` tool, where returning
// everything would fill a context window with a log the model did not ask for.

export interface JournalQuery {
    depth?: JournalDepth;
    /** Case-insensitive substring over the verb, target and detail. */
    filter?: string;
    /** Opaque cursor from the previous page. */
    after?: number;
    limit?: number;
    /** Only these kinds, when given. */
    kinds?: string[];
    /** Only warnings and errors — the "what went wrong" view. */
    problemsOnly?: boolean;
}

export interface JournalPage {
    lines: JournalLine[];
    /** Pass back as `after`. Absent when this is the last page. */
    nextCursor?: number;
    /** How many lines matched, so the tab can say "showing 200 of 2,418". */
    matched: number;
    /** Total lines in the run, before filtering. */
    total: number;
}

export const DEFAULT_PAGE_SIZE = 200;

/**
 * A page of a run's journal.
 *
 * `after` is a **sequence number, not a line offset**, so a page cursor stays valid while
 * a live run appends. An offset would drift by exactly the number of lines written between
 * the two requests, which is the bug where scrolling a running log silently skips entries.
 */
export function readPage(lines: JournalLine[], query: JournalQuery = {}): JournalPage {
    const depth = query.depth ?? 'normal';
    const limit = Math.max(1, Math.min(1_000, query.limit ?? DEFAULT_PAGE_SIZE));
    const needle = query.filter?.trim().toLowerCase();

    const matching = lines.filter(line => {
        if (!atOrBelow(line.depth, depth)) return false;
        if (query.problemsOnly && line.level === 'info') return false;
        if (query.kinds?.length && !query.kinds.includes(line.kind)) return false;
        if (needle && !matchesText(line, needle)) return false;
        return true;
    });

    const after = query.after;
    const start = after === undefined ? 0 : matching.findIndex(l => l.seq > after);
    const page = start < 0 ? [] : matching.slice(start, start + limit);
    const last = page[page.length - 1];
    const consumed = (start < 0 ? matching.length : start) + page.length;

    return {
        lines: page,
        nextCursor: consumed < matching.length && last ? last.seq : undefined,
        matched: matching.length,
        total: lines.length,
    };
}

/**
 * The last `limit` matching lines.
 *
 * Separate from `readPage` because "show me the end" is what a user opening a finished
 * run wants and what a model asking "what did the last run do" wants, and expressing it as
 * paging means walking the whole file to find the end.
 */
export function readTail(lines: JournalLine[], query: JournalQuery = {}): JournalPage {
    const full = readPage(lines, { ...query, after: undefined, limit: 1_000_000 });
    const limit = Math.max(1, Math.min(1_000, query.limit ?? DEFAULT_PAGE_SIZE));
    return {
        lines: full.lines.slice(-limit),
        matched: full.matched,
        total: full.total,
    };
}

export interface JournalSummary {
    total: number;
    /** Per-depth counts, so the tab can say what switching depth would show. */
    byDepth: Record<JournalDepth, number>;
    errors: number;
    warnings: number;
    tools: number;
    turns: number;
    startedAt?: number;
    endedAt?: number;
}

/** A run's shape at a glance — what the Logs tab's footer reports. */
export function summarize(lines: JournalLine[]): JournalSummary {
    const byDepth: Record<JournalDepth, number> = { summary: 0, normal: 0, verbose: 0 };
    let errors = 0, warnings = 0, tools = 0, turns = 0;

    for (const line of lines) {
        byDepth[line.depth]++;
        if (line.level === 'error') errors++;
        else if (line.level === 'warn') warnings++;
        if (line.kind === 'tool') tools++;
        if (line.kind === 'turn') turns++;
    }

    return {
        total: lines.length,
        byDepth,
        errors,
        warnings,
        // One `tool` line per start and one per finish; the count a reader means is calls.
        tools: Math.ceil(tools / 2),
        turns,
        startedAt: lines[0]?.ts,
        endedAt: lines[lines.length - 1]?.ts,
    };
}

/**
 * Parse a journal file.
 *
 * A malformed line is **skipped, not thrown on**. The file is appended to by a live
 * process that the user may kill at any moment, so a truncated final line is the normal
 * ending of an interrupted run — and that is precisely the run whose log matters most.
 * Refusing to render it because its last line is half-written would lose the evidence at
 * the exact moment it was needed.
 */
export function parseJournal(text: string): JournalLine[] {
    const out: JournalLine[] = [];
    for (const raw of String(text || '').split('\n')) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed.seq === 'number' && typeof parsed.ts === 'number') out.push(parsed);
        } catch {
            // A half-written line. See above.
        }
    }
    return out;
}

function matchesText(line: JournalLine, needle: string): boolean {
    if (line.verb?.toLowerCase().includes(needle)) return true;
    if (line.target?.toLowerCase().includes(needle)) return true;
    if (line.kind.includes(needle)) return true;
    if (line.detail) {
        try {
            if (JSON.stringify(line.detail).toLowerCase().includes(needle)) return true;
        } catch { /* unserialisable detail cannot be searched, and must not throw */ }
    }
    return false;
}
