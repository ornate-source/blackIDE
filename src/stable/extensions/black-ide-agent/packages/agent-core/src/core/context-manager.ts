import { ChatMessage } from './types';
import { estimateTokens } from './prompt-builder';

// ─── Context Window Management ──────────────────────────────────────────────
// Bounds the conversation by TOKEN BUDGET, not message count. Trimming by count
// is a trap: twenty-four whole-file reads overflow any window while twenty-four
// one-line results barely register.
//
// Two invariants hold no matter how tight the budget gets:
//   1. A tool_result is never sent without its tool_use. Providers hard-reject it.
//   2. The original task survives. An agent that forgets what it was asked is worse
//      than one that ran out of room.

/** Single tool results (a big file, a noisy build log) are capped before they can dominate. */
const MAX_CHARS_PER_MESSAGE = 24_000;
const CAP_NOTE = '\n…(truncated)';

export interface FitResult {
    messages: ChatMessage[];
    droppedCount: number;
    totalTokens: number;
}

export class ContextManager {
    private reservedForResponse = 4096;

    constructor(private readonly maxTokens: number = 128_000) {}

    /** Tokens for a full message, including tool calls and results — not just prose. */
    estimateMessageTokens(m: ChatMessage): number {
        let n = estimateTokens(m.content);
        for (const tc of m.toolCalls || []) {
            n += estimateTokens(tc.name) + estimateTokens(JSON.stringify(tc.arguments || {}));
        }
        for (const tr of m.toolResults || []) {
            n += estimateTokens(tr.name) + estimateTokens(tr.content);
        }
        // Images are billed per-tile, not per-char; this is a deliberate flat approximation.
        for (const im of m.images || []) n += 800;
        for (const tr of m.toolResults || []) for (const _ of tr.images || []) n += 800;
        return n;
    }

    totalTokens(messages: ChatMessage[]): number {
        return messages.reduce((sum, m) => sum + this.estimateMessageTokens(m), 0);
    }

    /**
     * Fit the conversation into the model's window. Keeps the task plus the most recent
     * messages that fit, folds anything dropped into a summary appended to the task, and
     * never cuts between a tool call and its result.
     */
    fit(messages: ChatMessage[], systemPrompt: string): FitResult {
        if (messages.length === 0) return { messages, droppedCount: 0, totalTokens: 0 };

        const capped = messages.map(m => this.capMessage(m));
        const budget = this.maxTokens - this.reservedForResponse - estimateTokens(systemPrompt);
        const head = capped[0];

        if (capped.length === 1 || budget <= 0) {
            return { messages: capped, droppedCount: 0, totalTokens: this.totalTokens(capped) };
        }

        const headTokens = this.estimateMessageTokens(head);
        let used = headTokens;
        let cut = capped.length;

        // Walk backwards from the newest message, keeping what fits.
        for (let i = capped.length - 1; i >= 1; i--) {
            const cost = this.estimateMessageTokens(capped[i]);
            if (used + cost > budget) break;
            used += cost;
            cut = i;
        }

        // Never begin the kept window on results whose call was just dropped.
        while (cut < capped.length && capped[cut].role === 'user' && capped[cut].toolResults?.length) {
            used -= this.estimateMessageTokens(capped[cut]);
            cut++;
        }

        if (cut <= 1) {
            return { messages: capped, droppedCount: 0, totalTokens: this.totalTokens(capped) };
        }

        const dropped = capped.slice(1, cut);
        const kept = [this.withSummary(head, dropped), ...capped.slice(cut)];
        return { messages: kept, droppedCount: dropped.length, totalTokens: this.totalTokens(kept) };
    }

    /**
     * Fold dropped turns into the task message rather than inserting a summary message
     * of its own. Anthropic requires roles to alternate, and a synthetic user message
     * landing next to the user task would break that.
     */
    private withSummary(head: ChatMessage, dropped: ChatMessage[]): ChatMessage {
        if (dropped.length === 0) return head;
        const lines: string[] = [];
        for (const m of dropped) {
            if (m.toolCalls?.length) {
                for (const tc of m.toolCalls) {
                    const arg = tc.arguments?.path || tc.arguments?.command || tc.arguments?.query || '';
                    lines.push(`- called ${tc.name}${arg ? ` (${arg})` : ''}`);
                }
            } else if (m.toolResults?.length) {
                for (const tr of m.toolResults) {
                    lines.push(`  → ${tr.name}: ${tr.isError ? 'error: ' : ''}${(tr.content || '').replace(/\s+/g, ' ').slice(0, 120)}`);
                }
            } else if (m.content) {
                lines.push(`- ${m.role}: ${m.content.replace(/\s+/g, ' ').slice(0, 160)}`);
            }
        }
        const summary = `\n\n[Earlier in this task (${dropped.length} messages compacted):\n${lines.join('\n').slice(0, 4000)}\n]`;
        return { ...head, content: head.content + summary };
    }

    /** Stop any single message from eating the whole window. */
    private capMessage(m: ChatMessage): ChatMessage {
        const overlong = (s: string) => s && s.length > MAX_CHARS_PER_MESSAGE;
        const cap = (s: string) => s.slice(0, MAX_CHARS_PER_MESSAGE - CAP_NOTE.length) + CAP_NOTE;

        const needsCap = overlong(m.content) || (m.toolResults || []).some(tr => overlong(tr.content));
        if (!needsCap) return m;

        return {
            ...m,
            content: overlong(m.content) ? cap(m.content) : m.content,
            toolResults: m.toolResults?.map(tr => overlong(tr.content) ? { ...tr, content: cap(tr.content) } : tr),
        };
    }

    /** Model-specific context window. */
    static getModelLimit(modelName: string): number {
        const lower = (modelName || '').toLowerCase();
        if (lower.includes('gemini-2.5')) return 1048576;
        if (lower.includes('gemini')) return 128000;
        if (lower.includes('claude')) return 200000;
        if (lower.includes('gpt-4o')) return 128000;
        if (lower.includes('gpt-4-turbo')) return 128000;
        if (lower.includes('gpt-4')) return 8192;
        if (lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) return 200000;
        if (lower.includes('llama-3') || lower.includes('llama3')) return 8192;
        if (lower.includes('deepseek')) return 32768;
        if (lower.includes('qwen')) return 32768;
        return 32000; // conservative default
    }
}
