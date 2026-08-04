/*
 * The model tier of the eval harness (X-1).
 *
 * Off by default. Reached only through `node eval/run-eval.js --models`, writes only to
 * `eval/baseline-models.json`, and cannot move a number in the deterministic
 * `eval/baseline.json` that every CI run gates on.
 *
 *   node eval/run-eval.js --models                       # measure and gate
 *   node eval/run-eval.js --models --json                # record the model baseline
 *   node eval/run-eval.js --models --model-runs=5        # N-run variance (default 3)
 *   node eval/run-eval.js --models --model-budget=2.50   # hard USD cap (default 1.00)
 *   node eval/run-eval.js --models --model-family=lspOverGrep
 *
 * ── Configuration ────────────────────────────────────────────────────────────
 *   BLACKIDE_EVAL_PROVIDER   claude | google | openai | … (default: claude)
 *   BLACKIDE_EVAL_MODEL      model id  (default: claude-sonnet-5)
 *   BLACKIDE_EVAL_API_KEY    the key; falls back to ANTHROPIC_API_KEY / OPENAI_API_KEY
 *   BLACKIDE_EVAL_URL        override the endpoint (local models, gateways)
 *
 * ── This file owns the I/O and nothing else ──────────────────────────────────
 * Every decision that has to be *correct* — the budget cap, the variance statistics, the
 * gate's noise band, the three scoring rules — lives in `src/core/eval-model-tier.ts` and
 * is unit-tested in `__tests__/eval-model-tier.test.ts` without a key, a network or a
 * cent. What is here is the part that cannot be tested that way: making the call.
 *
 * ── The one rule this file must not break ────────────────────────────────────
 * A run that could not finish reports `incomplete`, never `passed`. It is the day the key
 * is rate-limited and two of thirteen tasks ran that a green tick does the most damage.
 */

const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
/*
 * Where a compiled module lives, now that the core is a package (M62 · P11-2).
 *
 * Two output trees: the extension's `dist/`, and `packages/agent-core/dist/` for the 64
 * modules that moved. Resolved by looking rather than by a hardcoded list, so the next
 * module to cross the boundary — in either direction — needs no change here. A list would
 * have to be kept in step with the package by hand, and the failure mode of getting it
 * wrong is a `MODULE_NOT_FOUND` in a test suite rather than anywhere useful.
 */
const AGENT_CORE_DIST = path.join(__dirname, '..', 'packages', 'agent-core', 'dist');
const mod = (rel) => {
    const inCore = path.join(AGENT_CORE_DIST, rel);
    return fs.existsSync(inCore) ? inCore : path.join(DIST, rel);
};
const {
    BudgetLedger, approxTokens, gateModelMetrics, pricingFor, scoreExtraction,
    scoreLspOverGrep, scoreReview, summarise,
} = require(mod('core/eval-model-tier.js'));
const { LLMClient } = require(mod('core/llm-client.js'));
const { BASE_TOOLS } = require(mod('core/tools.js'));
const { buildExtractionPrompt, parseExtractionResponse } = require(mod('core/memory-extract.js'));
const { buildReviewPrompt, parseFindings } = require(mod('core/code-review.js'));

const modelTasks = require('./model-tasks');

const BASELINE_PATH = path.join(__dirname, 'baseline-models.json');

/** The tools a symbol question is answered with, as the model sees them. */
const SYMBOL_TOOLS = BASE_TOOLS.filter(t => [
    'read_file', 'grep_search', 'codebase_search', 'list_directory',
    'go_to_definition', 'find_references', 'workspace_symbols', 'hover',
    'impact_analysis', 'complete_task',
].includes(t.name));

function parseOptions(argv) {
    const value = (flag, fallback) => {
        const hit = argv.find(a => a.startsWith(`${flag}=`));
        return hit ? hit.slice(flag.length + 1) : fallback;
    };
    return {
        runs: Math.max(1, Math.min(20, Number(value('--model-runs', 3)) || 3)),
        budgetUsd: Math.max(0.01, Number(value('--model-budget', 1)) || 1),
        family: value('--model-family', undefined),
        record: argv.includes('--json'),
    };
}

function modelConfig() {
    const type = process.env.BLACKIDE_EVAL_PROVIDER || 'claude';
    const apiKey = process.env.BLACKIDE_EVAL_API_KEY
        || (type === 'claude' ? process.env.ANTHROPIC_API_KEY : undefined)
        || (type === 'google' ? process.env.GOOGLE_API_KEY : undefined)
        || process.env.OPENAI_API_KEY;
    return {
        id: 'eval',
        name: 'eval',
        type,
        model: process.env.BLACKIDE_EVAL_MODEL || (type === 'claude' ? 'claude-sonnet-5' : 'gpt-4o-mini'),
        url: process.env.BLACKIDE_EVAL_URL,
        apiKey,
    };
}

