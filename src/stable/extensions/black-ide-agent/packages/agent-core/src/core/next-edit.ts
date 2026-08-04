import { EditRecord, renderEditHistory } from './edit-history';
import { changedFraction } from './fast-apply';

// ─── Next-edit prediction (Phase 5, M28) ────────────────────────────────────
//
// `inline-completion.ts` answers "what comes after the cursor". This answers a
// different question: "given what was just changed, what is the next thing that has to
// change" — which is frequently **in another file**, and is the reason a rename applied
// to three of five call sites feels like the editor is helping rather than watching.
//
// ── Why this reuses the SEARCH/REPLACE contract rather than JSON ─────────────
// A prediction has to name a file, the exact text it replaces, and the replacement.
// JSON is the obvious carrier and the wrong one: the payload is source code, so every
// newline, quote and backslash becomes an escaping decision the model has to get right,
// and a single bad escape turns a good prediction into a parse error. The marker format
// at `core/tools.ts:76` has no escaping, the models are already prompted with it
// elsewhere in this codebase, and — the part that matters — it makes the anchor
// *verifiable*: a prediction whose ORIGINAL text is not in the file is detectably wrong
// before anything is shown to the user.
//
// ── The rule the gate is written around ─────────────────────────────────────
// "Zero completions emitted after the buffer changed." A prediction is computed against
// a document snapshot and shown some hundreds of milliseconds later. If the developer
// typed in the meantime, the prediction describes a file that no longer exists, and
// applying it either fails the anchor check or — worse — succeeds against text that
// coincidentally still matches. So every prediction carries the document versions it was
// computed from, and `isStale` is checked immediately before it is shown *and* again
// before it is applied. Both checks are cheap; the failure they prevent is not.

/** A region offered to the model as a place the next edit might belong. */
export interface NextEditCandidate {
    /** Workspace-relative path, as the code graph and the prompt both use. */
    file: string;
    /** 0-based line the snippet starts at, so a hit maps back to a position. */
    startLine: number;
    text: string;
    /** Why this file is in front of the model — a graph edge, or the active file. */
    because: string;
}

export interface NextEditRequest {
    activeFile: string;
    cursorLine: number;
    history: EditRecord[];
    candidates: NextEditCandidate[];
}

/** What the model said, before anything has been checked. */
export interface NextEditProposal {
    file: string;
    old: string;
    replacement: string;
}

/** A proposal that survived every check and may be shown to a human. */
export interface NextEditPrediction extends NextEditProposal {
    /** Character offset of `old` in the file's current text. */
    offset: number;
    /** 0-based line of `offset`, for the jump affordance. */
    line: number;
    /** True when the edit is not in the file the developer is looking at. */
    crossFile: boolean;
    /** True when the edit spans more than one line, either side. */
    multiLine: boolean;
    /** The document versions this was computed against. See `isStale`. */
    stamps: DocumentStamp[];
}

export type RejectionKind =
    | 'no-edit'
    | 'unparseable'
    | 'unknown-file'
    | 'empty-anchor'
    | 'anchor-missing'
    | 'anchor-ambiguous'
    | 'no-change'
    | 'oversized'
    | 'stale';

export interface NextEditRejection {
    ok: false;
    kind: RejectionKind;
    reason: string;
}

export type NextEditResult = { ok: true; prediction: NextEditPrediction } | NextEditRejection;

/** A document and the version it was read at. */
export interface DocumentStamp {
    file: string;
    version: number;
}

/** The refusal token. Most cursor positions have no next edit, and saying so is correct. */
export const NO_EDIT = 'NO_EDIT';

const ORIGINAL_MARKER = '<<<<<<< ORIGINAL';
const DIVIDER = '=======';
const UPDATED_MARKER = '>>>>>>> UPDATED';

/**
 * Cap on how much of the target file one prediction may rewrite.
 *
 * Tighter than fast-apply's 0.5 for the same reason it exists at all: fast-apply is
 * carrying out an edit a human asked for, while this is *guessing*, and a guess that
 * rewrites a third of a file is not a next edit — it is a rewrite wearing one's clothes.
 */
const MAX_REWRITE_FRACTION = 0.25;

