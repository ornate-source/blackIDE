import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AGENT_EDIT_GRACE_MS, agentIsWriting, asAgentEdit, markAgentWrite, resetEditOrigin, withinAgentEditGrace,
} from '../src/core/edit-origin';
import { EditHistory, renderEditHistory } from '@blackide/agent-core/core/edit-history';
import {
    DocumentStamp, NO_EDIT, budgetSignal, buildNextEditPrompt, isStale, normalizePath,
    parseProposal, selectCandidates, validateProposal,
} from '@blackide/agent-core/core/next-edit';

/**
 * Phase 5, M28 — next-edit prediction.
 *
 * The phase gate has four clauses and only one of them is answerable without spending
 * real model calls: **zero completions emitted after the buffer changed**. That clause is
 * the reason this suite exists in the shape it does — most of it is about refusing, and
 * the staleness section is written as an adversary rather than a happy path. p50 latency
 * and the multi-line/cross-file acceptance ratio need the model tier (§4.6); what is
 * asserted here is that the engine's own overhead is bounded and that the flags those
 * ratios will be computed from are set correctly.
 */

const edit = (over: Partial<Parameters<EditHistory['record']>[0]> = {}) => ({
    file: 'src/a.ts', startLine: 10, endLine: 10, removed: '', added: 'x', at: 1_000, ...over,
});

// ─── Ring buffer ────────────────────────────────────────────────────────────

describe('EditHistory coalescing', () => {
    it('merges keystrokes in the same region into one edit', () => {
        const history = new EditHistory();
        history.record(edit({ added: 'h', at: 1_000 }));
        history.record(edit({ added: 'ha', at: 1_100 }));
        history.record(edit({ added: 'han', at: 1_200 }));

        expect(history.size).toBe(1);
        expect(history.recent()[0].added).toBe('han');
    });

    it('does not merge across the time window', () => {
        const history = new EditHistory();
        history.record(edit({ at: 1_000 }));
        history.record(edit({ at: 1_000 + 5_000 }));
        expect(history.size).toBe(2);
    });

    it('does not merge distant lines in the same file', () => {
        const history = new EditHistory();
        history.record(edit({ startLine: 10, endLine: 10 }));
        history.record(edit({ startLine: 400, endLine: 400, at: 1_100 }));
        expect(history.size).toBe(2);
    });

    it('does not merge across files', () => {
        const history = new EditHistory();
        history.record(edit({ file: 'src/a.ts' }));
        history.record(edit({ file: 'src/b.ts', at: 1_100 }));
        expect(history.size).toBe(2);
    });

    it('keeps the earliest before-text and the latest after-text when merging', () => {
        const history = new EditHistory();
        history.record(edit({ removed: 'const x = 1;', added: 'const y = 1;', at: 1_000 }));
        history.record(edit({ removed: 'const y = 1;', added: 'const y = 2;', at: 1_100 }));

        const [record] = history.recent();
        expect(record.removed).toBe('const x = 1;');
        expect(record.added).toBe('const y = 2;');
    });

    it('ignores changes that neither add nor remove text', () => {
        const history = new EditHistory();
        history.record(edit({ added: '', removed: '' }));
        expect(history.size).toBe(0);
    });

    it('evicts oldest first at capacity', () => {
        const history = new EditHistory(3);
        for (let i = 0; i < 6; i++) {
            history.record(edit({ file: `src/f${i}.ts`, at: 1_000 + i * 10_000 }));
        }
        expect(history.size).toBe(3);
        expect(history.recent().map(r => r.file)).toEqual(['src/f3.ts', 'src/f4.ts', 'src/f5.ts']);
    });

    it('clips an oversized edit instead of dropping it', () => {
        const history = new EditHistory();
        history.record(edit({ added: 'x'.repeat(50_000) }));

        const [record] = history.recent();
        expect(record.truncated).toBe(true);
        expect(record.added.length).toBeLessThan(5_000);
        // The point of clipping rather than dropping: the history still says an edit
        // happened here, which is the signal about where attention moved.
        expect(record.file).toBe('src/a.ts');
    });

    it('lists files touched, most recent first, without duplicates', () => {
        const history = new EditHistory();
        history.record(edit({ file: 'src/a.ts', at: 1_000 }));
        history.record(edit({ file: 'src/b.ts', at: 20_000 }));
        history.record(edit({ file: 'src/a.ts', at: 40_000 }));
        expect(history.filesTouched()).toEqual(['src/a.ts', 'src/b.ts']);
    });
});