/**
 * One model call, booked against the budget.
 *
 * Returns `undefined` when the budget refuses it — and the caller records that run as
 * skipped rather than failed. The distinction is the difference between "the model got
 * this wrong" and "we ran out of money", and conflating them would make every truncated
 * run look like a quality regression.
 */
async function call(config, ledger, request) {
    const inputText = (request.system || '') + request.messages.map(m => m.content || '').join('\n');
    const estimatedIn = approxTokens(inputText) + (request.tools ? approxTokens(JSON.stringify(request.tools)) : 0);
    const estimatedOut = request.maxTokens || 1_024;

    if (!ledger.canAfford(estimatedIn, estimatedOut)) return undefined;

    const result = await LLMClient.streamAgentTurn(config, request, () => {});
    ledger.record(estimatedIn, approxTokens(result.text || ''));
    return result;
}

/** Run one task once. `undefined` means the budget stopped it, not that it failed. */
async function runOnce(task, config, ledger) {
    if (task.family === 'lspOverGrep') {
        const result = await call(config, ledger, {
            system: 'You are a coding agent working in a TypeScript repository with a language '
                + 'server available. Answer the user by calling tools. Call a tool now.',
            messages: [{ role: 'user', content: task.prompt }],
            tools: SYMBOL_TOOLS,
            maxTokens: 512,
        });
        if (!result) return undefined;
        return { passed: scoreLspOverGrep((result.toolCalls || []).map(c => c.name)) };
    }

    if (task.family === 'memoryExtraction') {
        const result = await call(config, ledger, {
            messages: [{ role: 'user', content: buildExtractionPrompt(task.transcript) }],
            maxTokens: 1_024,
        });
        if (!result) return undefined;
        const produced = parseExtractionResponse(result.text).map(c => c.text);
        const score = scoreExtraction({ produced, expected: task.expected, forbidden: task.forbidden });
        return { passed: score.passed, detail: score };
    }

    if (task.family === 'reviewFindings') {
        const result = await call(config, ledger, {
            messages: [{ role: 'user', content: buildReviewPrompt({ diff: task.diff }) }],
            maxTokens: 2_048,
        });
        if (!result) return undefined;
        /*
         * Map each finding back to a planted defect id.
         *
         * The fixtures mark defects with a `[d1]` comment on the offending line, so a
         * finding is credited when its reported line carries that marker. Matching on the
         * marker rather than on the line number is what keeps the scoring key stable when
         * a fixture is edited — a key that silently stops matching reports a reviewer
         * regression that never happened.
         */
        const lines = task.diff.split('\n');
        const flagged = parseFindings(result.text).map(finding => {
            const line = lines[finding.line - 1] || '';
            const marker = line.match(/\[([dn]\d+)\]/);
            // A finding on a line with no marker is a false positive, and each needs a
            // distinct id or `scoreReview`'s de-duplication would merge them into one.
            return marker ? marker[1] : `fp@${finding.file}:${finding.line}`;
        });
        const score = scoreReview({ flagged, planted: task.planted });
        return { passed: score.passed, detail: score };
    }

    throw new Error(`Unknown model-task family "${task.family}" on task ${task.id}`);
}

