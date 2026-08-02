// ─── Concurrency and spend governor (Phase 6, M33) ──────────────────────────
//
// Until now the concurrency cap was a constant inside `ManagedRunRegistry` and the token
// budget was a number read by the pipeline entry point, so the two lanes could not see
// each other. That was fine while there was one lane. Phase 6 adds task agents, which run
// in the *same* repo against the *same* provider account as pipeline runs, and two caps of
// four is not a cap of four — it is a cap of eight discovered at the worst moment.
//
// This is the one place that answers "may another agent start, and may this one keep
// spending". Pure, so both lanes can be tested against the same admission rules without a
// repo or a provider.
//
// ── Why admission is a reservation and not a boolean ─────────────────────────
// `canStart()` followed by `start()` is a race in a codebase that launches runs from
// webview messages: two clicks in the same tick both see three of four slots used and both
// proceed. `reserve()` returns a handle or a refusal, and the slot is held from that moment
// until the handle is released. There is no window between the check and the claim.

export type RefusalReason = 'at-capacity' | 'token-budget' | 'cost-budget';

export interface Refusal {
    ok: false;
    reason: RefusalReason;
    /** Sentence for the user. Says what is in the way and what to do about it. */
    message: string;
}

export interface Reservation {
    ok: true;
    id: string;
    /** Idempotent — releasing twice must not free somebody else's slot. */
    release(): void;
}

export type Admission = Reservation | Refusal;

export interface GovernorLimits {
    /** Simultaneous agents across every lane. */
    maxConcurrent?: number;
    /** Cumulative input+output tokens for the session. 0 disables the ceiling. */
    tokenBudget?: number;
    /** Cumulative estimated spend in USD. 0 disables the ceiling. */
    costBudget?: number;
}

export const GOVERNOR_DEFAULTS = {
    maxConcurrent: 4,
    /** The roadmap's ceiling. Above this, worktree setup and git contention dominate. */
    hardMaxConcurrent: 8,
    tokenBudget: 0,
    costBudget: 0,
} as const;

export interface GovernorSnapshot {
    active: number;
    maxConcurrent: number;
    tokensSpent: number;
    tokenBudget: number;
    costSpent: number;
    costBudget: number;
    /** True once a ceiling is hit — no further reservations will be granted. */
    exhausted: boolean;
}

export class AgentGovernor {
    private readonly active = new Set<string>();
    private tokensSpent = 0;
    private costSpent = 0;
    private sequence = 0;

    private maxConcurrent: number;
    private tokenBudget: number;
    private costBudget: number;

    constructor(limits: GovernorLimits = {}) {
        this.maxConcurrent = clampConcurrency(limits.maxConcurrent);
        this.tokenBudget = nonNegative(limits.tokenBudget);
        this.costBudget = nonNegative(limits.costBudget);
    }

    /**
     * Re-read limits from settings.
     *
     * Lowering the cap below the number of *running* agents does not kill any of them —
     * it stops the next one starting. Killing a run because a setting changed would
     * discard completed work to satisfy a number the user was in the middle of typing.
     */
    configure(limits: GovernorLimits): void {
        if (limits.maxConcurrent !== undefined) this.maxConcurrent = clampConcurrency(limits.maxConcurrent);
        if (limits.tokenBudget !== undefined) this.tokenBudget = nonNegative(limits.tokenBudget);
        if (limits.costBudget !== undefined) this.costBudget = nonNegative(limits.costBudget);
    }

    /**
     * Claim a slot, or explain why not.
     *
     * Budgets are checked here as well as during a run, because starting an agent that
     * cannot afford its first turn wastes a worktree and tells the user nothing useful.
     */
    reserve(label = 'agent'): Admission {
        const overspend = this.overBudget();
        if (overspend) return overspend;

        if (this.active.size >= this.maxConcurrent) {
            return {
                ok: false,
                reason: 'at-capacity',
                message: `${this.active.size} agents are already running — the limit is ${this.maxConcurrent}. `
                    + 'Wait for one to finish, cancel one, or raise the limit in Settings.',
            };
        }

        const id = `${label}-${++this.sequence}`;
        this.active.add(id);
        let released = false;
        return {
            ok: true,
            id,
            release: () => {
                // Idempotent: `finally` blocks and error paths both release, and a second
                // release must not hand a slot back that somebody else now holds.
                if (released) return;
                released = true;
                this.active.delete(id);
            },
        };
    }

    /** Record spend. Called per turn, from whichever lane produced it. */
    charge(tokens: number, costUsd = 0): void {
        this.tokensSpent += Math.max(0, tokens || 0);
        this.costSpent += Math.max(0, costUsd || 0);
    }

    /**
     * Whether a *running* agent may take another turn.
     *
     * Separate from `reserve` because the answer changes mid-run: the point of a spend
     * ceiling is to stop a run that is already going, and a check that only happens at
     * admission is a ceiling that can be exceeded by exactly one unbounded run.
     */
    mayContinue(): Refusal | undefined {
        return this.overBudget();
    }

    private overBudget(): Refusal | undefined {
        if (this.tokenBudget > 0 && this.tokensSpent >= this.tokenBudget) {
            return {
                ok: false,
                reason: 'token-budget',
                message: `The session token budget of ${this.tokenBudget.toLocaleString()} is spent `
                    + `(${this.tokensSpent.toLocaleString()} used). Raise it in Settings to continue.`,
            };
        }
        if (this.costBudget > 0 && this.costSpent >= this.costBudget) {
            return {
                ok: false,
                reason: 'cost-budget',
                message: `The session spend limit of $${this.costBudget.toFixed(2)} is reached `
                    + `($${this.costSpent.toFixed(2)} estimated). Raise it in Settings to continue.`,
            };
        }
        return undefined;
    }

    snapshot(): GovernorSnapshot {
        return {
            active: this.active.size,
            maxConcurrent: this.maxConcurrent,
            tokensSpent: this.tokensSpent,
            tokenBudget: this.tokenBudget,
            costSpent: this.costSpent,
            costBudget: this.costBudget,
            exhausted: !!this.overBudget(),
        };
    }

    /** Spend only. Slots belong to live runs and are not resettable from outside. */
    resetSpend(): void {
        this.tokensSpent = 0;
        this.costSpent = 0;
    }
}

/**
 * Concurrency is clamped rather than validated.
 *
 * The value arrives from a settings JSON blob that the user can edit by hand, so `0`,
 * `-1`, `"eight"` and `500` are all reachable. Rejecting them would mean an agent that
 * refuses to start because a number three screens away is malformed; clamping means the
 * feature works and the limit is sane. `NaN` falls to the default rather than to the
 * minimum — a garbled setting should behave like an absent one, not like a cap of 1.
 */
export function clampConcurrency(value: number | undefined): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return GOVERNOR_DEFAULTS.maxConcurrent;
    return Math.min(GOVERNOR_DEFAULTS.hardMaxConcurrent, Math.max(1, Math.floor(n)));
}

function nonNegative(value: number | undefined): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}
