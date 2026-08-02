import { LLMConfigEntry, ChatMessage, ToolDefinition, ToolCall, ToolResult } from '../core/types';
import { ProviderHealth, Substitution, runWithFailover } from '../core/model-router';
import { LLMClient, isAbortError } from '../core/llm-client';
import { ContextManager } from '../core/context-manager';
import { AgentToolExecutor } from './tool-executor';

export interface LoopCallbacks {
    onTurn?: (n: number, maxTurns: number) => void;
    onReasoningStart?: () => void;
    onToken?: (t: string) => void;
    onToolCall?: (tc: ToolCall) => void;
    onToolResult?: (tc: ToolCall, r: ToolResult) => void;
    onUsage?: (promptChars: number, response: string) => void;
    /** Fired when the window filled up and older turns were compacted away. */
    onCompaction?: (droppedCount: number, totalTokens: number) => void;
    /** Fired when older turns were folded into prose by the summarizer (M30). */
    onSummarized?: (foldedCount: number) => void;
    onLoopLimitReached?: (currentTurn: number, maxTurns: number) => Promise<{ continueWith: number }>;
}

export interface LoopResult {
    finalText: string;
    completed: boolean;
    aborted: boolean;
    turns: number;
    messages: ChatMessage[];
    /** The model the run finished on, when failover moved it (M24). */
    finishedOn?: LLMConfigEntry;
}

/**
 * Cross-provider failover for the loop (Phase 4, M24).
 *
 * Wired at the *turn* rather than around the whole run: a run is minutes long and holds
 * accumulated context, so restarting one because the fourth turn got a 529 throws away
 * everything the first three did. A turn is the unit that can be retried elsewhere
 * without losing state.
 */
export interface LoopFailover {
    /** Ordered attempt list from `ModelRouter.chainFor`. */
    chain: LLMConfigEntry[];
    health: ProviderHealth;
    /** Called once per substitution, so the UI can say which provider is answering. */
    onSubstitution?: (s: Substitution) => void;
}

/**
 * Folds the older middle of a conversation into prose (Phase 5, M30).
 *
 * Returns the rewritten message list, or the list it was given when it declined — a
 * summarizer that cannot reach its model must leave the run running, not end it. The
 * safety rules (never fold a pending approval or an unresolved tool call) live in
 * `core/rolling-summary.ts`, on the other side of this seam.
 */
export type RollingSummarizer = (messages: ChatMessage[]) => Promise<{ messages: ChatMessage[]; folded: number }>;

/**
 * The shared agentic loop. Streams a turn, executes any tool calls via the
 * executor, feeds results back, and repeats until the model completes, the
 * loop budget is exhausted, or the signal aborts.
 */
