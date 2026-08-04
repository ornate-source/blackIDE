#!/usr/bin/env node
/*
 * Golden-task eval runner (Phase 0, M3).
 *
 * Purpose: give every later phase a number to move, so a change either shows up in
 * the metrics or it does not ship. Run it before and after a phase and compare.
 *
 *   node eval/run-eval.js            # print the report
 *   node eval/run-eval.js --json     # also write eval/baseline.json
 *
 * ── What this measures (deterministic, no API key, no cost) ──────────────────
 *   1. Stack detection accuracy — does ProjectProfiler identify the stack?
 *   2. Skill resolution precision/recall — do the right packs fire for a
 *      (stack, role, prompt)?
 *   3. Skill coverage — what fraction of golden tasks get any appropriate pack?
 *      This is the headline number Phase 10 (library breadth) has to move.
 *   4. Fail-safe behaviour — an unrecognised repo must inject nothing.
 *   5. Retrieval recall@5/10/20 over a real index built on `eval/retrieval-corpus/`
 *      (Phase 3). Lexical tier only — see eval/retrieval.js for why that is the
 *      right baseline rather than a limitation to apologise for.
 *
 * ── The model tier (X-1), added 2026-08-04 ───────────────────────────────────
 *   node eval/run-eval.js --models   # also measure what needs real model calls
 *
 * Off unless asked for, gated against its own `eval/baseline-models.json`, and
 * incapable of moving a number in the deterministic baseline below. That
 * separation is the whole design: hanging five phases' deterministic gates off a
 * non-deterministic, paid runner is how a green gate becomes a disabled one. See
 * `eval/model-tier.js`.
 */

const path = require('path');
const fs = require('fs');
const Module = require('module');

// `skills-manager` imports `vscode` for workspace-root discovery. Resolve it to the
// shared stub the test tiers use, so the eval runs outside the extension host.
const vscodeStub = require('../test/vscode-stub');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub };

const DIST = path.join(__dirname, '..', 'dist');
const { detectProjectProfile } = require(path.join(DIST, 'core/project-profiler.js'));
const { SkillsManager } = require(path.join(DIST, 'agent/skills-manager.js'));
const { resolveSkills } = require(path.join(DIST, 'agent/skill-resolver.js'));

const CodebaseIndexModule = require(path.join(DIST, 'core/codebase-index.js'));
const OutputCompactModule = require(path.join(DIST, 'core/output-compact.js'));

const fixtures = require('./fixtures');
const tasks = require('./tasks');
const { measureRetrieval } = require('./retrieval');
const { measureCompaction } = require('./compaction');

const BUNDLED_SKILLS_DIR = path.join(__dirname, '..', 'resources', 'skills');

function loadBundledSkills() {
    const skills = [];
    for (const entry of fs.readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skill = SkillsManager.loadSkillDir(path.join(BUNDLED_SKILLS_DIR, entry.name), entry.name, 'bundled');
        if (skill) skills.push(skill);
    }
    return skills;
}

