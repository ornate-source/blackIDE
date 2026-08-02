// ─── Tool circuit breakers (Phase 9, M52) ───────────────────────────────────
//
// E_9 has read ⬜/❌ since rev 1: "a wedged tool currently burns iterations." The failure is
// specific and it is expensive. An MCP server stops responding, the model calls it, the
// call times out after 120 s, the model tries again because from its side nothing has been
// said, and the run spends its entire iteration budget and its token budget discovering
// one dead process — twenty-five times.
//
// A per-tool breaker ends that after three tries. Deliberately *per tool and per run*
// rather than global or persistent:
//   - **Per tool**, because `run_command` failing says nothing about `read_file`.
//   - **Per run**, because the fix for a wedged server is usually to restart it, and a
//     breaker that outlived the run would keep the tool disabled after the user fixed it.
//
// This is a sibling of `ProviderHealth` (M24) and deliberately not the same class: that
// one is about a provider being unreachable and has a cooldown with a half-open retry;
// this one is about a tool being *broken for this task*, where retrying after a timer buys
// nothing because nobody has changed anything.

export interface BreakerOptions {
    /** Consecutive failures before the tool is disabled for the run. */
    threshold?: number;
    /** A single call slower than this counts as a failure even if it returns. */
    latencyBudgetMs?: number;
    now?: () => number;
}

export interface TripRecord {
    tool: string;
    /** What the user and the model are told. */
    reason: string;
    at: number;
}

const DEFAULT_THRESHOLD = 3;

export class ToolBreaker {
    private readonly consecutive = new Map<string, number>();
    private readonly tripped = new Map<string, TripRecord>();
    private readonly threshold: number;
    private readonly latencyBudgetMs: number;
    private readonly now: () => number;

    constructor(options: BreakerOptions = {}) {
        this.threshold = Math.max(1, options.threshold ?? DEFAULT_THRESHOLD);
        this.latencyBudgetMs = Math.max(0, options.latencyBudgetMs ?? 0);
        this.now = options.now ?? Date.now;
    }

    /** False once the tool has tripped. Checked before the call, not after. */
    isUsable(tool: string): boolean {
        return !this.tripped.has(tool);
    }

    /**
     * A success resets the counter.
     *
     * Consecutive rather than cumulative, for the reason `ProviderHealth` documents: a tool
     * that fails one call in ten across a long run is being used on awkward input, not
     * broken, and a cumulative count would eventually disable every tool a long task
     * touched.
     */
    recordSuccess(tool: string, durationMs?: number): void {
        if (this.latencyBudgetMs > 0 && durationMs !== undefined && durationMs > this.latencyBudgetMs) {
            // A call that returns after four minutes is a failure from the run's point of
            // view even though it succeeded — the budget it spent is gone either way.
            this.recordFailure(tool, `took ${Math.round(durationMs / 1000)}s, over the ${Math.round(this.latencyBudgetMs / 1000)}s budget`);
            return;
        }
        this.consecutive.delete(tool);
    }

    recordFailure(tool: string, detail?: string): TripRecord | undefined {
        const count = (this.consecutive.get(tool) ?? 0) + 1;
        this.consecutive.set(tool, count);
        if (count < this.threshold) return undefined;

        const record: TripRecord = {
            tool,
            at: this.now(),
            reason: `\`${tool}\` failed ${count} times in a row${detail ? ` (${detail})` : ''} and is disabled for the rest of this task. `
                + 'Use a different approach, or tell the user what is broken.',
        };
        this.tripped.set(tool, record);
        return record;
    }

    /** The message handed back in place of a call to a tripped tool. */
    refusalFor(tool: string): string | undefined {
        return this.tripped.get(tool)?.reason;
    }

    trips(): TripRecord[] {
        return [...this.tripped.values()];
    }

    /**
     * Remove a tool from the model's advertised list once it has tripped.
     *
     * Both halves are needed and Phase 2 explains why: removing it from the list stops the
     * model reaching for it, and refusing at the executor stops a model that reaches
     * anyway. Advertising alone is a suggestion.
     */
    filterAdvertised<T extends { name: string }>(tools: T[]): T[] {
        return tools.filter(tool => this.isUsable(tool.name));
    }

    reset(tool?: string): void {
        if (tool) { this.consecutive.delete(tool); this.tripped.delete(tool); return; }
        this.consecutive.clear();
        this.tripped.clear();
    }
}
