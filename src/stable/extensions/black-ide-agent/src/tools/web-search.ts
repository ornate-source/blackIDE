// Web Search Tool — Feature 10
// Uses DuckDuckGo instant answer API (no API key required) for web search.

export class WebSearchTool {

    /**
     * Search the web using DuckDuckGo instant answer API.
     * No API key required — free and privacy-respecting.
     */
    static async search(query: string): Promise<string> {
        const encoded = encodeURIComponent(query);
        const url = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`;

        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Search failed: HTTP ${response.status}`);

            const data: any = await response.json();
            const results: string[] = [];

            // Abstract/summary
            if (data.AbstractText) {
                results.push(`📖 Summary: ${data.AbstractText}`);
                if (data.AbstractURL) {
                    results.push(`   Source: ${data.AbstractURL}`);
                }
            }

            // Answer (for factual queries)
            if (data.Answer) {
                results.push(`✅ Answer: ${data.Answer}`);
            }

            // Definition
            if (data.Definition) {
                results.push(`📝 Definition: ${data.Definition}`);
            }

            // Related topics
            if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
                const topics = data.RelatedTopics.slice(0, 5);
                for (const topic of topics) {
                    if (topic.Text) {
                        results.push(`- ${topic.Text.slice(0, 200)}${topic.FirstURL ? ` (${topic.FirstURL})` : ''}`);
                    }
                    // Handle subtopic groups
                    if (topic.Topics && Array.isArray(topic.Topics)) {
                        for (const sub of topic.Topics.slice(0, 2)) {
                            if (sub.Text) {
                                results.push(`  - ${sub.Text.slice(0, 200)}${sub.FirstURL ? ` (${sub.FirstURL})` : ''}`);
                            }
                        }
                    }
                }
            }

            if (results.length > 0) return results.join('\n');

            // Fall back to real web results (DuckDuckGo HTML endpoint) when the
            // instant-answer API has nothing — this is the common case.
            const html = await WebSearchTool.htmlResults(query);
            return html || `No results found for "${query}". Try a more specific query.`;

        } catch (err: any) {
            const html = await WebSearchTool.htmlResults(query).catch(() => '');
            return html || `Web search failed: ${err.message}. The agent can still use workspace tools.`;
        }
    }

    /** Scrape the DuckDuckGo HTML endpoint for real result titles, snippets and URLs. */
    static async htmlResults(query: string, limit = 6): Promise<string> {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlackIDE-Agent)' } });
        if (!resp.ok) return '';
        const body = await resp.text();

        const out: string[] = [];
        // Result anchors: <a ... class="result__a" href="...">Title</a>
        const anchorRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
        const snippets: string[] = [];
        let sm: RegExpExecArray | null;
        while ((sm = snippetRe.exec(body)) !== null) snippets.push(stripHtml(sm[1]));

        let am: RegExpExecArray | null;
        let i = 0;
        while ((am = anchorRe.exec(body)) !== null && out.length < limit) {
            const href = decodeDdgUrl(am[1]);
            const title = stripHtml(am[2]);
            if (!title) continue;
            const snip = snippets[i] ? `\n   ${snippets[i].slice(0, 240)}` : '';
            out.push(`- ${title}\n   ${href}${snip}`);
            i++;
        }
        return out.length ? `Web results for "${query}":\n${out.join('\n')}` : '';
    }
}

function stripHtml(s: string): string {
    return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

function decodeDdgUrl(href: string): string {
    // DuckDuckGo wraps results as /l/?uddg=<encoded-url>
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) { try { return decodeURIComponent(m[1]); } catch { return href; } }
    return href.startsWith('//') ? 'https:' + href : href;
}
