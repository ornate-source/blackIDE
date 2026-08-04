import { describe, expect, it } from 'vitest';
import { PipelineRunSummary } from '@blackide/agent-core/core/pipeline-runs';
import { TaskAgentSummary, canApply, canCancel, canDiscard, holdsWorktree } from '@blackide/agent-core/core/task-agents';
import { buildInbox } from '@blackide/agent-core/core/agent-inbox';
import { GovernorSnapshot } from '@blackide/agent-core/core/agent-governor';
import {
    Affordance, WorkItem, affordancesFor, buildDesks, buildOffice, isLive,
} from '@blackide/agent-core/core/office-model';
import {
    SLOW_AFTER_MS, STALLED_AFTER_MS, describeActivity, narrate, splitTarget, staleness,
} from '@blackide/agent-core/core/office-narrate';

/**
 * The Agent Office's pure half.
 *
 * Two rules from the design record are asserted here as tests rather than left as
 * conventions, because both were broken by a previous revision of the design and neither
 * is visible in a screenshot:
 *
 *   **R1 — no metric without a source.** A field the runtime does not publish must arrive
 *   at the renderer as `undefined`, never as `0` and never as a plausible default. A
 *   missing measurement and a measured zero are different facts.
 *
 *   **R2 — no affordance without a transition.** The button set is derived from the `can*`
 *   predicates that already govern the state machine, so a surface cannot offer an
 *   operation the runtime would refuse.
 */

const task = (over: Partial<TaskAgentSummary> = {}): TaskAgentSummary => ({
    id: 'ta_1', prompt: 'add retry logic', modelId: 'sonnet', mode: 'Backend', rootPath: '/repo',
    branch: 'blackide/agent/ta_1', status: 'running', startedAt: 1_000, ...over,
});

const pipeline = (over: Partial<PipelineRunSummary> = {}): PipelineRunSummary => ({
    id: 'pr_1', prompt: 'ship the settings redesign', modelId: 'sonnet', status: 'running', startedAt: 1_000, ...over,
});

const governor = (over: Partial<GovernorSnapshot> = {}): GovernorSnapshot => ({
    active: 1, maxConcurrent: 4, tokensSpent: 100, tokenBudget: 0,
    costSpent: 0.5, costBudget: 5, exhausted: false, ...over,
});

// ── Narration ───────────────────────────────────────────────────────────────

describe('narrating a tool call', () => {
    it('says what a person would say, and keeps the real tool name alongside', () => {
        const activity = narrate({ name: 'read_file', arguments: { path: 'src/store/apiSlice.tsx' } });
        expect(activity).toMatchObject({ tool: 'read_file', verb: 'opened', label: 'apiSlice.tsx', dir: 'src/store/' });
        expect(describeActivity(activity)).toBe('opened apiSlice.tsx');
    });

    it('names an unlisted tool rather than guessing a verb for it', () => {
        // The failure this prevents: a destructive tool given a friendly verb misleads
        // exactly when the user most needs to know what is happening.
        const activity = narrate({ name: 'some_future_tool', arguments: { path: 'a.ts' } });
        expect(activity!.verb).toBe('some_future_tool');
    });

    it('renders an em dash when the lane forwarded no arguments — R1', () => {
        // This is the task lane's state today: `ToolCallStarted` carries the name only.
        const activity = narrate({ name: 'edit_file' });
        expect(activity!.target).toBeUndefined();
        expect(describeActivity(activity)).toBe('editing —');
    });

    it('falls back across argument keys but never invents one', () => {
        expect(narrate({ name: 'run_command', arguments: { command: 'npm test' } })!.target).toBe('npm test');
        expect(narrate({ name: 'read_file', arguments: { file: 'a.ts' } })!.target).toBe('a.ts');
        expect(narrate({ name: 'read_file', arguments: {} })!.target).toBeUndefined();
        expect(narrate({ name: 'read_file', arguments: { unrelated: 3 } })!.target).toBeUndefined();
    });

    it('has no activity at all when there is no tool', () => {
        expect(narrate(undefined)).toBeUndefined();
        expect(narrate({ name: '   ' })).toBeUndefined();
    });

    it('splits paths but leaves commands whole', () => {
        expect(splitTarget('src/components/NavHeader.tsx')).toEqual({ label: 'NavHeader.tsx', dir: 'src/components/' });
        // A command that happens to contain a path is still a command: rendering `auth.ts`
        // as its label would hide what is actually running.
        expect(splitTarget('npm test -- src/auth.ts')).toEqual({ label: 'npm test -- src/auth.ts' });
        expect(splitTarget('useBreakpoint')).toEqual({ label: 'useBreakpoint' });
    });

    it('caps a pathological target instead of handing the desk 4 000 columns', () => {
        expect(splitTarget('x'.repeat(500)).label.length).toBeLessThanOrEqual(64);
    });
});

