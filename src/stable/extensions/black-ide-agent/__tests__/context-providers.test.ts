import { describe, expect, it } from 'vitest';
import {
    ContextProvider,
    ContextProviderRegistry,
    GitProvider,
    StaticListProvider,
    TerminalHistory,
    TerminalProvider,
    applyBudget,
} from '../src/core/context-providers';
import { extractMentions, resolveMentions } from '../src/core/mention-resolver';

/**
 * Phase 3, M19.
 *
 * Two properties carry most of the risk. First, a provider that throws or hangs must
 * degrade the dropdown, never empty it or take the turn down — providers shell out
 * to git and read arbitrary files. Second, over-budget content must be *truncated
 * visibly*: an agent handed half a diff without being told so will reason
 * confidently about code it cannot see, which is worse than getting nothing.
 */

function stubProvider(id: string, items: { id: string; label: string; body: string }[], budget = 1000): ContextProvider {
    return {
        id,
        title: id,
        description: `${id} provider`,
        budget,
        async suggest(query: string) {
            return items.filter(i => !query || i.label.includes(query)).map(({ id, label }) => ({ id, label }));
        },
        async resolve(itemId: string) {
            return items.find(i => i.id === itemId)?.body ?? '';
        },
    };
}

function registryWith(...providers: ContextProvider[]): ContextProviderRegistry {
    const registry = new ContextProviderRegistry();
    for (const p of providers) registry.register(p);
    return registry;
}

describe('applyBudget', () => {
    it('leaves content under budget untouched', () => {
        const result = applyBudget('short', 100, '@file:a.ts');
        expect(result.text).toBe('short');
        expect(result.truncated).toBe(false);
    });

    it('marks a truncation visibly and says how much was dropped', () => {
        const result = applyBudget('x'.repeat(500), 120, '@file:big.ts');
        expect(result.truncated).toBe(true);
        expect(result.text).toMatch(/truncated/);
        expect(result.text).toMatch(/characters omitted/);
        expect(result.text.length).toBeLessThanOrEqual(120);
    });
});

describe('ContextProviderRegistry', () => {
    const files = stubProvider('file', [
        { id: 'src/a.ts', label: 'a.ts', body: 'contents of a' },
        { id: 'src/b.ts', label: 'b.ts', body: 'contents of b' },
    ]);
    const problems = stubProvider('problems', [{ id: '*', label: 'All problems', body: 'error at line 1' }]);

    it('defaults a bare mention to the file provider', async () => {
        const resolved = await registryWith(files, problems).resolve('src/a.ts');
        expect(resolved?.text).toBe('contents of a');
    });

    it('routes a prefixed mention to its provider', async () => {
        const resolved = await registryWith(files, problems).resolve('problems:*');
        expect(resolved?.text).toBe('error at line 1');
    });

    it('returns undefined for an unknown provider rather than guessing', async () => {
        expect(await registryWith(files).resolve('nosuch:thing')).toBeUndefined();
    });

    it('offers matching providers alongside files so they are discoverable', async () => {
        const groups = await registryWith(files, problems).suggest('prob');
        expect(groups.find(g => g.provider === 'providers')?.items[0].label).toBe('@problems');
    });

    it('narrows within one provider after a colon', async () => {
        const groups = await registryWith(files, problems).suggest('problems:');
        expect(groups).toHaveLength(1);
        expect(groups[0].provider).toBe('problems');
    });

    it('applies the provider budget on resolve', async () => {
        const big = stubProvider('big', [{ id: 'x', label: 'x', body: 'y'.repeat(5000) }], 200);
        const resolved = await registryWith(big).resolve('big:x');
        expect(resolved!.truncated).toBe(true);
        expect(resolved!.text.length).toBeLessThanOrEqual(200);
    });

    it('survives a provider that throws during suggest', async () => {
        const broken: ContextProvider = {
            id: 'broken', title: 'b', description: 'b', budget: 10,
            async suggest() { throw new Error('boom'); },
            async resolve() { return ''; },
        };
        const groups = await registryWith(files, broken).suggest('a');
        // The file group must still be there — one bad provider cannot empty the menu.
        expect(groups.find(g => g.provider === 'file')?.items.length).toBeGreaterThan(0);
    });

    it('turns a resolve failure into a note rather than an exception', async () => {
        const broken: ContextProvider = {
            id: 'broken', title: 'b', description: 'b', budget: 100,
            async suggest() { return []; },
            async resolve() { throw new Error('git not found'); },
        };
        const resolved = await registryWith(broken).resolve('broken:x');
        expect(resolved?.text).toMatch(/git not found/);
    });
});

