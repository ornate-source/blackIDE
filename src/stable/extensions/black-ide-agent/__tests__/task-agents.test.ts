import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentGovernor } from '../src/core/agent-governor';
import {
    TaskAgentSummary, branchNameFor, canApply, canCancel, canDiscard, describeDiff,
    holdsWorktree, isTerminalStatus, newAgentId, parseNumstat, reconcileInterruptedAgents,
} from '../src/core/task-agents';
import { TaskAgentRegistry, TaskRunParams, TaskWorktreeOps } from '../src/agent/task-agent-registry';

/**
 * Phase 6, M31/M32 — task agents.
 *
 * The gate: **4 concurrent agents → 4 independently mergeable worktrees, kill-one
 * isolation holds, and the live workspace is untouched until an explicit apply.**
 *
 * All three are asserted here rather than in a real repo, because all three are properties
 * of the *lifecycle*, not of git: which directory the agent is handed, which signal aborts
 * it, and which code path is allowed to call `apply`. Injecting the git operations means
 * the failure paths — the ones that decide whether a user loses work — are reachable in a
 * test, which they would not be against a real repository.
 */

// ─── A fake git, recording what the registry asked it to do ─────────────────

function fakeWorktree() {
    const calls: string[] = [];
    let commitCounter = 0;
    const ops: TaskWorktreeOps & { calls: string[]; failApply?: string; failCreate?: string } = {
        calls,
        async create(branch, root) {
            calls.push(`create:${branch}:${root}`);
            if (ops.failCreate) throw new Error(ops.failCreate);
            return `/worktrees/${branch.replace(/\//g, '_')}`;
        },
        async sync(branch) { calls.push(`sync:${branch}`); },
        async commit(branch) { calls.push(`commit:${branch}`); return `sha${++commitCounter}`; },
        async diffStat() { return { files: 2, insertions: 10, deletions: 3 }; },
        async apply(branch, from, to, root) {
            calls.push(`apply:${branch}:${from}..${to}:${root}`);
            if (ops.failApply) throw new Error(ops.failApply);
        },
        async remove(branch) { calls.push(`remove:${branch}`); },
    };
    return ops;
}

interface Harness {
    registry: TaskAgentRegistry;
    worktree: ReturnType<typeof fakeWorktree>;
    governor: AgentGovernor;
    stored: TaskAgentSummary[];
    runs: TaskRunParams[];
    finish(agentId: string): void;
    fail(agentId: string, message: string): void;
    settle(): Promise<void>;
}

/** A registry whose agent runs are held open until the test resolves them. */
function harness(options: { maxConcurrent?: number; seed?: TaskAgentSummary[] } = {}): Harness {
    const worktree = fakeWorktree();
    const governor = new AgentGovernor({ maxConcurrent: options.maxConcurrent ?? 4 });
    const runs: TaskRunParams[] = [];
    const resolvers = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
    let stored: TaskAgentSummary[] = options.seed ?? [];

    const registry = new TaskAgentRegistry({
        governor,
        worktree,
        runTask: (params) => {
            runs.push(params);
            return new Promise<void>((resolve, reject) => resolvers.set(params.agentId, { resolve, reject }));
        },
        load: () => stored,
        save: (agents) => { stored = agents; },
    });

    return {
        registry, worktree, governor, runs,
        get stored() { return stored; },
        finish: (id) => resolvers.get(id)?.resolve(),
        fail: (id, message) => resolvers.get(id)?.reject(new Error(message)),
        settle: () => new Promise<void>(r => setTimeout(r, 0)),
    } as Harness;
}

const launch = (h: Harness, over: Partial<Parameters<TaskAgentRegistry['launch']>[0]> = {}) =>
    h.registry.launch({ prompt: 'add retry logic', modelId: 'm1', rootPath: '/repo', ...over });

// ─── The gate ───────────────────────────────────────────────────────────────

