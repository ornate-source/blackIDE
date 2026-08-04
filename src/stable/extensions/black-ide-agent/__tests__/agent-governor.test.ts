import { describe, expect, it } from 'vitest';
import { AgentGovernor, GOVERNOR_DEFAULTS, clampConcurrency } from '@blackide/agent-core/core/agent-governor';

/**
 * Phase 6, M33 — the concurrency and spend governor.
 *
 * Two properties carry everything else. **Admission is a reservation, not a boolean**:
 * runs are launched from webview messages, so `canStart()` then `start()` is a race two
 * clicks in the same tick will win. And **one governor spans both lanes**: task agents and
 * pipeline runs hit the same repo and the same provider account, so two caps of four is a
 * cap of eight discovered at the worst possible moment.
 */

describe('concurrency admission', () => {
    it('grants up to the cap and refuses past it', () => {
        const governor = new AgentGovernor({ maxConcurrent: 2 });
        expect(governor.reserve().ok).toBe(true);
        expect(governor.reserve().ok).toBe(true);

        const third = governor.reserve();
        expect(third.ok).toBe(false);
        if (!third.ok) {
            expect(third.reason).toBe('at-capacity');
            expect(third.message).toContain('limit is 2');
        }
    });

    it('has no window between the check and the claim', () => {
        // The race this exists to close: two launches in the same tick, each seeing a
        // free slot. Reservations are handed out one at a time, so the second is refused.
        const governor = new AgentGovernor({ maxConcurrent: 1 });
        const [a, b] = [governor.reserve(), governor.reserve()];
        expect([a.ok, b.ok]).toEqual([true, false]);
    });

    it('frees the slot on release', () => {
        const governor = new AgentGovernor({ maxConcurrent: 1 });
        const first = governor.reserve();
        expect(governor.reserve().ok).toBe(false);
        if (first.ok) first.release();
        expect(governor.reserve().ok).toBe(true);
    });

    it('releasing twice does not free somebody else\'s slot', () => {
        // `finally` blocks and error paths both release; a double release that freed a
        // slot would let a fifth agent start while four were running.
        const governor = new AgentGovernor({ maxConcurrent: 2 });
        const first = governor.reserve();
        const second = governor.reserve();
        if (first.ok) { first.release(); first.release(); }

        expect(governor.snapshot().active).toBe(1);
        expect(governor.reserve().ok).toBe(true);
        expect(governor.reserve().ok).toBe(false);
        expect(second.ok).toBe(true);
    });

    it('counts both lanes against one cap', () => {
        const governor = new AgentGovernor({ maxConcurrent: 3 });
        governor.reserve('pipeline');
        governor.reserve('task');
        governor.reserve('task');
        expect(governor.reserve('pipeline').ok).toBe(false);
    });
});

describe('limits are clamped, not validated', () => {
    it('falls back to the default for a garbled value', () => {
        // A garbled setting should behave like an absent one, not like a cap of 1 —
        // these arrive from a hand-editable JSON blob.
        for (const bad of [undefined, NaN, 'eight' as any, null as any]) {
            expect(clampConcurrency(bad)).toBe(GOVERNOR_DEFAULTS.maxConcurrent);
        }
    });

    it('clamps zero and negatives to the default, not to zero', () => {
        // A cap of 0 would mean no agent can ever start, from a stray keystroke.
        expect(clampConcurrency(0)).toBe(GOVERNOR_DEFAULTS.maxConcurrent);
        expect(clampConcurrency(-5)).toBe(GOVERNOR_DEFAULTS.maxConcurrent);
    });

    it('caps at the hard maximum', () => {
        expect(clampConcurrency(500)).toBe(GOVERNOR_DEFAULTS.hardMaxConcurrent);
        expect(clampConcurrency(8)).toBe(8);
    });

    it('floors a fractional value', () => {
        expect(clampConcurrency(3.9)).toBe(3);
    });
});

