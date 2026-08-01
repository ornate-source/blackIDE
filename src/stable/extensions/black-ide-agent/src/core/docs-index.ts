import * as fs from 'fs';
import * as path from 'path';
import { tokenize } from './text-tokens';

// ─── External docs indexing (Phase 3, M20) ──────────────────────────────────
//
// A `@docs` set is a crawled documentation site, stored as plain text and searched
// locally. It answers the question a base model gets wrong most often: *which version of
// the API am I on?* A model's training data has three versions of Django's ORM in it and
// no way to tell which one this project uses; the docs for the pinned version do.
//
// ── Why not reuse CodebaseIndex ──────────────────────────────────────────────
// It was the plan (E13 says "reusing E2's store"), and it is the wrong shape. That index
// is built by walking the *workspace* through `vscode.workspace.findFiles`, keys chunks by
// workspace-relative path, and rebuilds incrementally from file mtimes. Docs have no
// workspace path, no mtime worth trusting, and a different invalidation story (a site is
// re-crawled on demand, not on save). Bending one index around both would put two
// lifecycles in one cache — the failure would be a stale doc page presented as source.
// What *is* shared is the part that matters for ranking quality: `text-tokens.ts`, so a
// query tokenises identically against code and against docs.
//
// ── Politeness and bounds are not optional ───────────────────────────────────
// This fetches somebody else's site. Every crawl is same-origin, depth-bounded,
// page-bounded, rate-limited, and skips anything that is not HTML. An unbounded crawler
// pointed at a docs site with a calendar widget will fetch forever, and the person it
// happens to is the maintainer of the site, not us.

export interface DocPage {
    url: string;
    title: string;
    text: string;
}

export interface DocSet {
    /** `@docs:<name>` — the mention key. */
    name: string;
    rootUrl: string;
    pages: DocPage[];
    crawledAt: number;
}

export interface CrawlOptions {
    maxPages?: number;
    maxDepth?: number;
    /** Delay between requests, so a crawl is not a load test. */
    delayMs?: number;
    fetchImpl?: typeof fetch;
    onProgress?: (fetched: number, queued: number, url: string) => void;
}

export const CRAWL_DEFAULTS = { maxPages: 60, maxDepth: 3, delayMs: 150 };

/**
 * Extracts readable text from an HTML page.
 *
 * A deliberately small extractor: script/style/nav/header/footer/aside are dropped, tags
 * are stripped, entities are decoded, whitespace is collapsed. It is not a DOM parser and
 * does not try to be — docs sites are mostly semantic HTML, and the failure mode of this
 * approach is *extra* text (a nav item in the body), which costs a little ranking noise.
 * The failure mode of a real parser dependency is a native module in an extension that has
 * one runtime dependency, which is the same call M14 made about tree-sitter.
 */
export function extractText(html: string): { title: string; text: string } {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim() : '';

    let body = html;
    // Chrome first: these carry the same words on every page of a site, so leaving them in
    // makes every page match every query slightly, which is worse than useless.
    for (const tag of ['script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript', 'svg']) {
        body = body.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
    }
    // Block boundaries become newlines before tags are stripped, or every heading runs
    // into the paragraph beneath it and snippets become unreadable.
    body = body.replace(/<\/(p|div|section|article|li|h[1-6]|pre|tr|br)\s*\/?>/gi, '\n');
    body = stripTags(body);
    body = decodeEntities(body);
    body = body.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/gm, '').trim();

    return { title, text: body };
}

/** Absolute, same-origin, HTML-ish links found in a page. */
export function extractLinks(html: string, pageUrl: string, rootUrl: string): string[] {
    const out = new Set<string>();
    let root: URL;
    let base: URL;
    try {
        root = new URL(rootUrl);
        base = new URL(pageUrl);
    } catch {
        return [];
    }

    for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
        const href = match[1].trim();
        /*
         * A fragment is stripped, not excluded (caught by a test, 2026-08-01).
         *
         * The first version excluded `#` from the capture class, which does not skip the
         * *fragment* — it skips the whole link. Docs sites link to sections constantly
         * (`ref/models.html#field-options`), so a crawl would silently miss every page that
         * was only ever linked with an anchor. A link that is *nothing but* a fragment is a
         * jump within this page and is correctly ignored.
         */
        if (!href || href.startsWith('#') || /^(mailto|javascript|tel|data):/i.test(href)) continue;

        let candidate: URL;
        try {
            candidate = new URL(href, base);
        } catch {
            continue;
        }
        // Same origin *and* under the root path: pointing `@docs` at
        // `docs.djangoproject.com/en/5.0/` must not crawl `/en/4.2/` as well, or a version
        // question gets answered from the wrong version — the exact failure this feature
        // exists to prevent.
        if (candidate.origin !== root.origin) continue;
        if (!candidate.pathname.startsWith(dirOf(root.pathname))) continue;
        if (/\.(png|jpe?g|gif|svg|webp|pdf|zip|tar|gz|css|js|json|xml|ico|woff2?|ttf|mp4)$/i.test(candidate.pathname)) continue;
        candidate.hash = '';
        candidate.search = '';   // query strings on docs sites are usually the calendar trap
        out.add(candidate.toString());
    }
    return Array.from(out);
}

