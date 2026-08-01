import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    DocSet, DocsStore, crawlDocs, extractLinks, extractText, passages, searchDocs, suggestDocSets,
} from '../src/core/docs-index';
import { DocsProvider, WebProvider, splitDocsQuery } from '../src/core/context-providers';

/**
 * `@docs` — external documentation indexing (Phase 3, M20).
 *
 * The two properties worth the most here are both about *not* doing something. The crawler
 * fetches somebody else's site, so it must stay inside the root path it was given —
 * pointing it at `/en/5.0/` and having it wander into `/en/4.2/` would answer a version
 * question from the wrong version, which is the exact failure this feature exists to
 * prevent. And search must return *passages*, not pages: a docs page is thousands of words
 * and handing the model all of them spends the budget on the 95% that is irrelevant.
 */

const page = (title: string, body: string, links: string[] = []) => `
<!doctype html><html><head><title>${title}</title>
<style>.x { color: red }</style></head>
<body>
<nav>Home Guides API Reference Search</nav>
<h1>${title}</h1>
${body}
${links.map(l => `<a href="${l}">link</a>`).join('\n')}
<script>console.log('tracking')</script>
<footer>© Example</footer>
</body></html>`;

describe('extractText', () => {
    it('takes the title and the readable body', () => {
        const { title, text } = extractText(page('QuerySets', '<p>A QuerySet is lazy.</p><p>It caches results.</p>'));
        expect(title).toBe('QuerySets');
        expect(text).toContain('A QuerySet is lazy.');
        expect(text).toContain('It caches results.');
    });

    it('drops chrome, script and style', () => {
        // Nav and footer words appear on every page of a site, so leaving them in makes
        // every page match every query slightly — worse than useless for ranking.
        const { text } = extractText(page('QuerySets', '<p>Body text.</p>'));
        expect(text).not.toContain('tracking');
        expect(text).not.toContain('color: red');
        expect(text).not.toContain('© Example');
        expect(text).not.toMatch(/Home Guides API Reference/);
    });

    it('keeps block boundaries so passages stay readable', () => {
        const { text } = extractText('<h2>Caching</h2><p>Results are cached.</p>');
        expect(text).toMatch(/Caching\s*\n+\s*Results are cached\./);
    });

    it('decodes entities and collapses whitespace', () => {
        const { text } = extractText('<p>a &amp; b &lt;tag&gt; &quot;q&quot;&nbsp;&#39;s</p>');
        expect(text).toBe('a & b <tag> "q" \'s');
    });

    it('survives malformed HTML rather than throwing', () => {
        expect(() => extractText('<p>unclosed <div><span>')).not.toThrow();
        expect(extractText('').text).toBe('');
    });
});

describe('extractLinks', () => {
    const root = 'https://docs.example.com/en/5.0/';

    it('resolves relative links against the page', () => {
        const links = extractLinks('<a href="ref/models.html">m</a>', `${root}topics/db.html`, root);
        expect(links).toContain('https://docs.example.com/en/5.0/topics/ref/models.html');
    });

    it('stays under the root path — the version trap', () => {
        // A crawl of `/en/5.0/` that follows the version switcher into `/en/4.2/` produces an
        // index that answers version questions with the wrong version's docs.
        const html = '<a href="/en/4.2/topics/db.html">old</a><a href="/en/5.0/topics/db.html">new</a>';
        const links = extractLinks(html, root, root);
        expect(links).toEqual(['https://docs.example.com/en/5.0/topics/db.html']);
    });

    it('stays on the origin', () => {
        const links = extractLinks('<a href="https://evil.example/en/5.0/x">x</a>', root, root);
        expect(links).toEqual([]);
    });

    it('skips assets and strips fragments and query strings', () => {
        // Query strings on docs sites are usually the calendar/pagination trap that makes a
        // crawl unbounded. Fragments must be *stripped*, not used to reject the link: docs
        // sites link to sections constantly, and excluding `#` from the href pattern
        // silently skipped every page that was only linked with an anchor.
        const html = '<a href="a.png">i</a><a href="b.pdf">p</a><a href="c.html#frag">c</a><a href="d.html?page=2">d</a>';
        const links = extractLinks(html, root, root);
        expect(links.sort()).toEqual([`${root}c.html`, `${root}d.html`]);
    });

    it('ignores same-page and non-http links', () => {
        const html = '<a href="#top">top</a><a href="mailto:x@y.z">mail</a><a href="javascript:void(0)">js</a>';
        expect(extractLinks(html, root, root)).toEqual([]);
    });

    it('returns nothing for an unparseable base rather than throwing', () => {
        expect(extractLinks('<a href="x">x</a>', 'not a url', 'also not')).toEqual([]);
    });
});

