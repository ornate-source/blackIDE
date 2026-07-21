// ─── Parallel within-feature execution (planning half) ───────────────────────
// plan.md's "parallel specialized teams": phases in the same dependency wave are
// independent, so they can execute concurrently — each in its own git worktree — and have
// their (disjoint) deltas merged afterwards.
//
// This module is the PURE half: it decides whether to go parallel at all and lays out the
// worktree/merge plan. The execution half lives in PipelineOrchestrator, because only it
// can touch git. Keeping the decision logic here means the risky part of the feature is
// unit-testable without a repo.
//
// SAFETY: parallel execution is default-OFF. It mutates how execution touches git
// worktrees, and a defect there can corrupt the user's working tree, so the proven
// sequential path stays the default until the extension-host integration suite (P6b) can
// exercise concurrent cancellation and budget-trip behaviour.

export interface ParallelPhasePlan {
    /** Mode id of the phase, e.g. 'Backend Executor'. */
    phase: string;
    /** The dedicated branch/worktree this phase runs in. */
    branch: string;
    /** 0-based wave index. */
    wave: number;
}

export interface ParallelWavePlan {
    wave: number;
    /** Phases to run CONCURRENTLY. */
    phases: ParallelPhasePlan[];
    /**
     * The order their deltas are merged back afterwards. Merges are always SEQUENTIAL
     * (under gitMutex) even though execution is concurrent: two `git apply` runs against
     * the same working tree would race, and a deterministic order makes a conflict
     * reproducible instead of dependent on which phase happened to finish first.
     */
    mergeOrder: string[];
}

/**
 * Whether a run should use the parallel path at all.
 *
 * Requires BOTH the (default-off) setting and an actual opportunity: if no wave holds more
 * than one phase, parallel execution can only add worktree setup cost, extra git
 * contention, and failure surface for exactly zero speedup. Declining here keeps the
 * common single-phase plan on the proven sequential path even when the flag is on.
 */
export function shouldRunParallel(waves: string[][], enabled: boolean): boolean {
    if (!enabled) return false;
    return waves.some(w => w.length > 1);
}

/**
 * Lay out per-phase worktree branches and the merge order for each wave. Branch names are
 * derived from the run's base branch plus a filesystem-safe phase slug, so concurrent runs
 * (the Manager panel allows 4) can never collide on a branch name.
 */
export function planParallelExecution(waves: string[][], baseBranch: string): ParallelWavePlan[] {
    return waves.map((phases, wave) => {
        const planned = phases.map(phase => ({ phase, branch: `${baseBranch}-w${wave}-${slugify(phase)}`, wave }));
        return {
            wave,
            phases: planned,
            // Deterministic: the wave's own phase order, which comes from the dependency
            // scheduler and is therefore stable across runs of the same plan.
            mergeOrder: planned.map(p => p.branch),
        };
    });
}

/** Filesystem- and git-safe slug for a mode id ('Backend Executor' -> 'backend-executor'). */
export function slugify(name: string): string {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'phase';
}