describe('the gate: four concurrent agents, four independent worktrees', () => {
    it('gives each agent its own branch and its own worktree directory', async () => {
        const h = harness();
        for (let i = 0; i < 4; i++) launch(h, { prompt: `job ${i}` });
        await h.settle();

        const branches = h.registry.list().map(a => a.branch);
        expect(new Set(branches).size).toBe(4);

        const dirs = h.runs.map(r => r.cwd);
        expect(new Set(dirs).size).toBe(4);
    });

    it('never hands an agent the live workspace as its working directory', async () => {
        // This is the isolation guarantee. If `cwd` were ever the live root, every file
        // tool and every command the agent ran would edit the user's tree directly.
        const h = harness();
        for (let i = 0; i < 4; i++) launch(h);
        await h.settle();

        for (const run of h.runs) {
            expect(run.cwd).not.toBe('/repo');
            expect(run.rootPath).toBe('/repo');
        }
    });

    it('refuses the fifth agent rather than exceeding the cap', () => {
        const h = harness({ maxConcurrent: 4 });
        for (let i = 0; i < 4; i++) expect('agent' in launch(h)).toBe(true);

        const fifth = launch(h);
        expect('error' in fifth).toBe(true);
        if ('error' in fifth) expect(fifth.error).toContain('limit is 4');
    });

    it('frees a slot when a run ends, not when its result is applied', async () => {
        // An agent waiting for a human is not spending anything. Holding its slot would
        // let four unreviewed results block every further launch.
        const h = harness({ maxConcurrent: 1 });
        const first = launch(h);
        await h.settle();
        expect('error' in launch(h)).toBe(true);

        if ('agent' in first) h.finish(first.agent.id);
        await h.settle();

        expect('agent' in launch(h)).toBe(true);
        if ('agent' in first) expect(h.registry.find(first.agent.id)?.status).toBe('completed');
    });
});

describe('the gate: kill-one isolation', () => {
    it('cancelling one agent leaves the others running', async () => {
        const h = harness();
        const agents = [launch(h), launch(h), launch(h)];
        await h.settle();

        const [a, b, c] = agents.map(r => ('agent' in r ? r.agent.id : ''));
        h.registry.cancel(b);
        await h.settle();

        expect(h.registry.find(b)?.status).toBe('cancelled');
        expect(h.registry.find(a)?.status).toBe('running');
        expect(h.registry.find(c)?.status).toBe('running');
    });

    it('gives each agent its own abort signal', async () => {
        const h = harness();
        launch(h); launch(h);
        await h.settle();

        const [first, second] = h.runs;
        expect(first.signal).not.toBe(second.signal);
        h.registry.cancel(first.agentId);
        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(false);
    });

    it('a failing agent does not disturb its neighbours', async () => {
        const h = harness();
        const a = launch(h), b = launch(h);
        await h.settle();
        if ('agent' in a) h.fail(a.agent.id, 'provider exploded');
        await h.settle();

        if ('agent' in a) expect(h.registry.find(a.agent.id)?.status).toBe('failed');
        if ('agent' in b) expect(h.registry.find(b.agent.id)?.status).toBe('running');
    });

    it('reports cancelled immediately, without waiting for the run to notice', async () => {
        // A task that never observes its signal would otherwise sit `running` forever —
        // a state nothing in the registry could clear.
        const h = harness();
        const launched = launch(h);
        await h.settle();
        if (!('agent' in launched)) throw new Error('launch failed');

        h.registry.cancel(launched.agent.id);
        expect(h.registry.find(launched.agent.id)?.status).toBe('cancelled');
    });

    it('does not free the concurrency slot until the run actually ends', async () => {
        // Status is the user's intent and is known at once; the slot is the machine's
        // reality, and a run whose final turn is still streaming is still spending.
        const h = harness({ maxConcurrent: 1 });
        const launched = launch(h);
        await h.settle();
        if (!('agent' in launched)) throw new Error('launch failed');

        h.registry.cancel(launched.agent.id);
        expect('error' in launch(h)).toBe(true);

        h.finish(launched.agent.id);
        await h.settle();
        expect('agent' in launch(h)).toBe(true);
    });

    it('preserves a cancelled agent\'s worktree, because the work is real', async () => {
        const h = harness();
        const launched = launch(h);
        await h.settle();
        if (!('agent' in launched)) throw new Error('launch failed');

        h.registry.cancel(launched.agent.id);
        await h.settle();

        const agent = h.registry.find(launched.agent.id)!;
        expect(holdsWorktree(agent)).toBe(true);
        expect(h.worktree.calls.filter(c => c.startsWith('remove:'))).toEqual([]);
    });
});

