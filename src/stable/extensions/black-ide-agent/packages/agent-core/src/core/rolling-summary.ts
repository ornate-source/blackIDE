import { ChatMessage } from './types';

// ─── Rolling summarization (Phase 5, M30) ───────────────────────────────────
//
// `ContextManager.fit` already keeps a long run inside the window: it drops the oldest
// turns and folds a bullet list of what they did into the task message. That is a
// *bound*, and it is the right last resort — but the list it leaves behind ("called
// read_file (src/a.ts)") preserves the actions and throws away the reasoning, which is
// the part a long run cannot rebuild. Twelve turns in, the agent knows it read a file and
// not what it concluded from it.
//
// This runs earlier, at a threshold rather than at the ceiling, and spends a model call
// to turn the older turns into prose that survives. `fit` stays exactly where it is as
// the floor underneath: summarization needs a model and can fail, and when it does the
// deterministic path must still hold the window.
//
// ── The gate: never drop a pending approval or a tool result ─────────────────
// Three structural rules, none of them a runtime check that could be skipped:
//
//   1. **A pending approval stops summarization entirely.** The plan the user is about to
//      approve is live state, and a summary of the turn that produced it is not something
//      they can approve. Refusing while a gate is open is the whole guarantee, stated
//      once, in the one place that decides what gets folded away.
//   2. **The kept window never begins with tool results.** A `tool_result` whose
//      `tool_use` was summarized away is not degraded context, it is a hard provider
//      rejection — the run dies at the next request. This is the same invariant
//      `ContextManager.fit` holds, restated here because a second thing now edits the
//      message list and an invariant enforced in only one of two places is not enforced.
//   3. **An unresolved tool call is never summarized.** The tail of a run in flight has an
//      assistant turn whose results have not come back yet. Folding it away loses the call
//      the results are about to answer.

/** Marks the summary block inside the task message, so re-summarizing replaces it. */
const SUMMARY_OPEN = '[Conversation summary so far:';
const SUMMARY_CLOSE = ']';

/** Fraction of the window at which summarization starts, well before `fit` would cut. */
const DEFAULT_THRESHOLD = 0.7;

/** Turns kept verbatim at the tail. Recent context is what the next turn reasons from. */
const DEFAULT_KEEP_RECENT = 6;

export type SkipReason = 'below-threshold' | 'nothing-eligible' | 'approval-pending';

export interface SummarySelection {
    /** The task message. Never summarized — an agent that forgets the task is worse. */
    head: ChatMessage;
    /** Contiguous middle to fold into prose. Empty when nothing is eligible. */
    summarize: ChatMessage[];
    /** The tail, kept verbatim. */
    keep: ChatMessage[];
    skipped?: SkipReason;
}

export interface SelectOptions {
    maxTokens: number;
    estimate: (message: ChatMessage) => number;
    thresholdFraction?: number;
    keepRecent?: number;
    /** True while a plan or pipeline approval is open. See rule 1 above. */
    pendingApproval?: boolean;
    /** `/compact` — the user asked, so the threshold does not apply. The invariants do. */
    force?: boolean;
}

/**
 * Decide what may be folded away, or refuse.
 *
 * Pure and free of any model call so that the safety rules can be tested exhaustively
 * without one; the summarization itself is the caller's job.
 */
export function selectForSummary(messages: ChatMessage[], options: SelectOptions): SummarySelection {
    const head = messages[0];
    const keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
    const threshold = (options.thresholdFraction ?? DEFAULT_THRESHOLD) * options.maxTokens;

    if (messages.length === 0) {
        return { head: head ?? { role: 'user', content: '' }, summarize: [], keep: [], skipped: 'nothing-eligible' };
    }

    // Rule 1, before anything else is considered.
    if (options.pendingApproval) {
        return { head, summarize: [], keep: messages.slice(1), skipped: 'approval-pending' };
    }

    const total = messages.reduce((sum, m) => sum + options.estimate(m), 0);
    if (!options.force && total < threshold) {
        return { head, summarize: [], keep: messages.slice(1), skipped: 'below-threshold' };
    }

    // Rule 3: nothing at or after the first unresolved tool call may be folded away.
    const firstUnresolved = indexOfUnresolvedCall(messages);
    const recencyCut = Math.max(1, messages.length - keepRecent);
    let cut = Math.min(recencyCut, firstUnresolved === -1 ? messages.length : firstUnresolved);

    // Rule 2: the kept window must not start on results whose call is being folded away.
    while (cut < messages.length && messages[cut].role === 'user' && messages[cut].toolResults?.length) {
        cut++;
    }

    // One message is not worth a model call, and folding a single turn into prose is
    // usually longer than the turn.
    if (cut <= 2) {
        return { head, summarize: [], keep: messages.slice(1), skipped: 'nothing-eligible' };
    }

    return { head, summarize: messages.slice(1, cut), keep: messages.slice(cut) };
}

