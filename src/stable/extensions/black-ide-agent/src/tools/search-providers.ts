// ─── Keyed search providers (Phase 3, M21) ──────────────────────────────────
//
// `web-search.ts` scrapes DuckDuckGo's HTML endpoint. That works with no key, which is
// why it stays the default, but it is a scrape: it returns titles and snippets at the
// mercy of a markup change, and it has no ranking we control. Brave, Tavily and Google
// CSE return structured JSON, and Tavily returns page *content* rather than snippets,
// which is the difference between "here are some links" and "here is the answer".
//
// ── Shape of the abstraction ─────────────────────────────────────────────────
// One `SearchProvider` per backend, each turning its own JSON into the same
// `SearchResult[]`. Formatting for the model happens once, in `formatResults`, so a new
// provider cannot accidentally invent its own output format — the agent has to learn one
// shape, not four.
//
// ── Degradation is the whole design ──────────────────────────────────────────
// Every keyed provider falls back to DDG: no key configured, an expired key, a rate
// limit, a network failure. Search is a *supporting* capability — an agent that loses it
// mid-task should get worse results, never a failed task. The fallback is announced in the
// output so a user debugging "why are these results bad?" can see which backend answered.

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    /** Full page text, when the provider returns it (Tavily does). */
    content?: string;
}

export interface SearchProvider {
    readonly id: 'brave' | 'tavily' | 'google-cse' | 'duckduckgo';
    readonly label: string;
    /** False for DDG — it is the no-key default. */
    readonly needsKey: boolean;
    search(query: string, limit: number): Promise<SearchResult[]>;
}

type FetchLike = typeof fetch;

const DEFAULT_LIMIT = 6;
const TIMEOUT_MS = 10_000;

/** Every keyed provider gets the same timeout: a slow search is a stalled agent turn. */
async function getJson(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

export class BraveSearch implements SearchProvider {
    readonly id = 'brave' as const;
    readonly label = 'Brave Search';
    readonly needsKey = true;

    constructor(private readonly apiKey: string, private readonly fetchImpl: FetchLike = fetch) {}

    async search(query: string, limit = DEFAULT_LIMIT): Promise<SearchResult[]> {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
        const data = await getJson(this.fetchImpl, url, {
            headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey },
        });
        return (data?.web?.results || []).slice(0, limit).map((r: any) => ({
            title: String(r.title || ''),
            url: String(r.url || ''),
            snippet: stripTags(String(r.description || '')),
        }));
    }
}

export class TavilySearch implements SearchProvider {
    readonly id = 'tavily' as const;
    readonly label = 'Tavily';
    readonly needsKey = true;

    constructor(private readonly apiKey: string, private readonly fetchImpl: FetchLike = fetch) {}

    async search(query: string, limit = DEFAULT_LIMIT): Promise<SearchResult[]> {
        const data = await getJson(this.fetchImpl, 'https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: this.apiKey,
                query,
                max_results: limit,
                // Tavily's differentiator: extracted page text. Worth asking for, because a
                // snippet often omits the one version-specific detail the question is about.
                include_raw_content: false,
                search_depth: 'basic',
            }),
        });
        const results = (data?.results || []).slice(0, limit).map((r: any) => ({
            title: String(r.title || ''),
            url: String(r.url || ''),
            snippet: stripTags(String(r.content || '')).slice(0, 400),
            content: r.raw_content ? stripTags(String(r.raw_content)) : undefined,
        }));
        // Tavily can synthesise an answer; it goes first as a result with no URL rather
        // than being dropped, because it is frequently the most useful line returned.
        if (data?.answer) {
            results.unshift({ title: 'Answer', url: '', snippet: stripTags(String(data.answer)) });
        }
        return results;
    }
}

export class GoogleCseSearch implements SearchProvider {
    readonly id = 'google-cse' as const;
    readonly label = 'Google Custom Search';
    readonly needsKey = true;

