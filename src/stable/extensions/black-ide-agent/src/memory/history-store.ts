import * as vscode from 'vscode';
import { ChatMessage } from '../core/types';

export class HistoryStore {
    constructor(private readonly state: vscode.Memento) {}

    public getThreads(): any[] {
        return this.state.get('chat-threads', []);
    }

    public async saveThread(id: string, title: string, messages: any[]): Promise<void> {
        const threads = this.getThreads();
        const index = threads.findIndex((t: any) => t.id === id);
        if (index > -1) {
            threads[index] = { id, title, messages };
        } else {
            threads.push({ id, title, messages });
        }
        await this.state.update('chat-threads', threads);
    }

    public async deleteThread(id: string): Promise<void> {
        const threads = this.getThreads();
        const updated = threads.filter((t: any) => t.id !== id);
        await this.state.update('chat-threads', updated);
    }

    public async clear(): Promise<void> {
        await this.state.update('chat-threads', []);
    }

    // ─── Conversation State Persistence ─────────────────────────────────
    // Persists the host-side ChatMessage[] so multi-turn context survives
    // window reloads. Uses the same Memento backing store for atomicity.

    /** Persist pruned ChatMessage[] for a thread so conversation survives reload. */
    public async setConversationState(threadId: string, messages: ChatMessage[]): Promise<void> {
        const trimmed = messages.slice(-40); // Cap at 40 messages to bound Memento size
        await this.state.update(`conversation-${threadId}`, trimmed);
    }

    /** Load persisted conversation state for a thread. */
    public getConversationState(threadId: string): ChatMessage[] | null {
        return this.state.get<ChatMessage[] | null>(`conversation-${threadId}`, null);
    }

    /** Clear conversation state (e.g., new thread). */
    public async clearConversationState(threadId: string): Promise<void> {
        await this.state.update(`conversation-${threadId}`, undefined);
    }
}
