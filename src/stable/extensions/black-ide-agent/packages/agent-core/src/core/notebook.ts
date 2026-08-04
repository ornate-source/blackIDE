// ─── Notebooks (Phase 10, M61) ──────────────────────────────────────────────
//
// D12 has read ⬜/❌ since rev 1: "No `notebook`/`ipynb` reference anywhere in `src/`. Agent
// cannot read or edit a cell." Today an agent asked to fix a bug in a notebook reads a
// 40 000-line JSON document in which the code is `["import pandas as pd\n", "df = ..."]`
// and the outputs — base64 PNGs, full dataframe dumps — outweigh the source ten to one. It
// then edits that JSON with a text tool.
//
// ── The gate is "without corrupting JSON", and the corruption is subtle ──────
// A notebook that fails to parse is the *loud* failure and the easy one. The quiet failures
// are what this module is built around:
//
//   1. **`source` is a string OR an array of strings**, and Jupyter writes the array form —
//      one element per line, newline included, last line without one. Writing back a plain
//      string is valid nbformat and still opens fine, and it rewrites every cell in the
//      file. A one-line fix becomes a 40 000-line diff, which is a merge conflict with
//      every colleague.
//   2. **Outputs and `execution_count` are state, not source.** An editor that drops them
//      has thrown away the results the notebook exists to show; one that renumbers them has
//      invented an execution history that never happened.
//   3. **Unknown keys** — `id`, `attachments`, per-cell `metadata`, `nbformat_minor`, kernel
//      spec. A serializer that emits only what it understands silently deletes the rest.
//
// So the model here is *edit in place*: parse, replace one cell's source, and write back
// with every other byte of structure untouched. `roundTrip` asserts that on an unmodified
// notebook, which is the same discipline `memory-markdown.ts` needed for the same reason —
// the file is in the user's repo and therefore in their diffs.

export type CellType = 'code' | 'markdown' | 'raw';

export interface NotebookCell {
    cell_type: CellType;
    /** Preserved exactly as read: string or string[]. See the header. */
    source: string | string[];
    metadata?: Record<string, unknown>;
    outputs?: unknown[];
    execution_count?: number | null;
    id?: string;
    [key: string]: unknown;
}

export interface Notebook {
    cells: NotebookCell[];
    metadata?: Record<string, unknown>;
    nbformat?: number;
    nbformat_minor?: number;
    [key: string]: unknown;
}

export interface ParsedNotebook {
    notebook: Notebook;
    /** True when the file ended with a newline, so writing can put it back. */
    trailingNewline: boolean;
    /** The indent Jupyter used, so the file's shape survives a write. */
    indent: number;
}

export class NotebookError extends Error {}

/**
 * Parse a `.ipynb`.
 *
 * Throws rather than returning a partial notebook: every caller writes the result back, and
 * a "best effort" parse of a file we are about to overwrite is how a corrupt notebook
 * becomes a *destroyed* one.
 */
export function parseNotebook(text: string): ParsedNotebook {
    const raw = String(text ?? '');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err: any) {
        throw new NotebookError(`This file is not valid JSON, so it cannot be a notebook: ${err?.message || err}`);
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Notebook).cells)) {
        throw new NotebookError('This JSON has no "cells" array, so it is not a notebook.');
    }

    return {
        notebook: parsed as Notebook,
        trailingNewline: raw.endsWith('\n'),
        indent: detectIndent(raw),
    };
}

/**
 * Jupyter writes one space of indent; nbconvert and some tools write two or four.
 *
 * Detected rather than assumed, because re-indenting a notebook rewrites every line of a
 * file that is often megabytes — the same spurious-diff problem as the `source` shape, at a
 * larger scale.
 */
