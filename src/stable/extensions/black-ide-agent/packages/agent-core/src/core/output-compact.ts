// ─── Structured tool-output compression (Phase 3, M18) ──────────────────────
//
// Large tool results are structurally repetitive in a way plain prose is not:
// `grep_search` over a service repeats the same path on 40 consecutive lines,
// `get_diagnostics` repeats a filename per problem, `list_directory` repeats a
// prefix per entry. Every repetition is paid for in context.
//
// This encodes those results as a shared header plus per-row values, and keeps the
// original retrievable through `RawOutputStore` so nothing is actually lost — a
// compression that drops information is a regression, not a win, which is why the
// phase gate pairs "≥30% reduction" with "no eval-success regression".
//
// ── What this is not ────────────────────────────────────────────────────────
// Not a general-purpose encoder, and deliberately not a novel format. A model has
// to read the output *without a schema*, so the shape stays obvious on sight: a
// path on its own line, its rows indented beneath. Anything cleverer trades tokens
// the model needs for tokens it does not.

export interface CompactionStats {
    originalChars: number;
    compactChars: number;
    /** Positive means smaller. Rounded to one decimal. */
    savedPct: number;
}

export interface CompactedOutput extends CompactionStats {
    text: string;
    /** Set when the raw form was stored and can be fetched back. */
    rawId?: string;
}

/**
 * Separator for composite grouping keys.
 *
 * A NUL, written as an escape rather than as a literal byte: it cannot occur in a
 * diagnostic message, so `severity + SEP + message` splits unambiguously where a
 * space would truncate every message at its first word. (It was originally a raw
 * `\0` in the source, which worked but made the file binary to grep, diff and awk.)
 */
const FIELD_SEP = '\u0000';

/** Below this, grouping costs more in structure than it saves in repetition. */
const MIN_ROWS_TO_COMPACT = 4;
/** Never hand back a "compressed" result that is bigger than the input. */
function chooseSmaller(original: string, compact: string): string {
    return compact.length < original.length ? compact : original;
}

export function statsFor(original: string, compact: string): CompactionStats {
    return {
        originalChars: original.length,
        compactChars: compact.length,
        savedPct: original.length === 0
            ? 0
            : Math.round(((original.length - compact.length) / original.length) * 1000) / 10,
    };
}

// ─── Grep ───────────────────────────────────────────────────────────────────

export interface GrepRow { file: string; line: number; content: string }

/**
 * `src/a.ts:12: foo` × 40 → the path once, then `12: foo` per hit.
 *
 * Line content is *not* trimmed or elided: it is the entire evidence the model has
 * for whether a hit matters. Only the repeated path is removed.
 */
