import { describe, expect, it } from 'vitest';
import {
    WorkspaceRoot, defaultRootFor, groupByRoot, isWithin, normalizeRoot, relativeToRoot,
    resolveAgainstRoot, rootFor, rootId,
} from '../src/core/workspace-roots';

/**
 * Phase 6, M36 — multi-root correctness.
 *
 * The gate is "a 2-root workspace (Django API + React app) yields two profiles and injects
 * the correct stack skills per root". What makes that hard is not enumerating folders, it
 * is *attribution*: given a path, which root is it about. Two rules carry it, and both are
 * the kind that survive review and fail in production.
 *
 *   1. **Longest prefix wins.** Nested roots are ordinary — a monorepo plus one package
 *      inside it — and first-match resolves every file in `repo/packages/api/` to `repo/`.
 *   2. **Boundaries are respected.** `startsWith` makes `/repo/app` claim
 *      `/repo/application/x.ts`, which only shows up when one folder name prefixes another.
 */

const root = (path: string, name = path.slice(path.lastIndexOf('/') + 1)): WorkspaceRoot => ({ path, name });

const API = root('/work/shop/api');
const WEB = root('/work/shop/web');
const MONO = root('/work/shop');

describe('rootFor: longest prefix wins', () => {
    it('attributes a file to its own root', () => {
        expect(rootFor('/work/shop/api/manage.py', [API, WEB])?.name).toBe('api');
        expect(rootFor('/work/shop/web/src/App.tsx', [API, WEB])?.name).toBe('web');
    });

    it('prefers the nested root over its parent, whatever the order', () => {
        // First-match would answer `shop` for both, and the package's own rules, profile
        // and manifests would be invisible — which looks exactly like them not existing.
        expect(rootFor('/work/shop/api/manage.py', [MONO, API])?.name).toBe('api');
        expect(rootFor('/work/shop/api/manage.py', [API, MONO])?.name).toBe('api');
    });

    it('falls back to the parent for a file outside every nested root', () => {
        expect(rootFor('/work/shop/README.md', [MONO, API, WEB])?.name).toBe('shop');
    });

    it('does not let one root claim a sibling whose name it prefixes', () => {
        const app = root('/repo/app');
        const application = root('/repo/application');
        expect(rootFor('/repo/application/x.ts', [app, application])?.name).toBe('application');
        expect(rootFor('/repo/app/x.ts', [app, application])?.name).toBe('app');
    });

    it('returns undefined for a file outside the workspace', () => {
        // "Outside the workspace" is a real answer. Attributing it to the first root would
        // run a git command in a repo the file has nothing to do with.
        expect(rootFor('/etc/hosts', [API, WEB])).toBeUndefined();
    });

    it('treats the root itself as belonging to itself', () => {
        expect(rootFor('/work/shop/api', [API])?.name).toBe('api');
    });

    it('handles Windows separators', () => {
        const win = root('C:\\work\\shop\\api', 'api');
        expect(rootFor('C:\\work\\shop\\api\\manage.py', [win])?.name).toBe('api');
    });

    it('is unaffected by a trailing slash on the root', () => {
        expect(rootFor('/work/shop/api/manage.py', [root('/work/shop/api/', 'api')])?.name).toBe('api');
    });
});

describe('isWithin', () => {
    it('accepts the path itself and its descendants', () => {
        expect(isWithin('/a/b', '/a/b')).toBe(true);
        expect(isWithin('/a/b/c.ts', '/a/b')).toBe(true);
    });

    it('rejects a sibling with a shared prefix', () => {
        expect(isWithin('/a/bc/d.ts', '/a/b')).toBe(false);
    });

    it('rejects an ancestor', () => {
        expect(isWithin('/a', '/a/b')).toBe(false);
    });
});

describe('resolveAgainstRoot', () => {
    it('joins a relative path to the agent\'s declared root', () => {
        // Without the preferred root, an agent working in `web` would resolve
        // `src/App.tsx` against `api` and create a file nobody asked for.
        expect(resolveAgainstRoot('src/App.tsx', [API, WEB], WEB.path)).toBe('/work/shop/web/src/App.tsx');
    });

    it('falls back to the first root when none is declared', () => {
        expect(resolveAgainstRoot('src/App.tsx', [API, WEB])).toBe('/work/shop/api/src/App.tsx');
    });

    it('leaves an absolute path alone', () => {
        expect(resolveAgainstRoot('/somewhere/else.ts', [API], WEB.path)).toBe('/somewhere/else.ts');
        expect(resolveAgainstRoot('C:/x/y.ts', [API])).toBe('C:/x/y.ts');
    });

    it('strips a leading ./', () => {
        expect(resolveAgainstRoot('./src/a.ts', [API])).toBe('/work/shop/api/src/a.ts');
    });

    it('returns the path unchanged when there are no roots at all', () => {
        expect(resolveAgainstRoot('src/a.ts', [])).toBe('src/a.ts');
    });
});

