// ─── Task agents (Phase 6, M31/M32) ─────────────────────────────────────────
//
// A **task agent** is one independent unit of work the user launched: its own prompt, its
// own mode, its own model, its own git worktree, and — new in this phase — its own
// declared workspace root (M36). It is not a pipeline: nobody planned it, it has no
// phases, and four of them running at once are four unrelated jobs rather than one job
// with four parts.
//
// The Manager panel already modelled `modelId` and `awaiting_approval` for pipeline runs,
// which is why A6 was regraded "extend, don't build". This is the unit it was missing.
//
// ── The property the phase gate is written around ────────────────────────────
// "The live workspace is untouched until an explicit apply."
//
// That is not a policy this module asks callers to respect — it is the shape of the state
// machine. A task agent's work exists only in its worktree; `completed` means "finished
// and waiting", and the *only* transition that writes to the user's tree is `apply`, which
// `canApply` gates. There is deliberately no path from a run finishing to the live tree,
// so no future edit can create one by forgetting a flag.
//
// Pure and vscode-free: the state machine is where the isolation guarantees live, and they
// have to be testable without a git repo.

export type TaskAgentStatus =
    | 'queued'
    | 'running'
    | 'awaiting_approval'
    | 'completed'
    | 'failed'
    | 'cancelled';

export interface TaskAgentDiff {
    files: number;
    insertions: number;
    deletions: number;
}

export interface TaskAgentSummary {
    id: string;
    prompt: string;
    modelId: string;
    /** Mode name, e.g. `Agent` or `Backend Executor`. Each agent may differ (M32). */
    mode: string;
    /** The workspace root this agent acts on (M36). Absolute. */
    rootPath: string;
    /** Its isolated branch. The worktree lives beside the repo, never inside it. */
    branch: string;
    status: TaskAgentStatus;
    startedAt: number;
    endedAt?: number;
    error?: string;
    currentAction?: string;
    diff?: TaskAgentDiff;
    tokens?: number;
    costUsd?: number;
    /** Set once the work has been merged into the live workspace. */
    appliedAt?: number;
    /** Set once the worktree has been thrown away. Mutually exclusive with `appliedAt`. */
    discardedAt?: number;
    /**
     * The commits bracketing this agent's work.
     *
     * Persisted rather than kept in memory because they are the recovery instructions: if
     * the host dies mid-run, `git diff baselineSha..branch` is exactly the work, and a
     * summary that says "it is on branch X" without saying *from where* leaves the user to
     * guess which commits were theirs and which were the sync baseline.
     */
    baselineSha?: string;
    resultSha?: string;
    /**
     * What the verify step found (Phase 7, M40).
     *
     * Stored on the agent rather than looked up from the artifact store at read time,
     * because the race (M37) ranks on it and a ranking that depends on a second lookup
     * silently degrades to "no evidence" the moment that lookup fails — which is exactly
     * how M37 shipped partial in Phase 6.
     */
    verification?: {
        outcome: 'verified' | 'failed' | 'unverifiable' | 'incomplete';
        testsRan: boolean;
        passed?: number;
        failed?: number;
        reportPath?: string;
    };
    /**
     * True when this agent is one candidate of a multi-model race (M37). Losing
     * candidates are discarded wholesale, so they must be distinguishable from agents the
     * user launched individually.
     */
    raceId?: string;
}

const NON_TERMINAL: TaskAgentStatus[] = ['queued', 'running', 'awaiting_approval'];

export function isTerminalStatus(status: TaskAgentStatus): boolean {
    return !NON_TERMINAL.includes(status);
}

/** Agents holding a concurrency slot right now. */
export function activeAgents(agents: TaskAgentSummary[]): TaskAgentSummary[] {
    return agents.filter(a => !isTerminalStatus(a.status));
}