export function compactGrep(rows: GrepRow[]): CompactedOutput {
    const original = rows.map(r => `${r.file}:${r.line}: ${r.content}`).join('\n');
    if (rows.length < MIN_ROWS_TO_COMPACT) {
        return { text: original, ...statsFor(original, original) };
    }

    const byFile = groupInOrder(rows, r => r.file);
    const parts: string[] = [];
    for (const [file, hits] of byFile) {
        parts.push(`${file}  (${hits.length} match${hits.length === 1 ? '' : 'es'})`);
        for (const hit of hits) parts.push(`  ${hit.line}: ${hit.content}`);
    }

    const compact = chooseSmaller(original, parts.join('\n'));
    return { text: compact, ...statsFor(original, compact) };
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

export interface DiagnosticRow {
    file: string;
    line: number;
    severity: string;
    message: string;
    source?: string;
}

/**
 * Groups problems by file, and collapses runs of the *same message* into one row
 * with its line numbers.
 *
 * The second part matters more than the first in practice: one missing import
 * produces the identical "Cannot find name 'X'" on thirty lines, and thirty copies
 * of that sentence tell the model nothing the first one did not.
 */
export function compactDiagnostics(rows: DiagnosticRow[]): CompactedOutput {
    const original = rows
        .map(r => `${r.file}:${r.line}: ${r.severity}: ${r.message}${r.source ? ` (${r.source})` : ''}`)
        .join('\n');
    if (rows.length < MIN_ROWS_TO_COMPACT) {
        return { text: original, ...statsFor(original, original) };
    }

    const parts: string[] = [];
    for (const [file, problems] of groupInOrder(rows, r => r.file)) {
        parts.push(`${file}  (${problems.length})`);
        for (const [key, same] of groupInOrder(problems, p => `${p.severity}${FIELD_SEP}${p.message}`)) {
            const [severity, message] = key.split(FIELD_SEP);
            const lines = same.map(p => p.line).join(', ');
            parts.push(`  ${severity} @ ${lines}: ${message}`);
        }
    }

    const compact = chooseSmaller(original, parts.join('\n'));
    return { text: compact, ...statsFor(original, compact) };
}

// ─── Directory listings ─────────────────────────────────────────────────────

/**
 * Collapses a listing's shared directory prefix into a header.
 *
 * Entries keep their trailing `/` marker: knowing which entries are directories is
 * the main thing a listing is for, and it costs one character.
 */
export function compactListing(header: string, entries: string[]): CompactedOutput {
    const original = [header, ...entries].join('\n');
    if (entries.length < MIN_ROWS_TO_COMPACT) {
        return { text: original, ...statsFor(original, original) };
    }

    const prefix = commonPathPrefix(entries);
    if (!prefix) return { text: original, ...statsFor(original, original) };

    const stripped = entries.map(e => e.slice(prefix.length));
    const compact = chooseSmaller(original, [`${header} [all under ${prefix}]`, ...stripped].join('\n'));
    return { text: compact, ...statsFor(original, compact) };
}

// ─── Raw retrieval ──────────────────────────────────────────────────────────

/**
 * Holds the uncompressed form of recent tool outputs so the model can ask for it.
 *
 * Bounded and in-memory: this exists to make compression *reversible within a
 * conversation*, not to be a durable log — the audit trail (Phase 9, M53) is the
 * thing that must survive a reload, and conflating the two would put file contents
 * on disk that nobody asked to persist.
 */
export class RawOutputStore {
    private readonly entries = new Map<string, string>();
    private order: string[] = [];
    private counter = 0;

    constructor(private readonly maxEntries = 20) {}

    put(raw: string): string {
        const id = `out_${++this.counter}`;
        this.entries.set(id, raw);
        this.order.push(id);
        while (this.order.length > this.maxEntries) {
            const oldest = this.order.shift();
            if (oldest) this.entries.delete(oldest);
        }
        return id;
    }

    get(id: string): string | undefined {
        return this.entries.get(id);
    }

    get size(): number { return this.entries.size; }
}

/**
 * Appends the "ask for the full version" affordance — but only when compaction
 * actually did something. A pointer to an identical copy is pure noise, and the
 * model will sometimes spend a turn fetching it.
 */
export function withRawPointer(result: CompactedOutput, store: RawOutputStore, raw: string): CompactedOutput {
    if (result.savedPct <= 0) return result;

    const rawId = store.put(raw);
    return {
        ...result,
        rawId,
        text: `${result.text}\n\n[Grouped to save context (${result.savedPct}% smaller). Full untouched output: expand_output("${rawId}")]`,
    };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Groups preserving first-appearance order, so results stay in relevance order. */
function groupInOrder<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const row of rows) {
        const k = key(row);
        const list = out.get(k);
        if (list) list.push(row);
        else out.set(k, [row]);
    }
    return out;
}

/** Longest shared prefix ending at a path separator. Empty when there is none. */
export function commonPathPrefix(paths: string[]): string {
    if (paths.length < 2) return '';

    let prefix = paths[0];
    for (const p of paths.slice(1)) {
        let i = 0;
        while (i < prefix.length && i < p.length && prefix[i] === p[i]) i++;
        prefix = prefix.slice(0, i);
        if (!prefix) return '';
    }

    // Cut back to a separator — half a filename is not a prefix worth having.
    const cut = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
    return cut > 0 ? prefix.slice(0, cut + 1) : '';
}
