import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    BudgetLedger, DEFAULT_PRICING, ModelTierMetrics, approxTokens, estimateCostUsd,
    gateModelMetrics, pricingFor, scoreExtraction, scoreLspOverGrep, scoreReview,
    stdErrPct, summarise,
} from '../src/core/eval-model-tier';

/**
 * The model tier (X-1).
 *
 * Everything asserted here is the part of a model-backed eval that has to be right
 * *before* a key is involved: the cap that stops the spend, the band that decides
 * whether a drop is real, and the three scoring rules the roadmap's blocked clauses
 * are phrased in. The calls themselves are `eval/model-tier.js`'s problem.
 *
 * That split is the design, not a testing convenience. A runner whose correctness can
 * only be checked by spending money is a runner nobody checks.
 */

describe('budget: enforced before the call, not tallied after', () => {
    it('refuses the call that would cross the cap', () => {
        const ledger = new BudgetLedger(1.0, { inputPerMTok: 1, outputPerMTok: 1 }, 1);
        // 400k in + 100k out = 0.5 MTok at $1/MTok = $0.50.
        expect(ledger.canAfford(400_000, 100_000)).toBe(true);
        ledger.record(400_000, 100_000);
        expect(ledger.state.spentUsd).toBeCloseTo(0.5, 4);

        expect(ledger.canAfford(400_000, 100_000)).toBe(true);
        ledger.record(400_000, 100_000);
        expect(ledger.state.spentUsd).toBeCloseTo(1.0, 4);

        // The third would cross $1.00, so it never happens.
        expect(ledger.canAfford(400_000, 100_000)).toBe(false);
        expect(ledger.state.calls).toBe(2);
    });

    it('records that it refused, so a truncated run cannot look like a finished one', () => {
        const ledger = new BudgetLedger(0.0001, DEFAULT_PRICING);
        expect(ledger.state.exhausted).toBe(false);
        ledger.canAfford(1_000_000, 1_000_000);
        expect(ledger.state.exhausted).toBe(true);
    });

    it('applies a safety factor, because the output size is a guess about an unanswered call', () => {
        const pricing = { inputPerMTok: 1_000_000, outputPerMTok: 0 };
        const strict = new BudgetLedger(1.0, pricing, 1);
        const cautious = new BudgetLedger(1.0, pricing, 1.5);
        // Exactly $0.80 of input. Fits at face value; does not fit with 1.5× headroom.
        expect(strict.canAfford(0.8, 0)).toBe(true);
        expect(cautious.canAfford(0.8, 0)).toBe(false);
    });

    it('prices by longest prefix, so a dated model id is not billed as the default', () => {
        expect(pricingFor('claude-haiku-4-5-20251001').inputPerMTok).toBe(1);
        // `gpt-4o-mini` must not be priced as `gpt-4o`.
        expect(pricingFor('gpt-4o-mini-2024-07-18').inputPerMTok).toBe(0.15);
        expect(pricingFor('gpt-4o-2024-11-20').inputPerMTok).toBe(2.5);
    });

    it('falls back to the expensive end for an unknown model', () => {
        // Wrong in the safe direction: it halts a run early rather than overspending.
        expect(pricingFor('some-new-model')).toEqual(DEFAULT_PRICING);
        expect(pricingFor(undefined)).toEqual(DEFAULT_PRICING);
    });

    it('costs and token estimates are proportional and non-negative', () => {
        expect(estimateCostUsd(1_000_000, 0, { inputPerMTok: 3, outputPerMTok: 15 })).toBeCloseTo(3);
        expect(estimateCostUsd(0, 1_000_000, { inputPerMTok: 3, outputPerMTok: 15 })).toBeCloseTo(15);
        expect(approxTokens('')).toBe(0);
        expect(approxTokens('x'.repeat(400))).toBe(100);
    });
});

