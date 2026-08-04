import { describe, expect, it } from 'vitest';
import {
    Notebook, NotebookError, cellText, deleteCell, editCell, insertCell, isNotebookPath,
    parseNotebook, renderNotebook, renderOutputs, restoreCell, roundTrip, serializeNotebook,
    snapshotCell, summarizeCells, toSourceArray, withCellText,
} from '@blackide/agent-core/core/notebook';

/**
 * Phase 10, M61 — notebooks.
 *
 * The gate: **the agent edits a real `.ipynb` without corrupting JSON, and the edit is
 * individually revertible.**
 *
 * A notebook that fails to parse is the loud failure and the easy one. This suite is mostly
 * about the quiet ones — the edits that produce a valid file which nonetheless rewrites
 * every line, drops results the user cannot reproduce, or invents an execution history.
 */

/** A realistic notebook, in the shape Jupyter actually writes it. */
const NOTEBOOK = JSON.stringify({
    cells: [
        {
            cell_type: 'markdown',
            id: 'intro',
            metadata: {},
            source: ['# Analysis\n', '\n', 'Loading the data.'],
        },
        {
            cell_type: 'code',
            execution_count: 3,
            id: 'load',
            metadata: { tags: ['setup'] },
            outputs: [
                { output_type: 'stream', name: 'stdout', text: ['loaded 1200 rows\n'] },
            ],
            source: ['import pandas as pd\n', '\n', "df = pd.read_csv('data.csv')"],
        },
        {
            cell_type: 'code',
            execution_count: null,
            id: 'plot',
            metadata: {},
            outputs: [],
            source: 'df.plot()',
        },
    ],
    metadata: {
        kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        language_info: { name: 'python', version: '3.11.4' },
    },
    nbformat: 4,
    nbformat_minor: 5,
}, null, 1) + '\n';

const parsed = () => parseNotebook(NOTEBOOK);

// ─── The gate: the file is not corrupted ────────────────────────────────────

describe('an unmodified notebook round-trips byte-for-byte', () => {
    it('is stable on the first pass', () => {
        expect(roundTrip(NOTEBOOK)).toBe(NOTEBOOK);
    });

    it('is stable on repeated passes', () => {
        const once = roundTrip(NOTEBOOK);
        expect(roundTrip(once)).toBe(once);
    });

    it('preserves the indent the file used, rather than re-indenting megabytes', () => {
        const fourSpace = JSON.stringify(JSON.parse(NOTEBOOK), null, 4) + '\n';
        expect(roundTrip(fourSpace)).toBe(fourSpace);
    });

    it('preserves a missing trailing newline', () => {
        const noNewline = NOTEBOOK.trimEnd();
        expect(roundTrip(noNewline)).toBe(noNewline);
    });

    it('preserves keys it does not model', () => {
        // A serializer that emits only what it understands silently deletes the rest.
        const withExtras = JSON.stringify({
            ...JSON.parse(NOTEBOOK),
            custom_top_level: { anything: true },
        }, null, 1) + '\n';
        expect(roundTrip(withExtras)).toContain('custom_top_level');
    });
});

describe('editing one cell rewrites one cell', () => {
    it('keeps the array shape Jupyter wrote', () => {
        // Writing back a plain string is valid nbformat and opens fine — and turns a
        // one-line fix into a diff against every line of the file.
        const { notebook } = parsed();
        const result = editCell(notebook, 1, "import polars as pl\n\ndf = pl.read_csv('data.csv')");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(Array.isArray(result.notebook.cells[1].source)).toBe(true);
    });

    it('keeps a string-shaped cell a string', () => {
        // The editor has no opinion about which shape is better — only about not
        // rewriting files it was not asked to rewrite.
        const { notebook } = parsed();
        const result = editCell(notebook, 2, 'df.hist()');
        if (!result.ok) return;
        expect(typeof result.notebook.cells[2].source).toBe('string');
    });

    it('leaves every other cell byte-identical', () => {
        const before = parsed();
        const result = editCell(before.notebook, 1, 'changed');
        if (!result.ok) return;
        const after = serializeNotebook({ ...before, notebook: result.notebook });
        const original = JSON.parse(NOTEBOOK) as Notebook;
        const rewritten = JSON.parse(after) as Notebook;

        expect(rewritten.cells[0]).toEqual(original.cells[0]);
        expect(rewritten.cells[2]).toEqual(original.cells[2]);
        expect(rewritten.metadata).toEqual(original.metadata);
        expect(rewritten.nbformat_minor).toBe(5);
    });

    it('preserves the cell id and metadata of the cell it edits', () => {
        const { notebook } = parsed();
        const result = editCell(notebook, 1, 'changed');
        if (!result.ok) return;
        expect(result.notebook.cells[1].id).toBe('load');
        expect(result.notebook.cells[1].metadata).toEqual({ tags: ['setup'] });
    });

    it('does not clear outputs or renumber execution_count', () => {
        // Clearing destroys results the user may not be able to reproduce — a query
        // against a database they no longer have. Renumbering invents a history.
        const { notebook } = parsed();
        const result = editCell(notebook, 1, 'changed');
        if (!result.ok) return;
        expect(result.notebook.cells[1].outputs).toHaveLength(1);
        expect(result.notebook.cells[1].execution_count).toBe(3);
    });

    it('refuses an out-of-range index with the valid range', () => {
        const { notebook } = parsed();
        const result = editCell(notebook, 12, 'x');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toContain('3 cells');
        expect(result.error).toContain('0–2');
    });

    it('refuses a non-integer index rather than coercing it', () => {
        const { notebook } = parsed();
        expect(editCell(notebook, 1.5 as any, 'x').ok).toBe(false);
        expect(editCell(notebook, -1, 'x').ok).toBe(false);
    });

    it('does not mutate the notebook it was given', () => {
        const { notebook } = parsed();
        const snapshot = JSON.stringify(notebook);
        editCell(notebook, 1, 'changed');
        expect(JSON.stringify(notebook)).toBe(snapshot);
    });
});

