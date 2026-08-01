import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { CodebaseIndex } from '../src/core/codebase-index';
import { SymbolGraph, SymbolProvider } from '../src/core/context-providers';
import { buildContextProviders } from '../src/core/context-provider-setup';

/**
 * `@symbol` — the provider M19 shipped without (Phase 3).
 *
 * Two things are worth asserting and one is worth asserting *against a real index*.
 * Cheap: the ranking (exact before prefix before substring — a dropdown that buries
 * the exact match makes typing the full name useless) and the cold-graph wording
 * ("the index is not built" and "no such symbol" have different fixes and look
 * identical to a model). Expensive but necessary: that resolution returns the
 * definition's *own* lines and its callers from the corpus, which is the whole reason
 * to have this provider rather than telling the user to `@file` the file.
 */

const CORPUS = path.join(__dirname, '..', 'eval', 'retrieval-corpus');
const stub = vscode as any;

/** A graph with no files — the state during activation, before the first turn. */
const coldGraph: SymbolGraph = {
    fileCount: 0,
    searchSymbols: () => [],
    definitionsOf: () => [],
    referencesOf: () => [],
};

describe('SymbolProvider with a cold index', () => {
    const provider = new SymbolProvider(() => coldGraph);

    it('offers nothing rather than throwing', async () => {
        expect(await provider.suggest('convert')).toEqual([]);
    });

    it('says the index is not built, not that the symbol is missing', async () => {
        const text = await provider.resolve('convertMinor|src/a.ts|10');
        expect(text).toMatch(/not built yet/);
        expect(text).not.toMatch(/no definition/);
    });

    it('handles an absent graph the same way', async () => {
        const text = await new SymbolProvider(() => undefined).resolve('x|y|1');
        expect(text).toMatch(/not built yet/);
    });

    it('reports an unparseable id rather than guessing', async () => {
        const warm: SymbolGraph = { ...coldGraph, fileCount: 3 };
        expect(await new SymbolProvider(() => warm).resolve('garbage')).toMatch(/unrecognised/);
    });
});

describe('SymbolProvider against the retrieval corpus', () => {
    let index: CodebaseIndex;
    let storage: string;
    let previousFolders: unknown;
    let provider: SymbolProvider;

    beforeAll(async () => {
        previousFolders = stub.workspace.workspaceFolders;
        stub.workspace.workspaceFolders = [{ uri: { fsPath: CORPUS }, name: 'corpus', index: 0 }];
        storage = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-symbol-'));
        index = new CodebaseIndex(storage);
        await index.build(undefined, 2000);
        provider = new SymbolProvider(() => index.graph);
    });

    afterAll(() => {
        stub.workspace.workspaceFolders = previousFolders;
        fs.rmSync(storage, { recursive: true, force: true });
    });

    it('indexed the corpus', () => {
        expect(index.graph.fileCount).toBeGreaterThan(50);
        expect(index.graph.symbolCount).toBeGreaterThan(50);
    });

    it('ranks the exact match first', async () => {
        const items = await provider.suggest('convertMinor');
        expect(items.length).toBeGreaterThan(0);
        expect(items[0].label).toBe('convertMinor');
    });

    it('finds symbols by substring and names the file and kind', async () => {
        const items = await provider.suggest('convert');
        expect(items.some(i => i.label === 'convertMinor')).toBe(true);
        const found = items.find(i => i.label === 'convertMinor')!;
        expect(found.detail).toMatch(/\.ts:\d+$/);
        // The id carries file and line, so resolution cannot land on a different
        // same-named symbol than the one that was picked.
        expect(found.id.split('|')).toHaveLength(3);
    });

    it('offers something for an empty query, broadest symbols first', async () => {
        const items = await provider.suggest('');
        expect(items.length).toBeGreaterThan(0);
        // Containers (no parent) rank above members, so the first page is orienting
        // rather than an arbitrary slice of methods.
        expect(items[0].detail).not.toMatch(/ in /);
    });

    it('is deterministic across identical queries', async () => {
        const a = await provider.suggest('order');
        const b = await provider.suggest('order');
        expect(a.map(i => i.id)).toEqual(b.map(i => i.id));
    });

    it('resolves to the definition body, not the whole file', async () => {
        const items = await provider.suggest('convertMinor');
        const text = await provider.resolve(items[0].id);

        expect(text).toMatch(/--- symbol convertMinor \(/);
        expect(text).toMatch(/convertMinor/);

        const [, file] = items[0].id.split('|');
        const whole = fs.readFileSync(path.join(CORPUS, file), 'utf8');
        // The point of the provider: a slice, not the file the budget would truncate.
        expect(text.length).toBeLessThan(whole.length);
    });

    it('lists the files that reference the symbol, and says the list is name-matched', async () => {
        const items = await provider.suggest('convertMinor');
        const text = await provider.resolve(items[0].id);
        expect(text).toMatch(/referenced in \d+ other file/);
        // M15's design position is name-keyed, not binding-keyed. Saying so is what
        // stops a model treating an over-approximation as resolved truth.
        expect(text).toMatch(/not binding-resolved/);
        expect(text).toMatch(/find_references/);
    });

    it('never returns the definition of a symbol in a file it does not live in', async () => {
        const items = await provider.suggest('convertMinor');
        const [name, file] = items[0].id.split('|');
        const text = await provider.resolve(`${name}|${file}|999999`);
        // A stale line number (the file was edited since the dropdown opened) falls back
        // to the same file, not to a same-named symbol somewhere else.
        expect(text).toMatch(new RegExp(`--- symbol ${name}.*${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    });
});

describe('the provider is registered', () => {
    it('buildContextProviders exposes @symbol alongside the other eight', () => {
        const registry = buildContextProviders({
            getRules: () => [],
            getSkills: () => [],
            historyStore: { getThreads: () => [], getConversationState: () => [] } as any,
            terminalHistory: { list: () => [], record: () => {} } as any,
            workspaceRoot: () => undefined,
            codeGraph: () => coldGraph,
            docSets: async () => [],
            searchDocs: async () => [],
            searchWeb: async () => '',
        });
        expect(registry.get('symbol')).toBeDefined();
        // The **complete** M19 set: `@docs` and `@web` landed with M20/M21 on 2026-08-01,
        // so every provider the roadmap named is now registered.
        const ids = registry.list().map(p => p.id).sort();
        expect(ids).toEqual([
            'docs', 'file', 'folder', 'git', 'past-chats', 'problems', 'rules', 'skills', 'symbol', 'terminal', 'web',
        ]);
    });
});
