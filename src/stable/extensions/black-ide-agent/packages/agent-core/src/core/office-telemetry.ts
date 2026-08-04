import { LiveTelemetry } from './office-model';

// ─── The Office's patch channel ─────────────────────────────────────────────
//
// `TaskAgentRegistry.update()` is called for every field change including per-turn token
// charges, and each call persists the whole history to `globalState` and re-pushes **the
// entire agent array** to the panel (`task-agent-registry.ts:363-374`). Today that drives a
// six-field card and nobody notices. Four desks with a live verb, two progress bars and a
// files-in-play table, re-rendered from a whole-array replacement at tool cadence, is a
// jank source and a battery cost.
//
// So: **structural changes push a list, field changes push a patch**, and the patches are
// coalesced.
//
// ── Why the coalescer is on the extension-host side ──────────────────────────
// A webview that throttles still pays the `postMessage` serialisation cost for every frame
// it then drops — the structured clone happens before the listener ever sees it. Dropping
// the frame *before* it is posted is the only version of this that saves anything.
//
// Pure and clock-injected, so the budget can be tested without a webview or a timer.

export interface OfficePatch {
    id: string;
    fields: Partial<LiveTelemetry>;
}

/** Four per second per item. Faster than a human reads; slower than a model emits tokens. */
export const DEFAULT_PATCH_INTERVAL_MS = 250;

/**
 * Merges per-item field updates and hands them out no faster than the interval.
 *
 * The merge is **last-write-wins per field, not per patch**: an agent that reports a new
 * `activity` and then a new `progress` inside one window must produce one patch carrying
 * both, not two patches or one patch that lost the first field. That is the whole
 * correctness requirement here, and it is the one a naive "keep the newest patch"
 * implementation gets wrong.
 */
export class PatchCoalescer {
    private pending = new Map<string, Partial<LiveTelemetry>>();
    private lastFlush = new Map<string, number>();

    constructor(private readonly intervalMs: number = DEFAULT_PATCH_INTERVAL_MS) {}

    /** Stage a field change. Cheap enough to call from a tool-call callback. */
    record(id: string, fields: Partial<LiveTelemetry>): void {
        if (!id || !fields) return;
        const existing = this.pending.get(id);
        this.pending.set(id, existing ? { ...existing, ...fields } : { ...fields });
    }

    /**
     * The patches due at `now`, removed from the pending set.
     *
     * An item under its interval keeps its staged fields for the next drain rather than
     * losing them — a dropped frame must delay a value, never discard it, or the desk ends
     * up showing a tool the agent has already finished.
     */
    drain(now: number): OfficePatch[] {
        const out: OfficePatch[] = [];
        for (const [id, fields] of this.pending) {
            const last = this.lastFlush.get(id) ?? 0;
            if (now - last < this.intervalMs) continue;
            this.lastFlush.set(id, now);
            this.pending.delete(id);
            out.push({ id, fields });
        }
        return out;
    }

    /**
     * Flush everything regardless of the interval.
     *
     * For the transitions where lateness is a lie rather than a delay: a run ending, or a
     * panel mounting. A desk that reads `running · edit_file` for a quarter of a second
     * after the run finished is a surface disagreeing with itself.
     */
    flush(now: number): OfficePatch[] {
        const out: OfficePatch[] = [];
        for (const [id, fields] of this.pending) {
            this.lastFlush.set(id, now);
            out.push({ id, fields });
        }
        this.pending.clear();
        return out;
    }

    /** Drop an item entirely — it retired, and its staged fields are about to be wrong. */
    forget(id: string): void {
        this.pending.delete(id);
        this.lastFlush.delete(id);
    }

    get pendingCount(): number {
        return this.pending.size;
    }
}

/**
 * Whether a surface should be fed at all.
 *
 * The panel already drops posts when no panel is open (`manager-panel.ts:84`), but that is
 * the *consumer* declining — the producer still built the snapshot, took the git mutex for
 * a diff, and serialised the message. The rule in the design record is that nothing is
 * computed for a surface that is not open, and this is the predicate that enforces it at
 * the top of the producer instead.
 */
export function shouldPublish(surfaces: { open: boolean }[]): boolean {
    return surfaces.some(s => s.open);
}

/**
 * How often telemetry may take the process-global git mutex for one agent.
 *
 * `GitMutex` is documented as a throughput ceiling on all parallel work
 * (`git-mutex.ts:22-27`): a live diff polled per event would serialise four agents behind
 * the UI, which is watching changing what it watches — the one thing the telemetry
 * contract forbids outright.
 */
export const GIT_POLL_INTERVAL_MS = 10_000;

/** A per-agent gate over an expensive probe. Returns true at most once per interval. */
export class ProbeBudget {
    private last = new Map<string, number>();

    constructor(private readonly intervalMs: number = GIT_POLL_INTERVAL_MS) {}

    mayRun(id: string, now: number): boolean {
        const previous = this.last.get(id);
        if (previous !== undefined && now - previous < this.intervalMs) return false;
        this.last.set(id, now);
        return true;
    }

    forget(id: string): void {
        this.last.delete(id);
    }
}
