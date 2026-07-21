// ─── Pipeline Run Persistence Model ──────────────────────────────────────────
// The serializable projection of a Manager-panel pipeline run (the live record in
// extension.ts also holds an AbortController and an approval resolver, neither of
// which can cross a postMessage or survive a reload). Kept vscode-free so the
// reconciliation logic is unit-testable.

export type PipelineRunStatus =
    | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export interface PipelineRunSummary {
    id: string;
    prompt: string;
    modelId: string;
    status: PipelineRunStatus;
    startedAt: number;
    endedAt?: number;
    currentPhase?: string;
    error?: string;
}

export const NON_TERMINAL_STATUSES: PipelineRunStatus[] = ['running', 'awaiting_approval'];

export function isTerminal(status: PipelineRunStatus): boolean {
    return !NON_TERMINAL_STATUSES.includes(status);
}

/**
 * Flip any run a window reload interrupted (still non-terminal) to a failed terminal
 * state — its live AbortController/resolver died with the old extension host, so it
 * cannot actually still be running. Keeps completed/failed/cancelled runs untouched.
 * Pure/exported for testing.
 */
export function reconcileInterruptedRuns(runs: PipelineRunSummary[], now = Date.now()): PipelineRunSummary[] {
    return (runs || []).map(r =>
        NON_TERMINAL_STATUSES.includes(r.status)
            ? { ...r, status: 'failed' as const, error: r.error || 'Interrupted by a window reload.', endedAt: r.endedAt ?? now }
            : r
    );
}

/** Keep the most recent `max` runs (input ordered oldest→newest). Pure/exported for testing. */
export function capRunHistory(runs: PipelineRunSummary[], max = 50): PipelineRunSummary[] {
    return runs.length <= max ? runs : runs.slice(runs.length - max);
}

/**
 * Merge persisted history with the live in-memory runs, live winning on id collision
 * (a run that is still active this session supersedes its persisted snapshot). Returns
 * oldest→newest by startedAt. Pure/exported for testing.
 */
export function mergeRunViews(history: PipelineRunSummary[], live: PipelineRunSummary[]): PipelineRunSummary[] {
    const byId = new Map<string, PipelineRunSummary>();
    for (const r of history) byId.set(r.id, r);
    for (const r of live) byId.set(r.id, r); // live overrides
    return Array.from(byId.values()).sort((a, b) => a.startedAt - b.startedAt);
}