describe('relativeToRoot', () => {
    it('strips the owning root', () => {
        expect(relativeToRoot('/work/shop/web/src/App.tsx', [API, WEB]))
            .toEqual({ root: WEB, relative: 'src/App.tsx' });
    });

    it('strips the nested root, not the parent', () => {
        expect(relativeToRoot('/work/shop/api/manage.py', [MONO, API]).relative).toBe('manage.py');
    });

    it('returns the whole path when nothing owns it', () => {
        expect(relativeToRoot('/etc/hosts', [API]))
            .toEqual({ root: undefined, relative: '/etc/hosts' });
    });

    it('returns an empty relative path for the root itself', () => {
        expect(relativeToRoot('/work/shop/api', [API]).relative).toBe('');
    });
});

describe('rootId', () => {
    it('is stable for the same path', () => {
        expect(rootId('/work/shop/api')).toBe(rootId('/work/shop/api'));
    });

    it('distinguishes two roots with the same folder name', () => {
        // Two workspaces each with a `frontend` would otherwise share an index shard and
        // quietly serve each other's files.
        expect(rootId('/work/a/frontend')).not.toBe(rootId('/work/b/frontend'));
    });

    it('keeps the readable name in the id', () => {
        expect(rootId('/work/shop/api')).toMatch(/^api-/);
    });

    it('is filesystem-safe for awkward folder names', () => {
        expect(rootId('/work/my project (v2)')).toMatch(/^[A-Za-z0-9._-]+$/);
    });

    it('normalises separators, so the same folder gets one id', () => {
        expect(rootId('C:\\work\\api')).toBe(rootId('C:/work/api'));
    });
});

describe('groupByRoot', () => {
    it('groups per root and keeps orphans separate', () => {
        const { byRoot, orphans } = groupByRoot(
            ['/work/shop/api/a.py', '/work/shop/web/b.tsx', '/work/shop/api/c.py', '/etc/hosts'],
            [API, WEB],
        );
        expect(byRoot.get('/work/shop/api')).toEqual(['/work/shop/api/a.py', '/work/shop/api/c.py']);
        expect(byRoot.get('/work/shop/web')).toEqual(['/work/shop/web/b.tsx']);
        expect(orphans).toEqual(['/etc/hosts']);
    });

    it('assigns nested files to the nested root', () => {
        const { byRoot } = groupByRoot(['/work/shop/api/a.py', '/work/shop/top.md'], [MONO, API]);
        expect(byRoot.get('/work/shop/api')).toEqual(['/work/shop/api/a.py']);
        expect(byRoot.get('/work/shop')).toEqual(['/work/shop/top.md']);
    });

    it('returns empty structures for no input', () => {
        const { byRoot, orphans } = groupByRoot([], [API]);
        expect(byRoot.size).toBe(0);
        expect(orphans).toEqual([]);
    });
});

describe('defaultRootFor', () => {
    it('prefers the root of the file being looked at', () => {
        expect(defaultRootFor('/work/shop/web/src/App.tsx', [API, WEB])?.name).toBe('web');
    });

    it('falls back to the first root with no active file', () => {
        expect(defaultRootFor(undefined, [API, WEB])?.name).toBe('api');
    });

    it('falls back to the first root when the active file is outside the workspace', () => {
        expect(defaultRootFor('/etc/hosts', [API, WEB])?.name).toBe('api');
    });

    it('returns undefined with no roots at all', () => {
        expect(defaultRootFor('/x', [])).toBeUndefined();
    });
});

describe('normalizeRoot', () => {
    it('flips separators and drops a trailing slash', () => {
        expect(normalizeRoot('C:\\work\\api\\')).toBe('C:/work/api');
    });

    it('preserves a lone root slash', () => {
        expect(normalizeRoot('/')).toBe('/');
    });

    it('tolerates empty input', () => {
        expect(normalizeRoot('')).toBe('');
    });
});
