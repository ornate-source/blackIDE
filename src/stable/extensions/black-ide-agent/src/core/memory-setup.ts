import * as vscode from 'vscode';
import { LLMClient } from './llm-client';
import { loadModelRouter } from './model-router-loader';
import { SecretManager } from './secret-manager';
import { MemoryTurn } from '../agent/memory-turn';
import { MemoryStore } from '../memory/memory-store';

// ─── Wiring the memory loop (Phase 8, M41 · P8-1) ──────────────────────────
//
// The same shape as `rerank-setup.ts` and `fast-apply-setup.ts`: the feature itself is
// vscode-free and testable, and this is the twenty lines that know where the workspace
// is and which model to use. Keeping them apart is what lets `memory-turn.ts` be driven
// by a recorded response in a test and by a real model here.
//
// ── The role, and why it is not the chat model ──────────────────────────────
// Extraction resolves through the `edit` role. It is a short structured generation over
// a transcript — precisely what that role exists for — and pointing a background pass at
// the user's expensive chat model would make an invisible feature the most surprising
// line on their bill. The router is loaded per call rather than captured, so a model
// changed in settings takes effect on the next turn instead of at the next reload.

export function buildMemoryTurn(
    secretManager: SecretManager,
    log: (message: string) => void,
): MemoryTurn | undefined {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // No workspace, no memory file. Returning `undefined` rather than a store rooted at
    // `process.cwd()` — which for an extension host is somewhere inside the application
    // bundle, and writing a user's project facts there is worse than not having the
    // feature.
    if (!rootPath) return undefined;

    return new MemoryTurn({
        store: new MemoryStore(rootPath),
        log,
        complete: async (prompt) => {
            const { router } = await loadModelRouter(secretManager);
            const config = router.resolve('edit')?.config;
            if (!config) throw new Error('no model is configured for the edit role');
            let text = '';
            await LLMClient.streamCompletion(config, prompt, token => { text += token; });
            return text;
        },
    });
}
