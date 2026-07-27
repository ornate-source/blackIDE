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
 *
 * ── What it deliberately does NOT measure yet ────────────────────────────────
 *   - Retrieval recall@k. CodebaseIndex.build() enumerates files through
 *     `vscode.workspace.findFiles`, which the test stub returns empty for, so a
 *     recall number here would be measuring the stub. Wiring a fixture-backed
 *     findFiles belongs with Phase 3, which is the phase that needs the metric.
 *   - End-to-end task success / wrong-idiom rate. Both need real model calls;
 *     scaffolded as the opt-in model tier, not run in CI.
 *   Claiming either of those today would be inventing a baseline we cannot defend.
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

const fixtures = require('./fixtures');
const tasks = require('./tasks');

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
    const resolution = { total: 0, exact: 0, partial: 0, covered: 0, coverable: 0, failSafe: 0, failSafeTotal: 0, rows: [] };
    for (const task of tasks) {
        const fx = byFixture.get(task.fixture);
        if (!fx) throw new Error(`Task ${task.id} references unknown fixture "${task.fixture}"`);
        const profile = profiles.get(task.fixture);

        const picked = resolveSkills({ skills, role: task.role, profile, prompt: task.prompt })
            .map(s => s.name);

        resolution.total++;

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
    };

    return { metrics, detection, resolution };
}

function report({ metrics, detection, resolution }) {
    const line = (s = '') => process.stdout.write(s + '\n');
    line();
    line('══ Black IDE — Golden-Task Eval ═══════════════════════════════════════');
    line(`  bundled skill packs         ${metrics.bundledPackCount}`);
    line(`  stack detection accuracy    ${metrics.stackDetectionAccuracyPct}%  (${metrics.stackDetectionPassed}/${metrics.stackDetectionTotal})`);
    line(`  skill exact-match rate      ${metrics.skillExactMatchPct}%  (of ${metrics.coverableTasks} coverable tasks)`);
    line(`  skill any-hit rate          ${metrics.skillAnyHitPct}%`);
    line(`  known library gaps          ${metrics.knownGapTasks} task(s) with no suitable pack bundled`);
    line(`  fail-safe (no stack→none)   ${metrics.failSafePassed}/${metrics.failSafeTotal}`);
    line();

    if (detection.failures.length) {
        line('  Detection failures:');
        for (const f of detection.failures) line(`    ✗ ${f}`);
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

const result = run();
report(result);

if (process.argv.includes('--json')) {
    const out = path.join(__dirname, 'baseline.json');
    fs.writeFileSync(out, JSON.stringify(result.metrics, null, 2) + '\n', 'utf8');
    process.stdout.write(`baseline written to ${path.relative(process.cwd(), out)}\n`);
    process.exit(0);
}

/*
 * The gate is "no regression against the committed baseline", not "everything is
 * perfect". Two real defects are open at the time this baseline was recorded (see
 * docs/notes/eval-baseline.md, findings F1 and F2); a gate that fails on day one
 * would just be switched off, and would never catch the regressions it exists for.
 * Later phases raise these numbers and re-record the baseline.
 */
const baselinePath = path.join(__dirname, 'baseline.json');
if (fs.existsSync(baselinePath)) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const guarded = [
        ['stackDetectionAccuracyPct', 'stack detection accuracy'],
        ['skillExactMatchPct', 'skill exact-match rate'],
        ['skillAnyHitPct', 'skill any-hit rate'],
        ['failSafePassed', 'fail-safe passes'],
    ];
    const regressions = guarded
        .filter(([k]) => typeof baseline[k] === 'number' && result.metrics[k] < baseline[k])
        .map(([k, label]) => `  ✗ ${label}: ${baseline[k]} → ${result.metrics[k]}`);

    if (regressions.length) {
        process.stderr.write('\nFAIL: metrics regressed against eval/baseline.json\n');
        process.stderr.write(regressions.join('\n') + '\n');
        process.stderr.write('\nIf the change is intentional, re-record with: node eval/run-eval.js --json\n');
        process.exit(1);
    }
    process.stdout.write('  No regression against eval/baseline.json.\n\n');
} else {
    process.stdout.write('  No baseline recorded yet — run with --json to create one.\n\n');
}
