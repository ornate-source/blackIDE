import { GovernorSnapshot } from './agent-governor';
import { InboxItem, InboxReason, inboxCounts } from './agent-inbox';
import { PipelineRunSummary } from './pipeline-runs';
import {
    TaskAgentSummary, canApply, canCancel, canDiscard, holdsWorktree, isTerminalStatus,
} from './task-agents';
import { Activity } from './office-narrate';

// ─── The Agent Office's work-item model ─────────────────────────────────────
//
// Four lanes — task agents, pipeline runs, chat subagents, the daemon — projected onto
// **one row type**. The lane is a *field*, not a different card.
//
// ── Why one row type ─────────────────────────────────────────────────────────
// A pipeline phase has no worktree, so it shows no worktree button — not a greyed one. A
// daemon result has no live turn, so its progress cell is absent, not `0/25`. The lane
// decides which cells have referents; it does not get its own layout. Four card layouts is
// how the three existing agent surfaces (`ManagerPanel`, `ParallelSubagents`,
// `PipelineLogPanel`) drifted apart in the first place, and consolidating them is most of
// the point of this module.
//
// ── The two rules this file enforces on behalf of the UI ─────────────────────
// **R1 — no metric without a source.** Every optional field here is optional *because the
// runtime may genuinely not publish it*, and the renderer is required to show `—` rather
// than a default. `progress` is undefined for a lane that reports no turn; it is never
// `{ turn: 0 }`.
//
// **R2 — no affordance without a transition.** `affordancesFor` is the single place that
// decides which buttons exist, and it derives every one from the `can*` predicates already
// exported by `task-agents.ts`. A renderer that adds a button of its own is a bug the
// affordance test will catch.
//
// Pure and vscode-free, like `agent-inbox.ts` and `task-agents.ts` — the isolation and
// ordering guarantees have to be testable without a webview, a repo, or a clock.

export type WorkLane = 'task' | 'pipeline' | 'chat' | 'daemon';

/**
 * The desk's status vocabulary — deliberately *not* the union of the lanes' own statuses.
 *
 * `ready` is the case the whole inbox exists for: finished, nothing wrong, nothing on a
 * timer, and the work quietly never lands. It is a different thing from `done` (finished
 * and already applied or discarded) and the desk must not render them alike.
 */
export type WorkStatus =
    | 'queued'
    | 'running'
    | 'needs_you'
    | 'ready'
    | 'done'
    | 'failed'
    | 'cancelled';

export type Affordance =
    | 'steer' | 'stop' | 'diff' | 'worktree' | 'logs'
    | 'apply' | 'discard' | 'openBranch' | 'retry'
    | 'readPlan' | 'approve' | 'reject' | 'dismiss';

export interface WorkProgress {
    /** 1-based, as the loop counts them. */
    turn: number;
    maxTurns: number;
}

export interface WorkContext {
    usedTokens: number;
    limitTokens: number;
    /** 0–100, pre-computed so three surfaces cannot round it three ways. */
    percent: number;
}

export interface WorkDelta {
    files: number;
    insertions: number;
    deletions: number;
}

export interface WorkEvidence {
    outcome: 'verified' | 'failed' | 'unverifiable' | 'incomplete';
    testsRan: boolean;
    passed?: number;
    failed?: number;
    reportPath?: string;
}

export interface WorkItem {
    /** The real handle — `ta_m4x1`, `pr_88f`, `sa_…`, `dm_0142`. Never a synthetic id. */
    id: string;
    lane: WorkLane;
    /** The desk's occupant: a mode name, or a pipeline phase name. */
    role: string;
    title: string;
    status: WorkStatus;
    model?: string;
    rootPath?: string;
    /** R5 — rendered on everything that has one. It is the recovery path, not metadata. */
    branch?: string;
    startedAt: number;
    endedAt?: number;
    /** The sentence on the desk. Undefined while nothing is in flight. */
    activity?: Activity;
    progress?: WorkProgress;
    context?: WorkContext;
    delta?: WorkDelta;
    evidence?: WorkEvidence;
    tokens?: number;
    costUsd?: number;
    error?: string;
    /** The inbox's reason, when this item is in the inbox. */
    needs?: InboxReason;
    /** Position within a sequential pipeline. R3: a position, never a scheduler. */
    phase?: { name: string; index: number; total: number };
    affordances: Affordance[];
}