describe('spend ceilings', () => {
    it('refuses admission once the token budget is spent', () => {
        const governor = new AgentGovernor({ tokenBudget: 1_000 });
        governor.charge(999);
        expect(governor.reserve().ok).toBe(true);

        governor.charge(1);
        const refused = governor.reserve();
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.reason).toBe('token-budget');
    });

    it('stops a run that is already going', () => {
        // A ceiling checked only at admission is a ceiling one unbounded run can exceed.
        const governor = new AgentGovernor({ tokenBudget: 100 });
        expect(governor.mayContinue()).toBeUndefined();
        governor.charge(150);
        expect(governor.mayContinue()?.reason).toBe('token-budget');
    });

    it('enforces a cost ceiling independently of tokens', () => {
        const governor = new AgentGovernor({ costBudget: 1 });
        governor.charge(10, 0.99);
        expect(governor.mayContinue()).toBeUndefined();
        governor.charge(0, 0.02);
        expect(governor.mayContinue()?.reason).toBe('cost-budget');
    });

    it('treats 0 as no ceiling rather than as an instant stop', () => {
        const governor = new AgentGovernor({ tokenBudget: 0, costBudget: 0 });
        governor.charge(10_000_000, 500);
        expect(governor.mayContinue()).toBeUndefined();
        expect(governor.reserve().ok).toBe(true);
    });

    it('ignores negative and garbled charges instead of crediting them', () => {
        const governor = new AgentGovernor({ tokenBudget: 100 });
        governor.charge(-500);
        governor.charge(NaN as any);
        governor.charge(120);
        expect(governor.mayContinue()?.reason).toBe('token-budget');
    });

    it('names the number in the refusal, so the message is actionable', () => {
        const governor = new AgentGovernor({ costBudget: 2.5 });
        governor.charge(0, 3);
        const refusal = governor.mayContinue();
        expect(refusal?.message).toContain('$2.50');
        expect(refusal?.message).toContain('Settings');
    });
});

describe('reconfiguring mid-session', () => {
    it('lowering the cap does not kill running agents', () => {
        // Killing a run because a setting changed would discard completed work to satisfy
        // a number the user was in the middle of typing.
        const governor = new AgentGovernor({ maxConcurrent: 4 });
        governor.reserve(); governor.reserve(); governor.reserve();

        governor.configure({ maxConcurrent: 1 });
        expect(governor.snapshot().active).toBe(3);
        expect(governor.reserve().ok).toBe(false);
    });

    it('raising the cap admits again immediately', () => {
        const governor = new AgentGovernor({ maxConcurrent: 1 });
        governor.reserve();
        expect(governor.reserve().ok).toBe(false);
        governor.configure({ maxConcurrent: 3 });
        expect(governor.reserve().ok).toBe(true);
    });

    it('leaves untouched limits alone', () => {
        const governor = new AgentGovernor({ maxConcurrent: 2, tokenBudget: 500 });
        governor.configure({ maxConcurrent: 5 });
        expect(governor.snapshot().tokenBudget).toBe(500);
    });
});

describe('snapshot', () => {
    it('reports what the UI needs', () => {
        const governor = new AgentGovernor({ maxConcurrent: 3, tokenBudget: 1_000, costBudget: 5 });
        governor.reserve();
        governor.charge(400, 1.25);

        expect(governor.snapshot()).toEqual({
            active: 1, maxConcurrent: 3,
            tokensSpent: 400, tokenBudget: 1_000,
            costSpent: 1.25, costBudget: 5,
            exhausted: false,
        });
    });

    it('flags exhaustion', () => {
        const governor = new AgentGovernor({ tokenBudget: 10 });
        governor.charge(10);
        expect(governor.snapshot().exhausted).toBe(true);
    });

    it('resetSpend clears spend but not live slots', () => {
        const governor = new AgentGovernor({ tokenBudget: 10 });
        governor.reserve();
        governor.charge(50);
        governor.resetSpend();

        const snapshot = governor.snapshot();
        expect(snapshot.tokensSpent).toBe(0);
        expect(snapshot.active).toBe(1);
        expect(snapshot.exhausted).toBe(false);
    });
});