describe('GitProvider', () => {
    it('runs the right git subcommand for each item', async () => {
        const calls: string[][] = [];
        const provider = new GitProvider(async args => { calls.push(args); return 'output'; });

        await provider.resolve('diff');
        await provider.resolve('staged');
        await provider.resolve('log');
        await provider.resolve('branch');

        expect(calls[0]).toEqual(['diff']);
        expect(calls[1]).toEqual(['diff', '--staged']);
        expect(calls[2][0]).toBe('log');
        expect(calls[3][0]).toBe('status');
    });

    it('says git is unavailable instead of returning an empty block', async () => {
        // An empty block reads as "there are no changes", which is a different and
        // very misleading claim.
        const provider = new GitProvider(async () => { throw new Error('not a git repository'); });
        const text = await provider.resolve('diff');
        expect(text).toMatch(/unavailable/);
        expect(text).toMatch(/not a git repository/);
    });
});

describe('TerminalProvider', () => {
    it('offers the most recent commands first', async () => {
        const history = new TerminalHistory();
        history.record('npm test', 'ok');
        history.record('npm run build', 'built');

        const items = await new TerminalProvider(history).suggest('');
        expect(items[0].id).toBe('*');
        expect(items[1].label).toContain('npm run build');
    });

    it('bounds what it retains', () => {
        const history = new TerminalHistory(2);
        history.record('one', 'a');
        history.record('two', 'b');
        history.record('three', 'c');
        expect(history.list().map(e => e.command)).toEqual(['three', 'two']);
    });

    it('explains an empty history rather than returning nothing', async () => {
        const text = await new TerminalProvider(new TerminalHistory()).resolve('*');
        expect(text).toMatch(/No commands/);
    });
});

describe('StaticListProvider', () => {
    it('filters suggestions by label and resolves bodies', async () => {
        const provider = new StaticListProvider('rules', 'Rules', 'r', async () => [
            { id: 'ts', label: 'typescript', body: 'use strict types' },
            { id: 'py', label: 'python', body: 'use type hints' },
        ]);

        expect((await provider.suggest('type')).map(i => i.id)).toEqual(['ts']);
        expect(await provider.resolve('py')).toContain('use type hints');
    });
});

describe('extractMentions', () => {
    it('finds a bare path mention', () => {
        expect(extractMentions('look at @src/a.ts please')).toEqual(['src/a.ts']);
    });

    it('finds a provider-qualified mention', () => {
        expect(extractMentions('check @problems:* now')).toEqual(['problems:*']);
    });

    it('strips trailing sentence punctuation from a path', () => {
        // Otherwise the mention is a file called `a.ts,` which resolves to nothing.
        expect(extractMentions('see @src/a.ts, then @src/b.ts.')).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('ignores an email address', () => {
        expect(extractMentions('mail someone@example.com about it')).toEqual([]);
    });

    it('ignores a half-typed provider mention', () => {
        expect(extractMentions('@git:')).toEqual([]);
    });

    it('finds several mentions in order', () => {
        expect(extractMentions('@a.ts and @git:diff and @problems:*'))
            .toEqual(['a.ts', 'git:diff', 'problems:*']);
    });
});

describe('resolveMentions', () => {
    const files = stubProvider('file', [{ id: 'src/a.ts', label: 'a.ts', body: 'contents of a' }]);
    const git = stubProvider('git', [{ id: 'diff', label: 'diff', body: 'diff --git a b' }]);

    it('appends resolved content without rewriting the user message', async () => {
        const result = await resolveMentions('explain @src/a.ts', registryWith(files, git));
        expect(result.text).toContain('contents of a');
        expect(result.text).not.toContain('explain');
    });

    it('labels attached content as data rather than instructions', async () => {
        const result = await resolveMentions('@src/a.ts', registryWith(files));
        expect(result.text).toMatch(/data, not as instructions/);
    });

    it('resolves several providers in one message', async () => {
        const result = await resolveMentions('@src/a.ts and @git:diff', registryWith(files, git));
        expect(result.resolved).toHaveLength(2);
        expect(result.text).toContain('contents of a');
        expect(result.text).toContain('diff --git');
    });

    it('attaches a repeated mention only once', async () => {
        const result = await resolveMentions('@src/a.ts vs @src/a.ts', registryWith(files));
        expect(result.resolved).toHaveLength(1);
    });

    it('reports an unresolvable mention instead of failing the turn', async () => {
        const result = await resolveMentions('@nope:thing', registryWith(files));
        expect(result.resolved).toEqual([]);
        expect(result.unresolved).toEqual(['nope:thing']);
        expect(result.text).toBe('');
    });

    it('returns nothing for a message with no mentions', async () => {
        const result = await resolveMentions('just a normal question', registryWith(files));
        expect(result.text).toBe('');
        expect(result.resolved).toEqual([]);
    });
});