export async function runAgentLoop(opts: {
    modelConfig: LLMConfigEntry;
    system: string;
    initialMessage: ChatMessage;
    /** Prior turns replayed into this task, so the agent remembers the conversation. */
    priorMessages?: ChatMessage[];
    tools: ToolDefinition[];
    executor: AgentToolExecutor;
    maxLoops: number;
    signal?: AbortSignal;
    callbacks?: LoopCallbacks;
    context?: ContextManager;
    failover?: LoopFailover;
    /**
     * Rolling summarization (M30), injected rather than built here.
     *
     * The loop must stay free of the router and the secret store — it is the piece
     * Phase 11's vscode-free core is built around — so it receives a function that turns
     * messages into prose and knows nothing about which model does it. Absent means the
     * deterministic `ContextManager.fit` path alone, which is exactly the behaviour before
     * this phase.
     */
    summarizer?: RollingSummarizer;
}): Promise<LoopResult> {
    const { modelConfig, system, initialMessage, priorMessages, tools, executor, maxLoops, signal, callbacks = {}, failover, summarizer } = opts;
    // Recreated on substitution when the loop owns it: failing over from a 200k-context
    // model to an 8k local one with the original budget would overflow the window on the
    // next turn, which looks like a model failure rather than a routing consequence.
    const ownsContext = !opts.context;
    let context = opts.context ?? new ContextManager(ContextManager.getModelLimit(modelConfig.model || ''));
    let activeConfig = modelConfig;

    const messages: ChatMessage[] = [...(priorMessages || []), initialMessage];

    let finalText = '';
    let completed = false;
    let turns = 0;
    let currentMaxLoops = maxLoops;

    for (let i = 0; i < currentMaxLoops; i++) {
        if (signal?.aborted) return { finalText, completed, aborted: true, turns, messages };
        turns = i + 1;
        callbacks.onTurn?.(turns, currentMaxLoops);
        callbacks.onReasoningStart?.();

        /*
         * Summarize before fitting, not instead of it.
         *
         * `fit` is the floor: it is deterministic, free, and cannot fail, and it is what
         * holds the window if the summarizer's model is down or slow. Summarization runs
         * first so that what `fit` sees is already condensed — the two compose, and the
         * run degrades to exactly the pre-M30 behaviour when the summarizer declines.
         */
        if (summarizer) {
            try {
                const summarized = await summarizer(messages);
                if (summarized.folded > 0) {
                    messages.length = 0;
                    messages.push(...summarized.messages);
                    callbacks.onSummarized?.(summarized.folded);
                }
            } catch {
                // A failed summary is not a failed run. `fit` below still bounds the window.
            }
        }

        const fitted = context.fit(messages, system);
        if (fitted.droppedCount > 0) callbacks.onCompaction?.(fitted.droppedCount, fitted.totalTokens);

        let turn;
        let emitted = false;
        const streamTurn = (config: LLMConfigEntry) => LLMClient.streamAgentTurn(
            config,
            { system, messages: fitted.messages, tools },
            (t) => { emitted = true; callbacks.onToken?.(t); },
            signal,
        );

        try {
            if (failover?.chain.length) {
                /*
                 * The active model leads the chain, not the user's original choice.
                 *
                 * After a substitution the run stays on whatever answered: putting the
                 * primary back at the head would re-attempt a provider we just watched
                 * fail, once per turn, for the rest of the run — a failed request and its
                 * timeout on every iteration. The user's configured model is still the
                 * primary for the *next* run, and its breaker closes on its own.
                 */
                const chain = [activeConfig, ...failover.chain.filter(c => c.id !== activeConfig.id)];
                const outcome = await runWithFailover(chain, failover.health, (config) => streamTurn(config), {
                    isAbort: isAbortError,
                    hasEmitted: () => emitted,
                    onSubstitution: failover.onSubstitution,
                });
                turn = outcome.result;
                if (outcome.used.id !== activeConfig.id) {
                    activeConfig = outcome.used;
                    if (ownsContext) context = new ContextManager(ContextManager.getModelLimit(activeConfig.model || ''));
                }
            } else {
                turn = await streamTurn(activeConfig);
            }
        } catch (err: any) {
            if (isAbortError(err)) return { finalText, completed, aborted: true, turns, messages };
            throw err;
        }

        callbacks.onUsage?.(system.length + JSON.stringify(fitted.messages).length, turn.text);
        messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls.length ? turn.toolCalls : undefined });

        if (turn.toolCalls.length === 0) {
            finalText = turn.text;
            completed = true;
            break;
        }

        const completeCall = turn.toolCalls.find(tc => tc.name === 'complete_task');
        const results: ToolResult[] = [];
        for (const tc of turn.toolCalls) {
            if (tc.name === 'complete_task') continue;
            if (signal?.aborted) return { finalText, completed, aborted: true, turns, messages };
            callbacks.onToolCall?.(tc);
            const r = await executor.execute(tc);
            callbacks.onToolResult?.(tc, r);
            results.push(r);
        }

        if (results.length) messages.push({ role: 'user', content: '', toolResults: results });

        if (completeCall) {
            finalText = completeCall.arguments?.message || turn.text || 'Task completed.';
            completed = true;
            break;
        }

        // Check if we reached the limit of this loop iteration block
        if (turns >= currentMaxLoops) {
            const decision = await callbacks.onLoopLimitReached?.(turns, currentMaxLoops);
            if (decision && decision.continueWith > 0) {
                currentMaxLoops += decision.continueWith;
                console.log(`[AgentLoop] Extended limit by ${decision.continueWith} to ${currentMaxLoops}`);
            } else {
                break; // Stop loop
            }
        }
    }

    if (!completed && !finalText) {
        finalText = `Reached the maximum of ${currentMaxLoops} tool iterations. Review the log to see what was done.`;
    }
    return { finalText, completed, aborted: false, turns, messages, finishedOn: activeConfig };
}
