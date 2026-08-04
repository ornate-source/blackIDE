import * as vscode from 'vscode';
import {
    PipelineRunSummary,
    reconcileInterruptedRuns,
    capRunHistory,
    mergeRunViews,
} from '@blackide/agent-core/core/pipeline-runs';

/**
 * The Manager panel's concurrency lane: every pipeline run the user launches from
 * the Manager panel, its durable history, and the approval bookkeeping that goes
 * with it.
 *
 * Extracted from `BlackIdeChatProvider` (Phase 0, M2 — the cut that finally brought
 * `extension.ts` under its 700 LOC gate). Unlike the earlier extractions this one is
 * a *class*, not a deps-object function, because the thing being moved is state with
 * an invariant, not a procedure: the live `Map` and the persisted history must be
 * folded together on every transition or a reload shows ghost "running" rows. Moving
 * the methods without the state they guard would have left that invariant split
 * across two files, which is worse than leaving it alone.
 *
 * This lane deliberately shares nothing with `ChatSession` — see that file's scope
 * note. A Manager run has its own `AbortController` per run precisely so it cannot
 * corrupt the chat's streaming message, and that property is preserved here.
 *
 * No `vscode` dependency beyond `Webview`/`ExtensionContext` typing and the Memento
 * it persists into, both of which the Phase 11 host interface will supply.
 */

/** One concurrently-running (or completed) pipeline instance tracked by the Manager panel. */
// The live in-memory record: the serializable PipelineRunSummary (see core/pipeline-runs.ts)
// plus the non-serializable runtime handles that die with the extension host.
export interface PipelineRunRecord extends PipelineRunSummary {
    abortController: AbortController;
    pendingApproval?: {
        planContent: string;
        planPath: string;
        resolve: (approved: boolean) => void;
    };
}

/** How the registry reaches the shared pipeline mechanics (see `runPipelineCore`). */
export interface ManagedRunDeps {
    context: vscode.ExtensionContext;
    runPipelineCore(params: {
        userPrompt: string;
        modelId: string;
        signal: AbortSignal;
        emit: (e: any) => void;
        requestApproval: (planContent: string, planPath: string) => Promise<boolean>;
    }): Promise<boolean>;
}

const RUN_HISTORY_KEY = 'pipeline-run-history';
const MAX_CONCURRENT_PIPELINE_RUNS = 4;

/**
 * The plan-approval blurb shown on both the chat card and the Manager card. One
 * constant so the two surfaces cannot drift into describing the gate differently.
 */
export const PIPELINE_PLAN_APPROVAL_NOTE =
    'Pipeline plans are self-contained — the Sequential Task List section above already breaks work into design/backend/frontend/testing phases.';

export class ManagedRunRegistry {
    /**
     * Concurrent pipeline runs started from the Manager panel — a separate concurrency
     * lane from the chat sidebar's single `ChatSession`, keyed by runId. In-memory only:
     * it does not survive an extension-host restart, which is what `_history` and
     * `reconcileInterruptedRuns` exist to paper over honestly (interrupted runs surface
     * as 'failed', never as ghost 'running').
     */
    private readonly _runs = new Map<string, PipelineRunRecord>();

    /**
     * Durable, reload-surviving history of Manager pipeline runs (serializable
     * summaries), persisted to globalState. The live `_runs` Map is the source of truth
     * for the CURRENT session; this is everything before it.
     */
    private _history: PipelineRunSummary[];

    constructor(private readonly _d: ManagedRunDeps) {
        this._history = reconcileInterruptedRuns(
            this._d.context.globalState.get<PipelineRunSummary[]>(RUN_HISTORY_KEY) || []
        );
    }

    /** Starts a new concurrent pipeline run, or returns an error if the concurrency cap is hit. */
    public start(prompt: string, modelId: string, managerWebview: vscode.Webview): { runId: string } | { error: string } {
        const activeCount = Array.from(this._runs.values())
            .filter(r => r.status === 'running' || r.status === 'awaiting_approval').length;
        if (activeCount >= MAX_CONCURRENT_PIPELINE_RUNS) {
            return { error: `Already running ${activeCount} pipeline${activeCount === 1 ? '' : 's'} — the limit is ${MAX_CONCURRENT_PIPELINE_RUNS}. Wait for one to finish or cancel it first.` };
        }

        const runId = 'run_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const record: PipelineRunRecord = {
            id: runId, prompt, modelId, status: 'running', startedAt: Date.now(),
            abortController: new AbortController(),
        };
        this._runs.set(runId, record);
        this._persist();

        // Fire-and-forget: the caller (a webview message handler) must not block on the
        // whole pipeline run. _run reports its own progress/completion via
        // managerWebview.postMessage, keyed by runId.
        this._run(runId, prompt, modelId, managerWebview).catch(() => {});