describe('renderEditHistory', () => {
    it('renders as a diff and keeps the newest edits when the budget is tight', () => {
        const records = [1, 2, 3].map(n => ({
            file: `src/f${n}.ts`, startLine: 0, endLine: 0, removed: `old${n}`, added: `new${n}`, at: n,
        }));
        const rendered = renderEditHistory(records, 60);

        expect(rendered).toContain('+ new3');
        expect(rendered).not.toContain('+ new1');
        expect(rendered).toContain('- old3');
    });

    it('is empty for an empty history rather than a header with nothing under it', () => {
        expect(renderEditHistory([])).toBe('');
    });
});

// ─── Parsing ────────────────────────────────────────────────────────────────

const proposal = (file: string, original: string, updated: string) =>
    `FILE: ${file}\n<<<<<<< ORIGINAL\n${original}\n=======\n${updated}\n>>>>>>> UPDATED`;

describe('parseProposal', () => {
    it('parses a well-formed prediction', () => {
        const parsed = parseProposal(proposal('src/b.ts', 'const a = 1;', 'const a = 2;'));
        expect(parsed).toEqual({ file: 'src/b.ts', old: 'const a = 1;', replacement: 'const a = 2;' });
    });

    it('tolerates prose and fences around the contract', () => {
        const parsed = parseProposal(
            `Sure! Here is the next edit you probably want:\n\n${proposal('src/b.ts', 'a', 'b')}\n\nLet me know!`,
        );
        expect(parsed?.file).toBe('src/b.ts');
        expect(parsed?.replacement).toBe('b');
    });

    it('preserves indentation inside the anchor', () => {
        const parsed = parseProposal(proposal('src/b.ts', '    return x;', '    return y;'));
        expect(parsed?.old).toBe('    return x;');
        expect(parsed?.replacement).toBe('    return y;');
    });

    it('returns undefined for the refusal token', () => {
        expect(parseProposal(NO_EDIT)).toBeUndefined();
        expect(parseProposal(`I do not see one. ${NO_EDIT}`)).toBeUndefined();
    });

    it('returns undefined when the markers are incomplete', () => {
        expect(parseProposal('FILE: a.ts\n<<<<<<< ORIGINAL\nx\n=======')).toBeUndefined();
        expect(parseProposal('FILE: a.ts\nno markers at all')).toBeUndefined();
    });

    it('returns undefined when no file is named', () => {
        expect(parseProposal('<<<<<<< ORIGINAL\na\n=======\nb\n>>>>>>> UPDATED')).toBeUndefined();
    });

    it('takes the last FILE header, so a chatty preamble cannot redirect the edit', () => {
        const response = `I looked at FILE: src/wrong.ts first.\n${proposal('src/right.ts', 'a', 'b')}`;
        expect(parseProposal(response)?.file).toBe('src/right.ts');
    });
});

// ─── Validation ─────────────────────────────────────────────────────────────

const FILE_A = ['export function reserve(id) {', '    return stock.take(id);', '}'].join('\n');
const FILE_B = ['import { reserve } from "./a";', '', 'reserve(42);'].join('\n');

const context = (over: Partial<Parameters<typeof validateProposal>[1]> = {}) => ({
    activeFile: 'src/a.ts',
    documents: new Map([['src/a.ts', FILE_A], ['src/b.ts', FILE_B]]),
    stamps: [] as DocumentStamp[],
    ...over,
});