describe('the gate: the live workspace is untouched until an explicit apply', () => {
    it('a completed run writes nothing to the live tree', async () => {
        const h = harness();
        const launched = launch(h);
        await h.settle();
        if (!('agent' in launched)) throw new Error('launch failed');
        h.finish(launched.agent.id);
        await h.settle();

        expect(h.registry.find(launched.agent.id)?.status).toBe('completed');
        expect(h.worktree.calls.some(c => c.startsWith('apply:'))).toBe(false);
    });

    it('apply is the only thing that writes, and it writes the recorded range', async () => {
        const h = harness();
        const launched = launch(h);
        await h.settle();
        if (!('agent' in launched)) throw new Error('launch failed');
        h.finish(launched.agent.id);
        await h.settle();

        const before = h.registry.find(launched.agent.id)!;
        const result = await h.registry.apply(launched.agent.id);
        expect(result).toEqual({ ok: true });

        const applyCall = h.worktree.calls.find(c => c.startsWith('apply:'));
        expect(applyCall).toContain(`${before.baselineSha}..${before.resultSha}`);
        expect(applyCall).toContain('/repo');
        expect(h.registry.find(launched.agent.id)?.appliedAt).toBeTypeOf('number');
    });

    it('refuses to apply a run that did not complete', async () => {
        // A cancelled agent may well have written real files. Offering to apply them is
        // how a half-finished refactor reaches the user's tree with nothing saying so.
        const h = harness();
        const launched = launch(h);
        await h.settle();
        if (!('agent' in launched)) throw new Error('launch failed');
        h.registry.cancel(launched.agent.id);
        await h.settle();

        const result = await h.registry.apply(launched.agent.id);
        expect('error' in result).toBe(true);
        expect(h.worktree.calls.some(c => c.startsWith('apply:'))).toBe(false);
    });

    it('refuses a second apply of the same agent', async () => {
        const h = harness();
        const launched = launch(h);
        await h.settle();
        if (!('agent' in launched)) throw new Error('launch failed');
        h.finish(launched.agent.id);
        await h.settle();

        await h.registry.apply(launched.agent.id);
        const second = await h.registry.apply(launched.agent.id);
        expect('error' in second).toBe(true);
        expect(h.worktree.calls.filter(c => c.startsWith('apply:'))).toHaveLength(1);
    });

    it('keeps the worktree when applying fails, because it holds the only copy', async () => {
        const h = harness();
        const launched = launch(h);
        await h.settle();
        if (!('agent' in launched)) throw new Error('launch failed');
        h.finish(launched.agent.id);
        await h.settle();

        h.worktree.failApply = 'patch does not apply';
        const result = await h.registry.apply(launched.agent.id);

        expect('error' in result).toBe(true);
        if ('error' in result) expect(result.error).toContain(launched.agent.branch);
        expect(h.worktree.calls.some(c => c.startsWith('remove:'))).toBe(false);
        // Still applicable: a failed merge must not consume the one chance to merge.
        expect(canApply(h.registry.find(launched.agent.id)!)).toBe(true);
    });

    it('removes the worktree only after a successful apply', async () => {
        const h = harness();
        const launched = launch(h);
        await h.settle();
        if (!('agent' in launched)) throw new Error('launch failed');
        h.finish(launched.agent.id);
        await h.settle();
        await h.registry.apply(launched.agent.id);

        expect(h.worktree.calls.filter(c => c.startsWith('remove:'))).toHaveLength(1);
        expect(holdsWorktree(h.registry.find(launched.agent.id)!)).toBe(false);
    });
});

describe('discard', () => {
    it('stops a running agent before removing its worktree', async () => {
        // `git worktree remove` races a process still writing into that directory.
        const h = harness();
        const launched = launch(h);
        await h.settle();
        if (!('agent' in launched)) throw new Error('launch failed');

        await h.registry.discard(launched.agent.id);
        expect(h.runs[0].signal.aborted).toBe(true);
        expect(h.worktree.calls.some(c => c.startsWith('remove:'))).toBe(true);
    });

    it('cannot be applied afterwards', async () => {
        const h = harness();
        const launched = launch(h);
        await h.settle();
        if (!('agent' in launched)) throw new Error('launch failed');
        h.finish(launched.agent.id);
        await h.settle();
        await h.registry.discard(launched.agent.id);

        expect('error' in await h.registry.apply(launched.agent.id)).toBe(true);
    });

    it('refuses to discard an applied agent', async () => {
        const h = harness();
        const launched = launch(h);
        await h.settle();
        if (!('agent' in launched)) throw new Error('launch failed');
        h.finish(launched.agent.id);
        await h.settle();
        await h.registry.apply(launched.agent.id);

        expect('error' in await h.registry.discard(launched.agent.id)).toBe(true);
    });
});