function pct(n, d) {
    return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

function run() {
    const skills = loadBundledSkills();
    const byFixture = new Map(fixtures.map(f => [f.id, f]));

    // ── 1. Stack detection ───────────────────────────────────────────────────
    const detection = { total: 0, passed: 0, failures: [] };
    const profiles = new Map();
    for (const fx of fixtures) {
        const profile = detectProjectProfile(fx.files, fx.manifests);
        profiles.set(fx.id, profile);
        detection.total++;

        const got = (profile.stacks || []).map(s => s.toLowerCase());
        let ok;
        if (fx.expect.mustBeEmpty) {
            ok = got.length === 0;
            if (!ok) detection.failures.push(`${fx.id}: expected NO stacks, got [${got.join(', ')}]`);
        } else {
            const missing = fx.expect.stacks.filter(s => !got.includes(s));
            ok = missing.length === 0;
            if (!ok) detection.failures.push(`${fx.id}: missing [${missing.join(', ')}] (got [${got.join(', ')}])`);
        }
        if (ok) detection.passed++;
    }

    // ── 2 & 3. Skill resolution + coverage ───────────────────────────────────
    const resolution = {
        total: 0, exact: 0, partial: 0, covered: 0, coverable: 0, failSafe: 0, failSafeTotal: 0, rows: [],
        // Wrong-idiom: tasks that name packs which must NOT fire, and the ones where
        // one did. §4.2 lists this metric as "record"; this is the deterministic half
        // of it (injecting another framework's idioms). The model-behaviour half —
        // does it then *write* raw SQL where the ORM is idiomatic — needs the model tier.
        wrongIdiomTotal: 0, wrongIdiomLeaks: 0, leaks: [],
    };
    for (const task of tasks) {
        const fx = byFixture.get(task.fixture);
        if (!fx) throw new Error(`Task ${task.id} references unknown fixture "${task.fixture}"`);
        const profile = profiles.get(task.fixture);

        const picked = resolveSkills({ skills, role: task.role, profile, prompt: task.prompt })
            .map(s => s.name);

        resolution.total++;

        // Scored independently of expect/gap status, because a task can perfectly well
        // select the right pack *and* a wrong one alongside it — which is exactly what
        // F3 looked like: `flask` first, `django` and `fastapi` right behind it.
        if (task.forbidSkills?.length) {
            resolution.wrongIdiomTotal++;
            const fired = task.forbidSkills.filter(f => picked.includes(f));
            if (fired.length) {
                resolution.wrongIdiomLeaks++;
                resolution.leaks.push(`${task.id}: ${fired.join(', ')} must not fire on a ${task.fixture} repo`);
            }
        }

        if (task.forbidAny) {
            resolution.failSafeTotal++;
            const clean = picked.length === 0;
            if (clean) resolution.failSafe++;
            resolution.rows.push({ id: task.id, expected: '(none)', got: picked, status: clean ? 'PASS' : 'LEAK' });
            continue;
        }

        const expected = task.expectSkills;
        if (expected.length === 0) {
            // A known library gap. Not scored as a pass or a failure — tracked so the
            // coverage number reflects reality instead of being quietly inflated.
            resolution.rows.push({ id: task.id, expected: '(gap)', got: picked, status: 'GAP' });
            continue;
        }

        resolution.coverable++;
        const hits = expected.filter(e => picked.includes(e));
        if (hits.length === expected.length) resolution.exact++;
        if (hits.length > 0) { resolution.partial++; resolution.covered++; }
        resolution.rows.push({
            id: task.id,
            expected: expected.join('+'),
            got: picked,
            status: hits.length === expected.length ? 'PASS' : hits.length ? 'PARTIAL' : 'MISS',
        });
    }

    const metrics = {
        generatedAt: new Date().toISOString(),
        bundledPackCount: skills.length,
        stackDetectionAccuracyPct: pct(detection.passed, detection.total),
        stackDetectionPassed: detection.passed,
        stackDetectionTotal: detection.total,
        skillExactMatchPct: pct(resolution.exact, resolution.coverable),
        skillAnyHitPct: pct(resolution.covered, resolution.coverable),
        coverableTasks: resolution.coverable,
        knownGapTasks: resolution.rows.filter(r => r.status === 'GAP').length,
        totalTasks: resolution.total,
        failSafePassed: resolution.failSafe,
        failSafeTotal: resolution.failSafeTotal,
        fixtureCount: fixtures.length,
        wrongIdiomTasks: resolution.wrongIdiomTotal,
        wrongIdiomLeaks: resolution.wrongIdiomLeaks,
        wrongIdiomRatePct: pct(resolution.wrongIdiomLeaks, resolution.wrongIdiomTotal),
    };

    return { metrics, detection, resolution };
}

function report({ metrics, detection, resolution }) {
    const line = (s = '') => process.stdout.write(s + '\n');
    line();
    line('══ Black IDE — Golden-Task Eval ═══════════════════════════════════════');
    line(`  bundled skill packs         ${metrics.bundledPackCount}`);
    line(`  golden tasks / fixtures     ${metrics.totalTasks} tasks over ${metrics.fixtureCount} fixtures`);
    line(`  stack detection accuracy    ${metrics.stackDetectionAccuracyPct}%  (${metrics.stackDetectionPassed}/${metrics.stackDetectionTotal})`);
    line(`  skill exact-match rate      ${metrics.skillExactMatchPct}%  (of ${metrics.coverableTasks} coverable tasks)`);
    line(`  skill any-hit rate          ${metrics.skillAnyHitPct}%`);
    line(`  known library gaps          ${metrics.knownGapTasks} task(s) with no suitable pack bundled`);
    line(`  fail-safe (no stack→none)   ${metrics.failSafePassed}/${metrics.failSafeTotal}`);
    line(`  wrong-idiom rate            ${metrics.wrongIdiomRatePct}%  (${metrics.wrongIdiomLeaks} of ${metrics.wrongIdiomTasks} tasks that name a forbidden pack)`);
    line();

    if (detection.failures.length) {
        line('  Detection failures:');
        for (const f of detection.failures) line(`    ✗ ${f}`);
        line();
    }

    if (resolution.leaks.length) {
        line('  Wrong-idiom leaks:');
        for (const l of resolution.leaks) line(`    ✗ ${l}`);
        line();
    }

    line('  Per-task skill resolution:');
    const mark = { PASS: '✓', PARTIAL: '~', MISS: '✗', GAP: '·', LEAK: '✗' };
    for (const r of resolution.rows) {
        const got = r.got.length ? r.got.join(', ') : '(none)';
        line(`    ${mark[r.status]} ${r.id.padEnd(16)} expected ${String(r.expected).padEnd(22)} got ${got}`);
    }
    line();
    line('  Legend: ✓ exact  ~ partial  ✗ miss/leak  · known library gap (Phase 10)');
    line('═══════════════════════════════════════════════════════════════════════');
    line();
}

function reportRetrieval({ metrics, rows, ks }) {
    const line = (s = '') => process.stdout.write(s + '\n');
    line('══ Retrieval (recall over eval/retrieval-corpus) ══════════════════════');
    line(`  corpus                      ${metrics.corpusFiles} files → ${metrics.corpusChunks} chunks`);
    line(`  index build                 ${metrics.buildMs} ms`);
    for (const k of ks) {
        line(`  recall@${String(k).padEnd(20)}${metrics[`recallAt${k}Pct`]}%  (over ${metrics.queries} queries)`);
    }
    line();
    line('  Per-query recall@10 (gold files retrieved / gold files):');
    for (const r of rows) {
        const at = r.at[10];
        const mark = at.recall === 1 ? '✓' : at.recall > 0 ? '~' : '✗';
        const detail = at.missed.length ? `  missed: ${at.missed.join(', ')}` : '';
        line(`    ${mark} ${r.id.padEnd(28)} ${at.hits.length}/${r.mustFind.length}${detail}`);
    }
    line('═══════════════════════════════════════════════════════════════════════');
    line();
}

function reportCompaction({ metrics, rows, deepPaths }) {
    const line = (s = '') => process.stdout.write(s + '\n');
    line('══ Tool-output compaction (M18) ═══════════════════════════════════════');
    line(`  fixture corpus              ${metrics.savedPct}%  (${metrics.originalChars} → ${metrics.compactChars} chars`
        + `, ~${metrics.originalTokens} → ~${metrics.compactTokens} tokens; avg path ${metrics.avgPathChars} chars)`);
    if (deepPaths) {
        line(`  realistic path depth        ${deepPaths.savedPct}%  (this extension's own src/, ${deepPaths.rows} rows,`
            + ` avg path ${deepPaths.avgPathChars} chars)`);
        line('    Grouping removes the repeated path and nothing else, so the reduction is');
        line('    a ratio of path length to line length. The fixture corpus is a flat demo');
        line('    app and understates it; the second figure is the realistic one.');
    }
    line();
    for (const row of rows) {
        line(`    ${String(row.savedPct).padStart(5)}%  ${row.sample.padEnd(34)} ${row.count} rows, ${row.originalChars} → ${row.compactChars}`);
    }
    line('═══════════════════════════════════════════════════════════════════════');
    line();
}

async function main() {
    const result = run();
    report(result);

    const retrieval = await measureRetrieval(vscodeStub, CodebaseIndexModule);
    reportRetrieval(retrieval);

    const compaction = measureCompaction(OutputCompactModule);
    reportCompaction(compaction);
    Object.assign(result.metrics, {
        compactionSavedPct: compaction.metrics.savedPct,
        compactionSamples: compaction.metrics.samples,
        ...(compaction.deepPaths ? { compactionDeepPathSavedPct: compaction.deepPaths.savedPct } : {}),
    });
    Object.assign(result.metrics, {
        recallAt3Pct: retrieval.metrics.recallAt3Pct,
        recallAt5Pct: retrieval.metrics.recallAt5Pct,
        recallAt10Pct: retrieval.metrics.recallAt10Pct,
        recallAt20Pct: retrieval.metrics.recallAt20Pct,
        retrievalQueries: retrieval.metrics.queries,
        retrievalCorpusFiles: retrieval.metrics.corpusFiles,
        retrievalCorpusChunks: retrieval.metrics.corpusChunks,
    });

    if (process.argv.includes('--json')) {
        const out = path.join(__dirname, 'baseline.json');
        fs.writeFileSync(out, JSON.stringify(result.metrics, null, 2) + '\n', 'utf8');
        process.stdout.write(`baseline written to ${path.relative(process.cwd(), out)}\n`);
        // The model tier still runs when asked, so `--models --json` records both
        // baselines. It writes its own file and cannot touch the one just written.
        if (process.argv.includes('--models')) {
            const { runModelTier } = require('./model-tier');
            process.exit(await runModelTier(process.argv) ? 0 : 1);
        }
        process.exit(0);
    }

    return result;
}

/**
 * The model tier, after the deterministic gate and never instead of it.
 *
 * Ordered this way so a failure is attributable: if the deterministic tier is red, the
 * build stops before a single paid call is made, and nobody is left asking whether the
 * model number moved because the resolver changed.
 */
async function maybeRunModelTier() {
    if (!process.argv.includes('--models')) return;
    const { runModelTier } = require('./model-tier');
    if (!await runModelTier(process.argv)) process.exit(1);
}

/*
 * The gate is "no regression against the committed baseline", not "everything is
 * perfect". Two real defects were open when this baseline was first recorded (see
 * docs/notes/eval-baseline.md, findings F1 and F2); a gate that fails on day one
 * would just be switched off, and would never catch the regressions it exists for.
 * Later phases raise these numbers and re-record the baseline.
 *
 * Recall is guarded with a small tolerance. The other metrics are exact counts over
 * fixed inputs and cannot move by a hair; recall is an average over 20 queries where
 * one gold file crossing the k boundary shifts the mean by ~2.5 points. Failing on
 * that would make the gate noisy, and a noisy gate is a disabled gate. Anything
 * larger is a real regression and stops the build.
 */
const RECALL_TOLERANCE_PCT = 2.0;

function gate(result) {
    const baselinePath = path.join(__dirname, 'baseline.json');
    if (!fs.existsSync(baselinePath)) {
        process.stdout.write('  No baseline recorded yet — run with --json to create one.\n\n');
        return;
    }

    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const guarded = [
        ['stackDetectionAccuracyPct', 'stack detection accuracy', 0],
        ['skillExactMatchPct', 'skill exact-match rate', 0],
        ['skillAnyHitPct', 'skill any-hit rate', 0],
        ['failSafePassed', 'fail-safe passes', 0],
        // Inverted metric: guarded as a *ceiling* below, not a floor.
        ['recallAt5Pct', 'retrieval recall@5', RECALL_TOLERANCE_PCT],
        ['recallAt10Pct', 'retrieval recall@10', RECALL_TOLERANCE_PCT],
        ['recallAt20Pct', 'retrieval recall@20', RECALL_TOLERANCE_PCT],
        ['compactionSavedPct', 'tool-output compaction', 1.0],
    ];
    const regressions = guarded
        .filter(([k, , tol]) => typeof baseline[k] === 'number' && result.metrics[k] < baseline[k] - tol)
        .map(([k, label]) => `  ✗ ${label}: ${baseline[k]} → ${result.metrics[k]}`);

    /*
     * Wrong-idiom is a count of failures, so "no regression" means it must not *rise* —
     * the opposite direction from every other guarded metric. Guarding it with the same
     * comparator would have made a leak look like an improvement, which is the kind of
     * inverted-metric bug that only shows up when someone reintroduces the defect.
     */
    if (typeof baseline.wrongIdiomLeaks === 'number' && result.metrics.wrongIdiomLeaks > baseline.wrongIdiomLeaks) {
        regressions.push(`  ✗ wrong-idiom leaks: ${baseline.wrongIdiomLeaks} → ${result.metrics.wrongIdiomLeaks} (a pack fired on a repo of another framework)`);
    }

    if (regressions.length) {
        process.stderr.write('\nFAIL: metrics regressed against eval/baseline.json\n');
        process.stderr.write(regressions.join('\n') + '\n');
        process.stderr.write('\nIf the change is intentional, re-record with: node eval/run-eval.js --json\n');
        process.exit(1);
    }
    process.stdout.write('  No regression against eval/baseline.json.\n\n');
}

main().then(gate).then(maybeRunModelTier).catch((err) => {
    process.stderr.write(`\nFAIL: eval run threw — ${err?.stack || err}\n`);
    process.exit(1);
});
