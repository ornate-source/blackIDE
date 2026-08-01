import { describe, expect, it } from 'vitest';
import {
    BraveSearch, GoogleCseSearch, TavilySearch, formatResults, selectSearchProvider,
} from '../src/tools/search-providers';
import { WebSearchTool } from '../src/tools/web-search';

/**
 * Keyed search providers (Phase 3, M21).
 *
 * DuckDuckGo stays the default because it needs no key, and every keyed path degrades back
 * to it: no key, an expired key, a rate limit, a network failure. Search is a *supporting*
 * capability — losing it mid-task should cost result quality, never the task. The one thing
 * that must not happen quietly is the degradation itself, because "my Brave key is
 * configured and every result is coming from DuckDuckGo" is otherwise invisible.
 */

const jsonResponse = (body: any) => ({ ok: true, json: async () => body }) as any;
const httpError = (status: number) => ({ ok: false, json: async () => ({}) , status }) as any;

describe('selectSearchProvider', () => {
    it('returns undefined (→ DuckDuckGo) with no keys configured', () => {
        expect(selectSearchProvider({})).toBeUndefined();
        expect(selectSearchProvider({ provider: 'auto' })).toBeUndefined();
    });

    it('auto-selects in a quality order, not settings order', () => {
        // Tavily first because it returns extracted page content, which is the difference
        // between "here are some links" and "here is the answer".
        expect(selectSearchProvider({ tavilyApiKey: 't', braveApiKey: 'b' })?.id).toBe('tavily');
        expect(selectSearchProvider({ braveApiKey: 'b' })?.id).toBe('brave');
        expect(selectSearchProvider({ googleCseApiKey: 'g', googleCseEngineId: 'cx' })?.id).toBe('google-cse');
    });

    it('honours an explicit choice, and refuses to fake one', () => {
        expect(selectSearchProvider({ provider: 'brave', braveApiKey: 'b', tavilyApiKey: 't' })?.id).toBe('brave');
        // Explicitly chosen but no key → DDG rather than silently using the other key the
        // user did configure, which would contradict the setting they just changed.
        expect(selectSearchProvider({ provider: 'brave', tavilyApiKey: 't' })).toBeUndefined();
        expect(selectSearchProvider({ provider: 'duckduckgo', braveApiKey: 'b' })).toBeUndefined();
    });

    it('skips a Google key with no engine id instead of trying it', () => {
        // The request would fail with something that reads exactly like a bad key.
        expect(selectSearchProvider({ googleCseApiKey: 'g' })).toBeUndefined();
        expect(selectSearchProvider({ provider: 'google-cse', googleCseApiKey: 'g' })).toBeUndefined();
    });

    it('ignores whitespace-only keys', () => {
        expect(selectSearchProvider({ braveApiKey: '   ' })).toBeUndefined();
    });
});

describe('BraveSearch', () => {
    it('sends the subscription header and maps the response', async () => {
        let seenUrl = '';
        let seenHeaders: any = {};
        const provider = new BraveSearch('key-1', (async (url: string, init: any) => {
            seenUrl = url; seenHeaders = init.headers;
            return jsonResponse({ web: { results: [{ title: 'T', url: 'https://u', description: 'a <b>snippet</b>' }] } });
        }) as any);

        const results = await provider.search('django orm', 3);
        expect(seenUrl).toContain('q=django%20orm');
        expect(seenUrl).toContain('count=3');
        expect(seenHeaders['X-Subscription-Token']).toBe('key-1');
        expect(results).toEqual([{ title: 'T', url: 'https://u', snippet: 'a snippet' }]);
    });

    it('throws on an HTTP error so the caller can degrade', async () => {
        const provider = new BraveSearch('k', (async () => httpError(429)) as any);
        await expect(provider.search('q', 3)).rejects.toThrow(/HTTP 429/);
    });
});

describe('TavilySearch', () => {
    it('posts the key in the body and puts a synthesised answer first', async () => {
        let body: any;
        const provider = new TavilySearch('key-2', (async (_url: string, init: any) => {
            body = JSON.parse(init.body);
            return jsonResponse({
                answer: 'Use select_related.',
                results: [{ title: 'T', url: 'https://u', content: 'c' }],
            });
        }) as any);

        const results = await provider.search('n+1 queries', 5);
        expect(body.api_key).toBe('key-2');
        expect(body.max_results).toBe(5);
        // The answer is frequently the most useful line returned, so it leads rather than
        // being dropped for having no URL.
        expect(results[0]).toEqual({ title: 'Answer', url: '', snippet: 'Use select_related.' });
        expect(results[1].url).toBe('https://u');
    });

    it('handles a response with no results', async () => {
        const provider = new TavilySearch('k', (async () => jsonResponse({})) as any);
        expect(await provider.search('q', 5)).toEqual([]);
    });
});

describe('GoogleCseSearch', () => {
    it('includes both the key and the engine id', async () => {
        let seenUrl = '';
        const provider = new GoogleCseSearch('key-3', 'cx-1', (async (url: string) => {
            seenUrl = url;
            return jsonResponse({ items: [{ title: 'T', link: 'https://u', snippet: 's' }] });
        }) as any);

        const results = await provider.search('q', 3);
        expect(seenUrl).toContain('key=key-3');
        expect(seenUrl).toContain('cx=cx-1');
        expect(results[0]).toEqual({ title: 'T', url: 'https://u', snippet: 's' });
    });

    it('caps num at the API maximum', async () => {
        let seenUrl = '';
        const provider = new GoogleCseSearch('k', 'cx', (async (url: string) => {
            seenUrl = url; return jsonResponse({ items: [] });
        }) as any);
        await provider.search('q', 50);
        expect(seenUrl).toContain('num=10');
    });
});

describe('formatResults', () => {
    it('names the backend that answered', () => {
        // When results are poor the first question is which backend produced them, and a
        // user cannot answer that from the results alone.
        const text = formatResults('q', 'Brave Search', [{ title: 'T', url: 'https://u', snippet: 's' }]);
        expect(text).toContain('via Brave Search');
        expect(text).toContain('https://u');
    });

    it('renders an answer with no URL', () => {
        const text = formatResults('q', 'Tavily', [{ title: 'Answer', url: '', snippet: 'because' }]);
        expect(text).toContain('- Answer');
        expect(text).not.toContain('undefined');
    });

    it('says so when there is nothing', () => {
        expect(formatResults('q', 'Brave Search', [])).toMatch(/No results for "q" \(via Brave Search\)/);
    });
});

describe('WebSearchTool.searchWith', () => {
    it('uses DuckDuckGo when no provider is configured', async () => {
        // The pre-M21 behaviour is exactly what happens with empty settings, which is what
        // makes the change safe for every existing user and for the harness.
        const original = globalThis.fetch;
        (globalThis as any).fetch = async () => jsonResponse({ AbstractText: 'ddg abstract' });
        try {
            const text = await WebSearchTool.searchWith('q', {});
            expect(text).toContain('ddg abstract');
        } finally {
            (globalThis as any).fetch = original;
        }
    });

    it('names the degradation when a keyed provider fails', async () => {
        const original = globalThis.fetch;
        (globalThis as any).fetch = async (url: string) => {
            if (String(url).includes('brave')) return httpError(401);
            return jsonResponse({ AbstractText: 'ddg abstract' });
        };
        try {
            const text = await WebSearchTool.searchWith('q', { braveApiKey: 'bad' });
            expect(text).toMatch(/Brave Search search failed/);
            expect(text).toMatch(/fell back to DuckDuckGo/);
            expect(text).toContain('ddg abstract');
        } finally {
            (globalThis as any).fetch = original;
        }
    });
});