describe('per-agent model, mode and root (M32/M36)', () => {
    it('carries each agent\'s own model and mode into its run', async () => {
        const h = harness();
        launch(h, { modelId: 'fast', mode: 'Backend Executor' });
        launch(h, { modelId: 'strong', mode: 'Frontend Executor' });
        await h.settle();

        expect(h.runs.map(r => [r.modelId, r.mode])).toEqual([
            ['fast', 'Backend Executor'], ['strong', 'Frontend Executor'],
        ]);
    });

    it('defaults the mode rather than launching with an empty one', async () => {
        const h = harness();
        launch(h);
        await h.settle();
        expect(h.runs[0].mode).toBe('Agent');
    });

    it('creates the worktree in the root the agent declared', async () => {
        const h = harness();
        launch(h, { rootPath: '/work/shop/web' });
        await h.settle();
        expect(h.worktree.calls[0]).toContain(':/work/shop/web');
    });

    it('refuses to launch with no root instead of guessing one', async () => {
        const h = harness();
        const result = h.registry.launch({ prompt: 'x', modelId: 'm', rootPath: '' });
        expect('error' in result).toBe(true);
    });
});

describe('spend is charged to the shared governor', () => {
    it('accumulates per agent and against the session', async () => {
        const h = harness();
        launch(h); launch(h);
        await h.settle();

        h.runs[0].onUsage?.(1_000, 0.5);
        h.runs[1].onUsage?.(500, 0.25);
        h.runs[0].onUsage?.(200, 0.1);

        expect(h.governor.snapshot().tokensSpent).toBe(1_700);
        expect(h.registry.find(h.runs[0].agentId)?.tokens).toBe(1_200);
        expect(h.registry.find(h.runs[1].agentId)?.tokens).toBe(500);
    });

    it('refuses to launch once the budget is spent', async () => {
        const h = harness();
        h.governor.configure({ tokenBudget: 100 });
        launch(h);
        await h.settle();
        h.runs[0].onUsage?.(200, 0);

        const refused = launch(h);
        expect('error' in refused).toBe(true);
        if ('error' in refused) expect(refused.error).toContain('token budget');
    });
});

describe('failure paths leave recoverable state', () => {
    it('records the error and keeps the branch when the run throws', async () => {
        const h = harness();
        const launched = launch(h);
        await h.settle();
        if (!('agent' in launched)) throw new Error('launch failed');
        h.fail(launched.agent.id, 'model refused');
        await h.settle();

        const agent = h.registry.find(launched.agent.id)!;
        expect(agent.status).toBe('failed');
        expect(agent.error).toContain('model refused');
        expect(holdsWorktree(agent)).toBe(true);
    });

    it('commits whatever the agent wrote before it failed', async () => {
        // Otherwise partial work sits uncommitted inside a worktree nobody will look in.
        const h = harness();
        const launched = launch(h);
        await h.settle();
        if (!('agent' in launched)) throw new Error('launch failed');
        h.fail(launched.agent.id, 'boom');
        await h.settle();

        expect(h.registry.find(launched.agent.id)?.resultSha).toBeTruthy();
    });

    it('releases the slot when worktree creation itself fails', async () => {
        // A leaked slot is permanent: nothing frees it, so the cap ratchets down by one
        // for the rest of the session every time git hiccups.
        const h = harness({ maxConcurrent: 1 });
        h.worktree.failCreate = 'fatal: branch already exists';
        const first = launch(h);
        await h.settle();

        if ('agent' in first) expect(h.registry.find(first.agent.id)?.status).toBe('failed');
        expect(h.governor.snapshot().active).toBe(0);
        expect('agent' in launch(h)).toBe(true);
    });
});

// ─── Pure model ─────────────────────────────────────────────────────────────

const agent = (over: Partial<TaskAgentSummary> = {}): TaskAgentSummary => ({
    id: 'ta_1', prompt: 'p', modelId: 'm', mode: 'Agent', rootPath: '/repo',
    branch: 'blackide/agent/ta_1', status: 'completed', startedAt: 1, ...over,
});