describe('validateProposal', () => {
    it('accepts an anchored, bounded, cross-file edit', () => {
        const result = validateProposal({ file: 'src/b.ts', old: 'reserve(42);', replacement: 'reserveStock(42);' }, context());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.prediction.crossFile).toBe(true);
        expect(result.prediction.multiLine).toBe(false);
        expect(result.prediction.line).toBe(2);
        expect(FILE_B.slice(result.prediction.offset)).toMatch(/^reserve\(42\);/);
    });

    it('flags a multi-line edit in the active file', () => {
        const result = validateProposal(
            { file: 'src/a.ts', old: 'export function reserve(id) {\n    return stock.take(id);', replacement: 'export function reserve(id, qty) {\n    return stock.take(id, qty);' },
            context(),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.prediction.crossFile).toBe(false);
        expect(result.prediction.multiLine).toBe(true);
    });

    it('refuses a file that was never offered', () => {
        const result = validateProposal({ file: 'src/secrets.ts', old: 'a', replacement: 'b' }, context());
        expect(result).toMatchObject({ ok: false, kind: 'unknown-file' });
    });

    it('refuses an empty anchor, which would match everywhere', () => {
        const result = validateProposal({ file: 'src/b.ts', old: '   ', replacement: 'x' }, context());
        expect(result).toMatchObject({ ok: false, kind: 'empty-anchor' });
    });

    it('refuses an anchor that is not in the file', () => {
        const result = validateProposal({ file: 'src/b.ts', old: 'release(42);', replacement: 'x' }, context());
        expect(result).toMatchObject({ ok: false, kind: 'anchor-missing' });
    });

    it('refuses an ambiguous anchor rather than guessing which one', () => {
        const documents = new Map([['src/a.ts', FILE_A], ['src/b.ts', 'x = 1;\ny = 2;\nx = 1;']]);
        const result = validateProposal({ file: 'src/b.ts', old: 'x = 1;', replacement: 'x = 3;' }, context({ documents }));
        expect(result).toMatchObject({ ok: false, kind: 'anchor-ambiguous' });
    });

    it('refuses an edit that changes nothing', () => {
        const result = validateProposal({ file: 'src/b.ts', old: 'reserve(42);', replacement: 'reserve(42);' }, context());
        expect(result).toMatchObject({ ok: false, kind: 'no-change' });
    });

    it('refuses a rewrite wearing a prediction costume', () => {
        const big = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
        const documents = new Map([['src/a.ts', FILE_A], ['src/big.ts', big]]);
        const result = validateProposal(
            { file: 'src/big.ts', old: big, replacement: Array.from({ length: 40 }, (_, i) => `changed ${i}`).join('\n') },
            context({ documents }),
        );
        expect(result).toMatchObject({ ok: false, kind: 'oversized' });
    });

    it('matches a path that differs only by separator', () => {
        const result = validateProposal({ file: 'src\\b.ts', old: 'reserve(42);', replacement: 'reserveStock(42);' }, context());
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.prediction.file).toBe('src/b.ts');
    });

    it('normalizePath strips a leading ./ and flips separators', () => {
        expect(normalizePath('.\\src\\a.ts')).toBe('src/a.ts');
        expect(normalizePath('./src/a.ts')).toBe('src/a.ts');
    });
});

// ─── The gate: nothing survives a buffer change ─────────────────────────────

describe('staleness — the "zero completions after the buffer changed" gate', () => {
    const stamps: DocumentStamp[] = [{ file: 'src/a.ts', version: 7 }, { file: 'src/b.ts', version: 2 }];

    it('is not stale when every document is untouched', () => {
        expect(isStale(stamps, f => ({ 'src/a.ts': 7, 'src/b.ts': 2 } as any)[f])).toBe(false);
    });

    it('is stale when the file being edited moved by one version', () => {
        expect(isStale(stamps, f => ({ 'src/a.ts': 8, 'src/b.ts': 2 } as any)[f])).toBe(true);
    });

    it('is stale when the TARGET file moved, even though the active one did not', () => {
        // The failure this prevents: a cross-file prediction computed against b.ts while
        // the developer was in a.ts, applied after something else rewrote b.ts.
        expect(isStale(stamps, f => ({ 'src/a.ts': 7, 'src/b.ts': 3 } as any)[f])).toBe(true);
    });

    it('is stale when a document has closed and can no longer be checked', () => {
        expect(isStale(stamps, f => (f === 'src/a.ts' ? 7 : undefined))).toBe(true);
    });

    it('treats a version that went backwards as stale, not as unchanged', () => {
        expect(isStale(stamps, f => ({ 'src/a.ts': 6, 'src/b.ts': 2 } as any)[f])).toBe(true);
    });
});