/** A desk on the floor: an item, or an empty seat up to the governor's cap. */
export interface Desk {
    kind: 'occupied' | 'free';
    item?: WorkItem;
}

export interface OfficeSnapshot {
    items: WorkItem[];
    desks: Desk[];
    governor?: GovernorSnapshot;
    inbox: InboxItem[];
    counts: { total: number; blocking: number; review: number; failed: number };
    /** Live items, for the status bar and the sidebar's `3/4`. */
    running: number;
    capacity: number;
}

export interface OfficeInput {
    agents?: TaskAgentSummary[];
    pipelines?: PipelineRunSummary[];
    chat?: ChatSubagentSummary[];
    daemon?: DaemonResultSummary[];
    inbox?: InboxItem[];
    governor?: GovernorSnapshot;
    /** Live per-item telemetry the lane summaries cannot carry (§5 of the design record). */
    live?: Record<string, LiveTelemetry>;
    /** Ordered phase list for a pipeline run, when one is known. */
    phases?: Record<string, { names: string[]; current?: string }>;
    now?: number;
}

/** What the telemetry channel adds to a summary while a run is in flight. */
export interface LiveTelemetry {
    activity?: Activity;
    progress?: WorkProgress;
    context?: WorkContext;
    delta?: WorkDelta;
    model?: string;
}

/** The chat lane's subagents, structurally typed — they live in the editor half today. */
export interface ChatSubagentSummary {
    id: string;
    name: string;
    task: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    progress?: string;
    startedAt?: number;
}

/** A daemon result, as `daemon-protocol.ts` projects it. */
export interface DaemonResultSummary {
    id: string;
    title: string;
    status?: string;
    seen?: boolean;
    startedAt?: number;
    endedAt?: number;
    rootPath?: string;
    branch?: string;
    delta?: WorkDelta;
}

/**
 * Everything the Office renders, in one ordered roster.
 *
 * Ordering is **live work first, then the rest newest-first** — and note what it is
 * deliberately *not*: it is not the inbox's ordering. The inbox sorts by urgency and the
 * Front Desk renders that order unchanged (`agent-inbox.ts:124-129`); the floor answers a
 * different question ("what is everything doing?") and sorting it by urgency would make
 * the desks jump around as items block and unblock, which is the one thing a live view
 * must not do.
 */
export function buildOffice(input: OfficeInput): OfficeSnapshot {
    const now = input.now ?? Date.now();
    const live = input.live || {};
    const needs = new Map<string, InboxReason>();
    for (const item of input.inbox || []) needs.set(item.id, item.reason);

    const items: WorkItem[] = [
        ...(input.agents || []).map(a => fromTaskAgent(a, live[a.id], needs.get(a.id))),
        ...(input.pipelines || []).map(p => fromPipeline(p, live[p.id], needs.get(p.id), input.phases?.[p.id])),
        ...(input.chat || []).map(c => fromChatSubagent(c, live[c.id], now)),
        ...(input.daemon || []).map(d => fromDaemon(d, needs.get(d.id))),
    ];

    items.sort(byFloorOrder);

    const inbox = input.inbox || [];
    const running = items.filter(isLive).length;
    const capacity = input.governor?.maxConcurrent ?? running;

    return {
        items,
        desks: buildDesks(items, capacity),
        governor: input.governor,
        inbox,
        counts: inboxCounts(inbox),
        running,
        capacity,
    };
}

/**
 * The desks: every live item gets one, and the remaining capacity is drawn as empty seats.
 *
 * Empty seats are rendered rather than implied because "three of four busy" is a fact the
 * user can act on — launching a fourth agent is free, launching a fifth is refused by the
 * governor — and an implicit capacity is one they have to remember. When more items are
 * live than the cap allows (the cap was lowered mid-flight, which `AgentGovernor.configure`
 * explicitly permits) there are simply no free seats; we never render a negative one.
 */
