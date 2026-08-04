import { AgentGovernor } from '../core/agent-governor';
import { SteeringNote, SteeringQueue } from '../core/steering';
import {
    TaskAgentDiff, TaskAgentSummary, activeAgents, branchNameFor, canApply, canCancel,
    canDiscard, holdsWorktree, isTerminalStatus, newAgentId, reconcileInterruptedAgents,
} from '../core/task-agents';

// ─── The task-agent lane (Phase 6, M31/M32) ─────────────────────────────────
//
// `ManagedRunRegistry` owns pipeline runs. This owns task agents: independent jobs the
// user launched, each in its own worktree, each on its own model, each against its own
// declared workspace root. Two registries rather than one because the two things have
// genuinely different lifecycles — a pipeline has phases, an approval gate and a
// deterministic plan; a task agent has none of those and has something a pipeline does
// not, which is a *pending result the user has to accept or throw away*.
//
// ── Where the isolation guarantee actually lives ─────────────────────────────
// The gate says: 4 concurrent agents → 4 independently mergeable worktrees, kill-one
// isolation holds, and the live workspace is untouched until an explicit apply.
//
//   - **Isolation** is the worktree, plus the fact that the agent's executor is handed
//     `cwd = worktreeDir` and never the live root. Every file tool and every command it
//     runs resolves inside there. Nothing about that is enforced by convention.
//   - **Kill-one** is one `AbortController` per agent. There is no shared signal to get
//     wrong.
//   - **Untouched-until-apply** is that no code path from "the run finished" reaches the
//     live tree. `apply()` is the only caller of the delta operation, and `canApply`
//     guards it.
//
// Every git operation is injected (`TaskWorktreeOps`) so the whole lifecycle — including
// the failure paths, which are the ones that matter — is testable without a repo.

export interface TaskWorktreeOps {
    create(branch: string, root: string): Promise<string>;
    /** Copy the live tree's uncommitted state in, so the agent starts from what the user sees. */
    sync(branch: string, root: string): Promise<void>;
    commit(branch: string, message: string, root: string): Promise<string>;
    diffStat(branch: string, fromRef: string, toRef: string, root: string): Promise<TaskAgentDiff>;
    /** The one operation that writes to the user's workspace. */
    apply(branch: string, fromRef: string, toRef: string, root: string): Promise<void>;
    remove(branch: string, root: string): Promise<void>;
}

export interface TaskRunParams {
    agentId: string;
    prompt: string;
    modelId: string;
    mode: string;
    /** The worktree. The agent's executor gets this as its root, never `rootPath`. */
    cwd: string;
    /** The live root this agent declared (M36), for reporting and for git. */
    rootPath: string;
    signal: AbortSignal;
    emit(event: any): void;
    onUsage?(tokens: number, costUsd: number): void;
    /** The verify step's finding (Phase 7, M40), recorded on the agent summary. */
    onVerified?(verification: TaskAgentSummary['verification']): void;
    /** The user's mid-run corrections for this agent (Phase 7, M39). */
    steering: SteeringQueue;
}

export interface TaskAgentDeps {
    governor: AgentGovernor;
    worktree: TaskWorktreeOps;
    runTask(params: TaskRunParams): Promise<void>;
    /** Durable storage for summaries across reloads. */
    load(): TaskAgentSummary[];
    save(agents: TaskAgentSummary[]): void;
    /** Fired on every state change, so the panel can re-render. */
    onChanged?(agents: TaskAgentSummary[]): void;
    /**
     * Every event the run publishes, forwarded verbatim (M76).
     *
     * Separate from `onChanged` because these are two different cadences carrying two
     * different things: `onChanged` is a *state* change and re-pushes the whole summary
     * array, while this is a *stream* — a tool starting, a turn beginning, a file moving —
     * which the Office coalesces into per-item patches. Routing the stream through
     * `onChanged` would mean persisting the agent history to `globalState` on every tool
     * call, which is the cost §2.1 of the design record exists to avoid.
     */
    onEvent?(agentId: string, event: any): void;
    now?(): number;
}

export interface LaunchRequest {
    prompt: string;
    modelId: string;
    mode?: string;
    rootPath: string;
    raceId?: string;
}

const MAX_HISTORY = 50;

