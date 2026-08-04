// ─── The model tier of the eval harness (X-1) ───────────────────────────────
//
// Fifteen revisions of the roadmap have named this as the single prerequisite blocking
// P1-1 (LSP-over-grep), P8-1's accuracy clause and P9-2's TP/FP rate, and fifteen have
// not built it. The reason is not effort. It is that a model-backed measurement has
// three properties the deterministic tiers do not — it costs money, it is
// non-deterministic, and it can fail for reasons that have nothing to do with the
// code — and wiring five phases' gates to a runner with those properties is how a green
// gate becomes a disabled gate.
//
// So the tier is built around the three properties rather than in spite of them:
//
//   **Cost** → `BudgetLedger`. A cap in USD, checked *before* each call, not tallied
//   after. A run that hits the cap stops and is reported `incomplete`, never `passed`:
//   a truncated run that reports green is worse than no runner, because it reports
//   green loudest on the day the key is rate-limited and only two tasks ran.
//
//   **Non-determinism** → `summarise` runs each task N times and reports a rate with
//   its standard error, and `gateModelMetrics` compares against the baseline using a
//   band derived from that error. A metric that drops inside the band is noise; the
//   gate is silent on it by construction rather than by someone lowering a threshold.
//
//   **Independence** → its own baseline file. `eval/baseline.json` is the
//   deterministic gate every CI run enforces and must stay that way. Nothing in this
//   module can move a number in it.
//
// Everything here is pure. The calls themselves live in `eval/model-tier.js`, which
// owns the API keys and the I/O; this module owns every decision that has to be
// correct, so every decision that has to be correct is unit-testable without a key.

/** USD per million tokens, per direction. */
export interface ModelPricing {
    inputPerMTok: number;
    outputPerMTok: number;
}

/**
 * Published list prices, and a deliberately *pessimistic* default.
 *
 * The default is the expensive end rather than an average, because this table's job is
 * to stop a run before it spends money and the failure modes are asymmetric: an
 * over-estimate halts a run early and someone raises the cap, an under-estimate spends
 * past the cap the user set. A table that is out of date in the safe direction is a
 * table that still works.
 */
export const DEFAULT_PRICING: ModelPricing = { inputPerMTok: 15, outputPerMTok: 75 };

export const PRICING: Record<string, ModelPricing> = {
    'claude-opus-5': { inputPerMTok: 15, outputPerMTok: 75 },
    'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
    'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
    'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
    'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
    'gemini-2.5-pro': { inputPerMTok: 1.25, outputPerMTok: 10 },
    'gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
};

/**
 * Price a model id, longest-prefix first.
 *
 * Providers append dates and suffixes (`claude-haiku-4-5-20251001`,
 * `gpt-4o-mini-2024-07-18`), and an exact-match table would silently fall through to
 * the pessimistic default for every real-world id — which reads as "the budget is
 * mysteriously tiny" rather than as a missing table row. Longest prefix wins so
 * `gpt-4o-mini` is not priced as `gpt-4o`.
 */
export function pricingFor(model: string | undefined): ModelPricing {
    if (!model) return DEFAULT_PRICING;
    const id = model.toLowerCase();
    let best: { key: string; pricing: ModelPricing } | undefined;
    for (const [key, pricing] of Object.entries(PRICING)) {
        if (!id.startsWith(key)) continue;
        if (!best || key.length > best.key.length) best = { key, pricing };
    }
    return best?.pricing ?? DEFAULT_PRICING;
}

export function estimateCostUsd(inputTokens: number, outputTokens: number, pricing: ModelPricing): number {
    return (inputTokens / 1_000_000) * pricing.inputPerMTok
        + (outputTokens / 1_000_000) * pricing.outputPerMTok;
}

/**
 * Rough token count for budgeting only.
 *
 * Four characters per token is the usual English approximation and is wrong for code
 * in the direction that matters least here — code tokenises *denser* than 4 chars/token
 * for punctuation runs, so this under-counts, which is why `BudgetLedger.canAfford`
 * applies a safety factor on top rather than trusting this number.
 *
 * Deliberately not a real tokeniser: pulling one in would add a dependency and a
 * per-provider vocabulary to a number that only decides whether to make one more call.
 */
export function approxTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

export interface BudgetState {
    capUsd: number;
    spentUsd: number;
    remainingUsd: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    /** True once a call has been refused for want of budget. */
    exhausted: boolean;
}

