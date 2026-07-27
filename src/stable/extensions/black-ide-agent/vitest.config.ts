import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

// Unit tier. The primary tier remains `test/harness.js` (46 suites, vscode-free
// stubs) and the real-host tier remains `test/integration` under mocha; this
// config exists so that plain TypeScript unit suites can be added without
// hand-rolling a runner. See docs/notes/enhancement.md (Phase 0, M4).
export default defineConfig({
    resolve: {
        alias: {
            // `vscode` is injected by the extension host and cannot be resolved
            // outside it. Same stub the harness tier uses, so a suite behaves
            // identically in both runners.
            vscode: path.resolve(__dirname, 'test/vscode-stub.js'),
        },
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
