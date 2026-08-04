import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
    CANNOT_APPLY, buildApplyPrompt, changedFraction, countBlocks, extractBlocks, verifyFastApply,
} from '@blackide/agent-core/core/fast-apply';
import { ToolRunner } from '../src/tools/tool-runner';
import { AgentToolExecutor, ExecutorDeps } from '../src/agent/tool-executor';

/**
 * Phase 4, M25 — fast-apply.
 *
 * The gate is **zero silently wrong edits**, so these tests are almost entirely about
 * refusal. A fast-apply path that is 99% correct is worse than none: the 1% is a wrong
 * edit in a file the user did not read. Verification therefore runs the *real* applier —
 * a second implementation of the matching rules would be a second set of rules, and the
 * only rules that matter are the ones that write to disk.
 */

const apply = (content: string, blocks: string) => ToolRunner.applySearchReplace(content, blocks);

const FILE = [
    'export function withRetry(fn, attempts = 3) {',
    '    let lastError;',
    '    for (let i = 0; i < attempts; i++) {',
    '        try { return fn(); } catch (e) { lastError = e; }',
    '    }',
    '    throw lastError;',
    '}',
    '',
    'export function noop() {}',
].join('\n');

const block = (original: string, updated: string) =>
    `<<<<<<< ORIGINAL\n${original}\n=======\n${updated}\n>>>>>>> UPDATED`;

describe('verifyFastApply accepts a correct, bounded edit', () => {
    it('returns the content the blocks produce', () => {
        const result = verifyFastApply(
            FILE,
            block('export function withRetry(fn, attempts = 3) {', 'export function withRetry(fn, attempts = 3, jitter = 0.1) {'),
            apply,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.updated).toContain('jitter = 0.1');
        expect(result.blocks).toBe(1);
        // Verification must not mutate the input.
        expect(FILE).not.toContain('jitter');
    });

    it('counts multiple blocks', () => {
        const blocks = [
            block('    let lastError;', '    let lastError = undefined;'),
            block('export function noop() {}', 'export function noop() { return; }'),
        ].join('\n');
        const result = verifyFastApply(FILE, blocks, apply);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.blocks).toBe(2);
        expect(countBlocks(blocks)).toBe(2);
    });
});

describe('verifyFastApply refuses everything it cannot prove', () => {
    it('refuses an anchor that is not in the file', () => {
        const result = verifyFastApply(FILE, block('function retryOnce() {', 'x'), apply);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.kind).toBe('anchor-missing');
    });

    it('refuses an ambiguous anchor', () => {
        // The exact-match contract requires uniqueness; two candidate sites means the model
        // does not know which one it is editing, and neither do we.
        const duplicated = 'a();\nb();\na();\n';
        const result = verifyFastApply(duplicated, block('a();', 'c();'), apply);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.kind).toBe('anchor-ambiguous');
    });

    it('refuses malformed blocks', () => {
        const result = verifyFastApply(FILE, '<<<<<<< ORIGINAL\nlet lastError;\n', apply);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.kind).toBe('malformed');
    });

    it('refuses an edit that changes nothing', () => {
        // Applied cleanly and produced no change: the model matched an anchor and echoed it
        // back. Reporting success here would report an edit that never happened.
        const result = verifyFastApply(FILE, block('    let lastError;', '    let lastError;'), apply);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.kind).toBe('no-change');
    });

    it('refuses an edit that rewrites most of the file', () => {
        /*
         * The failure exact-match verification cannot catch on its own: a cheap model asked
         * for a small change sometimes returns the *whole file* as one block. It applies
         * cleanly and verifies cleanly — the model's copy genuinely matches — and quietly
         * reformats everything. The churn bound is what catches it.
         */
        const rewritten = FILE.split('\n').map(l => l.replace(/ {4}/g, '\t')).join('\n');
        const result = verifyFastApply(FILE, block(FILE, rewritten), apply);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.kind).toBe('oversized');
        expect(result.reason).toMatch(/rewrites \d+%/);
    });

    it('lets the caller widen the churn bound deliberately', () => {
        const rewritten = FILE.replace('noop', 'noOp');
        const result = verifyFastApply(FILE, block(FILE, rewritten), apply, { maxRewriteFraction: 1 });
        expect(result.ok).toBe(true);
    });

    it('reports the reason in one line, usable in a retry prompt', () => {
        const result = verifyFastApply(FILE, block('nope', 'x'), apply);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason.split('\n')).toHaveLength(1);
        expect(result.reason.length).toBeLessThanOrEqual(300);
    });
});

describe('changedFraction', () => {
    it('is 0 for identical content and 1 for a total rewrite', () => {
        expect(changedFraction('a\nb', 'a\nb')).toBe(0);
        expect(changedFraction('a\nb', 'c\nd')).toBe(1);
    });

    it('scales with the number of changed lines', () => {
        expect(changedFraction('a\nb\nc\nd', 'a\nb\nc\nZ')).toBeCloseTo(0.25);
    });

    it('is blind to pure reordering — a known limit of the line-multiset measure', () => {
        // Recorded rather than papered over: a block moved verbatim scores 0 churn, so the
        // oversized bound will not catch a pure reorder. It is not the defence against that
        // — `applySearchReplace`'s uniqueness rule is, since moving code means matching an
        // anchor that appears in both places. A real diff would score it, at more cost than
        // this bound is worth.
        expect(changedFraction('a\nb\nc', 'c\nb\na')).toBe(0);
    });

    it('handles growth and shrinkage without dividing by zero', () => {
        expect(changedFraction('', '')).toBe(0);
        expect(changedFraction('a', 'a\nb\nc')).toBeCloseTo(2 / 3);
    });
});