/**
 * …and the absolute allowance that keeps the fraction honest on small files.
 *
 * A fraction alone is unusable here, which the first test run demonstrated: renaming one
 * call in a three-line module changes 33% of it, so a pure 25% bound refuses every edit
 * to every small file — and small files are most of a real repo. The defect the bound
 * exists to catch (a model returning the whole file as one block) is inherently a
 * *large* edit, so both conditions must hold before a prediction is refused: a big
 * proportion **and** a big absolute change.
 */
const MAX_CHANGED_LINES = 12;

// ─── Prompt ─────────────────────────────────────────────────────────────────

/**
 * Build the prediction prompt.
 *
 * Three things are in front of the model and nothing else: what was just edited, where
 * the cursor is, and a short list of places the next edit could go. The candidate list
 * is a closed set on purpose — `validateProposal` refuses any file that is not in it, so
 * the prompt and the validator agree on the same universe and a hallucinated path cannot
 * become an edit to a real file.
 */
export function buildNextEditPrompt(request: NextEditRequest): string {
    const history = renderEditHistory(request.history);
    const parts: string[] = [
        'You predict the NEXT edit a developer is about to make, from the edits they just made.',
        '',
        'Rules, all mandatory:',
        '1. Output ONE edit, in exactly this format and nothing else:',
        'FILE: <path exactly as listed below>',
        ORIGINAL_MARKER,
        '(text copied byte-for-byte from that file)',
        DIVIDER,
        '(replacement text)',
        UPDATED_MARKER,
        '2. The ORIGINAL text must appear in that file EXACTLY once. Include just enough',
        '   surrounding lines to make it unique, and no more.',
        '3. Predict a change that the recent edits IMPLY and that has not been made yet —',
        '   the remaining call sites of a rename, the other branch of a new condition, the',
        '   test that now needs a case. Do not restate an edit that is already done.',
        `4. If nothing is clearly implied, output exactly: ${NO_EDIT}. That is the correct`,
        '   answer most of the time, and a wrong guess costs the developer more than silence.',
        '',
        '## Edits just made (oldest first)',
        history || '(none recorded yet)',
        '',
        `## Cursor: ${request.activeFile}:${request.cursorLine + 1}`,
        '',
        '## Files you may edit',
    ];

    for (const candidate of request.candidates) {
        parts.push('', `FILE: ${candidate.file}  (${candidate.because})`, '```', candidate.text, '```');
    }
    return parts.join('\n');
}

// ─── Candidate selection ────────────────────────────────────────────────────

/** One hop of the code graph, in the shape `CodeGraph.neighbours` returns. */
export interface GraphHop {
    file: string;
    via: string;
    direction: 'out' | 'in';
}

export interface CandidateOptions {
    /** Lines of the active file to show either side of the cursor. */
    activeWindow?: number;
    /** Lines to show around the anchor in a neighbour file. */
    neighbourWindow?: number;
    maxCandidates?: number;
    /** Total characters across all candidates — the latency budget in disguise. */
    maxChars?: number;
}

const CANDIDATE_DEFAULTS: Required<CandidateOptions> = {
    activeWindow: 40,
    neighbourWindow: 24,
    maxCandidates: 5,
    maxChars: 6_000,
};

/**
 * Choose the files the next edit could plausibly land in.
 *
 * Ranked by how directly each one is implicated, which is the whole reason this feature
 * needs Phase 3's graph:
 *
 *   1. **The active file**, windowed around the cursor. Always present — most next edits
 *      are two lines below the last one.
 *   2. **Files edited in the last few minutes.** A multi-file change already in progress
 *      is the single strongest signal available, and it needs no graph at all.
 *   3. **Incoming graph edges before outgoing ones.** When a symbol changes, the files
 *      that must follow are the ones that *use* it, not the ones it uses. Ranking
 *      importers first is the difference between suggesting the remaining call sites of a
 *      rename and suggesting the library it was renamed in.
 *
 * Neighbour snippets are windowed around the symbol that justifies the edge rather than
 * taken from the head of the file, so the model sees the call site instead of the import
 * block — the head of a file is the least informative part of it for this question.
 */