/**
 * A spend cap that is enforced before the call, not after it.
 *
 * The distinction is the whole point. A ledger that records spend and warns afterwards
 * is an invoice; this one refuses the call that would cross the line. `canAfford`
 * takes the *estimated* size of the call it is being asked about, because the only
 * moment at which a cap can be enforced is before the money is spent.
 */
export class BudgetLedger {
    private spent = 0;
    private calls = 0;
    private inputTokens = 0;
    private outputTokens = 0;
    private refused = false;

    /**
     * @param capUsd   Hard ceiling for the whole run.
     * @param pricing  Prices for the model being measured.
     * @param safety   Multiplier applied to estimates in `canAfford`. Defaults to 1.5
     *                 because `approxTokens` under-counts code and an output estimate
     *                 is a guess about a model that has not answered yet.
     */
    constructor(
        private readonly capUsd: number,
        private readonly pricing: ModelPricing = DEFAULT_PRICING,
        private readonly safety = 1.5,
    ) {}

    /** Would a call of roughly this size still fit under the cap? */
    canAfford(estInputTokens: number, estOutputTokens: number): boolean {
        const estimate = estimateCostUsd(estInputTokens, estOutputTokens, this.pricing) * this.safety;
        const fits = this.spent + estimate <= this.capUsd;
        if (!fits) this.refused = true;
        return fits;
    }

    /** Book a completed call. Returns what it cost. */
    record(inputTokens: number, outputTokens: number): number {
        const cost = estimateCostUsd(inputTokens, outputTokens, this.pricing);
        this.spent += cost;
        this.calls++;
        this.inputTokens += inputTokens;
        this.outputTokens += outputTokens;
        return cost;
    }

    get state(): BudgetState {
        return {
            capUsd: this.capUsd,
            spentUsd: round(this.spent, 4),
            remainingUsd: round(Math.max(0, this.capUsd - this.spent), 4),
            calls: this.calls,
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            exhausted: this.refused,
        };
    }
}

// ─── Variance ───────────────────────────────────────────────────────────────

/** One task's outcome across N runs. `undefined` marks a run the budget cut short. */
export interface TaskRuns {
    id: string;
    /** The metric family this task scores into (`lspOverGrep`, `memoryExtraction`, …). */
    family: string;
    /** One entry per attempted run. */
    outcomes: (boolean | undefined)[];
}

export interface TaskStat {
    id: string;
    family: string;
    /** Runs that produced an outcome. Runs the budget skipped are not counted. */
    runs: number;
    passes: number;
    ratePct: number;
    /** Standard error of the rate, in percentage points. 0 when runs ≤ 1. */
    stdErrPct: number;
    skipped: number;
}

/**
 * Bernoulli standard error, in percentage points.
 *
 * Using the standard error of the *mean* rather than the sample standard deviation is
 * the correct choice for the thing the gate asks: "could this drop be chance?" is a
 * question about how precisely N runs pin down the true rate, not about how much
 * individual runs vary — and for a binary outcome the second number is fixed by the
 * first, so reporting it would tell the reader nothing they could act on.
 */
export function stdErrPct(passes: number, runs: number): number {
    if (runs <= 1) return 0;
    const p = passes / runs;
    return round(Math.sqrt((p * (1 - p)) / runs) * 100, 2);
}

export function taskStat(t: TaskRuns): TaskStat {
    const done = t.outcomes.filter((o): o is boolean => o !== undefined);
    const passes = done.filter(Boolean).length;
    return {
        id: t.id,
        family: t.family,
        runs: done.length,
        passes,
        ratePct: done.length ? round((passes / done.length) * 100, 1) : 0,
        stdErrPct: stdErrPct(passes, done.length),
        skipped: t.outcomes.length - done.length,
    };
}

export interface FamilyStat {
    family: string;
    tasks: number;
    runs: number;
    passes: number;
    ratePct: number;
    stdErrPct: number;
    skipped: number;
}

export interface ModelTierSummary {
    /** Per-task detail, for the report. */
    tasks: TaskStat[];
    /** Per-family rollup — these are the numbers the gate compares. */
    families: FamilyStat[];
    /**
     * False when any run was skipped for budget. A summary that is not complete must
     * never be recorded as a baseline nor reported as a pass, so the flag travels with
     * the numbers rather than being inferred by each caller.
     */
    complete: boolean;
    skippedRuns: number;
}