describe('budgetSignal', () => {
    it('aborts at the budget', () => {
        vi.useFakeTimers();
        try {
            const budget = budgetSignal(250);
            expect(budget.signal.aborted).toBe(false);
            vi.advanceTimersByTime(251);
            expect(budget.signal.aborted).toBe(true);
            budget.done();
        } finally {
            vi.useRealTimers();
        }
    });

    it('aborts immediately when the parent is already aborted', () => {
        const parent = new AbortController();
        parent.abort();
        const budget = budgetSignal(10_000, parent.signal);
        expect(budget.signal.aborted).toBe(true);
        budget.done();
    });

    it('follows a parent that aborts later — the keystroke path', () => {
        const parent = new AbortController();
        const budget = budgetSignal(10_000, parent.signal);
        parent.abort();
        expect(budget.signal.aborted).toBe(true);
        budget.done();
    });

    it('does not abort after done() clears the timer', () => {
        vi.useFakeTimers();
        try {
            const budget = budgetSignal(250);
            budget.done();
            vi.advanceTimersByTime(1_000);
            expect(budget.signal.aborted).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});

// ─── Candidate selection ────────────────────────────────────────────────────

describe('selectCandidates', () => {
    const files: Record<string, string> = {
        'src/a.ts': FILE_A,
        'src/b.ts': FILE_B,
        'src/c.ts': 'import { reserve } from "./a";\nreserve(1);',
        'src/unrelated.ts': 'export const x = 1;',
    };
    const read = (f: string) => files[normalizePath(f)];

    it('always puts the active file first', () => {
        const candidates = selectCandidates({
            activeFile: 'src/a.ts', cursorLine: 1, recentFiles: [], neighbours: () => [], read,
        });
        expect(candidates[0].file).toBe('src/a.ts');
        expect(candidates[0].because).toContain('being edited');
    });

    it('ranks importers (incoming edges) ahead of dependencies', () => {
        const candidates = selectCandidates({
            activeFile: 'src/a.ts',
            cursorLine: 0,
            recentFiles: [],
            neighbours: (file) => file === 'src/a.ts'
                ? [{ file: 'src/unrelated.ts', via: 'x', direction: 'out' }, { file: 'src/b.ts', via: 'reserve', direction: 'in' }]
                : [],
            read,
        });
        const order = candidates.map(c => c.file);
        expect(order.indexOf('src/b.ts')).toBeLessThan(order.indexOf('src/unrelated.ts'));
    });

    it('puts recently edited files ahead of graph neighbours', () => {
        const candidates = selectCandidates({
            activeFile: 'src/a.ts',
            cursorLine: 0,
            recentFiles: ['src/c.ts'],
            neighbours: () => [{ file: 'src/b.ts', via: 'reserve', direction: 'in' }],
            read,
        });
        const order = candidates.map(c => c.file);
        expect(order).toEqual(['src/a.ts', 'src/c.ts', 'src/b.ts']);
    });

    it('windows a neighbour around the symbol, not the head of the file', () => {
        const padded = [...Array(60).fill('// filler'), 'reserve(99);', ...Array(60).fill('// more')].join('\n');
        const candidates = selectCandidates(
            {
                activeFile: 'src/a.ts',
                cursorLine: 0,
                recentFiles: [],
                neighbours: () => [{ file: 'src/padded.ts', via: 'reserve', direction: 'in' }],
                read: (f) => (normalizePath(f) === 'src/padded.ts' ? padded : read(f)),
            },
            { neighbourWindow: 5 },
        );
        const neighbour = candidates.find(c => c.file === 'src/padded.ts');
        expect(neighbour?.text).toContain('reserve(99);');
        expect(neighbour?.startLine).toBeGreaterThan(50);
    });

    it('does not offer the same file twice', () => {
        const candidates = selectCandidates({
            activeFile: 'src/a.ts',
            cursorLine: 0,
            recentFiles: ['src/b.ts'],
            neighbours: () => [{ file: 'src/b.ts', via: 'reserve', direction: 'in' }],
            read,
        });
        expect(candidates.filter(c => c.file === 'src/b.ts')).toHaveLength(1);
    });

    it('skips files that cannot be read rather than offering an empty snippet', () => {
        const candidates = selectCandidates({
            activeFile: 'src/a.ts', cursorLine: 0, recentFiles: ['src/deleted.ts'], neighbours: () => [], read,
        });
        expect(candidates.map(c => c.file)).toEqual(['src/a.ts']);
    });

    it('honours the character budget, which is the latency budget in disguise', () => {
        const candidates = selectCandidates(
            { activeFile: 'src/a.ts', cursorLine: 0, recentFiles: ['src/b.ts', 'src/c.ts'], neighbours: () => [], read },
            { maxChars: FILE_A.length + 5 },
        );
        expect(candidates.map(c => c.file)).toEqual(['src/a.ts']);
    });
});

describe('buildNextEditPrompt', () => {
    it('offers a closed set of files and names the refusal token', () => {
        const prompt = buildNextEditPrompt({
            activeFile: 'src/a.ts',
            cursorLine: 4,
            history: [{ file: 'src/a.ts', startLine: 0, endLine: 0, removed: 'reserve', added: 'reserveStock', at: 1 }],
            candidates: [{ file: 'src/b.ts', startLine: 0, text: FILE_B, because: 'uses reserve' }],
        });

        expect(prompt).toContain(NO_EDIT);
        expect(prompt).toContain('FILE: src/b.ts');
        expect(prompt).toContain('+ reserveStock');
        expect(prompt).toContain('src/a.ts:5');
    });

    it('says so plainly when there is no history yet', () => {
        const prompt = buildNextEditPrompt({ activeFile: 'src/a.ts', cursorLine: 0, history: [], candidates: [] });
        expect(prompt).toContain('(none recorded yet)');
    });
});

// ─── Round trip ─────────────────────────────────────────────────────────────

describe('prompt → response → validated prediction', () => {
    it('carries a realistic rename through every stage', () => {
        const history = new EditHistory();
        history.record({
            file: 'src/a.ts', startLine: 0, endLine: 0,
            removed: 'export function reserve(id) {', added: 'export function reserveStock(id) {', at: 1_000,
        });

        const candidates = selectCandidates({
            activeFile: 'src/a.ts',
            cursorLine: 0,
            recentFiles: history.filesTouched(),
            neighbours: () => [{ file: 'src/b.ts', via: 'reserve', direction: 'in' }],
            read: (f) => ({ 'src/a.ts': FILE_A, 'src/b.ts': FILE_B } as any)[normalizePath(f)],
        });

        const prompt = buildNextEditPrompt({
            activeFile: 'src/a.ts', cursorLine: 0, history: history.recent(), candidates,
        });
        expect(prompt).toContain('src/b.ts');

        const parsed = parseProposal(proposal('src/b.ts', 'reserve(42);', 'reserveStock(42);'));
        expect(parsed).toBeDefined();

        const result = validateProposal(parsed!, {
            activeFile: 'src/a.ts',
            documents: new Map([['src/a.ts', FILE_A], ['src/b.ts', FILE_B]]),
            stamps: [{ file: 'src/b.ts', version: 1 }],
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.prediction.crossFile).toBe(true);
        // And it is still discarded if b.ts moved between prediction and application.
        expect(isStale(result.prediction.stamps, () => 2)).toBe(true);
    });
});

// ─── Edit origin ────────────────────────────────────────────────────────────

describe('agent writes are not developer edits', () => {
    beforeEach(() => resetEditOrigin());

    it('reports the agent as writing only inside the bracket', async () => {
        expect(agentIsWriting()).toBe(false);
        await asAgentEdit(async () => { expect(agentIsWriting()).toBe(true); });
        expect(agentIsWriting()).toBe(false);
    });

    it('counts overlapping writes, so one finishing does not clear the others', async () => {
        // The pipeline runs phases concurrently; a boolean would be cleared by whichever
        // write returned first while three more were still in flight.
        let innerSawWriting = false;
        await asAgentEdit(async () => {
            await asAgentEdit(async () => {});
            innerSawWriting = agentIsWriting();
        });
        expect(innerSawWriting).toBe(true);
        expect(agentIsWriting()).toBe(false);
    });

    it('does not stay stuck above zero when a write throws', async () => {
        // A leaked counter would disable next-edit for the rest of the session, in a way
        // nobody would connect to a file write that failed an hour earlier.
        await expect(asAgentEdit(async () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
        expect(agentIsWriting()).toBe(false);
    });

    it('keeps a grace window after the write, because the change event arrives later', () => {
        markAgentWrite(1_000);
        expect(withinAgentEditGrace(1_000 + AGENT_EDIT_GRACE_MS - 1)).toBe(true);
        expect(withinAgentEditGrace(1_000 + AGENT_EDIT_GRACE_MS + 1)).toBe(false);
    });

    it('is not within the grace window before any agent write', () => {
        expect(withinAgentEditGrace()).toBe(false);
    });
});