describe('state machine', () => {
    it('treats queued, running and awaiting_approval as live', () => {
        for (const status of ['queued', 'running', 'awaiting_approval'] as const) {
            expect(isTerminalStatus(status)).toBe(false);
            expect(canCancel(agent({ status }))).toBe(true);
        }
        for (const status of ['completed', 'failed', 'cancelled'] as const) {
            expect(isTerminalStatus(status)).toBe(true);
            expect(canCancel(agent({ status }))).toBe(false);
        }
    });

    it('allows apply only from completed, and only once', () => {
        expect(canApply(agent())).toBe(true);
        expect(canApply(agent({ status: 'failed' }))).toBe(false);
        expect(canApply(agent({ status: 'running' }))).toBe(false);
        expect(canApply(agent({ appliedAt: 5 }))).toBe(false);
        expect(canApply(agent({ discardedAt: 5 }))).toBe(false);
    });

    it('allows discard from any state that still owns a worktree', () => {
        expect(canDiscard(agent({ status: 'failed' }))).toBe(true);
        expect(canDiscard(agent({ status: 'running' }))).toBe(true);
        expect(canDiscard(agent({ appliedAt: 5 }))).toBe(false);
    });
});

describe('reconcileInterruptedAgents', () => {
    it('fails a run the host cannot still be running, and says where the work is', () => {
        const [fixed] = reconcileInterruptedAgents([agent({ status: 'running' })], 99);
        expect(fixed.status).toBe('failed');
        expect(fixed.endedAt).toBe(99);
        // "Interrupted by a window reload" alone is true and useless in front of a user
        // whose branch still holds an afternoon of edits.
        expect(fixed.error).toContain('blackide/agent/ta_1');
    });

    it('leaves terminal agents alone', () => {
        const done = agent({ status: 'completed', endedAt: 7 });
        expect(reconcileInterruptedAgents([done])[0]).toEqual(done);
    });

    it('keeps an existing error rather than overwriting the real cause', () => {
        const [fixed] = reconcileInterruptedAgents([agent({ status: 'running', error: 'rate limited' })]);
        expect(fixed.error).toBe('rate limited');
    });

    it('tolerates a missing list', () => {
        expect(reconcileInterruptedAgents(undefined as any)).toEqual([]);
    });
});

describe('ids and branches', () => {
    it('namespaces branches so a user can find and delete them', () => {
        expect(branchNameFor('ta_abc')).toBe('blackide/agent/ta_abc');
    });

    it('does not collide for agents launched in the same millisecond', () => {
        // `git worktree add` fails on an existing branch, and a launch that fails for that
        // reason is undiagnosable from the UI.
        const ids = new Set(Array.from({ length: 200 }, () => newAgentId(1_000)));
        expect(ids.size).toBeGreaterThan(190);
    });
});

describe('parseNumstat', () => {
    it('sums a normal diff', () => {
        expect(parseNumstat('3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts'))
            .toEqual({ files: 2, insertions: 13, deletions: 1 });
    });

    it('counts a binary file as changed with no line changes', () => {
        // git reports `-` for both columns; summing it as NaN renders the whole stat as
        // NaN in the UI, from one image.
        expect(parseNumstat('-\t-\tlogo.png\n2\t1\tsrc/a.ts'))
            .toEqual({ files: 2, insertions: 2, deletions: 1 });
    });

    it('ignores blank and malformed lines', () => {
        expect(parseNumstat('\n\nnot a numstat line\n1\t1\ta.ts')).toEqual({ files: 1, insertions: 1, deletions: 1 });
    });

    it('returns zeros for empty output', () => {
        expect(parseNumstat('')).toEqual({ files: 0, insertions: 0, deletions: 0 });
        expect(parseNumstat(undefined as any)).toEqual({ files: 0, insertions: 0, deletions: 0 });
    });
});

describe('describeDiff', () => {
    it('reads naturally in the panel', () => {
        expect(describeDiff({ files: 1, insertions: 4, deletions: 0 })).toBe('1 file, +4/-0');
        expect(describeDiff({ files: 3, insertions: 4, deletions: 2 })).toBe('3 files, +4/-2');
    });

    it('says so when nothing changed', () => {
        expect(describeDiff({ files: 0, insertions: 0, deletions: 0 })).toBe('no changes');
        expect(describeDiff(undefined)).toBe('no changes');
    });
});