function dirOf(pathname: string): string {
    if (pathname.endsWith('/')) return pathname;
    const cut = pathname.lastIndexOf('/');
    return cut <= 0 ? '/' : pathname.slice(0, cut + 1);
}

/**
 * Breadth-first crawl of a documentation site.
 *
 * Breadth-first rather than depth-first on purpose: with a page cap, BFS spends the budget
 * on the pages *nearest the root*, which on a docs site is the overview and the top-level
 * guides. DFS would spend all 60 pages inside the first subsection it happened to enter.
 */
export async function crawlDocs(name: string, rootUrl: string, options: CrawlOptions = {}): Promise<DocSet> {
    const maxPages = options.maxPages ?? CRAWL_DEFAULTS.maxPages;
    const maxDepth = options.maxDepth ?? CRAWL_DEFAULTS.maxDepth;
    const delayMs = options.delayMs ?? CRAWL_DEFAULTS.delayMs;
    const fetchImpl = options.fetchImpl ?? fetch;

    const seen = new Set<string>([normalise(rootUrl)]);
    const queue: { url: string; depth: number }[] = [{ url: rootUrl, depth: 0 }];
    const pages: DocPage[] = [];

    while (queue.length && pages.length < maxPages) {
        const { url, depth } = queue.shift()!;
        options.onProgress?.(pages.length, queue.length, url);

        let html: string;
        try {
            const response = await fetchImpl(url, { headers: { 'User-Agent': 'BlackIDE-Agent docs indexer' } });
            if (!response.ok) continue;
            const type = response.headers?.get?.('content-type') || '';
            // A PDF or a tarball that slipped past the extension filter would otherwise be
            // "indexed" as binary noise that matches nothing and inflates the page count.
            if (type && !/html|text/i.test(type)) continue;
            html = await response.text();
        } catch {
            continue;                       // one unreachable page must not end the crawl
        }

        const { title, text } = extractText(html);
        if (text.length > 200) pages.push({ url, title: title || url, text });

        if (depth < maxDepth) {
            for (const link of extractLinks(html, url, rootUrl)) {
                const key = normalise(link);
                if (seen.has(key)) continue;
                seen.add(key);
                queue.push({ url: link, depth: depth + 1 });
            }
        }

        if (delayMs > 0 && queue.length && pages.length < maxPages) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    return { name, rootUrl, pages, crawledAt: Date.now() };
}

function normalise(url: string): string {
    return url.replace(/#.*$/, '').replace(/\/+$/, '');
}

/**
 * On-disk doc sets under `<storage>/docs/<name>.json`.
 *
 * JSON in the extension's storage rather than in the user's repo: a crawl is a cache of
 * somebody else's content, and committing 60 pages of Django docs into a project would be
 * both surprising and a licensing question we have no business creating.
 */
export class DocsStore {
    constructor(private readonly dir: string) {}

    private fileFor(name: string): string {
        // A doc-set name reaches this from a command prompt, so it is untrusted input:
        // `../../..` in a name must not decide where we write.
        const safe = name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^[.-]+/, '').slice(0, 64) || 'docs';
        return path.join(this.dir, `${safe}.json`);
    }

    async save(set: DocSet): Promise<void> {
        await fs.promises.mkdir(this.dir, { recursive: true });
        await fs.promises.writeFile(this.fileFor(set.name), JSON.stringify(set), 'utf8');
    }

    async list(): Promise<{ name: string; rootUrl: string; pages: number; crawledAt: number }[]> {
        try {
            const files = await fs.promises.readdir(this.dir);
            const out: { name: string; rootUrl: string; pages: number; crawledAt: number }[] = [];
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                const set = await this.load(file.replace(/\.json$/, ''));
                if (set) out.push({ name: set.name, rootUrl: set.rootUrl, pages: set.pages.length, crawledAt: set.crawledAt });
            }
            return out.sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            return [];
        }
    }

    async load(name: string): Promise<DocSet | undefined> {
        try {
            const raw = await fs.promises.readFile(this.fileFor(name), 'utf8');
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed?.pages) ? parsed as DocSet : undefined;
        } catch {
            return undefined;
        }
    }

    async remove(name: string): Promise<boolean> {
        try {
            await fs.promises.unlink(this.fileFor(name));
            return true;
        } catch {
            return false;
        }
    }
}

export interface DocHit {
    url: string;
    title: string;
    /** The passage that matched, not the whole page. */
    excerpt: string;
    score: number;
}