function detectIndent(raw: string): number {
    const match = raw.match(/\n(\s+)"/);
    if (!match) return 1;
    return Math.min(8, match[1].replace(/\t/g, '  ').length);
}

/** Serialize back, preserving indent and trailing newline. */
export function serializeNotebook(parsed: ParsedNotebook): string {
    const json = JSON.stringify(parsed.notebook, null, parsed.indent);
    return parsed.trailingNewline ? `${json}\n` : json;
}

export function roundTrip(text: string): string {
    return serializeNotebook(parseNotebook(text));
}

/** The cell's text, whichever shape it was stored in. */
export function cellText(cell: NotebookCell): string {
    return Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
}

/**
 * Split text back into Jupyter's line array.
 *
 * Every line keeps its trailing newline **except the last**, which is exactly what Jupyter
 * writes. Getting this wrong produces a file that works and diffs against itself forever.
 */
export function toSourceArray(text: string): string[] {
    const value = String(text ?? '');
    if (value === '') return [];
    const lines = value.split('\n');
    return lines.map((line, i) => (i === lines.length - 1 ? line : `${line}\n`)).filter((line, i, all) => !(i === all.length - 1 && line === ''));
}

/**
 * Write text into a cell **in the shape that cell already used**.
 *
 * The whole of point 1 in the header. A cell Jupyter wrote as an array stays an array; a
 * cell some other tool wrote as a string stays a string. The editor does not have an
 * opinion about which is better — it has an opinion about not rewriting files it was not
 * asked to rewrite.
 */
export function withCellText(cell: NotebookCell, text: string): NotebookCell {
    const source = Array.isArray(cell.source) ? toSourceArray(text) : text;
    return { ...cell, source };
}

export interface CellSummary {
    index: number;
    type: CellType;
    /** First non-empty line, for the listing. */
    preview: string;
    lines: number;
    hasOutput: boolean;
    executionCount?: number | null;
}

/** A listing an agent can read without pulling the whole file into context. */
export function summarizeCells(notebook: Notebook): CellSummary[] {
    return (notebook.cells || []).map((cell, index) => {
        const text = cellText(cell);
        const firstLine = text.split('\n').find(line => line.trim()) || '';
        return {
            index,
            type: (cell.cell_type as CellType) || 'code',
            preview: firstLine.trim().slice(0, 100),
            lines: text ? text.split('\n').length : 0,
            hasOutput: Array.isArray(cell.outputs) && cell.outputs.length > 0,
            executionCount: cell.execution_count,
        };
    });
}

export interface RenderOptions {
    /** Include cell outputs. Off by default — see below. */
    includeOutputs?: boolean;
    maxOutputChars?: number;
}

/**
 * Render a notebook for the model.
 *
 * **Outputs are excluded by default**, and that is the single biggest reason reading a
 * notebook as text is unusable today: a plotting cell's output is a base64 PNG that can be
 * hundreds of kilobytes, and a dataframe dump is a screen of HTML. The source is what the
 * agent is being asked to change; the outputs are what the source produced, and they are
 * available on request per cell.
 */
export function renderNotebook(notebook: Notebook, options: RenderOptions = {}): string {
    const parts: string[] = [];
    for (const [index, cell] of (notebook.cells || []).entries()) {
        const type = cell.cell_type || 'code';
        const marker = cell.execution_count != null ? ` [${cell.execution_count}]` : '';
        parts.push(`--- cell ${index} (${type}${marker}) ---`);
        parts.push(cellText(cell).replace(/\n$/, ''));

        if (options.includeOutputs && Array.isArray(cell.outputs) && cell.outputs.length) {
            parts.push(`--- cell ${index} output ---`);
            parts.push(renderOutputs(cell.outputs, options.maxOutputChars ?? 2_000));
        }
    }
    return parts.join('\n');
}

/**
 * Outputs as text, with images named rather than inlined.
 *
 * A base64 image in a prompt is thousands of tokens that say nothing the model can act on.
 * Saying `[image/png output, 41 KB]` says the same thing usefully.
 */
export function renderOutputs(outputs: unknown[], maxChars: number): string {
    const lines: string[] = [];
    let used = 0;

    for (const raw of outputs) {
        const output = raw as Record<string, any>;
        if (output?.output_type === 'stream') {
            lines.push(flatten(output.text));
        } else if (output?.output_type === 'error') {
            lines.push(`${output.ename}: ${output.evalue}`);
            const trace = Array.isArray(output.traceback) ? output.traceback.slice(-3).join('\n') : '';
            if (trace) lines.push(stripAnsi(trace));
        } else if (output?.data) {
            const data = output.data as Record<string, unknown>;
            if (typeof data['text/plain'] !== 'undefined') lines.push(flatten(data['text/plain']));
            for (const mime of Object.keys(data)) {
                if (mime.startsWith('image/')) {
                    const bytes = Math.round(String(flatten(data[mime])).length * 0.75 / 1024);
                    lines.push(`[${mime} output, ~${bytes} KB]`);
                }
            }
        }
        used = lines.join('\n').length;
        if (used > maxChars) break;
    }

    const text = lines.join('\n');
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(output truncated)` : text;
}

function flatten(value: unknown): string {
    return Array.isArray(value) ? value.join('') : String(value ?? '');
}

/** Jupyter tracebacks carry ANSI colour codes, which are noise in a prompt. */
function stripAnsi(text: string): string {
    // Built from a char code rather than written literally: an ESC in source is a raw
    // control character, which `__tests__/source-hygiene.test.ts` rejects — and rightly,
    // since this codebase has shipped three NUL bytes for exactly that reason.
    const esc = String.fromCharCode(27);
    return text.split(new RegExp(`${esc}\\[[0-9;]*m`, 'g')).join('');
}

export type EditResult =
    | { ok: true; notebook: Notebook; index: number }
    | { ok: false; error: string };

/**
 * Replace one cell's source.
 *
 * Refuses an out-of-range index with a message naming the valid range, because the model
 * chose that index from a listing that may be a turn old, and "index 12 is out of range;
 * this notebook has 9 cells" is a correction it can act on.
 *
 * Outputs and `execution_count` are deliberately **left alone**. An edited cell's outputs
 * are now stale, and marking them so is tempting — but clearing them destroys results the
 * user may not be able to reproduce (a query against a database they no longer have), and
 * renumbering invents an execution history. Staleness is visible in Jupyter already.
 */
export function editCell(notebook: Notebook, index: number, text: string): EditResult {
    const cells = notebook.cells || [];
    if (!Number.isInteger(index) || index < 0 || index >= cells.length) {
        return { ok: false, error: `Cell ${index} does not exist — this notebook has ${cells.length} cells (0–${Math.max(0, cells.length - 1)}).` };
    }
    const next = cells.slice();
    next[index] = withCellText(cells[index], text);
    return { ok: true, notebook: { ...notebook, cells: next }, index };
}

/** Insert a new cell. `at` is the index it will occupy; append when omitted. */
export function insertCell(notebook: Notebook, type: CellType, text: string, at?: number): EditResult {
    const cells = notebook.cells || [];
    const index = at === undefined ? cells.length : Math.max(0, Math.min(at, cells.length));
    // Matches the surrounding file's shape rather than defaulting to a string, so inserting
    // one cell does not reformat the notebook it was inserted into.
    const arrayShaped = cells.some(c => Array.isArray(c.source));
    const cell: NotebookCell = {
        cell_type: type,
        metadata: {},
        source: arrayShaped ? toSourceArray(text) : text,
        ...(type === 'code' ? { outputs: [], execution_count: null } : {}),
    };
    const next = [...cells.slice(0, index), cell, ...cells.slice(index)];
    return { ok: true, notebook: { ...notebook, cells: next }, index };
}

export function deleteCell(notebook: Notebook, index: number): EditResult {
    const cells = notebook.cells || [];
    if (!Number.isInteger(index) || index < 0 || index >= cells.length) {
        return { ok: false, error: `Cell ${index} does not exist — this notebook has ${cells.length} cells.` };
    }
    return { ok: true, notebook: { ...notebook, cells: cells.filter((_, i) => i !== index) }, index };
}

/**
 * A per-cell snapshot, for cell-granular undo (E_3's contract, extended to notebooks).
 *
 * The whole cell rather than its text, so restoring puts back the outputs and execution
 * count too — a revert that returned the old source but kept the new cell's cleared
 * outputs would not be a revert.
 */
export interface CellSnapshot {
    index: number;
    cell: NotebookCell;
}

export function snapshotCell(notebook: Notebook, index: number): CellSnapshot | undefined {
    const cell = (notebook.cells || [])[index];
    return cell ? { index, cell: JSON.parse(JSON.stringify(cell)) } : undefined;
}

/** Restore one cell. Other cells are untouched, which is what "cell-granular" means. */
export function restoreCell(notebook: Notebook, snapshot: CellSnapshot): EditResult {
    const cells = notebook.cells || [];
    if (snapshot.index < 0 || snapshot.index >= cells.length) {
        return { ok: false, error: `Cannot restore cell ${snapshot.index}: the notebook now has ${cells.length} cells.` };
    }
    const next = cells.slice();
    next[snapshot.index] = snapshot.cell;
    return { ok: true, notebook: { ...notebook, cells: next }, index: snapshot.index };
}

export function isNotebookPath(path: string): boolean {
    return /\.ipynb$/i.test(String(path || ''));
}
