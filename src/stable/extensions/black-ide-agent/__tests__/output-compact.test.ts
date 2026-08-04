import { describe, expect, it } from 'vitest';
import {
    RawOutputStore,
    commonPathPrefix,
    compactDiagnostics,
    compactGrep,
    compactListing,
    withRawPointer,
} from '@blackide/agent-core/core/output-compact';

/**
 * Phase 3, M18.
 *
 * The property that matters most is that nothing is *lost*. A compression that
 * silently drops a match is indistinguishable, from the model's side, from the match
 * not existing — and the agent then edits the wrong set of files. Every assertion
 * about size is paired with one about content.
 */

const grepRows = [
    { file: 'src/services/order-service.ts', line: 12, content: 'const total = convertMinor(subtotal);' },
    { file: 'src/services/order-service.ts', line: 40, content: 'return convertMinor(x, a, b);' },
    { file: 'src/services/order-service.ts', line: 68, content: '// convertMinor rounds half-up' },
    { file: 'src/utils/currency.ts', line: 23, content: 'export function convertMinor(...) {' },
    { file: 'src/utils/currency.ts', line: 31, content: 'return Math.round(converted);' },
];

describe('compactGrep', () => {
    it('keeps every line number and every line of content', () => {
        const { text } = compactGrep(grepRows);
        for (const row of grepRows) {
            expect(text, `line ${row.line}`).toContain(String(row.line));
            expect(text, row.content).toContain(row.content);
        }
    });

    it('names each file exactly once', () => {
        const { text } = compactGrep(grepRows);
        const occurrences = text.split('src/services/order-service.ts').length - 1;
        expect(occurrences).toBe(1);
    });

    it('is smaller than the flat form', () => {
        const result = compactGrep(grepRows);
        expect(result.compactChars).toBeLessThan(result.originalChars);
        expect(result.savedPct).toBeGreaterThan(0);
    });

    it('reports how many matches each file has', () => {
        expect(compactGrep(grepRows).text).toContain('(3 matches)');
    });

    it('leaves a short result alone rather than adding structure to it', () => {
        const two = grepRows.slice(0, 2);
        const result = compactGrep(two);
        expect(result.text).toBe(two.map(r => `${r.file}:${r.line}: ${r.content}`).join('\n'));
        expect(result.savedPct).toBe(0);
    });

    it('never returns something longer than the input', () => {
        // One hit per file is the worst case: grouping adds a header per row.
        const spread = Array.from({ length: 8 }, (_, i) => ({
            file: `a${i}.ts`, line: 1, content: 'x',
        }));
        const result = compactGrep(spread);
        expect(result.compactChars).toBeLessThanOrEqual(result.originalChars);
    });

    it('preserves file order from the original results', () => {
        const { text } = compactGrep(grepRows);
        expect(text.indexOf('src/services/order-service.ts')).toBeLessThan(text.indexOf('src/utils/currency.ts'));
    });
});

describe('compactDiagnostics', () => {
    const rows = [
        { file: 'a.ts', line: 3, severity: 'error', message: "Cannot find name 'X'." },
        { file: 'a.ts', line: 9, severity: 'error', message: "Cannot find name 'X'." },
        { file: 'a.ts', line: 14, severity: 'error', message: "Cannot find name 'X'." },
        { file: 'a.ts', line: 20, severity: 'warning', message: "'y' is unused." },
        { file: 'b.ts', line: 2, severity: 'error', message: "Cannot find name 'X'." },
    ];

    it('collapses a repeated message into one row listing its lines', () => {
        const { text } = compactDiagnostics(rows);
        expect(text).toContain('3, 9, 14');
        expect(text.split("Cannot find name 'X'.").length - 1).toBe(2); // once per file
    });

    it('keeps every line number', () => {
        const { text } = compactDiagnostics(rows);
        for (const row of rows) expect(text).toContain(String(row.line));
    });

    it('does not merge different severities', () => {
        const { text } = compactDiagnostics(rows);
        expect(text).toContain('error');
        expect(text).toContain('warning');
        expect(text).toContain("'y' is unused.");
    });

    it('achieves a large reduction on the repeated-message shape', () => {
        expect(compactDiagnostics(rows).savedPct).toBeGreaterThan(20);
    });
});

describe('compactListing', () => {
    it('lifts a shared directory prefix into the header', () => {
        const entries = ['src/core/a.ts', 'src/core/b.ts', 'src/core/c.ts', 'src/core/d.ts'];
        const { text } = compactListing('Contents:', entries);
        expect(text).toContain('src/core/');
        expect(text).toContain('a.ts');
        expect(text).not.toContain('src/core/a.ts');
    });

    it('leaves entries alone when they share no directory', () => {
        const entries = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
        const { text } = compactListing('Contents:', entries);
        expect(text).toBe(['Contents:', ...entries].join('\n'));
    });
});

describe('commonPathPrefix', () => {
    it('cuts back to a separator rather than splitting a filename', () => {
        // 'src/core/co' is a shared string but not a shared path.
        expect(commonPathPrefix(['src/core/codebase.ts', 'src/core/config.ts'])).toBe('src/core/');
    });

    it('is empty when there is no shared directory', () => {
        expect(commonPathPrefix(['a/x.ts', 'b/y.ts'])).toBe('');
    });

    it('is empty for a single path', () => {
        expect(commonPathPrefix(['src/core/a.ts'])).toBe('');
    });
});

describe('RawOutputStore', () => {
    it('returns what it stored', () => {
        const store = new RawOutputStore();
        const id = store.put('the full output');
        expect(store.get(id)).toBe('the full output');
    });

    it('evicts oldest entries past its bound', () => {
        const store = new RawOutputStore(2);
        const first = store.put('one');
        store.put('two');
        store.put('three');
        expect(store.get(first)).toBeUndefined();
        expect(store.size).toBe(2);
    });

    it('returns undefined for an unknown id instead of throwing', () => {
        expect(new RawOutputStore().get('out_999')).toBeUndefined();
    });
});

describe('withRawPointer', () => {
    it('stores the raw form and advertises how to fetch it', () => {
        const store = new RawOutputStore();
        const raw = grepRows.map(r => `${r.file}:${r.line}: ${r.content}`).join('\n');
        const result = withRawPointer(compactGrep(grepRows), store, raw);

        expect(result.rawId).toBeDefined();
        expect(result.text).toContain('expand_output');
        expect(store.get(result.rawId!)).toBe(raw);
    });

    it('adds no pointer when compaction saved nothing', () => {
        // A pointer to an identical copy is noise, and the model will sometimes
        // spend a whole turn fetching it.
        const store = new RawOutputStore();
        const two = grepRows.slice(0, 2);
        const raw = two.map(r => `${r.file}:${r.line}: ${r.content}`).join('\n');
        const result = withRawPointer(compactGrep(two), store, raw);

        expect(result.rawId).toBeUndefined();
        expect(result.text).not.toContain('expand_output');
        expect(store.size).toBe(0);
    });
});
