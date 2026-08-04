import { describe, expect, it } from 'vitest';
import { PipelineRunSummary } from '@blackide/agent-core/core/pipeline-runs';
import { TaskAgentSummary } from '@blackide/agent-core/core/task-agents';
import {
    DEFAULT_IDLE_TIMEOUT_MS, buildInbox, inboxCounts, newlyNotifiable, notificationKey,
    pruneNotified, summarizeForNotification,
} from '@blackide/agent-core/core/agent-inbox';

/**
 * Phase 6, M34 — the agent inbox.
 *
 * F16's defect was never the state, it was that nobody was told: `awaiting_approval` has
 * existed since before Phase 4 and an unattended run could idle in it indefinitely. So
 * this suite is mostly about *what counts as needing a human* and *not saying it twice* —
 * a notifier that re-announces on every poll gets switched off within the hour, and then
 * the user has both the missed run and a dead channel.
 */

const MINUTE = 60_000;

const pipeline = (over: Partial<PipelineRunSummary> = {}): PipelineRunSummary => ({
    id: 'run_1', prompt: 'build the checkout flow', modelId: 'm', status: 'running', startedAt: 1_000, ...over,
});

const task = (over: Partial<TaskAgentSummary> = {}): TaskAgentSummary => ({
    id: 'ta_1', prompt: 'add retry logic', modelId: 'm', mode: 'Agent', rootPath: '/repo',
    branch: 'blackide/agent/ta_1', status: 'running', startedAt: 1_000, ...over,
});

describe('what counts as needing a human', () => {
    it('picks up a pipeline waiting for plan approval', () => {
        const items = buildInbox([pipeline({ status: 'awaiting_approval' })], [], { now: 2_000 });
        expect(items).toHaveLength(1);
        expect(items[0].reason).toBe('blocked');
        expect(items[0].kind).toBe('pipeline');
    });

    it('picks up a finished task agent whose work is still in its worktree', () => {
        // The quiet one: nothing is wrong, nothing is on a timer, and without this the
        // work simply never lands and nobody notices it did not.
        const items = buildInbox([], [task({ status: 'completed', endedAt: 2_000 })], { now: 3_000 });
        expect(items[0].reason).toBe('review');
        expect(items[0].detail).toContain('apply');
    });

    it('picks up failures from both lanes', () => {
        const items = buildInbox(
            [pipeline({ status: 'failed', error: 'provider 529' })],
            [task({ id: 'ta_2', status: 'failed', error: 'anchor missing' })],
            { now: 5_000 },
        );
        expect(items.map(i => i.reason)).toEqual(['failed', 'failed']);
        expect(items.map(i => i.detail)).toContain('provider 529');
    });

    it('ignores healthy running work', () => {
        expect(buildInbox([pipeline({ status: 'running' })], [task({ status: 'running' })], { now: 2_000 })).toEqual([]);
    });

    it('ignores agents that were already applied or discarded', () => {
        const applied = task({ status: 'completed', appliedAt: 9 });
        const discarded = task({ id: 'ta_2', status: 'completed', discardedAt: 9 });
        expect(buildInbox([], [applied, discarded], { now: 100 })).toEqual([]);
    });

    it('ignores cancelled work — the user already knows', () => {
        expect(buildInbox([pipeline({ status: 'cancelled' })], [task({ status: 'cancelled' })], { now: 100 })).toEqual([]);
    });

    it('tolerates missing lists', () => {
        expect(buildInbox(undefined as any, undefined as any, { now: 1 })).toEqual([]);
    });
});

describe('parking', () => {
    it('calls a long-blocked run parked and says how long', () => {
        const items = buildInbox([pipeline({ status: 'awaiting_approval', startedAt: 0 })], [], {
            now: DEFAULT_IDLE_TIMEOUT_MS + MINUTE,
        });
        expect(items[0].reason).toBe('parked');
        expect(items[0].detail).toMatch(/1[56] min/);
    });

    it('stays blocked just under the timeout', () => {
        const items = buildInbox([pipeline({ status: 'awaiting_approval', startedAt: 0 })], [], {
            now: DEFAULT_IDLE_TIMEOUT_MS - 1,
        });
        expect(items[0].reason).toBe('blocked');
    });

    it('parks task agents on the same rule', () => {
        const items = buildInbox([], [task({ status: 'awaiting_approval', startedAt: 0 })], {
            now: 60 * MINUTE, idleTimeoutMs: 5 * MINUTE,
        });
        expect(items[0].reason).toBe('parked');
        expect(items[0].detail).toContain('1h');
    });

    it('is still blocked, not resolved — parking is a label, not an exit', () => {
        const items = buildInbox([pipeline({ status: 'awaiting_approval', startedAt: 0 })], [], { now: 10 ** 9 });
        expect(inboxCounts(items).blocking).toBe(1);
    });
});