        return { runId };
    }

    public cancel(runId: string): void {
        // The abort flows to onPipelineCancelled → the emit switch sets status + persists.
        this._runs.get(runId)?.abortController.abort();
    }

    public approve(runId: string): void {
        const record = this._runs.get(runId);
        if (!record?.pendingApproval) return;
        const pending = record.pendingApproval;
        record.pendingApproval = undefined;
        record.status = 'running';
        this._persist();
        pending.resolve(true);
    }

    public reject(runId: string): void {
        const record = this._runs.get(runId);
        if (!record?.pendingApproval) return;
        const pending = record.pendingApproval;
        record.pendingApproval = undefined;
        // Set the terminal state before resolving — orchestrator.run() unwinds a
        // rejection silently (see pipeline-orchestrator.ts's catch), so nothing else
        // will mark this run as done.
        record.status = 'cancelled';
        record.endedAt = Date.now();
        this._persist();
        pending.resolve(false);
    }

    public list(): PipelineRunSummary[] {
        return mergeRunViews(this._history, Array.from(this._runs.values()).map(r => toRunSummary(r)));
    }

    /**
     * Manager-panel entry point — runs concurrently with the chat sidebar's own flow
     * (and with other Manager runs) via a per-run AbortController rather than the chat
     * lane's shared one. Events go straight to the Manager panel webview tagged with
     * `runId`, never through the chat's EventBus/view — see `runPipelineCore`'s doc
     * comment for why that separation matters (a shared path would let concurrent runs
     * corrupt the chat's own streaming message).
     */
    private async _run(runId: string, userPrompt: string, modelId: string, managerWebview: vscode.Webview): Promise<void> {
        const record = this._runs.get(runId);
        if (!record) return;

        const emit = (e: any) => {
            let mutated = true;
            switch (e.type) {
                case 'PipelinePhaseStarted':
                    record.currentPhase = e.phase;
                    break;
                case 'TaskCompleted':
                    record.status = 'completed';
                    record.endedAt = Date.now();
                    break;
                case 'TaskFailed':
                    record.status = 'failed';
                    record.error = e.error;
                    record.endedAt = Date.now();
                    break;
                case 'TaskCancelled':
                    record.status = 'cancelled';
                    record.endedAt = Date.now();
                    break;
                default:
                    mutated = false;
            }
            // Persist on every state change so a reload finds an accurate, terminal-or-not
            // snapshot (reconcileInterruptedRuns handles the "was still running" case).
            if (mutated) this._persist();
            managerWebview.postMessage({ type: 'pipelineRunEvent', runId, value: e });
        };

        try {
            await this._d.runPipelineCore({
                userPrompt, modelId,
                signal: record.abortController.signal,
                emit,
                requestApproval: (planContent, planPath) => new Promise<boolean>((resolve) => {
                    record.status = 'awaiting_approval';
                    record.pendingApproval = { planContent, planPath, resolve };
                    this._persist();
                    // Same AgentEvent type (and agentReducer case) the chat approval card
                    // already relies on — ManagerPanel folds this into pendingPlan the
                    // same way, via the shared reducer, not a bespoke event shape.
                    managerWebview.postMessage({
                        type: 'pipelineRunEvent',
                        runId,
                        value: {
                            type: 'PlanApprovalRequested',
                            planPath, taskPath: planPath, planContent,
                            taskContent: PIPELINE_PLAN_APPROVAL_NOTE,
                            ts: Date.now(),
                        },
                    });
                }),
            });
        } finally {
            // Defensive fallback only: runPipelineCore should always resolve a terminal
            // status via onPipelineCompleted/onPipelineFailed/onPipelineCancelled (or the
            // reject() handler, for a rejected plan), but a run must never sit silently
            // "running" forever in the Manager panel if some future code path fails to
            // signal one.
            if (record.status === 'running' || record.status === 'awaiting_approval') {
                record.status = 'failed';
                record.error = record.error || 'Pipeline ended without a definitive result.';
                record.endedAt = Date.now();
                managerWebview.postMessage({
                    type: 'pipelineRunEvent',
                    runId,
                    value: { type: 'TaskFailed', error: record.error, durationMs: 0, ts: Date.now() },
                });
            }
        }
    }

    /** Fold the live runs into the durable history and persist. Called on every transition. */
    private _persist(): void {
        const live = Array.from(this._runs.values()).map(r => toRunSummary(r));
        this._history = capRunHistory(mergeRunViews(this._history, live));
        this._d.context.globalState.update(RUN_HISTORY_KEY, this._history);
    }
}

/** Serializable projection of a live run record (drops the AbortController/resolver). */
export function toRunSummary(r: PipelineRunRecord): PipelineRunSummary {
    return {
        id: r.id, prompt: r.prompt, modelId: r.modelId, status: r.status,
        startedAt: r.startedAt, endedAt: r.endedAt, currentPhase: r.currentPhase, error: r.error,
    };
}