describe('staleness — the cell that separates working from stuck', () => {
    it('grades against the two thresholds', () => {
        expect(staleness(1_000, 1_000 + SLOW_AFTER_MS - 1)).toBe('ok');
        expect(staleness(1_000, 1_000 + SLOW_AFTER_MS)).toBe('slow');
        expect(staleness(1_000, 1_000 + STALLED_AFTER_MS)).toBe('stalled');
    });

    it('stays quiet when the lane publishes no start time — R1', () => {
        // Inventing one from the panel's own render time would flag every agent the
        // moment the Office was opened.
        expect(staleness(undefined, 10_000_000)).toBe('ok');
    });
});

// ── The projection ──────────────────────────────────────────────────────────

describe('four lanes onto one roster', () => {
    it('produces one ordered roster from a fixture of all four lanes', () => {
        const snapshot = buildOffice({
            agents: [task({ id: 'ta_run', status: 'running', startedAt: 5_000 })],
            pipelines: [pipeline({ id: 'pr_wait', status: 'awaiting_approval', startedAt: 2_000 })],
            chat: [{ id: 'sa_1', name: 'Docs', task: 'update the README', status: 'running', startedAt: 6_000 }],
            daemon: [{ id: 'dm_1', title: 'nightly lint', endedAt: 3_000 }],
            now: 10_000,
        });

        // Running first, then whatever is waiting on the user, then the rest. The
        // pipeline is older than both running items and still sorts after them: the floor
        // answers "what is working?", not "what is most urgent?" — that is the inbox's
        // question, and re-sorting here would be a second opinion about urgency.
        expect(snapshot.items.map(i => i.lane)).toEqual(['task', 'chat', 'pipeline', 'daemon']);
        expect(snapshot.items.map(i => i.id)).toEqual(['ta_run', 'sa_1', 'pr_wait', 'dm_1']);
        expect(snapshot.items.map(i => i.status)).toEqual(['running', 'running', 'needs_you', 'ready']);
    });

    it('sorts running work oldest-first, so a desk does not migrate as newer ones launch', () => {
        const snapshot = buildOffice({
            agents: [
                task({ id: 'ta_new', status: 'running', startedAt: 9_000 }),
                task({ id: 'ta_old', status: 'running', startedAt: 1_000 }),
            ],
        });
        expect(snapshot.items.map(i => i.id)).toEqual(['ta_old', 'ta_new']);
    });

    it('sorts finished work newest-first, because there you are looking for what just landed', () => {
        const snapshot = buildOffice({
            agents: [
                task({ id: 'ta_older', status: 'completed', appliedAt: 1, endedAt: 2_000 }),
                task({ id: 'ta_newer', status: 'completed', appliedAt: 1, endedAt: 8_000 }),
            ],
        });
        expect(snapshot.items.map(i => i.id)).toEqual(['ta_newer', 'ta_older']);
    });

    it('keeps the real ids and branches, because they are what you paste into git', () => {
        const [item] = buildOffice({ agents: [task({ id: 'ta_m4x1' })] }).items;
        expect(item.id).toBe('ta_m4x1');
        expect(item.branch).toBe('blackide/agent/ta_1');
    });

    it('splits `completed` into ready and done — the case the inbox exists for', () => {
        const ready = buildOffice({ agents: [task({ status: 'completed', endedAt: 2_000 })] }).items[0];
        const applied = buildOffice({ agents: [task({ status: 'completed', endedAt: 2_000, appliedAt: 3_000 })] }).items[0];
        expect(ready.status).toBe('ready');
        expect(applied.status).toBe('done');
    });

    it('carries the pipeline phase as a position, never as a schedule — R3', () => {
        const [item] = buildOffice({
            pipelines: [pipeline({ currentPhase: 'Frontend Executor' })],
            phases: { pr_1: { names: ['HLD', 'LLD', 'Plan', 'Design Executor', 'Backend Executor', 'Frontend Executor', 'Testing Executor'] } },
        }).items;
        expect(item.phase).toEqual({ name: 'Frontend Executor', index: 6, total: 7 });
        expect(item.role).toBe('Frontend Executor');
    });

    it('attaches the inbox reason to the item it belongs to', () => {
        const agents = [task({ status: 'awaiting_approval', startedAt: 1_000 })];
        const snapshot = buildOffice({ agents, inbox: buildInbox([], agents, { now: 2_000 }), now: 2_000 });
        expect(snapshot.items[0].needs).toBe('blocked');
        expect(snapshot.counts.blocking).toBe(1);
    });
});