describe('ordering', () => {
    it('puts blocking work above finished work', () => {
        const items = buildInbox(
            [pipeline({ id: 'run_1', status: 'awaiting_approval', startedAt: 5_000 })],
            [task({ id: 'ta_1', status: 'completed', endedAt: 1_000 })],
            { now: 6_000 },
        );
        expect(items.map(i => i.reason)).toEqual(['blocked', 'review']);
    });

    it('puts the longest-waiting blocked run first', () => {
        // It is the one that has been wasting the most time.
        const items = buildInbox(
            [
                pipeline({ id: 'new', status: 'awaiting_approval', startedAt: 9_000 }),
                pipeline({ id: 'old', status: 'awaiting_approval', startedAt: 1_000 }),
            ],
            [], { now: 10_000 },
        );
        expect(items.map(i => i.id)).toEqual(['old', 'new']);
    });

    it('puts parked above merely blocked', () => {
        const items = buildInbox(
            [
                pipeline({ id: 'recent', status: 'awaiting_approval', startedAt: 100 * MINUTE }),
                pipeline({ id: 'stale', status: 'awaiting_approval', startedAt: 0 }),
            ],
            [], { now: 101 * MINUTE },
        );
        expect(items[0].id).toBe('stale');
        expect(items[0].reason).toBe('parked');
    });

    it('shows the newest finished agent first — there the user wants what just landed', () => {
        const items = buildInbox([], [
            task({ id: 'older', status: 'completed', endedAt: 1_000 }),
            task({ id: 'newer', status: 'completed', endedAt: 8_000 }),
        ], { now: 9_000 });
        expect(items.map(i => i.id)).toEqual(['newer', 'older']);
    });
});

describe('counts', () => {
    it('separates the urgent half from the rest', () => {
        const items = buildInbox(
            [pipeline({ id: 'p1', status: 'awaiting_approval' }), pipeline({ id: 'p2', status: 'failed' })],
            [task({ id: 't1', status: 'completed', endedAt: 1 }), task({ id: 't2', status: 'failed' })],
            { now: 2_000 },
        );
        expect(inboxCounts(items)).toEqual({ total: 4, blocking: 1, review: 1, failed: 2 });
    });

    it('is all zeros for an empty inbox', () => {
        expect(inboxCounts([])).toEqual({ total: 0, blocking: 0, review: 0, failed: 0 });
    });
});

describe('notifying once, and again when something changes', () => {
    const items = () => buildInbox([pipeline({ status: 'awaiting_approval' })], [], { now: 2_000 });

    it('announces an item once', () => {
        const notified = new Set<string>();
        const first = newlyNotifiable(items(), notified);
        expect(first).toHaveLength(1);

        for (const item of first) notified.add(notificationKey(item));
        expect(newlyNotifiable(items(), notified)).toHaveLength(0);
    });

    it('announces again when the reason changes', () => {
        // Blocked → failed is a different thing happening, not a repeat.
        const notified = new Set<string>();
        for (const item of newlyNotifiable(items(), notified)) notified.add(notificationKey(item));

        const nowFailed = buildInbox([pipeline({ status: 'failed', error: 'gave up' })], [], { now: 3_000 });
        expect(newlyNotifiable(nowFailed, notified)).toHaveLength(1);
    });

    it('does not confuse a pipeline and a task agent with the same id', () => {
        const both = buildInbox(
            [pipeline({ id: 'x', status: 'awaiting_approval' })],
            [task({ id: 'x', status: 'failed' })],
            { now: 2_000 },
        );
        expect(new Set(both.map(notificationKey)).size).toBe(2);
    });

    it('prunes keys for items that have left the inbox', () => {
        const notified = new Set(['pipeline:run_1:blocked', 'task:ta_9:review']);
        const pruned = pruneNotified(notified, items());
        expect([...pruned]).toEqual(['pipeline:run_1:blocked']);
    });

    it('re-announces a state the item returns to after leaving', () => {
        // Approve a plan, have the run block again later — silence forever would be the
        // bug this prunes to avoid.
        let notified = new Set<string>();
        for (const item of newlyNotifiable(items(), notified)) notified.add(notificationKey(item));

        notified = pruneNotified(notified, []);          // approved: inbox empties
        expect(newlyNotifiable(items(), notified)).toHaveLength(1);
    });
});

describe('summarizeForNotification', () => {
    it('names the single item outright', () => {
        const items = buildInbox([pipeline({ prompt: 'build checkout', status: 'awaiting_approval' })], [], { now: 2_000 });
        expect(summarizeForNotification(items)).toContain('build checkout');
        expect(summarizeForNotification(items)).toContain('approval');
    });

    it('counts by kind when there are several', () => {
        const items = buildInbox(
            [pipeline({ id: 'p1', status: 'awaiting_approval' }), pipeline({ id: 'p2', status: 'failed' })],
            [task({ id: 't1', status: 'completed', endedAt: 1 })],
            { now: 5_000 },
        );
        const line = summarizeForNotification(items);
        expect(line).toContain('1 waiting for you');
        expect(line).toContain('1 ready to review');
        expect(line).toContain('1 failed');
    });

    it('is empty for an empty inbox', () => {
        expect(summarizeForNotification([])).toBe('');
    });

    it('flattens and truncates a long prompt', () => {
        const items = buildInbox([pipeline({ prompt: 'a'.repeat(200) + '\n\nmore', status: 'failed' })], [], { now: 2 });
        expect(items[0].title.length).toBeLessThanOrEqual(60);
        expect(items[0].title).not.toContain('\n');
    });

    it('does not render an empty title for a promptless run', () => {
        const items = buildInbox([pipeline({ prompt: '', status: 'failed' })], [], { now: 2 });
        expect(items[0].title).toBe('(no prompt)');
    });
});