    constructor(
        private readonly apiKey: string,
        /** The Programmable Search engine id (`cx`). Without it the key is unusable. */
        private readonly engineId: string,
        private readonly fetchImpl: FetchLike = fetch,
    ) {}

    async search(query: string, limit = DEFAULT_LIMIT): Promise<SearchResult[]> {
        const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(this.apiKey)}`
            + `&cx=${encodeURIComponent(this.engineId)}&q=${encodeURIComponent(query)}&num=${Math.min(10, limit)}`;
        const data = await getJson(this.fetchImpl, url);
        return (data?.items || []).slice(0, limit).map((r: any) => ({
            title: String(r.title || ''),
            url: String(r.link || ''),
            snippet: stripTags(String(r.snippet || '')),
        }));
    }
}

/** Settings shape for search. Keys live in `SecretStorage`, never in settings.json (G2). */
export interface SearchSettings {
    provider?: 'auto' | 'brave' | 'tavily' | 'google-cse' | 'duckduckgo';
    braveApiKey?: string;
    tavilyApiKey?: string;
    googleCseApiKey?: string;
    googleCseEngineId?: string;
}

/** Picks the search fields out of the general-settings blob. Pure, so both the
 *  extension host and the chat task can use it without duplicating key names. */
export function pickSearchSettings(settings: any): SearchSettings {
    return {
        provider: settings?.searchProvider,
        braveApiKey: settings?.braveApiKey,
        tavilyApiKey: settings?.tavilyApiKey,
        googleCseApiKey: settings?.googleCseApiKey,
        googleCseEngineId: settings?.googleCseEngineId,
    };
}

/**
 * The provider to use, or undefined for "DuckDuckGo".
 *
 * `auto` (the default) picks the first provider that has a *usable* key, in an order that
 * is a judgement about output quality for a coding agent: Tavily returns extracted content,
 * Brave returns clean structured results, Google CSE needs two settings and is capped at
 * 100 free queries a day. A key that is present but unusable — a Google key with no engine
 * id — is skipped rather than tried, because the failure would look like a bad key.
 */
export function selectSearchProvider(settings: SearchSettings, fetchImpl: FetchLike = fetch): SearchProvider | undefined {
    const choice = settings.provider || 'auto';
    const brave = settings.braveApiKey?.trim();
    const tavily = settings.tavilyApiKey?.trim();
    const googleKey = settings.googleCseApiKey?.trim();
    const googleCx = settings.googleCseEngineId?.trim();

    if (choice === 'duckduckgo') return undefined;
    if (choice === 'brave') return brave ? new BraveSearch(brave, fetchImpl) : undefined;
    if (choice === 'tavily') return tavily ? new TavilySearch(tavily, fetchImpl) : undefined;
    if (choice === 'google-cse') return googleKey && googleCx ? new GoogleCseSearch(googleKey, googleCx, fetchImpl) : undefined;

    if (tavily) return new TavilySearch(tavily, fetchImpl);
    if (brave) return new BraveSearch(brave, fetchImpl);
    if (googleKey && googleCx) return new GoogleCseSearch(googleKey, googleCx, fetchImpl);
    return undefined;
}

/**
 * One output format for every provider, including DDG.
 *
 * `provider` is named in the header on purpose: when results are poor, the first question
 * is which backend produced them, and a user cannot answer that from the results alone.
 */
export function formatResults(query: string, provider: string, results: SearchResult[], note?: string): string {
    if (!results.length) {
        return `No results for "${query}" (via ${provider}).${note ? ` ${note}` : ''}`;
    }
    const lines = results.map(r => {
        const head = r.url ? `- ${r.title}\n   ${r.url}` : `- ${r.title}`;
        const body = r.snippet ? `\n   ${r.snippet.slice(0, 400)}` : '';
        return head + body;
    });
    return `Web results for "${query}" (via ${provider})${note ? ` — ${note}` : ''}:\n${lines.join('\n')}`;
}

function stripTags(value: string): string {
    return value
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