export function selectCandidates(
    input: {
        activeFile: string;
        cursorLine: number;
        recentFiles: string[];
        neighbours: (file: string) => GraphHop[];
        read: (file: string) => string | undefined;
    },
    options: CandidateOptions = {},
): NextEditCandidate[] {
    const opts = { ...CANDIDATE_DEFAULTS, ...options };
    const active = normalizePath(input.activeFile);
    const out: NextEditCandidate[] = [];
    const taken = new Set<string>();
    let used = 0;

    const add = (file: string, because: string, anchorLine: number | undefined, window: number): boolean => {
        const key = normalizePath(file);
        if (taken.has(key) || out.length >= opts.maxCandidates) return false;
        const content = input.read(file);
        if (content === undefined) return false;
        const snippet = windowAround(content, anchorLine, window);
        if (used + snippet.text.length > opts.maxChars) return false;
        taken.add(key);
        used += snippet.text.length;
        out.push({ file: key, startLine: snippet.startLine, text: snippet.text, because });
        return true;
    };

    add(active, 'the file being edited', input.cursorLine, opts.activeWindow);

    for (const file of input.recentFiles) {
        if (normalizePath(file) === active) continue;
        add(file, 'edited moments ago', undefined, opts.neighbourWindow);
    }

    // Hops are gathered from the active file *and* the recently edited ones: in a
    // half-finished rename the active file is often the definition, and the files that
    // still need changing hang off the ones already touched.
    const seeds = [active, ...input.recentFiles.map(normalizePath)];
    const hops: GraphHop[] = [];
    const seenSeed = new Set<string>();
    for (const seed of seeds) {
        if (seenSeed.has(seed)) continue;
        seenSeed.add(seed);
        hops.push(...input.neighbours(seed));
    }

    const incoming = hops.filter(h => h.direction === 'in');
    const outgoing = hops.filter(h => h.direction === 'out');
    for (const hop of [...incoming, ...outgoing]) {
        const content = input.read(hop.file);
        if (content === undefined) continue;
        const anchor = lineOf(content, hop.via);
        add(hop.file, `${hop.direction === 'in' ? 'uses' : 'used by'} ${hop.via}`, anchor, opts.neighbourWindow);
    }

    return out;
}

/** A bounded slice of a file, centred on `anchorLine` when there is one. */
function windowAround(content: string, anchorLine: number | undefined, window: number): { startLine: number; text: string } {
    const lines = content.split('\n');
    const centre = anchorLine === undefined ? 0 : Math.max(0, Math.min(anchorLine, lines.length - 1));
    const start = anchorLine === undefined ? 0 : Math.max(0, centre - window);
    const end = Math.min(lines.length, start + window * 2);
    return { startLine: start, text: lines.slice(start, end).join('\n') };
}

/** First line containing `symbol` as a whole word, or undefined. */
function lineOf(content: string, symbol: string): number | undefined {
    if (!symbol) return undefined;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        // Word-boundary matching rather than `includes`, so `id` does not match `valid`.
        // `$` is treated as an identifier character for the reason Phase 1 found the hard
        // way: `\b` never matches before a leading `$`, so `$scope` would never resolve.
        const index = lines[i].indexOf(symbol);
        if (index === -1) continue;
        const before = lines[i][index - 1];
        const after = lines[i][index + symbol.length];
        if (isIdentifierChar(before) || isIdentifierChar(after)) continue;
        return i;
    }
    return undefined;
}

