import { describe, expect, it } from 'vitest';
import {
    DEFAULT_PATCH_INTERVAL_MS, GIT_POLL_INTERVAL_MS, PatchCoalescer, ProbeBudget, shouldPublish,
} from '@blackide/agent-core/core/office-telemetry';
import { narrate } from '@blackide/agent-core/core/office-narrate';

/**
 * The telemetry budget, as a test rather than as care.
 *
 * The constraint that matters is not "add fields" — it is **that watching must not change
 * what runs**. Two properties carry that:
 *
 *   - a dropped frame **delays** a value, it never discards one. A desk showing a tool the
 *     agent already finished is worse than a desk a quarter-second behind;
 *   - the process-global git mutex is taken at most once per agent per 10 s, because a
 *     live diff polled per event would serialise four agents behind the UI.
 */

describe('coalescing', () => {
    it('merges per field, not per patch', () => {
        // The requirement a naive "keep the newest patch" implementation gets wrong.
        const c = new PatchCoalescer(250);
        c.record('ta_1', { activity: narrate({ name: 'read_file', arguments: { path: 'a.ts' } }) });
        c.record('ta_1', { progress: { turn: 3, maxTurns: 25 } });

        const [patch] = c.drain(1_000);
        expect(patch.id).toBe('ta_1');
        expect(patch.fields.progress).toEqual({ turn: 3, maxTurns: 25 });
        expect(patch.fields.activity!.verb).toBe('opened');
    });

    it('holds an item under its interval and releases it on the next drain', () => {
        const c = new PatchCoalescer(250);
        c.record('ta_1', { progress: { turn: 1, maxTurns: 25 } });
        expect(c.drain(1_000)).toHaveLength(1);

        c.record('ta_1', { progress: { turn: 2, maxTurns: 25 } });
        expect(c.drain(1_100)).toHaveLength(0);
        // Delayed, not dropped.
        expect(c.pendingCount).toBe(1);
        expect(c.drain(1_250)[0].fields.progress).toEqual({ turn: 2, maxTurns: 25 });
    });

    it('keeps the newest value of a field that changed several times while throttled', () => {
        const c = new PatchCoalescer(250);
        c.drain(1_000);
        for (let turn = 1; turn <= 9; turn++) c.record('ta_1', { progress: { turn, maxTurns: 25 } });
        expect(c.drain(1_000)[0].fields.progress).toEqual({ turn: 9, maxTurns: 25 });
    });

    it('rate-limits per item, so a chatty agent cannot starve a quiet one', () => {
        const c = new PatchCoalescer(250);
        c.record('ta_1', { progress: { turn: 1, maxTurns: 25 } });
        expect(c.drain(1_000).map(p => p.id)).toEqual(['ta_1']);

        c.record('ta_1', { progress: { turn: 2, maxTurns: 25 } });
        c.record('ta_2', { progress: { turn: 1, maxTurns: 25 } });
        // ta_1 is inside its window; ta_2 has never flushed and goes out immediately.
        expect(c.drain(1_050).map(p => p.id)).toEqual(['ta_2']);
    });

    it('flushes regardless of the interval, for transitions where lateness is a lie', () => {
        const c = new PatchCoalescer(250);
        c.drain(1_000);
        c.record('ta_1', { activity: undefined, progress: { turn: 7, maxTurns: 25 } });
        expect(c.flush(1_010)).toHaveLength(1);
        expect(c.pendingCount).toBe(0);
    });

    it('forgets a retired item rather than posting its stale fields', () => {
        const c = new PatchCoalescer(250);
        c.record('ta_1', { progress: { turn: 7, maxTurns: 25 } });
        c.forget('ta_1');
        expect(c.drain(10_000)).toHaveLength(0);
    });

    it('stays inside four posts per second per item under a realistic tool cadence', () => {
        // Four agents, one event every 40 ms each, for ten seconds.
        const c = new PatchCoalescer(DEFAULT_PATCH_INTERVAL_MS);
        const ids = ['ta_1', 'ta_2', 'ta_3', 'ta_4'];
        const posts: Record<string, number> = { ta_1: 0, ta_2: 0, ta_3: 0, ta_4: 0 };

        for (let now = 0; now <= 10_000; now += 40) {
            for (const id of ids) c.record(id, { progress: { turn: now, maxTurns: 25 } });
            for (const patch of c.drain(now)) posts[patch.id]++;
        }

        for (const id of ids) {
            // 10 s at 4 Hz is 40, plus the first unthrottled post.
            expect(posts[id]).toBeLessThanOrEqual(41);
        }
    });
});

describe('the git-mutex budget', () => {
    it('permits one probe per agent per interval', () => {
        const budget = new ProbeBudget(GIT_POLL_INTERVAL_MS);
        expect(budget.mayRun('ta_1', 0)).toBe(true);
        expect(budget.mayRun('ta_1', 9_999)).toBe(false);
        expect(budget.mayRun('ta_1', 10_000)).toBe(true);
    });

    it('budgets each agent separately', () => {
        const budget = new ProbeBudget(GIT_POLL_INTERVAL_MS);
        expect(budget.mayRun('ta_1', 0)).toBe(true);
        expect(budget.mayRun('ta_2', 0)).toBe(true);
    });

    it('holds four agents to at most one acquisition each per 10 s — the M76 gate', () => {
        const budget = new ProbeBudget(GIT_POLL_INTERVAL_MS);
        const ids = ['ta_1', 'ta_2', 'ta_3', 'ta_4'];
        const acquisitions: Record<string, number> = { ta_1: 0, ta_2: 0, ta_3: 0, ta_4: 0 };

        // Ask on every event for ten seconds — the pathological caller this gate exists for.
        for (let now = 0; now < 10_000; now += 40) {
            for (const id of ids) if (budget.mayRun(id, now)) acquisitions[id]++;
        }

        for (const id of ids) expect(acquisitions[id]).toBe(1);
    });
});

describe('not computing for a surface nobody has open', () => {
    it('declines when every surface is closed', () => {
        expect(shouldPublish([{ open: false }, { open: false }])).toBe(false);
        expect(shouldPublish([])).toBe(false);
        expect(shouldPublish([{ open: false }, { open: true }])).toBe(true);
    });
});
