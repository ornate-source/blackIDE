import { describe, expect, it } from 'vitest';
import {
    MAX_RACE_CANDIDATES, RaceCandidate, losersOf, pickWinner, planRace, rankCandidates,
} from '../src/core/model-race';

/**
 * Phase 6, M37 — the multi-model race.
 *
 * The concurrency is M31's; what is tested here is the only part that can mislead a user:
 * **what counts as better**. The comparison is lexicographic rather than weighted, and the
 * first test in this file is the reason. Any weighted score admits a trade where a
 * candidate with *failing tests* outranks one with passing tests because it was tidier or
 * quicker — and a race that recommends broken code because it is short has made the user's
 * decision worse than a coin flip.
 */

const candidate = (over: Partial<RaceCandidate> = {}): RaceCandidate => ({
    agentId: 'ta_1', modelId: 'model-a', status: 'completed',
    diff: { files: 2, insertions: 20, deletions: 5 },
    evidence: { testsRan: true, passed: 10, failed: 0 },
    ...over,
});

// ─── The rule that matters ──────────────────────────────────────────────────

describe('a failing candidate never outranks a passing one', () => {
    it('holds even when the failing one is far tidier and faster', () => {
        const ranked = rankCandidates([
            candidate({
                agentId: 'tidy', modelId: 'fails-but-small',
                diff: { files: 1, insertions: 2, deletions: 0 },
                evidence: { testsRan: true, passed: 9, failed: 1, durationMs: 1_000 },
            }),
            candidate({
                agentId: 'green', modelId: 'passes-but-big',
                diff: { files: 12, insertions: 800, deletions: 300 },
                evidence: { testsRan: true, passed: 10, failed: 0, durationMs: 90_000 },
            }),
        ]);
        expect(ranked[0].agentId).toBe('green');
    });

    it('holds for every diff size a weighted score would trade away', () => {
        for (const insertions of [1, 10, 100, 5_000]) {
            const ranked = rankCandidates([
                candidate({ agentId: 'fail', diff: { files: 1, insertions, deletions: 0 }, evidence: { testsRan: true, failed: 1 } }),
                candidate({ agentId: 'pass', diff: { files: 9, insertions: 9_999, deletions: 9_999 }, evidence: { testsRan: true, failed: 0 } }),
            ]);
            expect(ranked[0].agentId, `insertions=${insertions}`).toBe('pass');
        }
    });

    it('does not treat "no tests ran" as passing', () => {
        // Otherwise every candidate in an untested repo looks verified.
        const ranked = rankCandidates([
            candidate({ agentId: 'untested', evidence: { testsRan: false } }),
            candidate({ agentId: 'verified', evidence: { testsRan: true, passed: 3, failed: 0 } }),
        ]);
        expect(ranked[0].agentId).toBe('verified');
        expect(ranked[1].verdict).toContain('tests not run');
    });
});

describe('tiebreaks, in order', () => {
    it('prefers fewer failures when nobody is green', () => {
        const ranked = rankCandidates([
            candidate({ agentId: 'worse', evidence: { testsRan: true, failed: 7 } }),
            candidate({ agentId: 'better', evidence: { testsRan: true, failed: 2 } }),
        ]);
        expect(ranked[0].agentId).toBe('better');
    });

    it('prefers the smaller diff among equally correct candidates', () => {
        const ranked = rankCandidates([
            candidate({ agentId: 'big', diff: { files: 9, insertions: 400, deletions: 100 } }),
            candidate({ agentId: 'small', diff: { files: 2, insertions: 20, deletions: 4 } }),
        ]);
        expect(ranked[0].agentId).toBe('small');
    });

    it('uses duration only as a last resort', () => {
        const ranked = rankCandidates([
            candidate({ agentId: 'slow', evidence: { testsRan: true, failed: 0, durationMs: 90_000 } }),
            candidate({ agentId: 'fast', evidence: { testsRan: true, failed: 0, durationMs: 5_000 } }),
        ]);
        expect(ranked[0].agentId).toBe('fast');
    });
});

describe('viability', () => {
    it('ranks unfinished candidates last but keeps them visible', () => {
        // Three of four models failing is a result about the task, not noise to hide.
        const ranked = rankCandidates([
            candidate({ agentId: 'failed', status: 'failed' }),
            candidate({ agentId: 'cancelled', status: 'cancelled' }),
            candidate({ agentId: 'ok' }),
        ]);
        expect(ranked[0].agentId).toBe('ok');
        expect(ranked.map(c => c.viable)).toEqual([true, false, false]);
        expect(ranked.find(c => c.agentId === 'failed')?.verdict).toContain('did not finish');
    });

    it('treats a candidate that changed nothing as non-viable however green it is', () => {
        const ranked = rankCandidates([
            candidate({ agentId: 'noop', diff: { files: 0, insertions: 0, deletions: 0 } }),
            candidate({ agentId: 'did-work' }),
        ]);
        expect(ranked[0].agentId).toBe('did-work');
        expect(ranked[1].verdict).toContain('changed nothing');
    });

    it('handles an empty field', () => {
        expect(rankCandidates([])).toEqual([]);
        expect(rankCandidates(undefined as any)).toEqual([]);
    });
});

