// ─── Extension-host integration test entry point (P6b) ───────────────────────
// Downloads a real VS Code, launches it with this extension loaded, and runs the suite
// inside the extension host. This is the only place the ~2000-line extension.ts glue, the
// activation path, and the webview wiring can actually be exercised — the core harness
// (test/harness.js) deliberately stubs `vscode` and so can never reach them.
//
// Requires a display. On headless Linux CI, run under xvfb (see ci-agent-integration.yml).

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    try {
        // The extension's root (where package.json lives).
        const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
        // The compiled suite index (out/ mirrors the test/integration source tree).
        const extensionTestsPath = path.resolve(__dirname, './suite/index');
        // A disposable workspace so tests that write .blackIDE/ never touch the real repo.
        const workspacePath = path.resolve(__dirname, '../fixtures/workspace');

        // Start from a clean fixture. The first-run scan is deliberately once-per-workspace
        // and never overwrites existing content, so artifacts left by a previous run would
        // make it correctly skip — and the suite would then assert against stale content
        // instead of a real scan. (globalState is already fresh: the user-data dir below is
        // a new tmpdir each run.)
        fs.rmSync(path.join(workspacePath, '.blackIDE'), { recursive: true, force: true });

        // VS Code opens a unix domain socket under the user-data dir. The default lives
        // inside this deeply-nested extension path, which blows past the ~103-char sockaddr
        // limit on macOS/Linux and fails startup with EINVAL. A short tmpdir path avoids it.
        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bide-'));

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                workspacePath,
                '--user-data-dir', userDataDir,
                // Third-party extensions would slow startup and can steal focus/commands.
                '--disable-extensions',
                '--disable-gpu',
                '--disable-workspace-trust',
            ],
        });
    } catch (err) {
        console.error('Integration tests failed to run:', err);
        process.exit(1);
    }
}

void main();
