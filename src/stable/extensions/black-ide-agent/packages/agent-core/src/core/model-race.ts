import { TaskAgentDiff, TaskAgentSummary, describeDiff } from './task-agents';

// ─── Multi-model race (Phase 6, M37) ────────────────────────────────────────
//
// The same prompt to N models, each in its own worktree, compared on evidence rather than
// on vibes. Cursor 2.0 ships this; the substrate here is closer than it looks because a
// race is just N task agents (M31) sharing a `raceId`, so this module contains no
// concurrency, no git and no execution — only the two things that are actually hard:
// **what counts as better**, and **what to do when the answer is "unclear".**
//
// ── The scoring rule, and why it is lexicographic rather than weighted ───────
// The tempting design is a weighted score: tests × 0.6, diff size × 0.3, speed × 0.1. It
// is wrong here, and the way it is wrong is expensive. Any weighting admits a trade in
// which a candidate whose **tests fail** outranks one whose tests pass, because it was
// tidier or quicker — and a race that recommends broken code because it is short has
// actively made the user's decision worse than flipping a coin.
//
// So the comparison is strictly ordered and each term is a tiebreak for the one above:
//
//   1. **Tests pass.** A candidate with failing tests never outranks one with passing
//      tests. Not weighted, not discounted — never.
//   2. **Tests actually ran.** "No test command in this repo" is not the same as "the
//      suite is green", and treating it as such would make every candidate in an untested
//      repo look verified.
//   3. **Fewer failures**, when nobody is green. Between two broken candidates, the one
//      that broke less is the better starting point.
//   4. **Smaller diff.** Among candidates that are equally correct, less churn is easier
//      to review and less likely to carry an unrequested change.
//
// ── And the honest outcome: sometimes there is no winner ─────────────────────
// `pickWinner` returns a recommendation *or* a reason there is none, and nothing here
// applies anything. The user picks; a race auto-applying the output of a model comparison
// is the one behaviour that would make this feature dangerous rather than useful.

/** Bounded hard: each candidate is a full agent run, so N is a multiplier on cost. */
export const MAX_RACE_CANDIDATES = 4;
export const MIN_RACE_CANDIDATES = 2;

export interface RacePlan {
    raceId: string;
    prompt: string;
    modelIds: string[];
}

export type RacePlanResult = { ok: true; plan: RacePlan } | { ok: false; error: string };

/**
 * Validate and bound a race before anything is spent.
 *
 * Duplicate models are dropped rather than accepted: racing a model against itself costs
 * exactly twice as much as not doing that and compares two samples of the same
 * distribution, which is a measurement of temperature, not of models.
 */
export function planRace(
    prompt: string,
    modelIds: string[],
    options: { raceId?: string; now?: number; max?: number } = {},
): RacePlanResult {
    const trimmed = String(prompt || '').trim();
    if (!trimmed) return { ok: false, error: 'A race needs a prompt.' };

    const unique = [...new Set((modelIds || []).map(m => String(m || '').trim()).filter(Boolean))];
    if (unique.length < MIN_RACE_CANDIDATES) {
        return {
            ok: false,
            error: `Pick at least ${MIN_RACE_CANDIDATES} different models to race — `
                + `racing a model against itself measures temperature, not models.`,
        };
    }

    const max = Math.min(options.max ?? MAX_RACE_CANDIDATES, MAX_RACE_CANDIDATES);
    const chosen = unique.slice(0, max);
    const raceId = options.raceId || `race_${(options.now ?? Date.now()).toString(36)}`;
    return { ok: true, plan: { raceId, prompt: trimmed, modelIds: chosen } };
}

/** What a candidate's verification produced. */
export interface CandidateEvidence {
    /**
     * Whether the repo's test command ran at all. `false` means "no suite / could not
     * run", which is deliberately *not* the same as passing — see rule 2.
     */
    testsRan: boolean;
    passed?: number;
    failed?: number;
    /** Wall time of the agent run, used only as a last tiebreak. */
    durationMs?: number;
}

export interface RaceCandidate {
    agentId: string;
    modelId: string;
    status: TaskAgentSummary['status'];
    diff?: TaskAgentDiff;
    evidence?: CandidateEvidence;
}

export interface RankedCandidate extends RaceCandidate {
    rank: number;
    /** Why it landed here, in the words the panel shows. */
    verdict: string;
    /** False when this candidate is not a viable pick at all. */
    viable: boolean;
}

/**
 * Rank candidates best-first.
 *
 * Non-viable candidates (did not complete, or produced no change) are ranked last and
 * marked, rather than filtered out: a race where three of four models failed is a *result*
 * — it says something true about the task — and hiding the failures would present a
 * one-horse race as a considered choice.
 */
