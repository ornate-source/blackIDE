import { ChatMessage } from './types';
import { LLMClient } from './llm-client';
import { ModelRouter, ProviderHealth, runWithFailover } from './model-router';
import { applySummary, buildSummaryPrompt, selectForSummary, stripSummary } from './rolling-summary';

// ─── The summarizer, wired to a model (Phase 5, M30) ────────────────────────
//
// `rolling-summary.ts` decides *what* may be folded away and holds the safety rules;
// this decides *who* folds it. Split because the rules must be testable exhaustively
// without a provider, and because the loop that consumes this must not import a router.

export interface SummarizerOptions {
    router: ModelRouter;
    health: ProviderHealth;
    maxTokens: number;
    estimate: (message: ChatMessage) => number;
    /** True while an approval gate is open — summarization refuses outright. */
    pendingApproval?: () => boolean;
    thresholdFraction?: number;
    keepRecent?: number;
    signal?: AbortSignal;
    onFolded?: (folded: number, summaryChars: number) => void;
}

export interface SummarizeOutcome {
    messages: ChatMessage[];
    folded: number;
}

/**
 * Build the loop's summarizer.
 *
 * Runs on the **`plan` role**, and the choice is worth stating: summarizing a transcript
 * is a synthesis job, which is what that role is for, and it falls back to the chat model
 * when unset. `apply` was the tempting cheap alternative and is wrong twice over — it is
 * deliberately off unless configured (M23), so this would silently never run, and a model
 * chosen for byte-exact transcription is the wrong instrument for deciding which of forty
 * turns mattered.
 *
 * Failover is reused rather than re-implemented for the same reason it exists at all: a
 * long run that dies because the summarizer's provider returned a 529 would have survived
 * had it never had a summarizer.
 */
export function createSummarizer(options: SummarizerOptions) {
    return async (messages: ChatMessage[]): Promise<SummarizeOutcome> => {
        const selection = selectForSummary(messages, {
            maxTokens: options.maxTokens,
            estimate: options.estimate,
            thresholdFraction: options.thresholdFraction,
            keepRecent: options.keepRecent,
            pendingApproval: options.pendingApproval?.(),
        });
        if (!selection.summarize.length) return { messages, folded: 0 };

        const chain = options.router.chainFor('plan');
        if (!chain.length) return { messages, folded: 0 };

        // The head may already carry a previous summary; the prompt gets the *task*, not
        // the task plus a summary of turns that are no longer in the transcript below it.
        const task = stripSummary(selection.head.content);
        const prompt = buildSummaryPrompt(selection.summarize, task);

        let summary = '';
        try {
            const outcome = await runWithFailover(
                chain,
                options.health,
                (config) => LLMClient.streamCompletion(config, prompt, () => {}, undefined, options.signal),
            );
            summary = outcome.result;
        } catch {
            // Declining is a first-class outcome: the caller keeps the original messages
            // and `ContextManager.fit` still bounds the window. A run must never end
            // because the thing that makes it cheaper was unavailable.
            return { messages, folded: 0 };
        }

        if (!summary.trim()) return { messages, folded: 0 };

        options.onFolded?.(selection.summarize.length, summary.length);
        return { messages: applySummary(selection, summary), folded: selection.summarize.length };
    };
}

/**
 * The `/compact` path (M30's manual override).
 *
 * The same machinery with the threshold removed — the user asked, so "not full enough
 * yet" is not an answer. The *invariants* are not removed: an open approval gate still
 * refuses, tool results still keep their calls, and an unresolved call is still not folded
 * away. A manual override overrides the policy, never the correctness rules.
 */
export async function compactNow(
    messages: ChatMessage[],
    options: SummarizerOptions,
): Promise<{ messages: ChatMessage[]; folded: number; reason?: string }> {
    const selection = selectForSummary(messages, {
        maxTokens: options.maxTokens,
        estimate: options.estimate,
        keepRecent: options.keepRecent,
        pendingApproval: options.pendingApproval?.(),
        force: true,
    });

    if (!selection.summarize.length) {
        return {
            messages,
            folded: 0,
            reason: selection.skipped === 'approval-pending'
                ? 'There is an approval waiting — resolve it first, then compact.'
                : 'There is not enough conversation to compact yet.',
        };
    }

    const chain = options.router.chainFor('plan');
    if (!chain.length) return { messages, folded: 0, reason: 'No model is configured.' };

    const prompt = buildSummaryPrompt(selection.summarize, stripSummary(selection.head.content));
    try {
        const outcome = await runWithFailover(
            chain,
            options.health,
            (config) => LLMClient.streamCompletion(config, prompt, () => {}, undefined, options.signal),
        );
        if (!outcome.result.trim()) return { messages, folded: 0, reason: 'The model returned an empty summary.' };
        return { messages: applySummary(selection, outcome.result), folded: selection.summarize.length };
    } catch (err: any) {
        return { messages, folded: 0, reason: `Summarization failed: ${err?.message || err}` };
    }
}
