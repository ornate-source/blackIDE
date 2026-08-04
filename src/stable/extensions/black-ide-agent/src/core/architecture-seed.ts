import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { KnowledgeBase, summarizeRepoStructure } from './knowledge-base';

// ─── One-time architecture seeding (P1) ─────────────────────────────────────
//
// Extracted from `extension.ts` on 2026-08-04, when the file sat at 699 of its 700-line
// gate and the Reviewer (M47) needed one more method. The previous audit named this
// exactly — "the next feature that needs a field will hit the gate" — and the answer to
// hitting it is to extract something, not to raise it.
//
// This is the right thing to extract rather than the most convenient. It runs once per
// workspace at activation, it touches nothing the chat provider owns, and the only thing
// it needed from the provider was `context.globalState`. A method with one dependency on
// its host was never part of that host; it was living there because activation is where
// it is called from.
//
// ── Guarded three ways, because it runs unprompted ──────────────────────────
// A `globalState` flag so it runs once per workspace; an unseeded check so it can never
// overwrite what a human or an agent wrote; and a total try/catch, because a scan failure
// must never be the reason an editor fails to start.

const ARCH_SCAN_KEY = 'blackIde.architectureScan';

/** How many files the discovery scan will look at before giving up on being thorough. */
const SCAN_LIMIT = 4_000;

export interface ArchitectureSeedResult {
    seeded: boolean;
    /** Why nothing was written, when nothing was. */
    reason?: string;
    filesScanned?: number;
}

/**
 * Scan the repository once and scaffold `architecture.md` from what is there.
 *
 * Returns a result rather than logging, so a caller can report it and a test can assert
 * it. The `void`-ing caller in `activate()` ignores it, which is correct there: nothing
 * about activation should wait on or branch on a best-effort scan.
 */
export async function seedArchitectureOnce(
    context: vscode.ExtensionContext,
): Promise<ArchitectureSeedResult> {
    try {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) return { seeded: false, reason: 'no workspace folder' };

        const key = `${ARCH_SCAN_KEY}:${rootPath}`;
        if (context.globalState.get<boolean>(key)) return { seeded: false, reason: 'already scanned' };

        const kb = new KnowledgeBase(rootPath);
        // Check before scanning — the scan is the expensive part and is pointless if
        // architecture.md already says something.
        if (!kb.isArchitectureUnseeded()) {
            await context.globalState.update(key, true);
            return { seeded: false, reason: 'architecture.md already has content' };
        }

        const uris = await vscode.workspace.findFiles(
            '**/*',
            '**/{node_modules,.git,dist,out,build,.next,coverage,vendor}/**',
            SCAN_LIMIT,
        );
        // An empty result means the workspace has not finished opening, not that the repo
        // is empty. Not marking it done leaves the next activation free to try again.
        if (uris.length === 0) return { seeded: false, reason: 'workspace not ready' };

        let packageJson: any;
        try {
            packageJson = JSON.parse(fs.readFileSync(path.join(rootPath, 'package.json'), 'utf8'));
        } catch { /* not a Node project, or no manifest — the summary copes */ }

        kb.ensureScaffold();
        const relative = uris.map(u => vscode.workspace.asRelativePath(u));
        const seeded = kb.scaffoldArchitecture(summarizeRepoStructure(relative, packageJson));
        if (seeded) {
            // console, not the event bus: bus envelopes carry session/task metadata that
            // does not exist at activation time, and no run is in flight to attribute to.
            console.log(`[Knowledge] Seeded architecture.md from a scan of ${uris.length} files.`);
        }
        await context.globalState.update(key, true);
        return { seeded, filesScanned: uris.length };
    } catch (error: any) {
        return { seeded: false, reason: `scan failed: ${error?.message || error}` };
    }
}