describe('pickWinner is willing to say "no winner"', () => {
    it('recommends the clear leader', () => {
        const outcome = pickWinner([
            candidate({ agentId: 'a', modelId: 'a', diff: { files: 2, insertions: 20, deletions: 1 } }),
            candidate({ agentId: 'b', modelId: 'b', evidence: { testsRan: true, failed: 3 } }),
        ]);
        expect(outcome.winner?.agentId).toBe('a');
        expect(outcome.reason).toBeUndefined();
    });

    it('refuses to nominate a leader when nothing has a passing test run', () => {
        // A recommendation carries an implicit claim of confidence the evidence does not
        // support; "best of a bad lot" is exactly where that misleads.
        const outcome = pickWinner([
            candidate({ agentId: 'a', evidence: { testsRan: true, failed: 1 } }),
            candidate({ agentId: 'b', evidence: { testsRan: false } }),
        ]);
        expect(outcome.winner).toBeUndefined();
        expect(outcome.reason).toContain('none is recommended');
        // …but it still ranks them, so the user has somewhere to start.
        expect(outcome.ranked).toHaveLength(2);
    });

    it('declines to break a genuine tie by list order', () => {
        const outcome = pickWinner([
            candidate({ agentId: 'a', modelId: 'sonnet' }),
            candidate({ agentId: 'b', modelId: 'gpt' }),
        ]);
        expect(outcome.winner).toBeUndefined();
        expect(outcome.reason).toContain('sonnet');
        expect(outcome.reason).toContain('gpt');
    });

    it('says so when nothing finished', () => {
        const outcome = pickWinner([candidate({ status: 'failed' }), candidate({ agentId: 'b', status: 'cancelled' })]);
        expect(outcome.winner).toBeUndefined();
        expect(outcome.reason).toContain('Nothing to pick');
    });

    it('never applies anything — it only recommends', () => {
        // The whole surface: a race that auto-applied a model comparison would be the one
        // behaviour making this dangerous rather than useful.
        const outcome = pickWinner([candidate()]);
        expect(Object.keys(outcome).sort()).toEqual(['ranked', 'winner']);
    });
});

describe('losersOf', () => {
    it('is everything except the pick', () => {
        const outcome = pickWinner([
            candidate({ agentId: 'a', diff: { files: 1, insertions: 5, deletions: 0 } }),
            candidate({ agentId: 'b', evidence: { testsRan: true, failed: 2 } }),
            candidate({ agentId: 'c', status: 'failed' }),
        ]);
        expect(losersOf(outcome, 'a').map(c => c.agentId).sort()).toEqual(['b', 'c']);
    });
});

describe('planRace', () => {
    it('accepts a normal race', () => {
        const result = planRace('add retry logic', ['a', 'b', 'c'], { now: 1_000 });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.plan.modelIds).toEqual(['a', 'b', 'c']);
            expect(result.plan.raceId).toMatch(/^race_/);
        }
    });

    it('drops duplicate models', () => {
        // Racing a model against itself costs twice as much and compares two samples of
        // one distribution — a measurement of temperature, not of models.
        const result = planRace('p', ['a', 'a', 'b'], {});
        expect(result.ok && result.plan.modelIds).toEqual(['a', 'b']);
    });

    it('refuses fewer than two distinct models', () => {
        expect(planRace('p', ['a', 'a'], {}).ok).toBe(false);
        expect(planRace('p', ['a'], {}).ok).toBe(false);
        expect(planRace('p', [], {}).ok).toBe(false);
    });

    it('refuses an empty prompt', () => {
        expect(planRace('   ', ['a', 'b'], {}).ok).toBe(false);
    });

    it('caps the field, because each candidate is a full agent run', () => {
        const result = planRace('p', ['a', 'b', 'c', 'd', 'e', 'f'], {});
        expect(result.ok && result.plan.modelIds).toHaveLength(MAX_RACE_CANDIDATES);
    });

    it('honours a lower explicit cap but never a higher one', () => {
        expect(planRace('p', ['a', 'b', 'c', 'd'], { max: 2 }).ok && planRace('p', ['a', 'b', 'c', 'd'], { max: 2 }).ok).toBe(true);
        const low = planRace('p', ['a', 'b', 'c', 'd'], { max: 2 });
        expect(low.ok && low.plan.modelIds).toHaveLength(2);
        const high = planRace('p', ['a', 'b', 'c', 'd', 'e', 'f'], { max: 99 });
        expect(high.ok && high.plan.modelIds).toHaveLength(MAX_RACE_CANDIDATES);
    });

    it('trims whitespace and ignores blank model ids', () => {
        const result = planRace('p', [' a ', '', '  ', 'b'], {});
        expect(result.ok && result.plan.modelIds).toEqual(['a', 'b']);
    });
});