describe('variance: N runs produce a rate with an error bar', () => {
    it('a task run five times reports its rate and standard error', () => {
        const summary = summarise([
            { id: 't1', family: 'lspOverGrep', outcomes: [true, true, true, false, true] },
        ]);
        expect(summary.tasks[0].runs).toBe(5);
        expect(summary.tasks[0].passes).toBe(4);
        expect(summary.tasks[0].ratePct).toBe(80);
        expect(summary.tasks[0].stdErrPct).toBeGreaterThan(0);
        expect(summary.complete).toBe(true);
    });

    it('a unanimous task has zero standard error — which is why the gate has a floor', () => {
        expect(stdErrPct(5, 5)).toBe(0);
        expect(stdErrPct(0, 5)).toBe(0);
        expect(stdErrPct(1, 1)).toBe(0);
    });

    it('families pool over runs rather than averaging task rates', () => {
        const summary = summarise([
            { id: 'a', family: 'f', outcomes: [true, true, true, true] },   // 4/4
            { id: 'b', family: 'f', outcomes: [false] },                     // 0/1
        ]);
        // Averaging the two task rates would give 50%. Pooling gives 4/5 = 80%, which
        // is the number that reflects the evidence actually collected.
        expect(summary.families[0].ratePct).toBe(80);
        expect(summary.families[0].runs).toBe(5);
    });

    it('a budget-skipped run is not counted as a failure', () => {
        const summary = summarise([
            { id: 'a', family: 'f', outcomes: [true, true, undefined, undefined] },
        ]);
        expect(summary.tasks[0].runs).toBe(2);
        expect(summary.tasks[0].ratePct).toBe(100);
        expect(summary.tasks[0].skipped).toBe(2);
        expect(summary.complete).toBe(false);
        expect(summary.skippedRuns).toBe(2);
    });
});

// ─── The gate ───────────────────────────────────────────────────────────────

const metrics = (families: { family: string; ratePct: number; stdErrPct?: number; skipped?: number }[],
    over: Partial<ModelTierMetrics> = {}): ModelTierMetrics => ({
    generatedAt: '2026-08-04T00:00:00.000Z',
    model: 'test-model',
    runsPerTask: 5,
    complete: true,
    budget: { capUsd: 5, spentUsd: 0.1, remainingUsd: 4.9, calls: 10, inputTokens: 100, outputTokens: 100, exhausted: false },
    families: families.map(f => ({
        family: f.family, tasks: 1, runs: 20, passes: 0,
        ratePct: f.ratePct, stdErrPct: f.stdErrPct ?? 0, skipped: f.skipped ?? 0,
    })),
    ...over,
});

