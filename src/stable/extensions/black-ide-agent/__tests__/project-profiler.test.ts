import * as fs from 'node:fs';
import * as path from 'node:path';
import { FRAMEWORK_IDENTITY_TOKENS, detectProjectProfile } from '../src/core/project-profiler';

/**
 * Regression cover for eval finding F2: React-based frameworks must be detected *in
 * addition to* react, not instead of it. The original if/else-if chain meant a
 * Next.js repo reported `nextjs` but not `react`, so any skill keyed on `react`
 * alone silently never matched.
 */

const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) => ({
    'package.json': JSON.stringify({ name: 'app', dependencies: deps, devDependencies: dev }),
    'tsconfig.json': '{}',
});
const files = ['package.json', 'tsconfig.json', 'src/index.tsx'];

describe('React-family detection (F2)', () => {
    it('reports both nextjs and react for a Next.js project', () => {
        const p = detectProjectProfile(files, pkg({ next: '^14.2.0', react: '^18.3.0' }));
        expect(p.stacks).toContain('nextjs');
        expect(p.stacks).toContain('react');
    });

    it('infers react from next even when react is not a direct dependency', () => {
        const p = detectProjectProfile(files, pkg({ next: '^14.2.0' }));
        expect(p.stacks).toContain('react');
        expect(p.evidence.join(' ')).toContain('Next.js is React-based');
    });

    it('reports both react-native and react, plus expo when present', () => {
        const p = detectProjectProfile(files, pkg({ 'react-native': '0.74.0', expo: '^51.0.0', react: '18.2.0' }));
        expect(p.stacks).toContain('react-native');
        expect(p.stacks).toContain('react');
        expect(p.stacks).toContain('expo');
    });

    it('still reports plain react on its own', () => {
        const p = detectProjectProfile(files, pkg({ react: '^18.3.0' }));
        expect(p.stacks).toContain('react');
        expect(p.stacks).not.toContain('nextjs');
        expect(p.stacks).not.toContain('react-native');
    });

    it('does not invent react for a non-React project', () => {
        const p = detectProjectProfile(files, pkg({ vue: '^3.4.0' }));
        expect(p.stacks).not.toContain('react');
        expect(p.stacks).toContain('vue');
    });

    it('keeps the empty-repo fail-safe: no signal means no stacks', () => {
        const p = detectProjectProfile(['README.md', 'LICENSE'], {});
        expect(p.stacks).toEqual([]);
        expect(p.confidence).toBe(0);
    });
});

/**
 * FRAMEWORK_IDENTITY_TOKENS must not drift from what the profiler can actually emit
 * (2026-08-01). The resolver's F3 rule keys off that list: a token the profiler emits
 * but the list omits means a pack of that framework's idioms can be injected into a
 * repo using a competitor, and nothing would fail. The failure is silent in exactly the
 * direction that matters, so it is asserted against the source rather than trusted.
 */
describe('FRAMEWORK_IDENTITY_TOKENS covers what the profiler emits', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'project-profiler.ts'), 'utf8');

    /** Every literal the profiler pushes into `frameworks`, via `fw()` or `add(frameworks, …)`. */
    const emitted = new Set<string>([
        ...Array.from(source.matchAll(/\bfw\('([^']+)'/g), m => m[1]),
        ...Array.from(source.matchAll(/add\(frameworks,\s*'([^']+)'/g), m => m[1]),
    ]);

    /**
     * Tokens that are emitted but deliberately not identities, each because it
     * *co-exists* with a framework rather than replacing one. Kept explicit so adding a
     * new exclusion is a decision someone writes down.
     */
    const NOT_IDENTITIES = new Set([
        'expo', 'django-rest-framework', 'entity-framework-core', 'gorm',   // additive libraries
        'docker', 'github-actions', 'terraform',                            // infrastructure
        'dotnet', 'rust', 'go',                                             // bare platform tokens from fw()
    ]);

    it('found the profiler’s framework literals at all', () => {
        // If the regexes stop matching, every assertion below passes vacuously.
        expect(emitted.size).toBeGreaterThan(20);
        expect(emitted.has('django')).toBe(true);
    });

    it('classifies every emitted framework as either an identity or an explicit exclusion', () => {
        const unclassified = Array.from(emitted)
            .filter(t => !FRAMEWORK_IDENTITY_TOKENS.includes(t) && !NOT_IDENTITIES.has(t));
        expect(unclassified, `unclassified framework tokens: ${unclassified.join(', ')}`).toEqual([]);
    });

    it('lists no identity the profiler cannot produce', () => {
        // A token here that the profiler never emits can never be "detected", so every
        // pack named after it would be permanently suppressed.
        const orphans = FRAMEWORK_IDENTITY_TOKENS.filter(t => !emitted.has(t));
        expect(orphans, `identities the profiler never emits: ${orphans.join(', ')}`).toEqual([]);
    });

    it('every bundled pack named after an identity token can be detected', () => {
        const packs = fs.readdirSync(path.join(__dirname, '..', 'resources', 'skills'), { withFileTypes: true })
            .filter(e => e.isDirectory()).map(e => e.name);
        for (const pack of packs) {
            if (!FRAMEWORK_IDENTITY_TOKENS.includes(pack)) continue;
            expect(emitted.has(pack), `pack "${pack}" is an identity the profiler never emits`).toBe(true);
        }
    });
});
