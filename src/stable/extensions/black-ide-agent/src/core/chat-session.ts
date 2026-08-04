import { ChatMessage } from '@blackide/agent-core/core/types';
import { RuleActivationReason } from '@blackide/agent-core/core/rules';

/**
 * Mutable state for the chat sidebar's single conversation lane.
 *
 * Extracted from `BlackIdeChatProvider` (Phase 0, M2 follow-up) so that the chat
 * task can move out of `extension.ts`. It exists specifically to solve a
 * stale-read problem: `_runAgentTask` *reassigns* `conversation` and
 * `pendingApproval` partway through, and the webview message handler reads them
 * afterwards. Passing the individual values would have handed the extracted code a
 * snapshot, so a later read would see pre-reassignment data — a silent correctness
 * bug of exactly the kind a "pure move" refactor must not introduce. Passing this
 * object by reference means every reader and writer shares one source of truth.
 *
 * Deliberately a plain data holder with no behaviour and no `vscode` import: the
 * Phase 11 `agent-core` extraction needs the chat loop to be host-agnostic, and
 * this is the state it will carry.
 *
 * Scope note: this covers only the chat lane. Manager-panel pipeline runs are a
 * separate concurrency lane keyed by `runId` (`_pipelineRuns`) and deliberately do
 * not share any of this — that separation is what lets a Manager run proceed
 * without corrupting the chat's streaming message.
 */
export class ChatSession {
    /** The live conversation. Reassigned wholesale when the agent loop returns. */
    conversation: ChatMessage[] = [];

    /** Which persisted thread `conversation` belongs to. */
    activeThreadId = 'default';

    /** True while a task holds the lane; the UI gates input on it. */
    isGenerating = false;

    /** Cancels the in-flight task. Replaced per task, cleared on completion. */
    abortController?: AbortController;

    /**
     * A plan awaiting the user's approval. Persisted separately via Memento so the
     * gate survives a window reload; this field is the in-memory half.
     */
    pendingApproval: {
        planContent: string;
        taskContent: string;
        planPath: string;
        taskPath: string;
        originalPrompt: string;
        modelId: string;
        attachments?: any[];
        mode?: string;
    } | null = null;

    /**
     * Pending pipeline-plan approval. Unlike `pendingApproval` this holds a live
     * resolver, so it cannot be reconstructed after an extension-host restart —
     * only a webview reload is survivable.
     */
    pendingPipelineApproval: {
        planContent: string;
        planPath: string;
        resolve: (approved: boolean) => void;
    } | null = null;

    /** Per-subagent cancellation, keyed by subagent id. Mutated in place. */
    readonly subagentAbortControllers = new Map<string, AbortController>();

    // ─── Rules v2 session state (Phase 2) ───────────────────────────────────
    // Session-scoped, not persisted: a toggle is a decision about *this* conversation.
    // Persisting them would silently change how a project behaves days later, which is
    // exactly the kind of invisible state the rules files exist to avoid.

    /** `manual`-activation rules the user switched on for this session. */
    enabledRules: string[] = [];

    /** Rules the user switched off. Team-scoped rules ignore this by design. */
    disabledRules: string[] = [];

    /** `agent-requested` rules the model asked for, honoured on the following turn. */
    requestedRules: string[] = [];

    /**
     * Tools the user switched off for this session (Phase 2, M10).
     *
     * Session-scoped for the same reason as the rule toggles above. Enforced at the
     * executor as well as removed from the advertised list — see `core/tool-toggles.ts`
     * for why both are needed.
     */
    disabledTools: string[] = [];

    /**
     * What actually fired on the last turn, as produced by `selectRules` itself.
     * The session panel renders this array directly rather than recomputing, which is
     * what makes "what the panel shows" and "what the model was sent" the same thing.
     */
    lastRuleActivations: RuleActivationReason[] = [];

    /** True when either kind of approval gate is open. */
    get hasPendingApproval(): boolean {
        return this.pendingApproval !== null || this.pendingPipelineApproval !== null;
    }
}