describe('crawlDocs', () => {
    const root = 'https://docs.example.com/guide/';
    const site: Record<string, string> = {
        [root]: page('Guide', '<p>Welcome to the guide. It explains pagination and caching in depth.</p>', ['a.html', 'b.html', 'https://other.example/x']),
        [`${root}a.html`]: page('Pagination', `<p>${'Use Paginator to split a queryset into pages. '.repeat(6)}</p>`, ['c.html']),
        [`${root}b.html`]: page('Caching', `<p>${'QuerySets cache their results after the first evaluation. '.repeat(6)}</p>`),
        [`${root}c.html`]: page('Deep', `<p>${'Third level content about pagination internals. '.repeat(6)}</p>`),
    };

    const fetchImpl = async (url: string) => {
        const body = site[url];
        if (!body) return { ok: false, headers: { get: () => 'text/html' }, text: async () => '' } as any;
        return { ok: true, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => body } as any;
    };

    it('crawls the site and stores readable pages', async () => {
        const set = await crawlDocs('guide', root, { fetchImpl: fetchImpl as any, delayMs: 0 });
        expect(set.pages.map(p => p.title).sort()).toEqual(['Caching', 'Deep', 'Pagination']);
        // The root page is short in this fixture and is dropped by the 200-character floor,
        // which is the intended behaviour for a landing page of links.
        expect(set.rootUrl).toBe(root);
        expect(set.crawledAt).toBeGreaterThan(0);
    });

    it('honours the page cap', async () => {
        const set = await crawlDocs('guide', root, { fetchImpl: fetchImpl as any, delayMs: 0, maxPages: 2 });
        expect(set.pages).toHaveLength(2);
    });

    it('honours the depth cap', async () => {
        const set = await crawlDocs('guide', root, { fetchImpl: fetchImpl as any, delayMs: 0, maxDepth: 1 });
        expect(set.pages.some(p => p.title === 'Deep')).toBe(false);
    });

    it('skips non-HTML responses', async () => {
        const set = await crawlDocs('guide', root, {
            fetchImpl: (async () => ({ ok: true, headers: { get: () => 'application/pdf' }, text: async () => 'binary' })) as any,
            delayMs: 0,
        });
        expect(set.pages).toEqual([]);
    });

    it('keeps going when one page fails', async () => {
        // One unreachable page must not end the crawl — docs sites have dead links.
        let calls = 0;
        const flaky = async (url: string) => {
            calls++;
            if (url.endsWith('a.html')) throw new Error('ECONNRESET');
            return fetchImpl(url);
        };
        const set = await crawlDocs('guide', root, { fetchImpl: flaky as any, delayMs: 0 });
        expect(calls).toBeGreaterThan(2);
        expect(set.pages.some(p => p.title === 'Caching')).toBe(true);
    });

    it('reports progress so a long crawl is not a frozen notification', async () => {
        const seen: string[] = [];
        await crawlDocs('guide', root, { fetchImpl: fetchImpl as any, delayMs: 0, onProgress: (_f, _q, url) => seen.push(url) });
        expect(seen[0]).toBe(root);
        expect(seen.length).toBeGreaterThan(1);
    });
});