export function buildDesks(items: WorkItem[], capacity: number): Desk[] {
    const occupied = items.filter(isLive).map<Desk>(item => ({ kind: 'occupied', item }));
    // Finished-but-unreviewed work keeps a visible seat: it is the case the inbox exists
    // for, and hiding it the instant the run ends is how the work never lands.
    const reviewable = items.filter(i => i.status === 'ready').map<Desk>(item => ({ kind: 'occupied', item }));
    const free = Math.max(0, capacity - occupied.length);
    return [
        ...occupied,
        ...reviewable,
        ...Array.from({ length: free }, () => ({ kind: 'free' as const })),
    ];
}

/** Whether this item holds a concurrency slot right now. */
export function isLive(item: WorkItem): boolean {
    return item.status === 'running' || item.status === 'queued' || item.status === 'needs_you';
}

/** What the always-on status bar entry reads (M73). */
export interface OfficeStatus {
    /** The label, already assembled. `◆ Office` at its shortest. */
    text: string;
    tooltip: string;
    /** Items the user has to deal with: blocked, parked, or failed. */
    attention: number;
    /** True when a ceiling is hit, so the host can tint the entry. */
    exhausted: boolean;
}

/**
 * The status bar entry — the one Office surface that is always open.
 *
 * Every other surface in this file is a projection somebody chose to look at. This one is
 * on screen whether or not the user has thought about agents today, which makes it the
 * only place the *absence* of a panel is not also the absence of the information — and
 * therefore the only place that can honestly claim "you would have been told".
 *
 * ── R1 applies here more sharply than anywhere else ──────────────────────────
 * Four characters of ambient reassurance is a design decision, not a fallback. A status
 * bar entry that reads `◆ Office 0▸ 0!` when nothing has ever run trains the user to stop
 * reading it, and the one time it says `1!` they will not notice. So each segment appears
 * only when it has a non-zero value drawn from a field that was actually published:
 * `active` from the governor, `attention` from `inboxCounts`. With no governor snapshot
 * there is no number to show, and none is invented.
 *
 * ── Why `blocking + failed` and not `total` ──────────────────────────────────
 * `counts.review` is work that finished and is waiting to be looked at. It is real, it is
 * in the Front Desk, and it is deliberately not in the badge: nothing is stuck, nothing is
 * on a timer, and a permanently non-zero badge is an ignored badge. `blocking` and
 * `failed` are the two states where time is being wasted right now.
 */
export function officeStatus(snapshot: Pick<OfficeSnapshot, 'governor' | 'counts'>): OfficeStatus {
    const governor = snapshot.governor;
    const attention = snapshot.counts.blocking + snapshot.counts.failed;

    /*
     * Segments, in the order §7.1 of the design record draws them, each omitted when it
     * has nothing to say. The wireframe's three examples are the three that fall out:
     * `◆ Office`, `◆ Office 3▸`, `◆ Office ⛔ budget`.
     *
     * Exhaustion leads because it is the state that changes what the *user* can do — a
     * launch will be refused — while the counters describe what the machine is doing.
     * They compose rather than replace: an exhausted governor with three agents still
     * running and one failure is all three facts at once, and dropping two of them to
     * match a wireframe row would be the surface deciding which of the user's problems
     * is worth mentioning.
     */
    const segments = [
        governor?.exhausted ? '⛔ budget' : '',
        governor && governor.active > 0 ? `${governor.active}▸` : '',
        attention > 0 ? `${attention}!` : '',
    ].filter(Boolean);

    return {
        text: ['◆ Office', ...segments].join(' '),
        tooltip: officeTooltip(governor, snapshot.counts, attention),
        attention,
        exhausted: !!governor?.exhausted,
    };
}

/**
 * The hover, which is where the numbers get their names.
 *
 * The label is four characters and two glyphs; without this, `3▸ 1!` is a rebus. Built
 * from the same two sources as the label so the two cannot disagree.
 */