describe('gate: quiet on noise, loud on a real drop, never green on a truncated run', () => {
    it('a drop inside the noise band does not fail the build', () => {
        const result = gateModelMetrics(
            metrics([{ family: 'lspOverGrep', ratePct: 78, stdErrPct: 4 }]),
            metrics([{ family: 'lspOverGrep', ratePct: 80, stdErrPct: 4 }]),
        );
        expect(result.ok).toBe(true);
        expect(result.regressions).toEqual([]);
    });

    it('a drop beyond the band fails, and says how far beyond', () => {
        const result = gateModelMetrics(
            metrics([{ family: 'lspOverGrep', ratePct: 40, stdErrPct: 4 }]),
            metrics([{ family: 'lspOverGrep', ratePct: 80, stdErrPct: 4 }]),
        );
        expect(result.ok).toBe(false);
        expect(result.regressions[0]).toMatch(/lspOverGrep: 80% → 40%/);
        expect(result.regressions[0]).toMatch(/noise band/);
    });

    it('an improvement is never a regression', () => {
        const result = gateModelMetrics(
            metrics([{ family: 'f', ratePct: 95, stdErrPct: 2 }]),
            metrics([{ family: 'f', ratePct: 60, stdErrPct: 5 }]),
        );
        expect(result.ok).toBe(true);
    });

    it('a perfect baseline gets the floor rather than a zero-width band', () => {
        // stdErr is 0 on both sides; without `floorPct` a single flaky run out of 20
        // (100% → 95%) would fail the build.
        const result = gateModelMetrics(
            metrics([{ family: 'f', ratePct: 95, stdErrPct: 0 }]),
            metrics([{ family: 'f', ratePct: 100, stdErrPct: 0 }]),
        );
        expect(result.ok).toBe(true);

        // A real collapse still fails.
        expect(gateModelMetrics(
            metrics([{ family: 'f', ratePct: 55, stdErrPct: 0 }]),
            metrics([{ family: 'f', ratePct: 100, stdErrPct: 0 }]),
        ).ok).toBe(false);
    });

    it('a truncated run is neither a pass nor a regression — it says it was truncated', () => {
        const result = gateModelMetrics(
            metrics([{ family: 'f', ratePct: 100, skipped: 6 }], { complete: false }),
            metrics([{ family: 'f', ratePct: 100 }]),
        );
        expect(result.ok).toBe(false);
        expect(result.regressions[0]).toMatch(/truncated by the budget cap/);
        expect(result.regressions[0]).toMatch(/neither a pass nor evidence of a regression/);
    });

    it('a first run with no baseline passes and says to record one', () => {
        const result = gateModelMetrics(metrics([{ family: 'f', ratePct: 70 }]), undefined);
        expect(result.ok).toBe(true);
        expect(result.notes.join(' ')).toMatch(/No model baseline recorded yet/);
    });

    it('a different model makes the comparison advisory rather than failing', () => {
        const result = gateModelMetrics(
            metrics([{ family: 'f', ratePct: 30 }], { model: 'model-b' }),
            metrics([{ family: 'f', ratePct: 90 }], { model: 'model-a' }),
        );
        expect(result.notes.join(' ')).toMatch(/not comparable across models/);
        // It still reports the drop — advisory means "say why", not "say nothing".
        expect(result.regressions.length).toBe(1);
    });

    it('a new metric family is a note, not a failure', () => {
        const result = gateModelMetrics(
            metrics([{ family: 'old', ratePct: 90 }, { family: 'new', ratePct: 40 }]),
            metrics([{ family: 'old', ratePct: 90 }]),
        );
        expect(result.ok).toBe(true);
        expect(result.notes.join(' ')).toMatch(/New metric family "new"/);
    });
});

// ─── The three blocked measurements ─────────────────────────────────────────

describe('P1-1 scoring: the language server has to be reached for FIRST', () => {
    it('passes when an LSP tool is the first search-class call', () => {
        expect(scoreLspOverGrep(['read_file', 'go_to_definition', 'read_file'])).toBe(true);
        expect(scoreLspOverGrep(['find_references'])).toBe(true);
    });

    it('fails when grep got there first, even if the LSP is used later', () => {
        // The cost the gate exists to avoid has already been paid by then.
        expect(scoreLspOverGrep(['grep_search', 'read_file', 'find_references'])).toBe(false);
    });

    it('fails when neither was called — a symbol question answered from memory is not the gate passing', () => {
        expect(scoreLspOverGrep([])).toBe(false);
        expect(scoreLspOverGrep(['read_file', 'complete_task'])).toBe(false);
    });

    it('treats semantic codebase_search as a text answer, not a symbol one', () => {
        expect(scoreLspOverGrep(['codebase_search', 'go_to_definition'])).toBe(false);
    });
});

describe('P8-1 scoring: found the facts and refused the noise', () => {
    it('passes when every expected fact is present and nothing forbidden is', () => {
        const score = scoreExtraction({
            produced: ['The team deploys with Terraform, not CDK.', 'Prefers tabs over spaces.'],
            expected: ['deploys with Terraform', 'prefers tabs'],
            forbidden: ['the user asked me to fix the test'],
        });
        expect(score.passed).toBe(true);
        expect(score.missed).toEqual([]);
    });

    it('fails on a leak even when every fact was found', () => {
        const score = scoreExtraction({
            produced: ['deploys with Terraform', 'The user asked me to fix the failing test'],
            expected: ['deploys with Terraform'],
            forbidden: ['the user asked me to fix the failing test'],
        });
        expect(score.passed).toBe(false);
        expect(score.leaked.length).toBe(1);
    });

    it('fails on a miss even when nothing leaked', () => {
        const score = scoreExtraction({
            produced: ['deploys with Terraform'],
            expected: ['deploys with Terraform', 'the staging database is read-only'],
            forbidden: [],
        });
        expect(score.passed).toBe(false);
        expect(score.missed).toEqual(['the staging database is read-only']);
    });

    it('matches on content rather than wording — the metric is accuracy, not prose style', () => {
        const score = scoreExtraction({
            produced: ['  The  team   DEPLOYS with Terraform!  '],
            expected: ['deploys with terraform'],
            forbidden: [],
        });
        expect(score.passed).toBe(true);
    });
});