describe('R1 — a field with no source arrives undefined, not zero', () => {
    it('leaves every unmeasured cell absent on a bare task agent', () => {
        const [item] = buildOffice({ agents: [task()] }).items;
        expect(item.progress).toBeUndefined();
        expect(item.context).toBeUndefined();
        expect(item.delta).toBeUndefined();
        expect(item.evidence).toBeUndefined();
        // Not `{ turn: 0, maxTurns: 25 }`, which would render a progress bar for a
        // measurement nobody took.
        expect(Object.prototype.hasOwnProperty.call(item, 'progress')).toBe(true);
    });

    it('renders the lane\'s name-only action without inventing a target', () => {
        const [item] = buildOffice({ agents: [task({ currentAction: 'edit_file' })] }).items;
        expect(item.activity).toEqual({ tool: 'edit_file', verb: 'edit_file' });
        expect(item.activity!.target).toBeUndefined();
    });

    it('prefers the live telemetry channel over the summary when both exist', () => {
        const activity = narrate({ name: 'edit_file', arguments: { path: 'src/a.ts' }, ts: 9_000 });
        const [item] = buildOffice({
            agents: [task({ currentAction: 'read_file' })],
            live: { ta_1: { activity, progress: { turn: 7, maxTurns: 25 }, context: { usedTokens: 18_000, limitTokens: 25_000, percent: 72 } } },
        }).items;
        expect(item.activity).toBe(activity);
        expect(item.progress).toEqual({ turn: 7, maxTurns: 25 });
        expect(item.context!.percent).toBe(72);
    });
});

