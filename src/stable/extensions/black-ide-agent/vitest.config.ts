import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

// Unit tier. The primary tier remains `test/harness.js` (46 suites, vscode-free
// stubs) and the real-host tier remains `test/integration` under mocha; this
// config exists so that plain TypeScript unit suites can be added without
// hand-rolling a runner. See docs/notes/enhancement.md (Phase 0, M4).
export default defineConfig({
    resolve: {
        // An array rather than an object: order is significant, and the more specific
        // `@blackide/agent-core/*` entry has to be matched before the bare name.
        alias: [
            // `vscode` is injected by the extension host and cannot be resolved
            // outside it. Same stub the harness tier uses, so a suite behaves
            // identically in both runners.
            { find: 'vscode', replacement: path.resolve(__dirname, 'test/vscode-stub.js') },
            /*
             * The core package (M62 · P11-2), resolved to its **source** rather than its
             * build output.
             *
             * Deliberate: vitest transpiles TypeScript itself, so pointing at `dist/`
             * would make every unit test depend on a prior `tsc -b` and would silently
             * test yesterday's build after an edit.
             */
            { find: /^@blackide\/agent-core\/(.*)$/, replacement: path.resolve(__dirname, 'packages/agent-core/src') + '/$1' },
            { find: '@blackide/agent-core', replacement: path.resolve(__dirname, 'packages/agent-core/src/agent-core/index.ts') },
        ],
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['__tests__/**/*.test.ts'],
        // These suites shell out to `tsc -b` and `stylelint`, which are slow.
        testTimeout: 180_000,
        hookTimeout: 30_000,
    },
});