export function summarise(runs: TaskRuns[]): ModelTierSummary {
    const tasks = runs.map(taskStat);
    const byFamily = new Map<string, TaskStat[]>();
    for (const t of tasks) {
        const list = byFamily.get(t.family) || [];
        list.push(t);
        byFamily.set(t.family, list);
    }

    const families: FamilyStat[] = [];
    for (const [family, list] of byFamily) {
        // Pooled over runs rather than averaged over task rates: a family whose tasks
        // ran a different number of times (the budget cut one short) would otherwise
        // weight a 1-run task the same as a 5-run one.
        const runCount = list.reduce((n, t) => n + t.runs, 0);
        const passes = list.reduce((n, t) => n + t.passes, 0);
        families.push({
            family,
            tasks: list.length,
            runs: runCount,
            passes,
            ratePct: runCount ? round((passes / runCount) * 100, 1) : 0,
            stdErrPct: stdErrPct(passes, runCount),
            skipped: list.reduce((n, t) => n + t.skipped, 0),
        });
    }
    families.sort((a, b) => a.family.localeCompare(b.family));

    const skippedRuns = tasks.reduce((n, t) => n + t.skipped, 0);
    return { tasks, families, complete: skippedRuns === 0, skippedRuns };
}

// ─── The gate ───────────────────────────────────────────────────────────────

export interface ModelTierMetrics {
    generatedAt: string;
    model: string;
    runsPerTask: number;
    complete: boolean;
    budget: BudgetState;
    families: FamilyStat[];
}

export interface GateOptions {
    /**
     * How many standard errors a drop must exceed before it counts. Two is the usual
     * ~95% band and is what makes the gate quiet on noise.
     */
    sigma?: number;
    /**
     * A floor on the band, in percentage points. Without it a family that scored 100%
     * on every run has a standard error of exactly zero, and *any* regression — including
     * a single flaky run — fails the build. The floor is what keeps a perfect baseline
     * from being the most fragile one.
     */
    floorPct?: number;
}

export interface GateResult {
    ok: boolean;
    regressions: string[];
    /** Non-fatal notes: a run that could not be gated, and why. */
    notes: string[];
}

/**
 * Compare a model-tier run against its own baseline.
 *
 * Never returns `ok: false` for an incomplete run — it returns `ok: false` *and says
 * the run was truncated*, which is a different sentence and the one a reader needs.
 * An incomplete run is not evidence of a regression and must not be reported as one,
 * but it is also not a pass, because the tasks that did not run are exactly the tasks
 * that would have caught the thing.
 */
export function gateModelMetrics(
    current: ModelTierMetrics,
    baseline: ModelTierMetrics | undefined,
    options: GateOptions = {},
): GateResult {
    const sigma = options.sigma ?? 2;
    const floor = options.floorPct ?? 5;
    const regressions: string[] = [];
    const notes: string[] = [];

    if (!current.complete) {
        regressions.push(
            `the run was truncated by the budget cap ($${current.budget.capUsd}) after `
            + `${current.budget.calls} calls — ${current.families.reduce((n, f) => n + f.skipped, 0)} run(s) never happened, `
            + 'so this run is neither a pass nor evidence of a regression. Raise --model-budget or lower --model-runs.',
        );
        return { ok: false, regressions, notes };
    }

    if (!baseline) {
        notes.push('No model baseline recorded yet — run with --models --json to create one.');
        return { ok: true, regressions, notes };
    }

    if (baseline.model !== current.model) {
        // Comparing a run of one model against another model's baseline measures the
        // models, not the change. Saying so beats failing the build on it.
        notes.push(`Baseline was recorded against "${baseline.model}" and this run used `
            + `"${current.model}" — rates are not comparable across models, so the gate is advisory.`);
    }

    const previous = new Map(baseline.families.map(f => [f.family, f]));
    for (const family of current.families) {
        const before = previous.get(family.family);
        if (!before) {
            notes.push(`New metric family "${family.family}" (${family.ratePct}%) — no baseline to compare.`);
            continue;
        }
        // The band is built from *both* runs' errors: the baseline is an estimate too,
        // and treating it as exact is what makes a gate fire on the day the baseline
        // happened to be recorded on a lucky run.
        const band = Math.max(floor, sigma * Math.hypot(before.stdErrPct, family.stdErrPct));
        if (family.ratePct < before.ratePct - band) {
            regressions.push(
                `  ✗ ${family.family}: ${before.ratePct}% → ${family.ratePct}% `
                + `(drop of ${round(before.ratePct - family.ratePct, 1)} pts exceeds the ±${round(band, 1)} pt noise band `
                + `over ${family.runs} runs)`,
            );
        }
    }

    return { ok: regressions.length === 0, regressions, notes };
}

function round(n: number, places: number): number {
    const f = 10 ** places;
    return Math.round(n * f) / f;
}