describe('toSourceArray matches what Jupyter writes', () => {
    it('keeps a trailing newline on every line except the last', () => {
        expect(toSourceArray('a\nb\nc')).toEqual(['a\n', 'b\n', 'c']);
    });

    it('drops the empty tail of a trailing newline', () => {
        expect(toSourceArray('a\nb\n')).toEqual(['a\n', 'b\n']);
    });

    it('is empty for empty text, not [""]', () => {
        expect(toSourceArray('')).toEqual([]);
    });

    it('round-trips through cellText', () => {
        for (const text of ['a\nb\nc', 'single', 'a\nb\n', '']) {
            expect(cellText({ cell_type: 'code', source: toSourceArray(text) })).toBe(text);
        }
    });
});

describe('insert and delete', () => {
    it('inserts in the surrounding file\'s shape', () => {
        const { notebook } = parsed();
        const result = insertCell(notebook, 'code', 'print(1)', 1);
        if (!result.ok) return;
        expect(Array.isArray(result.notebook.cells[1].source)).toBe(true);
        expect(result.notebook.cells).toHaveLength(4);
        expect(cellText(result.notebook.cells[2])).toContain('import pandas');
    });

    it('gives a new code cell the fields nbformat requires', () => {
        const { notebook } = parsed();
        const result = insertCell(notebook, 'code', 'print(1)');
        if (!result.ok) return;
        const cell = result.notebook.cells[3];
        expect(cell.outputs).toEqual([]);
        expect(cell.execution_count).toBeNull();
    });

    it('does not give a markdown cell outputs', () => {
        const { notebook } = parsed();
        const result = insertCell(notebook, 'markdown', '# Heading');
        if (!result.ok) return;
        expect(result.notebook.cells[3].outputs).toBeUndefined();
    });

    it('clamps an out-of-range insertion point instead of failing', () => {
        const { notebook } = parsed();
        expect(insertCell(notebook, 'code', 'x', 99).ok).toBe(true);
        expect(insertCell(notebook, 'code', 'x', -5).ok).toBe(true);
    });

    it('deletes by index and refuses a bad one', () => {
        const { notebook } = parsed();
        const result = deleteCell(notebook, 0);
        if (!result.ok) return;
        expect(result.notebook.cells).toHaveLength(2);
        expect(deleteCell(notebook, 9).ok).toBe(false);
    });
});

// ─── The gate: the edit is individually revertible ──────────────────────────

describe('cell-granular checkpointing', () => {
    it('restores one cell and leaves the others alone', () => {
        const { notebook } = parsed();
        const snapshot = snapshotCell(notebook, 1)!;

        const edited = editCell(notebook, 1, 'totally different');
        if (!edited.ok) return;
        const restored = restoreCell(edited.notebook, snapshot);
        if (!restored.ok) return;

        expect(restored.notebook.cells[1]).toEqual((JSON.parse(NOTEBOOK) as Notebook).cells[1]);
        expect(restored.notebook.cells[0]).toEqual(edited.notebook.cells[0]);
    });

    it('restores outputs and execution count, not just the source', () => {
        // A revert that returned the old source but kept the new cell's state would not
        // be a revert.
        const { notebook } = parsed();
        const snapshot = snapshotCell(notebook, 1)!;
        const stripped = { ...notebook, cells: notebook.cells.map((c, i) => (i === 1 ? { ...c, outputs: [], execution_count: null } : c)) };

        const restored = restoreCell(stripped, snapshot);
        if (!restored.ok) return;
        expect(restored.notebook.cells[1].outputs).toHaveLength(1);
        expect(restored.notebook.cells[1].execution_count).toBe(3);
    });

    it('snapshots deeply, so a later edit cannot reach into the saved copy', () => {
        const { notebook } = parsed();
        const snapshot = snapshotCell(notebook, 1)!;
        (notebook.cells[1].metadata as any).tags.push('mutated');
        expect((snapshot.cell.metadata as any).tags).toEqual(['setup']);
    });

    it('refuses to restore into a notebook that has shrunk', () => {
        const { notebook } = parsed();
        const snapshot = snapshotCell(notebook, 2)!;
        const shrunk = deleteCell(deleteCell(notebook, 0).ok ? (deleteCell(notebook, 0) as any).notebook : notebook, 0);
        if (!shrunk.ok) return;
        expect(restoreCell(shrunk.notebook, snapshot).ok).toBe(false);
    });

    it('returns undefined for a cell that does not exist', () => {
        expect(snapshotCell(parsed().notebook, 99)).toBeUndefined();
    });
});

