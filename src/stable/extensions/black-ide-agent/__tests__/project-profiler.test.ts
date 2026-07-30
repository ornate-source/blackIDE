import { detectProjectProfile } from '../src/core/project-profiler';

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