function officeTooltip(
    governor: GovernorSnapshot | undefined,
    counts: OfficeSnapshot['counts'],
    attention: number,
): string {
    const lines = ['Agent Office'];

    if (governor) {
        lines.push(`${governor.active} of ${governor.maxConcurrent} slots running`);
        // Budgets of zero mean "unlimited" in `agent-governor.ts`, so a `$0.19 / $0.00`
        // line would read as an overrun. Stated only when there is a ceiling to state.
        if (governor.costBudget > 0) {
            lines.push(`$${governor.costSpent.toFixed(2)} of $${governor.costBudget.toFixed(2)} spent`);
        }
        if (governor.exhausted) lines.push('Budget spent — nothing further will start');
    }

    if (attention > 0) {
        const parts: string[] = [];
        if (counts.blocking > 0) parts.push(`${counts.blocking} waiting on you`);
        if (counts.failed > 0) parts.push(`${counts.failed} failed`);
        lines.push(parts.join(', '));
    }
    if (counts.review > 0) lines.push(`${counts.review} finished, ready to review`);

    lines.push('Click to open the Front Desk');
    return lines.join('\n');
}

/**
 * The buttons an item actually has.
 *
 * R2 lives here and only here. Every entry is derived from a predicate that already
 * governs the transition, so a button cannot exist for an operation the state machine
 * would refuse. Disabled buttons are never produced: they teach the user that a capability
 * exists and that they did something wrong, when in fact it does not apply.
 */
export function affordancesFor(
    lane: WorkLane,
    agent?: TaskAgentSummary,
    status?: WorkStatus,
): Affordance[] {
    // The log exists for every item in every state — including, especially, a failed one.
    const out: Affordance[] = ['logs'];

    if (lane === 'task' && agent) {
        if (canCancel(agent)) { out.push('steer', 'stop'); }
        if (canApply(agent)) out.push('apply');
        if (agent.resultSha || agent.diff) out.push('diff');
        if (holdsWorktree(agent)) out.push('worktree');
        if (agent.status === 'failed') out.push('openBranch', 'retry');
        if (canDiscard(agent)) out.push('discard');
        return dedupe(out);
    }

    if (lane === 'pipeline') {
        if (status === 'needs_you') out.push('readPlan', 'approve', 'reject');
        else if (status === 'running' || status === 'queued') out.push('stop');
        return dedupe(out);
    }

    if (lane === 'chat') {
        if (status === 'running') out.push('stop');
        return dedupe(out);
    }

    // Daemon results are already-finished work someone else produced. There is nothing to
    // steer and nothing to stop; the only verbs are look at it and make it go away.
    if (status === 'ready') out.push('apply', 'diff', 'discard');
    out.push('dismiss');
    return dedupe(out);
}

// ── Per-lane projections ────────────────────────────────────────────────────

function fromTaskAgent(
    agent: TaskAgentSummary,
    live: LiveTelemetry | undefined,
    needs: InboxReason | undefined,
): WorkItem {
    const status = taskStatus(agent);
    return {
        id: agent.id,
        lane: 'task',
        role: agent.mode || 'Agent',
        title: agent.prompt,
        status,
        model: live?.model || agent.modelId,
        rootPath: agent.rootPath,
        branch: agent.branch,
        startedAt: agent.startedAt,
        endedAt: agent.endedAt,
        // The live channel wins over the summary: `currentAction` holds a tool *name* only
        // (`task-agent-registry.ts:355`), so a narrated activity with a real target is
        // strictly better information about the same instant.
        activity: live?.activity ?? nameOnlyActivity(agent.currentAction),
        progress: live?.progress,
        context: live?.context,
        delta: live?.delta ?? agent.diff,
        evidence: agent.verification,
        tokens: agent.tokens,
        costUsd: agent.costUsd,
        error: agent.error,
        needs,
        affordances: affordancesFor('task', agent, status),
    };
}

function fromPipeline(
    run: PipelineRunSummary,
    live: LiveTelemetry | undefined,
    needs: InboxReason | undefined,
    phases: { names: string[]; current?: string } | undefined,
): WorkItem {
    const status = pipelineStatus(run);
    const current = phases?.current ?? run.currentPhase;
    const index = phases?.names.indexOf(current || '') ?? -1;
    return {
        id: run.id,
        lane: 'pipeline',
        // The phase *is* the occupant: `Frontend Executor` is who is at the desk, and it
        // is a literal in `pipeline-orchestrator.ts`, not a label invented here.
        role: current || 'Pipeline',
        title: run.prompt,
        status,
        model: live?.model || run.modelId,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        activity: live?.activity,
        progress: live?.progress,
        context: live?.context,
        error: run.error,
        needs,
        phase: phases && index >= 0
            ? { name: current || '', index: index + 1, total: phases.names.length }
            : undefined,
        affordances: affordancesFor('pipeline', undefined, status),
    };
}