describe('extractBlocks', () => {
    it('pulls blocks out of a response wrapped in prose or fences', () => {
        const response = ['Sure, here you go:', '```', block('noop', 'noOp'), '```', 'Let me know!'].join('\n');
        expect(extractBlocks(response)).toBe(block('noop', 'noOp'));
    });

    it('returns undefined for the explicit refusal token', () => {
        expect(extractBlocks(`I cannot do this. ${CANNOT_APPLY}`)).toBeUndefined();
    });

    it('returns undefined — not an empty string — when there are no markers', () => {
        // "The model refused" and "the model produced an empty edit" must stay
        // distinguishable at the call site.
        expect(extractBlocks('Here is the code you asked for.')).toBeUndefined();
        expect(extractBlocks('')).toBeUndefined();
    });

    it('ignores a stray trailing marker order', () => {
        expect(extractBlocks('>>>>>>> UPDATED\n<<<<<<< ORIGINAL')).toBeUndefined();
    });
});

describe('buildApplyPrompt', () => {
    it('states the format, the uniqueness rule, and the refusal token', () => {
        const prompt = buildApplyPrompt('src/a.ts', FILE, 'add a jitter argument');
        expect(prompt).toContain('<<<<<<< ORIGINAL');
        expect(prompt).toContain('EXACTLY once');
        expect(prompt).toContain(CANNOT_APPLY);
        expect(prompt).toContain('src/a.ts');
        expect(prompt).toContain('add a jitter argument');
    });

    it('includes the file without line numbers', () => {
        // A model handed numbered lines copies them into the anchor, which then matches
        // nothing — a failure that looks like the model being bad at copying.
        const prompt = buildApplyPrompt('src/a.ts', FILE, 'x');
        expect(prompt).not.toMatch(/^\s*1[:|]/m);
        expect(prompt).toContain(FILE);
    });
});

/**
 * The executor path (Phase 4, M25).
 *
 * `edit_file` gained an `intent` parameter rather than a second tool: a new tool name would
 * have to be added to thirteen mode allowlists, and the Phase 1 trap is that a tool missing
 * from one is silently never offered. What matters here is that a refusal reaches disk as
 * *nothing* and reaches the model as an instruction it can act on.
 */
describe('edit_file intent handling', () => {
    // A real workspace on disk: `edit_file` reads the file before it decides how to edit
    // it, so this path cannot be exercised against a stub root.
    let root: string;
    let previousFolders: unknown;

    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-fastapply-'));
        fs.writeFileSync(path.join(root, 'a.ts'), FILE, 'utf8');
        previousFolders = (vscode as any).workspace.workspaceFolders;
        (vscode as any).workspace.workspaceFolders = [{ uri: { fsPath: root }, name: 'fa', index: 0 }];
    });

    afterAll(() => {
        (vscode as any).workspace.workspaceFolders = previousFolders;
        fs.rmSync(root, { recursive: true, force: true });
    });

    const deps = (over: Partial<ExecutorDeps>): ExecutorDeps => ({
        mode: 'agent',
        rootPath: root,
        browserTool: {} as any,
        mcpClient: {} as any,
        artifactManager: {} as any,
        knowledgeStore: {} as any,
        codebaseIndex: {} as any,
        checkpoint: { snapshot: () => {} } as any,
        log: () => {},
        approve: async () => true,
        ...over,
    });

    const call = (args: any) => ({ id: 't1', name: 'edit_file', arguments: args }) as any;

    it('refuses intent with no apply model, and says what to do instead', async () => {
        const exec = new AgentToolExecutor(deps({}));
        const r = await exec.execute(call({ path: 'a.ts', intent: 'rename the helper' }));
        expect(r.isError).toBe(true);
        expect(r.content).toMatch(/No apply model is configured/);
        expect(r.content).toMatch(/search_replace_blocks/);
        // Nothing was written.
        expect(fs.readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe(FILE);
    });

    it('hands a refusal back to the strong model with the reason', async () => {
        // The escalation path *is* the error return: this tool is called by the strong
        // model, so "fast apply could not do it exactly — send me blocks" lands in exactly
        // the right place and costs one turn. No unverified edit can reach disk.
        const exec = new AgentToolExecutor(deps({
            fastApply: async () => ({ ok: false, kind: 'anchor-missing', reason: 'anchor not found' }),
        }));
        const r = await exec.execute(call({ path: 'a.ts', intent: 'rename the helper' }));
        expect(r.isError).toBe(true);
        expect(r.content).toMatch(/anchor-missing/);
        expect(r.content).toMatch(/anchor not found/);
        expect(r.content).toMatch(/Call edit_file again with explicit search_replace_blocks/);
        expect(fs.readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe(FILE);
    });

    it('writes the verified content when fast apply succeeds', async () => {
        const updated = FILE.replace('noop', 'noOp');
        const exec = new AgentToolExecutor(deps({
            fastApply: async () => ({ ok: true, updated, blocks: 1 }),
        }));
        const r = await exec.execute(call({ path: 'a.ts', intent: 'rename noop' }));
        expect(r.isError).toBeFalsy();
        expect(fs.readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe(updated);
        fs.writeFileSync(path.join(root, 'a.ts'), FILE, 'utf8');
    });

    it('does not consult the apply model when blocks were supplied', async () => {
        let called = false;
        const exec = new AgentToolExecutor(deps({
            fastApply: async () => { called = true; return { ok: false, kind: 'malformed', reason: 'x' }; },
        }));
        await exec.execute(call({ path: 'a.ts', search_replace_blocks: block('export function noop() {}', 'export function noOp() {}') }));
        expect(called).toBe(false);
        fs.writeFileSync(path.join(root, 'a.ts'), FILE, 'utf8');
    });
});