/**
 * The first assistant message whose tool calls have no matching results anywhere after
 * it, or -1. Matching is by tool-call id, which is what the providers match on.
 */
function indexOfUnresolvedCall(messages: ChatMessage[]): number {
    const resolved = new Set<string>();
    for (const message of messages) {
        for (const result of message.toolResults || []) resolved.add(result.id);
    }
    for (let i = 0; i < messages.length; i++) {
        const calls = messages[i].toolCalls || [];
        if (calls.length && calls.some(call => !resolved.has(call.id))) return i;
    }
    return -1;
}

/**
 * The prompt that turns folded turns into prose.
 *
 * Written to preserve decisions and dead ends rather than to be short. A summary that
 * says "explored the auth module" costs the next turn the same rediscovery the summary
 * was meant to prevent — including *what did not work* is the difference between context
 * and a table of contents.
 */
export function buildSummaryPrompt(messages: ChatMessage[], task: string): string {
    const transcript = messages.map(renderMessage).filter(Boolean).join('\n');
    return [
        'Summarize the following portion of an agent run so the agent can continue without it.',
        '',
        'Include, in this order:',
        '1. What was established as fact about the codebase (files, symbols, how things fit).',
        '2. Decisions taken, and why.',
        '3. What was tried and did NOT work — this is the most valuable part, because the',
        '   agent will otherwise try it again.',
        '4. What remains outstanding.',
        '',
        'Write plain prose under 400 words. Do not include tool-call syntax, and do not',
        'address the reader. Omit nothing from category 3.',
        '',
        `## The task being worked on\n${task.slice(0, 1_000)}`,
        '',
        '## Transcript to summarize',
        transcript,
    ].join('\n');
}

function renderMessage(message: ChatMessage): string {
    const parts: string[] = [];
    if (message.content?.trim()) parts.push(`${message.role}: ${message.content.trim().slice(0, 2_000)}`);
    for (const call of message.toolCalls || []) {
        parts.push(`${message.role} called ${call.name}(${JSON.stringify(call.arguments || {}).slice(0, 300)})`);
    }
    for (const result of message.toolResults || []) {
        parts.push(`  -> ${result.name}${result.isError ? ' [error]' : ''}: ${(result.content || '').replace(/\s+/g, ' ').slice(0, 600)}`);
    }
    return parts.join('\n');
}

/**
 * Fold the summary into the task message and return the new conversation.
 *
 * The summary lives *inside* the head rather than as a message of its own for the reason
 * `ContextManager.withSummary` already documents: Anthropic requires alternating roles,
 * and a synthetic user message next to the user's task breaks that. Re-summarizing
 * **replaces** the previous block instead of appending a second one, which is what makes
 * this idempotent — running it twice on an unchanged conversation produces the same array,
 * and a run summarized six times has one summary rather than six nested ones.
 */
export function applySummary(selection: SummarySelection, summary: string): ChatMessage[] {
    if (!selection.summarize.length || !summary.trim()) {
        return [selection.head, ...selection.keep];
    }
    const base = stripSummary(selection.head.content);
    const block = `${SUMMARY_OPEN}\n${summary.trim()}\n${SUMMARY_CLOSE}`;
    return [{ ...selection.head, content: `${base}\n\n${block}` }, ...selection.keep];
}

/** Remove a previously folded summary block, leaving the original task text. */
export function stripSummary(content: string): string {
    const at = content.indexOf(SUMMARY_OPEN);
    if (at === -1) return content;
    return content.slice(0, at).replace(/\s+$/, '');
}

/** True when this conversation already carries a folded summary. */
export function hasSummary(messages: ChatMessage[]): boolean {
    return !!messages[0] && messages[0].content.includes(SUMMARY_OPEN);
}