describe('searchDocs', () => {
    const set: DocSet = {
        name: 'guide', rootUrl: 'https://d/', crawledAt: 1,
        pages: [
            {
                url: 'https://d/pagination', title: 'Pagination',
                // Long paragraphs on purpose: `passages` merges blocks up to ~700
                // characters, so a short page is legitimately one passage and would not
                // exercise the selection at all.
                text: `Intro paragraph about nothing much in particular. ${'Filler about unrelated topics. '.repeat(20)}`
                    + `\n\nUse the Paginator class to split a queryset into pages of results. ${'More on the Paginator API. '.repeat(20)}`
                    + `\n\nAnother paragraph about pages of results and offsets. ${'Offsets and limits explained. '.repeat(20)}`,
            },
            {
                url: 'https://d/caching', title: 'Caching',
                text: 'QuerySets cache their results after the first evaluation.\n\nSlicing an evaluated queryset reuses the cache.',
            },
        ],
    };

    it('returns the passage that matched, not the page', () => {
        const hits = searchDocs(set, 'paginator split queryset');
        expect(hits[0].url).toBe('https://d/pagination');
        expect(hits[0].excerpt).toContain('Paginator class');
        expect(hits[0].excerpt).not.toContain('Intro paragraph');
    });

    it('prefers a passage covering more distinct query terms', () => {
        const hits = searchDocs(set, 'queryset cache evaluation');
        expect(hits[0].url).toBe('https://d/caching');
    });

    it('offers one hit per page before a second from the same page', () => {
        // The same rule M14 had to learn for chunk selection: four hits should be four
        // pages, not four paragraphs of one page.
        const hits = searchDocs(set, 'queryset results', 2);
        expect(new Set(hits.map(h => h.url)).size).toBe(2);
    });

    it('returns nothing for an empty query or no match', () => {
        expect(searchDocs(set, '')).toEqual([]);
        expect(searchDocs(set, 'kubernetes ingress')).toEqual([]);
    });
});

describe('passages', () => {
    it('merges short blocks up to the target size', () => {
        const merged = passages('Heading\n\nBody one.\n\nBody two.', 200);
        expect(merged).toHaveLength(1);
    });

    it('splits when the target is exceeded', () => {
        const long = 'x'.repeat(400);
        expect(passages(`${long}\n\n${long}`, 500)).toHaveLength(2);
    });
});

describe('DocsStore', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-docs-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('round-trips a set and lists it', async () => {
        const store = new DocsStore(dir);
        await store.save({ name: 'django', rootUrl: 'https://d/', pages: [{ url: 'u', title: 't', text: 'x' }], crawledAt: 5 });
        expect((await store.list())).toEqual([{ name: 'django', rootUrl: 'https://d/', pages: 1, crawledAt: 5 }]);
        expect((await store.load('django'))?.pages).toHaveLength(1);
    });

    it('treats a set name as untrusted input', async () => {
        // The name comes from a command prompt, so `../../..` in it must not decide where
        // we write.
        const store = new DocsStore(dir);
        await store.save({ name: '../../escape', rootUrl: 'https://d/', pages: [{ url: 'u', title: 't', text: 'x' }], crawledAt: 1 });
        const written = fs.readdirSync(dir);
        expect(written).toHaveLength(1);
        expect(written[0]).not.toContain('..');
    });

    it('returns undefined for a missing or corrupt set instead of throwing', async () => {
        const store = new DocsStore(dir);
        expect(await store.load('nope')).toBeUndefined();
        fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json', 'utf8');
        expect(await store.load('broken')).toBeUndefined();
        expect(await store.list()).toEqual([]);
    });

    it('reports whether a removal happened', async () => {
        const store = new DocsStore(dir);
        await store.save({ name: 'x', rootUrl: 'r', pages: [], crawledAt: 1 });
        expect(await store.remove('x')).toBe(true);
        expect(await store.remove('x')).toBe(false);
    });
});