describe('P9-2 scoring: recall and false positives pass together or not at all', () => {
    it('a reviewer that finds most defects with few false alarms passes', () => {
        const score = scoreReview({
            flagged: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'x1'],
            planted: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10'],
        });
        expect(score.recallPct).toBe(90);
        expect(score.falsePositivesPer10).toBe(1);
        expect(score.passed).toBe(true);
    });

    it('flagging everything does not pass, despite perfect recall', () => {
        const score = scoreReview({
            flagged: ['d1', 'd2', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8'],
            planted: ['d1', 'd2'],
        });
        expect(score.recallPct).toBe(100);
        expect(score.falsePositivesPer10).toBe(8);
        expect(score.passed).toBe(false);
    });

    it('flagging nothing does not pass, despite no false positives', () => {
        const score = scoreReview({ flagged: [], planted: ['d1', 'd2'] });
        expect(score.recallPct).toBe(0);
        expect(score.falsePositivesPer10).toBe(0);
        expect(score.passed).toBe(false);
    });

    it('the same defect flagged twice is one finding, not two', () => {
        const score = scoreReview({ flagged: ['d1', 'd1', 'd2'], planted: ['d1', 'd2'] });
        expect(score.truePositives).toBe(2);
        expect(score.falsePositives).toBe(0);
    });

    it('sits exactly on the stated boundary: 60% recall at 1 FP per 10', () => {
        const score = scoreReview({
            flagged: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'x1', 'x2', 'x3'],
            planted: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10'],
        });
        expect(score.recallPct).toBe(60);
        expect(score.falsePositivesPer10).toBeGreaterThan(1);
        expect(score.passed).toBe(false);
    });
});

// ─── The runner is wired, and stays off by default ──────────────────────────

describe('the tier is opt-in and separate from the deterministic gate', () => {
    const evalDir = path.join(__dirname, '..', 'eval');
    const runner = fs.readFileSync(path.join(evalDir, 'run-eval.js'), 'utf8');

    it('ships a runner and a task set', () => {
        expect(fs.existsSync(path.join(evalDir, 'model-tier.js'))).toBe(true);
        expect(fs.existsSync(path.join(evalDir, 'model-tasks.js'))).toBe(true);
    });

    it('run-eval.js only reaches the model tier behind --models', () => {
        expect(runner).toMatch(/--models/);
        expect(runner).toMatch(/argv\.includes\('--models'\)/);
    });

    it('writes its own baseline, never eval/baseline.json', () => {
        const modelTier = fs.readFileSync(path.join(evalDir, 'model-tier.js'), 'utf8');
        expect(modelTier).toMatch(/baseline-models\.json/);
        expect(modelTier).not.toMatch(/'baseline\.json'/);
    });

    it('the deterministic baseline carries no model-tier metric', () => {
        // The two tiers share a report and nothing else. A model number appearing in
        // eval/baseline.json would put a non-deterministic value behind every CI run,
        // which is the exact failure X-1 exists to avoid.
        const baseline = JSON.parse(fs.readFileSync(path.join(evalDir, 'baseline.json'), 'utf8'));
        for (const key of Object.keys(baseline)) {
            expect(key).not.toMatch(/lspOverGrep|memoryExtraction|reviewFindings|modelTier/i);
        }
    });

    it('every model task declares a family the scorer knows', () => {
        const tasks = require(path.join(evalDir, 'model-tasks.js'));
        const known = new Set(['lspOverGrep', 'memoryExtraction', 'reviewFindings']);
        expect(tasks.length).toBeGreaterThan(0);
        for (const task of tasks) {
            expect(known.has(task.family)).toBe(true);
            expect(typeof task.id).toBe('string');
        }
    });
});