async function measure(options) {
    const config = modelConfig();
    if (!config.apiKey && config.type !== 'local') {
        return { unavailable: 'No API key. Set BLACKIDE_EVAL_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY).' };
    }

    const tasks = options.family ? modelTasks.filter(t => t.family === options.family) : modelTasks;
    if (!tasks.length) return { unavailable: `No model tasks in family "${options.family}".` };

    const ledger = new BudgetLedger(options.budgetUsd, pricingFor(config.model));
    const runs = [];

    /*
     * Runs are the outer loop and tasks the inner one, deliberately.
     *
     * With tasks outermost, a budget that runs dry part-way through leaves the early
     * tasks with N samples and the later ones with none — so the families are measured on
     * different subsets and the pooled rate silently becomes a rate for a different set of
     * tasks. Sweeping run-by-run means a truncated run has fewer samples of *everything*,
     * which is a smaller error bar rather than a biased number.
     */
    const outcomes = new Map(tasks.map(t => [t.id, { id: t.id, family: t.family, outcomes: [] }]));
    for (let run = 0; run < options.runs; run++) {
        for (const task of tasks) {
            let result;
            try {
                result = await runOnce(task, config, ledger);
            } catch (error) {
                // A transport failure is a failed observation, not a crash. Reporting the
                // whole tier as broken because one call 500'd would make the tier useless
                // exactly when a provider is flaky.
                process.stderr.write(`  ! ${task.id} run ${run + 1}: ${error?.message || error}\n`);
                result = { passed: false };
            }
            outcomes.get(task.id).outcomes.push(result === undefined ? undefined : result.passed);
        }
        if (ledger.state.exhausted) break;
    }

    // Runs that never happened, so `summarise` can mark the result incomplete.
    for (const entry of outcomes.values()) {
        while (entry.outcomes.length < options.runs) entry.outcomes.push(undefined);
        runs.push(entry);
    }

    const summary = summarise(runs);
    return {
        summary,
        metrics: {
            generatedAt: new Date().toISOString(),
            model: `${config.type}/${config.model}`,
            runsPerTask: options.runs,
            complete: summary.complete,
            budget: ledger.state,
            families: summary.families,
        },
    };
}

function report(result) {
    const line = (s = '') => process.stdout.write(`${s}\n`);
    const { metrics, summary } = result;

    line('══ Model tier (X-1) — opt-in, costs money ═════════════════════════════');
    line(`  model                       ${metrics.model}`);
    line(`  runs per task               ${metrics.runsPerTask}`);
    line(`  spend                       $${metrics.budget.spentUsd} of $${metrics.budget.capUsd} `
        + `over ${metrics.budget.calls} calls`);
    line();
    for (const family of metrics.families) {
        line(`  ${family.family.padEnd(20)}${String(family.ratePct).padStart(5)}%  `
            + `± ${family.stdErrPct} pts  (${family.passes}/${family.runs} over ${family.tasks} tasks)`);
    }
    line();
    line('  Per task:');
    for (const task of summary.tasks) {
        const mark = task.skipped ? '·' : task.ratePct === 100 ? '✓' : task.ratePct === 0 ? '✗' : '~';
        line(`    ${mark} ${task.id.padEnd(26)} ${String(task.ratePct).padStart(5)}%  `
            + `(${task.passes}/${task.runs})${task.skipped ? `  ${task.skipped} skipped for budget` : ''}`);
    }
    if (!metrics.complete) {
        line();
        line(`  ⚠ INCOMPLETE — ${summary.skippedRuns} run(s) never happened. This is not a pass.`);
    }
    line('═══════════════════════════════════════════════════════════════════════');
    line();
}

function readBaseline() {
    try { return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); } catch { return undefined; }
}

/**
 * Run the tier. Returns `true` when the build may continue.
 *
 * Never throws for a missing key: a developer who runs `--models` without one should be
 * told what to set, not handed a stack trace, and CI without the secret should skip the
 * tier rather than fail on it. A *broken* tier is a different thing and does throw.
 */
async function runModelTier(argv) {
    const options = parseOptions(argv);
    const result = await measure(options);

    if (result.unavailable) {
        process.stdout.write(`\n══ Model tier (X-1) ═══════════════════════════════════════════════════\n`);
        process.stdout.write(`  Skipped: ${result.unavailable}\n`);
        process.stdout.write('  The deterministic tiers above are unaffected — they never call a model.\n\n');
        return true;
    }

    report(result);

    if (options.record) {
        if (!result.metrics.complete) {
            // Recording a truncated run as the baseline would bake a low number in as the
            // thing to beat, and the next full run would look like an improvement.
            process.stderr.write('Refusing to record an incomplete run as the model baseline. '
                + 'Raise --model-budget or lower --model-runs.\n');
            return false;
        }
        fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(result.metrics, null, 2)}\n`, 'utf8');
        process.stdout.write(`  model baseline written to ${path.relative(process.cwd(), BASELINE_PATH)}\n\n`);
        return true;
    }

    const gate = gateModelMetrics(result.metrics, readBaseline());
    for (const note of gate.notes) process.stdout.write(`  ℹ ${note}\n`);
    if (!gate.ok) {
        process.stderr.write('\nFAIL: model tier\n');
        process.stderr.write(`${gate.regressions.join('\n')}\n`);
        process.stderr.write('\nIf the change is intentional, re-record with: '
            + 'node eval/run-eval.js --models --json\n');
        return false;
    }
    process.stdout.write('  No regression against eval/baseline-models.json.\n\n');
    return true;
}

module.exports = { runModelTier, BASELINE_PATH };