describe('suggestDocSets', () => {
    it('suggests sets for detected stacks and skips ones already indexed', () => {
        expect(suggestDocSets(['python', 'django']).map(s => s.name)).toEqual(['django']);
        expect(suggestDocSets(['django'], ['django'])).toEqual([]);
        expect(suggestDocSets([])).toEqual([]);
    });

    it('does not pin a version it cannot know', () => {
        // The profiler knows the framework, not always the version, and a suggestion pinned
        // to the wrong version is worse than one pinned to none.
        for (const suggestion of suggestDocSets(['django', 'nextjs', 'react', 'rails'])) {
            expect(suggestion.url).not.toMatch(/\/\d+\.\d+/);
        }
    });
});

describe('the @docs and @web providers', () => {
    const sets = async () => [{ name: 'django', rootUrl: 'https://d/', pages: 12 }];
    const search = async (_set: string, query: string) =>
        query.includes('paginate') ? [{ url: 'https://d/p', title: 'Pagination', excerpt: 'Use Paginator.' }] : [];

    it('splits `set/question` mentions', () => {
        expect(splitDocsQuery('django/how do I paginate')).toEqual(['django', 'how do I paginate']);
        expect(splitDocsQuery('django')).toEqual(['django', '']);
    });

    it('resolves a question to passages', async () => {
        const provider = new DocsProvider(sets, search);
        const text = await provider.resolve('django/how do I paginate');
        expect(text).toContain('Pagination');
        expect(text).toContain('Use Paginator.');
    });

    it('distinguishes "no such set" from "no match" from "no question"', async () => {
        // Three different situations with three different fixes; one generic message would
        // make all of them look like the same failure.
        const provider = new DocsProvider(sets, search);
        expect(await provider.resolve('flask/anything')).toMatch(/no such doc set/);
        expect(await provider.resolve('django/')).toMatch(/add a question/);
        expect(await provider.resolve('django/kubernetes')).toMatch(/No passage matched/);
    });

    it('explains the empty state in the dropdown', async () => {
        const provider = new DocsProvider(async () => [], search);
        const items = await provider.suggest('');
        expect(items[0].label).toMatch(/No doc sets indexed/);
        expect(items[0].detail).toMatch(/Add Docs/);
    });

    it('does not search the web per keystroke', async () => {
        // `suggest` runs on every keystroke; a search per keystroke is slow and rude. The
        // query is offered as the item and the search happens once, at resolve time.
        let searches = 0;
        const provider = new WebProvider(async (q) => { searches++; return `results for ${q}`; });
        const items = await provider.suggest('django async orm');
        expect(searches).toBe(0);
        expect(items[0].id).toBe('django async orm');

        const text = await provider.resolve(items[0].id);
        expect(searches).toBe(1);
        expect(text).toContain('results for django async orm');
    });

    it('names a web-search failure rather than returning an empty block', async () => {
        const provider = new WebProvider(async () => { throw new Error('offline'); });
        expect(await provider.resolve('x')).toMatch(/search failed: offline/);
    });
});

/**
 * Command registration (Phase 3, M20).
 *
 * `command-registry.ts` states the trap in its own header: a command registered without
 * being contributed is invisible in the palette, and one contributed without being
 * registered throws when invoked. Both halves are silent until a user tries it, which is
 * the worst time to find out.
 */
describe('the docs commands are both registered and contributed', () => {
    const registry = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'command-registry.ts'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const contributed = new Set((pkg.contributes?.commands || []).map((c: any) => c.command));

    for (const id of ['black-ide.addDocs', 'black-ide.manageDocs']) {
        it(`${id} is registered and contributed`, () => {
            expect(registry).toContain(`registerCommand('${id}'`);
            expect(contributed.has(id), `${id} missing from contributes.commands`).toBe(true);
        });
    }

    it('every registered black-ide command is contributed', () => {
        const registered = Array.from(registry.matchAll(/registerCommand\('([^']+)'/g), m => m[1]);
        const missing = registered.filter(id => !contributed.has(id));
        expect(missing, `registered but not contributed: ${missing.join(', ')}`).toEqual([]);
    });
});