/**
 * Whether this agent's work can still be merged into the live workspace.
 *
 * Deliberately narrow. A cancelled or failed agent may well have written real files, and
 * offering to apply them is tempting — it is also how a half-finished refactor reaches the
 * user's tree with no indication that it stopped halfway. The work is not lost: the
 * worktree and its branch survive, and the summary says where. Recovering it is a git
 * operation the user performs deliberately, which is the correct amount of friction for
 * merging the output of a run that did not finish.
 */
export function canApply(agent: TaskAgentSummary): boolean {
    return agent.status === 'completed' && !agent.appliedAt && !agent.discardedAt;
}

/** Applying and discarding are the two exits, and both are one-way. */
export function canDiscard(agent: TaskAgentSummary): boolean {
    return !agent.appliedAt && !agent.discardedAt;
}

export function canCancel(agent: TaskAgentSummary): boolean {
    return !isTerminalStatus(agent.status);
}

/**
 * True when this agent still owns a worktree on disk.
 *
 * Every state except applied/discarded does, including failed and cancelled ones — which
 * is the point: a worktree is how an interrupted agent's work survives, and pruning them
 * on failure would throw away the only copy.
 */
export function holdsWorktree(agent: TaskAgentSummary): boolean {
    return !agent.appliedAt && !agent.discardedAt;
}

/**
 * Fix up agents that a window reload interrupted.
 *
 * The same problem `reconcileInterruptedRuns` solves for pipelines, with one difference
 * that changes the message: a pipeline run's progress lived in memory and is simply gone,
 * whereas a task agent's work is **on disk in a git worktree** and survives perfectly. So
 * these are marked failed — they genuinely are not running, their `AbortController` died
 * with the host — but the error says where the work is, because "Interrupted by a window
 * reload" in front of a user whose branch still holds an afternoon of edits is true and
 * useless.
 */
export function reconcileInterruptedAgents(
    agents: TaskAgentSummary[],
    now = Date.now(),
): TaskAgentSummary[] {
    return (agents || []).map(agent => {
        if (isTerminalStatus(agent.status)) return agent;
        return {
            ...agent,
            status: 'failed' as const,
            endedAt: agent.endedAt ?? now,
            error: agent.error
                || `Interrupted by a window reload. Whatever this agent had written is preserved on branch "${agent.branch}".`,
        };
    });
}

/**
 * A branch name for an agent.
 *
 * Namespaced under `blackide/agent/` so a user scanning `git branch` can tell instantly
 * what created it and delete the lot with one glob. The id is included because two agents
 * launched in the same millisecond with the same prompt must not collide on a branch —
 * `git worktree add` fails on an existing branch, so a collision is a launch that fails
 * for a reason nobody could diagnose.
 */
export function branchNameFor(id: string): string {
    return `blackide/agent/${id}`;
}

/** Short, sortable, collision-resistant enough for a launch rate of "a human clicking". */
export function newAgentId(now = Date.now(), random = Math.random): string {
    return `ta_${now.toString(36)}_${random().toString(36).slice(2, 6)}`;
}

/**
 * Parse `git diff --numstat` into a count.
 *
 * Binary files report `-` for both columns rather than a number; they are counted as
 * changed files with zero line changes, which is the honest reading — a changed PNG is a
 * real change and it has no lines. Treating `-` as `NaN` and summing would render the
 * whole stat as `NaN` in the UI, from one image.
 */
export function parseNumstat(output: string): TaskAgentDiff {
    let files = 0, insertions = 0, deletions = 0;
    for (const line of String(output || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split('\t');
        if (parts.length < 3) continue;
        files++;
        const added = Number(parts[0]);
        const removed = Number(parts[1]);
        if (Number.isFinite(added)) insertions += added;
        if (Number.isFinite(removed)) deletions += removed;
    }
    return { files, insertions, deletions };
}

/** One-line description for the Manager card. */
export function describeDiff(diff: TaskAgentDiff | undefined): string {
    if (!diff || diff.files === 0) return 'no changes';
    const files = `${diff.files} file${diff.files === 1 ? '' : 's'}`;
    return `${files}, +${diff.insertions}/-${diff.deletions}`;
}
