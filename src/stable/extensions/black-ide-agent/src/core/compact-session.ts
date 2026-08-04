import * as vscode from 'vscode';
import { ChatSession } from './chat-session';
import { ContextManager } from '@blackide/agent-core/core/context-manager';
import { SecretManager } from '@blackide/agent-core/core/secret-manager';
import { HistoryStore } from '../memory/history-store';
import { loadModelRouter, providerHealth } from './model-router-loader';
import { compactNow } from './summarizer';
import { pruneForPersistence } from '../agent/chat-task';

// ─── `/compact` (Phase 5, M30's manual override) ────────────────────────────
//
// The slash command has been in the webview's suggestion list since Phase 2 and did
// nothing — `planning-engine.ts` knew to skip planning for it and no code ever handled
// it, so typing it sent the literal string "/compact" to the model as a task. This is the
// implementation that was missing, and the reason the roadmap phrases M30 as "keep
// `/compact` as the manual override" rather than "add" it.
//
// Deliberately the same `selectForSummary` path as the automatic one. A manual compaction
// that took a shortcut past the invariants would be the most dangerous caller of all: it
// runs when the user is watching, on a conversation they are about to continue.

export interface CompactDeps {
    session: ChatSession;
    secretManager: SecretManager;
    historyStore: HistoryStore;
    webview?: vscode.Webview;
}

export async function compactSession(deps: CompactDeps): Promise<{ folded: number; reason?: string }> {
    const { session } = deps;
    if (session.isGenerating) {
        return { folded: 0, reason: 'Wait for the current task to finish, then compact.' };
    }

    const { router } = await loadModelRouter(deps.secretManager);
    const model = router.resolve('plan')?.config;
    if (!model) return { folded: 0, reason: 'No model is configured. Add one in Black IDE Settings.' };

    const limit = ContextManager.getModelLimit(model.model || '');
    const context = new ContextManager(limit);

    const before = context.totalTokens(session.conversation);
    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Compacting the conversation…' },
        () => compactNow(session.conversation, {
            router,
            health: providerHealth,
            maxTokens: limit,
            estimate: (m) => context.estimateMessageTokens(m),
            pendingApproval: () => session.hasPendingApproval,
        }),
    );

    if (!result.folded) return { folded: 0, reason: result.reason };

    session.conversation = result.messages;
    await deps.historyStore.setConversationState(session.activeThreadId, pruneForPersistence(session.conversation));

    const after = context.totalTokens(session.conversation);
    deps.webview?.postMessage({
        type: 'conversationCompacted',
        value: { folded: result.folded, beforeTokens: before, afterTokens: after },
    });
    return { folded: result.folded };
}
