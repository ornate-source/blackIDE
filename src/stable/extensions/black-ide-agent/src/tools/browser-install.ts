// On-demand browser-support installer — Phase 1 (Option B).
//
// Browser automation is opt-in: Playwright is not bundled (it would add ~300 MB to the
// distribution). This installs it, plus the Chromium binary, into the extension's own
// node_modules so `require('playwright')` resolves afterward — turning the gated browser_*
// tools on without shipping the weight to users who never use them.

import { exec } from 'child_process';

/** Run one shell command in `cwd`, streaming combined output to `onLog`. Rejects on non-zero. */
function run(cmd: string, cwd: string, onLog: (line: string) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        onLog(`$ ${cmd}`);
        const child = exec(cmd, { cwd, maxBuffer: 1024 * 1024 * 64 });
        child.stdout?.on('data', d => onLog(String(d).trimEnd()));
        child.stderr?.on('data', d => onLog(String(d).trimEnd()));
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`\`${cmd}\` exited with code ${code}`));
        });
    });
}

/**
 * Install `playwright` and its Chromium browser into `extensionPath`. Sequential on purpose:
 * `playwright install` needs the npm package present first. Progress streams to `onLog`.
 */
export async function installBrowserSupport(extensionPath: string, onLog: (line: string) => void): Promise<void> {
    await run('npm install playwright', extensionPath, onLog);
    await run('npx playwright install chromium', extensionPath, onLog);
    onLog('Browser support installed. Enable it in Settings → Browser, then start a new task.');
}