/**
 * Searches a doc set and returns passages.
 *
 * **Passages, not pages.** A docs page is often thousands of words; handing the model the
 * whole page to answer one question spends the budget on the 95% that is irrelevant. Pages
 * are split into paragraph-ish windows, windows are scored, and the best few *from
 * different pages* are returned — the same "one hit per file before any file's second"
 * rule M14 had to learn for chunk selection, for the same reason.
 *
 * Scoring is deliberately simple: distinct-term coverage first, then term frequency. The
 * reranker's own finding applies here too — coverage of the query is the signal that
 * matters, and a passage repeating one rare word is usually about something else.
 */
export function searchDocs(set: DocSet, query: string, limit = 4): DocHit[] {
    const terms = Array.from(new Set(tokenize(query)));
    if (!terms.length) return [];

    const scored: (DocHit & { page: string })[] = [];
    for (const page of set.pages) {
        for (const passage of passages(page.text)) {
            const tokens = tokenize(passage);
            if (!tokens.length) continue;
            const present = new Set(tokens);
            const matched = terms.filter(t => present.has(t));
            if (!matched.length) continue;

            const coverage = matched.length / terms.length;
            const frequency = tokens.filter(t => present.has(t) && terms.includes(t)).length / tokens.length;
            scored.push({
                page: page.url,
                url: page.url,
                title: page.title,
                excerpt: passage.trim().slice(0, 700),
                score: coverage * 2 + frequency,
            });
        }
    }

    scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));

    // Best passage per page first, then second-bests — so four hits are four *pages*
    // rather than four paragraphs of one page.
    const firstPass: (DocHit & { page: string })[] = [];
    const seenPages = new Set<string>();
    const rest: (DocHit & { page: string })[] = [];
    for (const hit of scored) {
        if (seenPages.has(hit.page)) { rest.push(hit); continue; }
        seenPages.add(hit.page);
        firstPass.push(hit);
    }

    return [...firstPass, ...rest].slice(0, limit).map(({ page, ...hit }) => hit);
}

/** Paragraph-ish windows, merged so a one-line heading is not its own passage. */
export function passages(text: string, targetChars = 700): string[] {
    const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
    const out: string[] = [];
    let current = '';
    for (const block of blocks) {
        if (!current) { current = block; }
        else if (current.length + block.length + 1 <= targetChars) { current += '\n' + block; }
        else { out.push(current); current = block; }
    }
    if (current) out.push(current);
    return out;
}

/**
 * Doc sets worth offering for a detected stack (M20's auto-suggest).
 *
 * Version-pinned URLs are deliberately avoided here: the profiler knows the framework, not
 * always the version, and a suggestion pinned to the wrong version is worse than a
 * suggestion pinned to none. The user can point a crawl at a version URL themselves, and
 * `extractLinks`' root-path rule then keeps the crawl inside that version.
 */
export const DOC_SUGGESTIONS: Record<string, { name: string; url: string }> = {
    django: { name: 'django', url: 'https://docs.djangoproject.com/en/stable/' },
    fastapi: { name: 'fastapi', url: 'https://fastapi.tiangolo.com/' },
    flask: { name: 'flask', url: 'https://flask.palletsprojects.com/en/stable/' },
    express: { name: 'express', url: 'https://expressjs.com/en/4x/api.html' },
    nestjs: { name: 'nestjs', url: 'https://docs.nestjs.com/' },
    nextjs: { name: 'nextjs', url: 'https://nextjs.org/docs' },
    react: { name: 'react', url: 'https://react.dev/reference/react' },
    angular: { name: 'angular', url: 'https://angular.dev/overview' },
    'react-native': { name: 'react-native', url: 'https://reactnative.dev/docs/getting-started' },
    vue: { name: 'vue', url: 'https://vuejs.org/guide/introduction.html' },
    tailwind: { name: 'tailwind', url: 'https://tailwindcss.com/docs/installation' },
    'aspnet-core': { name: 'aspnet-core', url: 'https://learn.microsoft.com/en-us/aspnet/core/' },
    rails: { name: 'rails', url: 'https://guides.rubyonrails.org/' },
    axum: { name: 'axum', url: 'https://docs.rs/axum/latest/axum/' },
    gin: { name: 'gin', url: 'https://gin-gonic.com/docs/' },
    'spring-boot': { name: 'spring-boot', url: 'https://docs.spring.io/spring-boot/index.html' },
    laravel: { name: 'laravel', url: 'https://laravel.com/docs' },
    flutter: { name: 'flutter', url: 'https://docs.flutter.dev/' },
};

export function suggestDocSets(stacks: string[] = [], existing: string[] = []): { name: string; url: string }[] {
    const have = new Set(existing.map(n => n.toLowerCase()));
    const out: { name: string; url: string }[] = [];
    for (const stack of stacks) {
        const suggestion = DOC_SUGGESTIONS[stack.toLowerCase()];
        if (suggestion && !have.has(suggestion.name) && !out.some(o => o.name === suggestion.name)) out.push(suggestion);
    }
    return out;
}

function stripTags(value: string): string {
    return value.replace(/<[^>]+>/g, ' ');
}

function decodeEntities(value: string): string {
    return value
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}
