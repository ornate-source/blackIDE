import * as vscode from 'vscode';
import { LLMClient } from './llm-client';
import { LLMConfigEntry } from './types';
import { HistoryStore } from '../memory/history-store';

/**
 * Names a thread from its first prompt.
 *
 * Extracted from `BlackIdeChatProvider._generateConversationTitle` (Phase 0, M2)
 * because two callers now live outside `extension.ts` — the chat task and the chat
 * pipeline entry — and a private method on the provider forced both to route back
 * through a callback.
 *
 * Best-effort throughout: a title is cosmetic, so every failure path here leaves the
 * existing title alone rather than surfacing an error into a run.
 */
export async function generateConversationTitle(
    deps: {
        historyStore: HistoryStore;
        activeThreadId: string;
        view?: vscode.WebviewView;
    },
    userPrompt: string,
    modelConfig: LLMConfigEntry,
): Promise<void> {
    const { historyStore, activeThreadId, view } = deps;
    if (!activeThreadId) return;

    const threads = historyStore.getThreads();
    const thread = threads.find((t: any) => t.id === activeThreadId);
    // Already named — never overwrite a title the user may have seen or set.
    if (thread && thread.title && thread.title !== 'New Session' && thread.title !== 'New Conversation') return;

    try {
        let title = '';
        const req = {
            system: 'You are a helpful assistant. Generate a concise, 3-5 word title for the following conversation prompt. DO NOT include quotes or punctuation.',
            messages: [{ role: 'user' as const, content: userPrompt }],
        };

        await LLMClient.streamAgentTurn(modelConfig, req, (token) => { title += token; });

        if (!title) return;
        const finalTitle = title.trim().replace(/^["']|["']$/g, '');
        if (thread) {
            await historyStore.saveThread(thread.id, finalTitle, thread.messages || []);
        } else {
            await historyStore.saveThread(activeThreadId, finalTitle, []);
        }
        view?.webview.postMessage({ type: 'loadHistory', value: historyStore.getThreads() });
    } catch (e: any) {
        console.error('[Title] Error generating title:', e);
    }
}