export class TaskAgentRegistry {
    /** Live agents, including their non-serializable handles. */
    private readonly live = new Map<string, {
        summary: TaskAgentSummary;
        abort: AbortController;
        release: () => void;
        /** Mid-run corrections for this agent (M39). Per-agent: a correction meant for one
         *  of four concurrent runs must not reach the other three. */
        steering: SteeringQueue;
    }>();
    /** Everything else, including this session's finished agents. */
    private history: TaskAgentSummary[];

    constructor(private readonly d: TaskAgentDeps) {
        // Anything left non-terminal by a previous host is not running now, whatever it
        // says — but its worktree is still on disk, which is what the message explains.
        this.history = reconcileInterruptedAgents(this.d.load(), this.now());
        this.d.save(this.history);
    }

    private now(): number {
        return this.d.now ? this.d.now() : Date.now();
    }

    /**
     * Launch an agent, or explain why not.
     *
     * The concurrency slot is claimed *before* the worktree is created, because worktree
     * creation is the expensive part and admitting an agent that will be refused after
     * spending a `git worktree add` is the worst ordering available.
     */
    launch(request: LaunchRequest): { agent: TaskAgentSummary } | { error: string } {
        if (!request.rootPath) {
            return { error: 'This agent has no workspace root. Open a folder, or pick which root it should work in.' };
        }

        const admission = this.d.governor.reserve('task');
        if (!admission.ok) return { error: admission.message };

        const id = newAgentId(this.now());
        const summary: TaskAgentSummary = {
            id,
            prompt: request.prompt,
            modelId: request.modelId,
            mode: request.mode || 'Agent',
            rootPath: request.rootPath,
            branch: branchNameFor(id),
            status: 'queued',
            startedAt: this.now(),
            raceId: request.raceId,
        };

        this.live.set(id, { summary, abort: new AbortController(), release: admission.release, steering: new SteeringQueue() });
        this.emitChanged();

        // Fire and forget: the caller is a webview message handler and must not block on
        // the run. Every outcome, including a thrown one, is recorded on the summary.
        void this.run(id);
        return { agent: summary };
    }

    /**
     * Kill one agent. Its worktree is deliberately preserved — see `canApply`.
     *
     * The status flips to `cancelled` *here*, not when the run gets around to noticing.
     * Two reasons, and the second is the load-bearing one: the user pressed cancel and the
     * panel should say so immediately rather than after the next turn completes; and a
     * task that never observes its signal would otherwise sit `running` forever, which is
     * a state nothing in this class could ever clear.
     *
     * The concurrency slot is deliberately *not* freed here. Status is the user's
     * intent and can be known at once; the slot is the machine's reality, and a run whose
     * final turn is still streaming is still spending. Releasing early would let a fifth
     * agent start against a cap of four.
     */
    cancel(id: string): void {
        const entry = this.live.get(id);
        if (!entry || !canCancel(entry.summary)) return;
        entry.abort.abort();
        this.update(id, { status: 'cancelled', endedAt: this.now(), currentAction: undefined });
    }

    /**
     * Merge an agent's work into the live workspace. **The only writer.**
     *
     * Re-checks `canApply` rather than trusting the caller: the button that triggers this
     * lives in a webview whose state can be a few hundred milliseconds stale, and "apply
     * an agent that was already applied" would replay a patch onto a tree that has it.
     */
    async apply(id: string): Promise<{ ok: true } | { error: string }> {
        const agent = this.find(id);
        if (!agent) return { error: 'That agent is no longer tracked.' };
        if (!canApply(agent)) {
            return { error: agent.appliedAt ? 'That agent\'s work has already been applied.'
                : agent.discardedAt ? 'That agent\'s work was discarded.'
                : `Only a completed agent can be applied — this one is ${agent.status}.` };
        }
        if (!agent.baselineSha || !agent.resultSha) {
            return { error: 'That agent has no recorded baseline, so its work cannot be applied automatically. '
                + `It is on branch "${agent.branch}".` };
        }

        try {
            await this.d.worktree.apply(agent.branch, agent.baselineSha, agent.resultSha, agent.rootPath);
        } catch (err: any) {
            // The worktree is left alone on failure. Its branch still holds the work, and
            // removing it here would destroy the only copy of an edit that failed to merge
            // — which is precisely when the user needs it most.
            return { error: `Could not apply this agent's work: ${err?.message || err}. `
                + `It is preserved on branch "${agent.branch}".` };
        }

        this.update(id, { appliedAt: this.now() });
        // Only now is the worktree redundant: its content is in the live tree.
        await this.d.worktree.remove(agent.branch, agent.rootPath).catch(() => {});
        return { ok: true };
    }