export function rankCandidates(candidates: RaceCandidate[]): RankedCandidate[] {
    const scored = (candidates || []).map(candidate => ({
        candidate,
        viable: isViable(candidate),
        key: sortKey(candidate),
    }));

    scored.sort((a, b) => {
        if (a.viable !== b.viable) return a.viable ? -1 : 1;
        for (let i = 0; i < a.key.length; i++) {
            if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
        }
        return 0;
    });

    return scored.map((entry, index) => ({
        ...entry.candidate,
        rank: index + 1,
        viable: entry.viable,
        verdict: describeCandidate(entry.candidate, entry.viable),
    }));
}

function isViable(candidate: RaceCandidate): boolean {
    if (candidate.status !== 'completed') return false;
    // A candidate that changed nothing did not do the task, whatever its tests say.
    return !!candidate.diff && candidate.diff.files > 0;
}

/**
 * The lexicographic sort key. Lower is better in every position.
 *
 * Written as a key rather than a comparator chain so the ordering is one readable list
 * and a future term cannot be inserted above the test result by accident.
 */
function sortKey(candidate: RaceCandidate): number[] {
    const evidence = candidate.evidence;
    const failed = evidence?.failed ?? 0;
    const green = !!evidence?.testsRan && failed === 0;

    return [
        green ? 0 : 1,                                   // 1. tests pass
        evidence?.testsRan ? 0 : 1,                      // 2. tests actually ran
        failed,                                          // 3. fewer failures
        candidate.diff ? candidate.diff.insertions + candidate.diff.deletions : Number.MAX_SAFE_INTEGER, // 4. less churn
        evidence?.durationMs ?? Number.MAX_SAFE_INTEGER, // 5. faster, as a last resort
    ];
}

function describeCandidate(candidate: RaceCandidate, viable: boolean): string {
    if (candidate.status !== 'completed') return `did not finish (${candidate.status})`;
    if (!viable) return 'finished but changed nothing';

    const churn = describeDiff(candidate.diff);
    const evidence = candidate.evidence;
    if (!evidence || !evidence.testsRan) return `${churn} · tests not run`;
    if ((evidence.failed ?? 0) > 0) return `${churn} · ${evidence.failed} test${evidence.failed === 1 ? '' : 's'} failing`;
    return `${churn} · tests pass${evidence.passed ? ` (${evidence.passed})` : ''}`;
}

export interface RaceOutcome {
    ranked: RankedCandidate[];
    /** The recommendation, when there is one. Never applied automatically. */
    winner?: RankedCandidate;
    /** Present when no candidate can be recommended, or when the choice is a human's. */
    reason?: string;
}

/**
 * Recommend a candidate, or explain why the user has to look.
 *
 * There is deliberately no "best of a bad lot" mode. If nothing is verifiably good, saying
 * so is more useful than nominating a leader, because a recommendation carries an implicit
 * claim of confidence that the evidence does not support.
 */
export function pickWinner(candidates: RaceCandidate[]): RaceOutcome {
    const ranked = rankCandidates(candidates);
    const viable = ranked.filter(c => c.viable);

    if (viable.length === 0) {
        return { ranked, reason: 'No candidate finished with changes. Nothing to pick — read the failures and try again.' };
    }

    const best = viable[0];
    const green = viable.filter(isGreen);

    if (green.length === 0) {
        return {
            ranked,
            reason: 'No candidate has a passing test run, so none is recommended. '
                + 'Compare the diffs yourself before applying one.',
        };
    }

    // A tie on the whole key is a genuine tie, and picking the first is picking by list
    // order — which is not a comparison, it is an accident presented as a judgement.
    const tied = green.filter(c => sameKey(sortKey(c), sortKey(green[0])));
    if (tied.length > 1) {
        return {
            ranked,
            reason: `${tied.length} candidates are indistinguishable on tests and diff size `
                + `(${tied.map(c => c.modelId).join(', ')}). Pick the one you would rather maintain.`,
        };
    }

    return { ranked, winner: best };
}

function isGreen(candidate: RaceCandidate): boolean {
    return !!candidate.evidence?.testsRan && (candidate.evidence.failed ?? 0) === 0;
}

function sameKey(a: number[], b: number[]): boolean {
    return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** The losing candidates, for the "pick one, discard the rest" step. */
export function losersOf(outcome: RaceOutcome, winnerAgentId: string): RankedCandidate[] {
    return outcome.ranked.filter(c => c.agentId !== winnerAgentId);
}