function fromChatSubagent(sub: ChatSubagentSummary, live: LiveTelemetry | undefined, now: number): WorkItem {
    const status: WorkStatus =
        sub.status === 'running' ? 'running'
        : sub.status === 'completed' ? 'done'
        : sub.status === 'cancelled' ? 'cancelled'
        : 'failed';
    return {
        id: sub.id,
        lane: 'chat',
        role: sub.name || 'Subagent',
        title: sub.task,
        status,
        startedAt: sub.startedAt ?? now,
        activity: live?.activity,
        progress: live?.progress,
        context: live?.context,
        // The chat lane reports free-text progress rather than a structured event, so it
        // becomes the error line on a failure and is otherwise left to the activity.
        error: status === 'failed' ? sub.progress : undefined,
        affordances: affordancesFor('chat', undefined, status),
    };
}

function fromDaemon(result: DaemonResultSummary, needs: InboxReason | undefined): WorkItem {
    const status: WorkStatus = result.seen ? 'done' : 'ready';
    return {
        id: result.id,
        lane: 'daemon',
        role: 'Daemon',
        title: result.title,
        status,
        rootPath: result.rootPath,
        branch: result.branch,
        startedAt: result.startedAt ?? result.endedAt ?? 0,
        endedAt: result.endedAt,
        delta: result.delta,
        needs,
        affordances: affordancesFor('daemon', undefined, status),
    };
}

// ── Status mapping ──────────────────────────────────────────────────────────

function taskStatus(agent: TaskAgentSummary): WorkStatus {
    if (agent.status === 'awaiting_approval') return 'needs_you';
    if (agent.status === 'running') return 'running';
    if (agent.status === 'queued') return 'queued';
    if (agent.status === 'failed') return 'failed';
    if (agent.status === 'cancelled') return 'cancelled';
    // `completed` splits in two, and the split is the whole reason this vocabulary is not
    // the lane's own: work that can still be applied is *waiting on the user*, work that
    // has been applied or discarded is finished. One deserves a desk, the other a row.
    return canApply(agent) ? 'ready' : 'done';
}

function pipelineStatus(run: PipelineRunSummary): WorkStatus {
    switch (run.status) {
        case 'awaiting_approval': return 'needs_you';
        case 'running': return 'running';
        case 'failed': return 'failed';
        case 'cancelled': return 'cancelled';
        default: return 'done';
    }
}

/**
 * The task lane's `currentAction` as an activity with no target.
 *
 * This is R1 made concrete: until the lane forwards `ToolStarted.arguments`, the desk can
 * honestly say `editing —` and must not say `editing something`. The narrator is not used
 * here because there are no arguments to narrate — deriving the verb without a target
 * would render the same sentence as a fully-instrumented agent and hide the difference.
 */
function nameOnlyActivity(currentAction: string | undefined): Activity | undefined {
    const tool = String(currentAction || '').trim();
    return tool ? { tool, verb: tool } : undefined;
}

// ── Ordering ────────────────────────────────────────────────────────────────

const STATUS_ORDER: Record<WorkStatus, number> = {
    running: 0, needs_you: 1, queued: 2, ready: 3, failed: 4, cancelled: 5, done: 6,
};

/**
 * Live work first, then whatever needs a look, then history newest-first.
 *
 * Within a group the tie-break is `startedAt` **ascending for live work** (the oldest
 * running agent is the one closest to finishing, and it should not migrate down the floor
 * as newer ones launch) and **descending for finished work** (there, the user is looking
 * for what just landed).
 */
function byFloorOrder(a: WorkItem, b: WorkItem): number {
    const rank = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (rank !== 0) return rank;
    const liveGroup = isLive(a);
    return liveGroup ? a.startedAt - b.startedAt : (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);
}

function dedupe(list: Affordance[]): Affordance[] {
    return Array.from(new Set(list));
}

/** Re-exported so a caller needing "is this finished" does not import two modules. */
export { isTerminalStatus };