    /** Throw the work away. The other one-way exit. */
    async discard(id: string): Promise<{ ok: true } | { error: string }> {
        const agent = this.find(id);
        if (!agent) return { error: 'That agent is no longer tracked.' };
        if (!canDiscard(agent)) return { error: 'That agent has already been applied or discarded.' };

        // Cancel first: discarding a *running* agent has to stop it, or `git worktree
        // remove` races a process still writing into that directory.
        this.cancel(id);
        if (holdsWorktree(agent)) {
            await this.d.worktree.remove(agent.branch, agent.rootPath).catch(() => {});
        }
        this.update(id, { discardedAt: this.now() });
        return { ok: true };
    }

    /**
     * Send the user's correction to a running agent (M39).
     *
     * Only a *live* agent can be steered: a finished run has no next turn to inject into,
     * and silently accepting a comment that will never be delivered is worse than refusing
     * it — the user would believe the agent had been told.
     */
    steer(id: string, text: string, options: { artifactPath?: string; region?: string } = {}): { ok: true } | { error: string } {
        const entry = this.live.get(id);
        if (!entry) return { error: 'That agent has finished — there is no turn left to steer.' };
        if (isTerminalStatus(entry.summary.status)) return { error: `That agent is ${entry.summary.status}.` };
        const note = entry.steering.add(text, options);
        if (!note) return { error: 'The comment was empty.' };
        return { ok: true };
    }

    /** How many corrections are queued for an agent, for the panel. */
    pendingSteering(id: string): number {
        return this.live.get(id)?.steering.pending ?? 0;
    }

    /**
     * Agents a comment can still reach, for the review panel (M38).
     *
     * Derived from the same `live` map and the same terminal-status test `steer` uses, so
     * the panel's "this run is live" badge and the steer call's own answer cannot disagree.
     * Two independent notions of live is how a UI comes to offer an action that always
     * fails.
     */
    liveIds(): string[] {
        return Array.from(this.live.entries())
            .filter(([, entry]) => !isTerminalStatus(entry.summary.status))
            .map(([id]) => id);
    }

    list(): TaskAgentSummary[] {
        const live = Array.from(this.live.values()).map(e => e.summary);
        const byId = new Map<string, TaskAgentSummary>();
        for (const agent of this.history) byId.set(agent.id, agent);
        for (const agent of live) byId.set(agent.id, agent);
        return Array.from(byId.values()).sort((a, b) => a.startedAt - b.startedAt);
    }

    find(id: string): TaskAgentSummary | undefined {
        return this.live.get(id)?.summary ?? this.history.find(a => a.id === id);
    }

    /** Agents in a given race (M37). */
    inRace(raceId: string): TaskAgentSummary[] {
        return this.list().filter(a => a.raceId === raceId);
    }

    active(): TaskAgentSummary[] {
        return activeAgents(this.list());
    }

    // ── The run itself ──────────────────────────────────────────────────────