function isIdentifierChar(ch: string | undefined): boolean {
    return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * Pull one proposal out of a model response.
 *
 * Trims to the markers rather than parsing around them: models wrap output in prose or
 * fences however they like, and everything outside the contract is noise by definition.
 * Only the first edit is taken — "the next edit" is singular, and a model that emitted
 * three has answered a question that was not asked.
 */
export function parseProposal(response: string): NextEditProposal | undefined {
    if (!response) return undefined;
    if (response.trim().includes(NO_EDIT)) return undefined;

    const start = response.indexOf(ORIGINAL_MARKER);
    if (start === -1) return undefined;

    const dividerAt = response.indexOf(DIVIDER, start);
    if (dividerAt === -1) return undefined;

    const endAt = response.indexOf(UPDATED_MARKER, dividerAt);
    if (endAt === -1) return undefined;

    // The FILE: header is whatever precedes the marker; take the last one, since a
    // chatty preamble may have mentioned other paths on the way.
    const header = response.slice(0, start);
    const fileMatches = [...header.matchAll(/^\s*FILE:\s*(.+?)\s*$/gm)];
    const file = fileMatches.length ? fileMatches[fileMatches.length - 1][1].replace(/^`|`$/g, '').trim() : '';
    if (!file) return undefined;

    return {
        file,
        old: stripEdgeNewlines(response.slice(start + ORIGINAL_MARKER.length, dividerAt)),
        replacement: stripEdgeNewlines(response.slice(dividerAt + DIVIDER.length, endAt)),
    };
}

/**
 * The markers sit on their own lines, so the payload always arrives with a leading and
 * trailing newline that belongs to the format rather than to the code. Trimming
 * whitespace generally would be wrong — leading indentation is part of the anchor.
 */
function stripEdgeNewlines(text: string): string {
    return text.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface ValidationContext {
    activeFile: string;
    /** Current text of every file that was offered, keyed by the path in the prompt. */
    documents: Map<string, string>;
    /** Versions the documents were read at, carried into the prediction. */
    stamps: DocumentStamp[];
}

/**
 * Check a proposal against the live files, and reject it on any doubt.
 *
 * Every branch here is a failure mode observed in the fast-apply work (M25) or implied
 * by it, and the posture is the same: this feature is optional and silence is free, so
 * an uncertain prediction is discarded rather than shown. A wrong suggestion in an
 * editor is not a neutral event — the developer has to read it, decide it is wrong, and
 * dismiss it, which costs more attention than the feature saves.
 */
export function validateProposal(proposal: NextEditProposal, context: ValidationContext): NextEditResult {
    const file = normalizePath(proposal.file);
    const content = lookup(context.documents, file);
    if (content === undefined) {
        // The model named a file it was not shown. That is a hallucinated path, and the
        // one thing it must never do is become an edit to a file that happens to exist.
        return reject('unknown-file', `The prediction names ${proposal.file}, which was not offered.`);
    }

    if (!proposal.old.trim()) {
        // An empty anchor matches at every offset; "found once" would be meaningless.
        return reject('empty-anchor', 'The prediction has an empty anchor.');
    }

    const first = content.indexOf(proposal.old);
    if (first === -1) {
        return reject('anchor-missing', `The anchor is not present in ${file}.`);
    }
    if (content.indexOf(proposal.old, first + 1) !== -1) {
        return reject('anchor-ambiguous', `The anchor appears more than once in ${file}.`);
    }
    if (proposal.replacement === proposal.old) {
        return reject('no-change', 'The prediction replaces the anchor with itself.');
    }

    const updated = content.slice(0, first) + proposal.replacement + content.slice(first + proposal.old.length);
    const churn = changedFraction(content, updated);
    const changedLines = Math.round(churn * Math.max(content.split('\n').length, updated.split('\n').length));
    if (churn > MAX_REWRITE_FRACTION && changedLines > MAX_CHANGED_LINES) {
        return reject('oversized', `The prediction rewrites ${changedLines} lines (${Math.round(churn * 100)}%) of ${file}.`);
    }

    return {
        ok: true,
        prediction: {
            file,
            old: proposal.old,
            replacement: proposal.replacement,
            offset: first,
            line: content.slice(0, first).split('\n').length - 1,
            crossFile: normalizePath(context.activeFile) !== file,
            multiLine: proposal.old.includes('\n') || proposal.replacement.includes('\n'),
            stamps: context.stamps,
        },
    };
}

function reject(kind: RejectionKind, reason: string): NextEditRejection {
    return { ok: false, kind, reason };
}

/**
 * Paths are compared with separators normalised because the prompt, the code graph and
 * the host disagree about them on Windows, and a prediction rejected as "unknown file"
 * because of a backslash would be a platform-only bug — the worst kind to find.
 */
export function normalizePath(file: string): string {
    return file.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function lookup(documents: Map<string, string>, file: string): string | undefined {
    const direct = documents.get(file);
    if (direct !== undefined) return direct;
    for (const [key, value] of documents) {
        if (normalizePath(key) === file) return value;
    }
    return undefined;
}

// ─── Staleness ──────────────────────────────────────────────────────────────

/**
 * True when any document the prediction was computed from has moved on.
 *
 * This is the whole of "zero completions emitted after the buffer changed", and it is
 * deliberately a *pure function of version numbers* rather than a cancellation token: a
 * token tells you the request was cancelled, which is a different and weaker claim. A
 * request that completed while the developer typed one character was never cancelled and
 * is still wrong.
 *
 * A document that has closed (no version) counts as stale — its content is no longer
 * something we can check the anchor against, and guessing is not an option here.
 */
export function isStale(stamps: DocumentStamp[], versionOf: (file: string) => number | undefined): boolean {
    for (const stamp of stamps) {
        const current = versionOf(stamp.file);
        if (current === undefined || current !== stamp.version) return true;
    }
    return false;
}

// ─── Latency budget ─────────────────────────────────────────────────────────

/**
 * An AbortSignal that fires after `budgetMs`, chained to an optional parent.
 *
 * The gate is a p50 of 250 ms, and a prediction that arrives after the developer has
 * moved on is not late — it is wrong, because `isStale` will discard it anyway. Aborting
 * at the budget stops paying for a request whose result is already unusable, which on a
 * per-keystroke feature is the difference between a fast model and a bill.
 *
 * `done()` must be called on every path; the timer holds the event loop otherwise.
 */
export function budgetSignal(budgetMs: number, parent?: AbortSignal): { signal: AbortSignal; done(): void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const onParentAbort = () => controller.abort();
    parent?.addEventListener('abort', onParentAbort);
    if (parent?.aborted) controller.abort();

    return {
        signal: controller.signal,
        done() {
            clearTimeout(timer);
            parent?.removeEventListener('abort', onParentAbort);
        },
    };
}

// ─── Instrumentation ────────────────────────────────────────────────────────

export interface NextEditStatsSnapshot {
    shown: number;
    accepted: number;
    /** Share of *accepted* suggestions that were multi-line or in another file. */
    substantialShare: number;
    acceptanceRate: number;
    /** Median end-to-end latency of a shown prediction, in ms. */
    p50Ms: number;
    p90Ms: number;
    rejections: Record<string, number>;
}

/**
 * Counters for the two clauses of the M28 gate that are ratios rather than invariants:
 * "p50 latency ≤250 ms" and "≥40% of accepted suggestions are multi-line or cross-file".
 *
 * Both need real model calls to produce a number — they are §4.6 rows, not deterministic
 * ones. What is deterministic, and what this class is for, is that the number *can* be
 * produced: a gate with no instrument behind it is an assertion, and this codebase has
 * spent four revisions learning what those are worth. Deliberately in-memory and
 * session-scoped: it is a measurement instrument, not telemetry, and nothing here leaves
 * the machine.
 */
export class NextEditStats {
    private readonly latencies: number[] = [];
    private acceptedCount = 0;
    private substantialCount = 0;
    private shownCount = 0;
    private readonly rejections = new Map<RejectionKind, number>();

    recordShown(latencyMs: number): void {
        this.shownCount++;
        this.latencies.push(latencyMs);
    }

    recordAccepted(prediction: Pick<NextEditPrediction, 'crossFile' | 'multiLine'>): void {
        this.acceptedCount++;
        if (prediction.crossFile || prediction.multiLine) this.substantialCount++;
    }

    recordRejected(kind: RejectionKind): void {
        this.rejections.set(kind, (this.rejections.get(kind) ?? 0) + 1);
    }

    snapshot(): NextEditStatsSnapshot {
        return {
            shown: this.shownCount,
            accepted: this.acceptedCount,
            substantialShare: this.acceptedCount ? this.substantialCount / this.acceptedCount : 0,
            acceptanceRate: this.shownCount ? this.acceptedCount / this.shownCount : 0,
            p50Ms: percentile(this.latencies, 0.5),
            p90Ms: percentile(this.latencies, 0.9),
            rejections: Object.fromEntries(this.rejections),
        };
    }
}

/** Nearest-rank percentile. Zero for an empty sample — "no data" is not "instant". */
function percentile(values: number[], q: number): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.max(0, Math.ceil(q * sorted.length) - 1);
    return sorted[rank];
}