// ─── Scoring the three blocked measurements ─────────────────────────────────
//
// The runner supplies observations; these functions decide whether an observation
// passed. They live here rather than in the runner for the reason the whole module
// does: the scoring rule is the part that has to be right, and it is testable with no
// key, no network and no cost.

/** Tools that answer a symbol question through the language server rather than text. */
export const LSP_TOOLS = [
    'go_to_definition', 'find_references', 'workspace_symbols', 'hover',
    'document_symbols', 'rename_symbol', 'impact_analysis', 'code_actions',
];

/** Tools that answer it by searching text — the behaviour P1-1's gate exists to exclude. */
export const TEXT_SEARCH_TOOLS = ['grep_search', 'codebase_search'];

/**
 * P1-1: did the model reach for the language server first?
 *
 * Scored on the **first** tool call and not on "an LSP tool appears anywhere in the
 * transcript", because a model that greps, reads three files and then calls
 * `go_to_definition` has already paid the cost the gate exists to avoid. First call is
 * also the only point the observation is unambiguous: later calls are conditioned on
 * what the earlier ones returned, so a run where grep happened to answer the question
 * would score as a pass for a reason that has nothing to do with tool choice.
 */
export function scoreLspOverGrep(toolCalls: string[]): boolean {
    const first = toolCalls.find(name => LSP_TOOLS.includes(name) || TEXT_SEARCH_TOOLS.includes(name));
    return first !== undefined && LSP_TOOLS.includes(first);
}

export interface ExtractionObservation {
    /** Candidate texts the extractor produced from the turn. */
    produced: string[];
    /** Facts the turn genuinely contained, which a good extraction finds. */
    expected: string[];
    /** Text that must NOT be extracted — narration, restated tasks, questions. */
    forbidden: string[];
}

export interface ExtractionScore {
    /** True when every expected fact was found and nothing forbidden was. */
    passed: boolean;
    matched: string[];
    missed: string[];
    leaked: string[];
}

/**
 * P8-1: did end-of-turn extraction find the facts and refuse the noise?
 *
 * Matching is on normalised substring containment rather than equality: the extractor
 * writes a sentence, and asserting its exact wording would measure prose style and call
 * it accuracy. What must be exact is the *forbidden* side — a leak is a leak regardless
 * of how it is phrased — so both directions use the same loose matcher and the strictness
 * lives in which list a hit lands in.
 */
export function scoreExtraction(observation: ExtractionObservation): ExtractionScore {
    const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const produced = observation.produced.map(normalise);
    const hit = (needle: string) => {
        const n = normalise(needle);
        return produced.some(p => p.includes(n) || n.includes(p));
    };

    const matched = observation.expected.filter(hit);
    const missed = observation.expected.filter(e => !matched.includes(e));
    const leaked = observation.forbidden.filter(hit);
    return { passed: missed.length === 0 && leaked.length === 0, matched, missed, leaked };
}

export interface ReviewObservation {
    /** Line numbers (or defect ids) the reviewer flagged. */
    flagged: string[];
    /** Defects genuinely planted in the diff. */
    planted: string[];
}

export interface ReviewScore {
    truePositives: number;
    falsePositives: number;
    planted: number;
    /** Share of planted defects found, 0–100. */
    recallPct: number;
    /** False positives per ten findings — P9-2's acceptance clause states it this way. */
    falsePositivesPer10: number;
    /** P9-2's gate: ≥60% of planted defects found at ≤1 false positive per 10 findings. */
    passed: boolean;
}

/**
 * P9-2: is the Reviewer worth reading?
 *
 * The two halves are scored together and pass together, because either one alone is
 * trivially satisfiable in the wrong direction: a reviewer that flags every line has
 * perfect recall, and one that flags nothing has no false positives. The acceptance
 * clause names both for that reason and this function enforces the conjunction.
 */
export function scoreReview(observation: ReviewObservation): ReviewScore {
    const planted = new Set(observation.planted);
    const flagged = [...new Set(observation.flagged)];
    const truePositives = flagged.filter(f => planted.has(f)).length;
    const falsePositives = flagged.length - truePositives;
    const recallPct = planted.size ? round((truePositives / planted.size) * 100, 1) : 0;
    const falsePositivesPer10 = flagged.length ? round((falsePositives / flagged.length) * 10, 2) : 0;
    return {
        truePositives,
        falsePositives,
        planted: planted.size,
        recallPct,
        falsePositivesPer10,
        passed: recallPct >= 60 && falsePositivesPer10 <= 1,
    };
}