    private async run(id: string): Promise<void> {
        const entry = this.live.get(id);
        if (!entry) return;
        const { summary, abort } = entry;

        let worktreeCreated = false;
        try {
            this.update(id, { status: 'running' });

            const dir = await this.d.worktree.create(summary.branch, summary.rootPath);
            worktreeCreated = true;
            // `git worktree add` clones committed HEAD only, so without this the agent
            // starts from a tree that is missing everything the user has not committed —
            // which for most working repos is the thing they asked it to change.
            await this.d.worktree.sync(summary.branch, summary.rootPath);
            const baselineSha = await this.d.worktree.commit(summary.branch, 'blackide: agent baseline', summary.rootPath);
            this.update(id, { baselineSha });

            if (abort.signal.aborted) throw new AbortError();

            await this.d.runTask({
                agentId: id,
                prompt: summary.prompt,
                modelId: summary.modelId,
                mode: summary.mode,
                cwd: dir,
                rootPath: summary.rootPath,
                signal: abort.signal,
                emit: (event) => this.onEvent(id, event),
                steering: entry.steering,
                onVerified: (verification) => this.update(id, { verification }),
                onUsage: (tokens, cost) => {
                    this.d.governor.charge(tokens, cost);
                    const current = this.find(id);
                    this.update(id, {
                        tokens: (current?.tokens || 0) + tokens,
                        costUsd: (current?.costUsd || 0) + cost,
                    });
                },
            });

            const resultSha = await this.d.worktree.commit(summary.branch, `blackide: ${summary.prompt.slice(0, 60)}`, summary.rootPath);
            const diff = await this.d.worktree.diffStat(summary.branch, this.find(id)?.baselineSha || baselineSha, resultSha, summary.rootPath);

            this.update(id, {
                // An abort that arrived while the last turn was in flight still means
                // cancelled: the work is committed and keepable, but reporting it as
                // completed would invite an apply of a run the user stopped.
                status: abort.signal.aborted ? 'cancelled' : 'completed',
                resultSha,
                diff,
                endedAt: this.now(),
                currentAction: undefined,
            });
        } catch (err: any) {
            const aborted = abort.signal.aborted || err instanceof AbortError;
            // A committed snapshot even on failure, so partial work is recoverable rather
            // than left as uncommitted state inside a worktree nobody will look in.
            if (worktreeCreated) {
                try {
                    const resultSha = await this.d.worktree.commit(summary.branch, 'blackide: agent stopped', summary.rootPath);
                    this.update(id, { resultSha });
                } catch { /* the worktree may be gone; the status below is what matters */ }
            }
            this.update(id, {
                status: aborted ? 'cancelled' : 'failed',
                error: aborted ? undefined : String(err?.message || err),
                endedAt: this.now(),
                currentAction: undefined,
            });
        } finally {
            // The slot is freed when the *run* ends, not when the result is applied. An
            // agent waiting for a human is not consuming a model or a CPU, and holding its
            // slot would let four unreviewed results block every further launch.
            entry.release();
            this.retire(id);
        }
    }

    private onEvent(id: string, event: any): void {
        if (event?.type === 'ToolCallStarted' && event.name) {
            this.update(id, { currentAction: String(event.name) });
        }
        // Forwarded whole, and after the summary update rather than before: a subscriber
        // that reacts by reading `find(id)` must not see a summary one event behind the
        // event it was just handed.
        try { this.d.onEvent?.(id, event); } catch { /* a telemetry subscriber must never fail a run */ }
    }

    // ── State bookkeeping ───────────────────────────────────────────────────

    private update(id: string, patch: Partial<TaskAgentSummary>): void {
        const entry = this.live.get(id);
        if (entry) {
            entry.summary = { ...entry.summary, ...patch };
        } else {
            const index = this.history.findIndex(a => a.id === id);
            if (index === -1) return;
            this.history[index] = { ...this.history[index], ...patch };
        }
        this.persist();
        this.emitChanged();
    }

    /** Move a finished agent out of the live map, keeping its summary in history. */
    private retire(id: string): void {
        const entry = this.live.get(id);
        if (!entry || !isTerminalStatus(entry.summary.status)) return;
        this.live.delete(id);
        this.history = [...this.history.filter(a => a.id !== id), entry.summary];
        this.persist();
        this.emitChanged();
    }

    private persist(): void {
        const live = Array.from(this.live.values()).map(e => e.summary);
        const byId = new Map<string, TaskAgentSummary>();
        for (const agent of this.history) byId.set(agent.id, agent);
        for (const agent of live) byId.set(agent.id, agent);
        const all = Array.from(byId.values()).sort((a, b) => a.startedAt - b.startedAt);
        // Cap by dropping the oldest *retired* agents. Trimming a live one would make it
        // vanish from the panel while it was still running.
        const liveIds = new Set(live.map(a => a.id));
        const retired = all.filter(a => !liveIds.has(a.id));
        const keep = retired.length > MAX_HISTORY ? retired.slice(retired.length - MAX_HISTORY) : retired;
        this.history = keep;
        this.d.save(all.filter(a => liveIds.has(a.id) || keep.includes(a)));
    }

    private emitChanged(): void {
        this.d.onChanged?.(this.list());
    }
}

/** Distinguishes "the user cancelled" from a real failure on the throw path. */
class AbortError extends Error {
    constructor() { super('Cancelled'); this.name = 'AbortError'; }
}