// ─── Reading ────────────────────────────────────────────────────────────────

describe('rendering for the model', () => {
    it('excludes outputs by default', () => {
        // A plotting cell's output is a base64 PNG worth thousands of tokens that say
        // nothing the model can act on.
        const rendered = renderNotebook(parsed().notebook);
        expect(rendered).toContain('import pandas');
        expect(rendered).not.toContain('loaded 1200 rows');
    });

    it('includes them on request', () => {
        const rendered = renderNotebook(parsed().notebook, { includeOutputs: true });
        expect(rendered).toContain('loaded 1200 rows');
    });

    it('labels cells with an index the edit tool accepts', () => {
        const rendered = renderNotebook(parsed().notebook);
        expect(rendered).toContain('--- cell 0 (markdown) ---');
        expect(rendered).toContain('--- cell 1 (code [3]) ---');
    });

    it('names an image rather than inlining it', () => {
        const outputs = [{ output_type: 'display_data', data: { 'image/png': 'A'.repeat(4_000), 'text/plain': '<Figure>' } }];
        const rendered = renderOutputs(outputs, 2_000);
        expect(rendered).toContain('[image/png output');
        expect(rendered).not.toContain('AAAA');
    });

    it('renders an error output usefully', () => {
        const outputs = [{ output_type: 'error', ename: 'KeyError', evalue: "'missing'", traceback: ['line1', 'line2', 'line3', 'line4'] }];
        const rendered = renderOutputs(outputs, 2_000);
        expect(rendered).toContain("KeyError: 'missing'");
        expect(rendered).toContain('line4');
    });

    it('strips ANSI colour codes from a traceback', () => {
        const esc = String.fromCharCode(27);
        const outputs = [{ output_type: 'error', ename: 'E', evalue: 'v', traceback: [`${esc}[0;31mboom${esc}[0m`] }];
        expect(renderOutputs(outputs, 2_000)).toContain('boom');
        expect(renderOutputs(outputs, 2_000)).not.toContain(esc);
    });

    it('bounds output length', () => {
        const outputs = [{ output_type: 'stream', name: 'stdout', text: ['x'.repeat(50_000)] }];
        expect(renderOutputs(outputs, 500).length).toBeLessThan(600);
    });
});

describe('summarizeCells', () => {
    it('gives an index, a type and a preview without the whole file', () => {
        const summary = summarizeCells(parsed().notebook);
        expect(summary).toHaveLength(3);
        expect(summary[0]).toMatchObject({ index: 0, type: 'markdown', preview: '# Analysis' });
        expect(summary[1].hasOutput).toBe(true);
        expect(summary[2].hasOutput).toBe(false);
    });

    it('skips blank lines when picking a preview', () => {
        const notebook: Notebook = { cells: [{ cell_type: 'code', source: ['\n', '\n', 'real code'] }] };
        expect(summarizeCells(notebook)[0].preview).toBe('real code');
    });
});

describe('parse failures are loud', () => {
    it('throws on invalid JSON rather than returning a partial notebook', () => {
        // Every caller writes the result back; a best-effort parse of a file about to be
        // overwritten is how a corrupt notebook becomes a destroyed one.
        expect(() => parseNotebook('{ not json')).toThrow(NotebookError);
    });

    it('throws on JSON that is not a notebook', () => {
        expect(() => parseNotebook('{"foo":1}')).toThrow(/no "cells" array/);
        expect(() => parseNotebook('[]')).toThrow(NotebookError);
    });
});

describe('isNotebookPath', () => {
    it('matches .ipynb in any case', () => {
        expect(isNotebookPath('a/b/Analysis.ipynb')).toBe(true);
        expect(isNotebookPath('x.IPYNB')).toBe(true);
    });

    it('does not match other files', () => {
        expect(isNotebookPath('a.py')).toBe(false);
        expect(isNotebookPath('ipynb')).toBe(false);
        expect(isNotebookPath('')).toBe(false);
    });
});