describe('R2 — every affordance is a transition that exists', () => {
    const has = (list: Affordance[], a: Affordance) => list.includes(a);

    it('offers apply exactly when canApply does', () => {
        for (const agent of [
            task({ status: 'completed' }),
            task({ status: 'completed', appliedAt: 1 }),
            task({ status: 'failed' }),
            task({ status: 'running' }),
        ]) {
            expect(has(affordancesFor('task', agent), 'apply')).toBe(canApply(agent));
        }
    });

    it('offers stop and steer exactly when the run has a next turn', () => {
        for (const agent of [task({ status: 'running' }), task({ status: 'completed' }), task({ status: 'cancelled' })]) {
            expect(has(affordancesFor('task', agent), 'stop')).toBe(canCancel(agent));
            expect(has(affordancesFor('task', agent), 'steer')).toBe(canCancel(agent));
        }
    });

    it('offers a worktree exactly when one is still on disk', () => {
        for (const agent of [task({ status: 'failed' }), task({ status: 'completed', discardedAt: 1 })]) {
            expect(has(affordancesFor('task', agent), 'worktree')).toBe(holdsWorktree(agent));
        }
    });

    it('offers discard exactly when canDiscard does', () => {
        for (const agent of [task({ status: 'running' }), task({ status: 'completed', appliedAt: 1 })]) {
            expect(has(affordancesFor('task', agent), 'discard')).toBe(canDiscard(agent));
        }
    });

    it('never gives a pipeline phase a worktree button', () => {
        // A phase has no worktree to open. Rendering a greyed one would teach the user
        // that the capability exists and they did something wrong.
        const buttons = affordancesFor('pipeline', undefined, 'running');
        expect(buttons).not.toContain('worktree');
        expect(buttons).not.toContain('apply');
        expect(buttons).toContain('stop');
    });

    it('gives a waiting pipeline the plan verbs and nothing else', () => {
        expect(affordancesFor('pipeline', undefined, 'needs_you').sort())
            .toEqual(['approve', 'logs', 'readPlan', 'reject']);
    });

    it('leads a failed agent to its branch, because that is the recovery path — R5', () => {
        const buttons = affordancesFor('task', task({ status: 'failed' }));
        expect(buttons).toContain('openBranch');
        expect(buttons).toContain('worktree');
    });

    it('gives every item a log, in every state', () => {
        for (const status of ['running', 'ready', 'failed', 'done'] as const) {
            expect(affordancesFor('task', task(), status)).toContain('logs');
            expect(affordancesFor('pipeline', undefined, status)).toContain('logs');
            expect(affordancesFor('daemon', undefined, status)).toContain('logs');
        }
    });

    it('produces no duplicates, so a renderer can map straight over it', () => {
        const buttons = affordancesFor('task', task({ status: 'failed' }));
        expect(new Set(buttons).size).toBe(buttons.length);
    });
});

describe('desks', () => {
    const item = (over: Partial<WorkItem> = {}): WorkItem => ({
        id: 'x', lane: 'task', role: 'Agent', title: 't', status: 'running',
        startedAt: 0, affordances: [], ...over,
    });

    it('draws the free capacity as empty seats', () => {
        const desks = buildDesks([item({ id: 'a' }), item({ id: 'b' })], 4);
        expect(desks.filter(d => d.kind === 'occupied')).toHaveLength(2);
        expect(desks.filter(d => d.kind === 'free')).toHaveLength(2);
    });

    it('never draws a negative seat when the cap was lowered mid-flight', () => {
        // `AgentGovernor.configure` explicitly allows lowering the cap below the number of
        // running agents — it stops the next launch rather than killing a run.
        const desks = buildDesks([item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })], 2);
        expect(desks.filter(d => d.kind === 'free')).toHaveLength(0);
        expect(desks.filter(d => d.kind === 'occupied')).toHaveLength(3);
    });

    it('keeps a seat for finished-but-unreviewed work', () => {
        // Hiding it the instant the run ends is exactly how the work never lands.
        const desks = buildDesks([item({ id: 'a', status: 'ready' })], 4);
        expect(desks.filter(d => d.kind === 'occupied')).toHaveLength(1);
    });

    it('does not seat finished-and-applied work', () => {
        const desks = buildDesks([item({ id: 'a', status: 'done' })], 4);
        expect(desks.filter(d => d.kind === 'occupied')).toHaveLength(0);
    });
});

describe('the header numbers', () => {
    it('sources capacity and spend from the governor snapshot', () => {
        const snapshot = buildOffice({
            agents: [task({ status: 'running' })],
            governor: governor({ active: 1, maxConcurrent: 4, costSpent: 0.82, costBudget: 5 }),
        });
        expect(snapshot.capacity).toBe(4);
        expect(snapshot.running).toBe(1);
        expect(snapshot.governor!.costSpent).toBe(0.82);
    });

    it('falls back to the live count rather than inventing a capacity', () => {
        // No governor snapshot means no configured cap to report. Reporting a default of
        // four would be a number with no source.
        const snapshot = buildOffice({ agents: [task({ status: 'running' })] });
        expect(snapshot.capacity).toBe(snapshot.running);
        expect(snapshot.governor).toBeUndefined();
    });
});
