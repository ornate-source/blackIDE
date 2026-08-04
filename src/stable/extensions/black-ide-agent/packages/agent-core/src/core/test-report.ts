// Structured test running — Phase 1 (M8) of docs/notes/enhancement.md.
//
// Pure, vscode-free, fs-free: command selection and output parsing only. The caller
// runs the command. Keeping this side-effect-free is what makes every parser below
// unit-testable against captured fixtures instead of a live toolchain.
//
// Why this exists: the agent could already shell out to a test command via
// `run_command`, but it got back raw output — tens of kilobytes of passing-test
// noise per run, truncated mid-stream by the text cap, with the actual failure
// often cut off. This turns that into a small structured report carrying the
// failures and nothing else.

import { ProjectProfile } from './project-profiler';

export interface TestFailure {
    /** Test identifier as the framework reports it (file::case, suite > case, …). */
    name: string;
    /** First meaningful line(s) of the assertion/error, trimmed. */
    message?: string;
}

export interface TestReport {
    framework: string;
    command: string;
    /** Undefined when the framework's default output does not report the count. */
    passed?: number;
    failed?: number;
    skipped?: number;
    failures: TestFailure[];
    /** True when the run reported no failures AND the process exited cleanly. */
    ok: boolean;
    exitCode: number;
    timedOut?: boolean;
    /** Set when the runner could not classify the output at all. */
    unparsed?: boolean;
}

/** Per-failure message cap — enough to identify the assertion, not a whole stack. */
const MESSAGE_CAP = 300;
/** Hard cap on failures reported back to the model. */
const MAX_FAILURES = 20;

const clip = (s: string, n = MESSAGE_CAP) => {
    const t = (s || '').trim().replace(/\s+/g, ' ');
    return t.length > n ? t.slice(0, n) + '…' : t;
};
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

/**
 * Choose the test command for a detected stack.
 *
 * Returns undefined when nothing is detected, so the caller can say "no test
 * framework detected" rather than guessing a command and failing confusingly.
 * `scope` is passed through verbatim (a path or a test-name filter, framework
 * dependent) — the caller is responsible for having approved it, since this
 * string ends up on a command line.
 */
export function selectTestCommand(profile: ProjectProfile, scope?: string): { framework: string; command: string } | undefined {
    const tests = (profile.testFrameworks || []).map(t => t.toLowerCase());
    const langs = (profile.languages || []).map(l => l.toLowerCase());
    const has = (t: string) => tests.includes(t);
    const arg = scope ? ` ${scope}` : '';

    // Explicit test-framework signals first — they are the strongest evidence.
    if (has('pytest')) return { framework: 'pytest', command: `python -m pytest -q${arg}` };
    if (has('vitest')) return { framework: 'vitest', command: `npx vitest run --reporter=basic${arg}` };
    if (has('jest')) return { framework: 'jest', command: `npx jest --ci${arg}` };
    if (has('xunit') || has('nunit') || has('mstest')) {
        return { framework: 'dotnet', command: `dotnet test --nologo -v q${arg}` };
    }
    if (has('rspec')) return { framework: 'rspec', command: `bundle exec rspec${arg}` };
    if (has('junit')) return { framework: 'junit', command: `./gradlew test${arg}` };

    // Language defaults, for toolchains whose runner is built in and therefore
    // leaves no dependency signal in a manifest.
    if (langs.includes('rust')) return { framework: 'cargo', command: `cargo test${arg}` };
    if (langs.includes('go')) return { framework: 'go', command: scope ? `go test ${scope}` : 'go test ./...' };

    return undefined;
}

/** Dispatch to the right parser. Unknown frameworks fall back to exit-code only. */
export function parseTestOutput(
    framework: string,
    r: { stdout?: string; stderr?: string; exitCode: number; timedOut?: boolean },
    command = '',
): TestReport {
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    const base = { framework, command, exitCode: r.exitCode, timedOut: r.timedOut, failures: [] as TestFailure[] };

    let parsed: Partial<TestReport>;
    switch (framework) {
        case 'pytest': parsed = parsePytest(out); break;
        case 'jest': parsed = parseJest(out); break;
        case 'vitest': parsed = parseVitest(out); break;
        case 'dotnet': parsed = parseDotnet(out); break;
        case 'cargo': parsed = parseCargo(out); break;
        case 'go': parsed = parseGo(out); break;
        case 'rspec': parsed = parseRspec(out); break;
        default: parsed = { unparsed: true }; break;
    }

    const failures = (parsed.failures || []).slice(0, MAX_FAILURES);
    // Trust the exit code over the parse. A framework that crashed before running
    // anything prints no summary, and reporting that as "ok" would be the worst
    // possible failure mode — the agent would move on believing tests passed.
    const ok = r.exitCode === 0 && !r.timedOut && failures.length === 0 && !(parsed.failed! > 0);

    return { ...base, ...parsed, failures, ok };
}

// ─── Per-framework parsers ───────────────────────────────────────────────────

/**
 * pytest -q. The `short test summary info` block is the reliable source: it lists
 * one `FAILED <nodeid> - <message>` line per failure regardless of verbosity.
 */
export function parsePytest(out: string): Partial<TestReport> {
    const failures: TestFailure[] = [];
    for (const m of out.matchAll(/^(?:FAILED|ERROR)\s+(\S+)(?:\s+-\s+(.*))?$/gm)) {
        failures.push({ name: m[1], message: m[2] ? clip(m[2]) : undefined });
    }
    const summary = out.match(/=+\s*(?:(\d+) failed)?[,\s]*(?:(\d+) passed)?[,\s]*(?:(\d+) skipped)?.*?in [\d.]+s/);
    return {
        failed: num(summary?.[1]) ?? (failures.length || undefined),
        passed: num(summary?.[2]),
        skipped: num(summary?.[3]),
        failures,
    };
}

/** jest. Failures are the `●  suite › case` headers; counts come from `Tests:`. */
export function parseJest(out: string): Partial<TestReport> {
    const failures: TestFailure[] = [];
    const seen = new Set<string>();
    for (const m of out.matchAll(/^\s*●\s+(?!Console)(.+?)\s*$/gm)) {
        const name = m[1].trim();
        // jest repeats the header above the stack trace; keep the first occurrence.
        if (name && !seen.has(name)) { seen.add(name); failures.push({ name }); }
    }
    const line = out.match(/^Tests:\s+(.*)$/m)?.[1] || '';
    return {
        failed: num(line.match(/(\d+) failed/)?.[1]) ?? (failures.length || undefined),
        passed: num(line.match(/(\d+) passed/)?.[1]),
        skipped: num(line.match(/(\d+) (?:skipped|todo)/)?.[1]),
        failures,
    };
}

/** vitest run. `FAIL <file> > <suite> > <case>` plus a `Tests  …` summary line. */
export function parseVitest(out: string): Partial<TestReport> {
    const failures: TestFailure[] = [];
    const seen = new Set<string>();
    for (const m of out.matchAll(/^\s*(?:×|✕|FAIL)\s+(.+?)\s*$/gm)) {
        const name = m[1].trim();
        // The per-file "FAIL src/x.test.ts" banner duplicates the per-case lines.
        if (!name || seen.has(name)) continue;
        seen.add(name);
        failures.push({ name });
    }
    const line = out.match(/^\s*Tests\s+(.*)$/m)?.[1] || '';
    return {
        failed: num(line.match(/(\d+) failed/)?.[1]) ?? (failures.length || undefined),
        passed: num(line.match(/(\d+) passed/)?.[1]),
        skipped: num(line.match(/(\d+) skipped/)?.[1]),
        failures,
    };
}

/** dotnet test. `Failed <name> [12 ms]` per case, plus the `Failed!  - Failed: …` tally. */
export function parseDotnet(out: string): Partial<TestReport> {
    const failures: TestFailure[] = [];
    for (const m of out.matchAll(/^\s*(?:X|Failed)\s+(.+?)(?:\s+\[[\d.]+\s*m?s\])?\s*$/gm)) {
        const name = m[1].trim();
        if (name && !name.startsWith('!')) failures.push({ name });
    }
    const line = out.match(/(?:Failed|Passed)!\s*-\s*(.*)$/m)?.[1] || '';
    return {
        failed: num(line.match(/Failed:\s*(\d+)/)?.[1]) ?? (failures.length || undefined),
        passed: num(line.match(/Passed:\s*(\d+)/)?.[1]),
        skipped: num(line.match(/Skipped:\s*(\d+)/)?.[1]),
        failures,
    };
}

/** cargo test. `test <path> ... FAILED` per case, `test result: …` per target. */
export function parseCargo(out: string): Partial<TestReport> {
    const failures: TestFailure[] = [];
    for (const m of out.matchAll(/^test\s+(\S+)\s+\.\.\.\s+FAILED\s*$/gm)) {
        failures.push({ name: m[1] });
    }
    // A workspace runs one target per crate, each with its own summary line; sum them.
    let passed: number | undefined;
    let failed: number | undefined;
    let skipped: number | undefined;
    for (const m of out.matchAll(/test result:.*?(\d+) passed;\s*(\d+) failed;\s*(\d+) ignored/g)) {
        passed = (passed || 0) + Number(m[1]);
        failed = (failed || 0) + Number(m[2]);
        skipped = (skipped || 0) + Number(m[3]);
    }
    return { failed: failed ?? (failures.length || undefined), passed, skipped, failures };
}

/**
 * go test ./…. Without -v, Go prints only failures, so `passed` is genuinely
 * unknown and is left undefined rather than guessed — `ok <pkg>` lines count
 * packages, not tests, and reporting them as test counts would be wrong.
 */
export function parseGo(out: string): Partial<TestReport> {
    const failures: TestFailure[] = [];
    for (const m of out.matchAll(/^\s*---\s+FAIL:\s+(\S+)/gm)) {
        failures.push({ name: m[1] });
    }
    const skipped = [...out.matchAll(/^\s*---\s+SKIP:/gm)].length || undefined;
    const passedCases = [...out.matchAll(/^\s*---\s+PASS:/gm)].length; // only present with -v
    return {
        failed: failures.length || undefined,
        passed: passedCases || undefined,
        skipped,
        failures,
    };
}

/** rspec. `  1) <description>` per failure, `N examples, N failures` tally. */
export function parseRspec(out: string): Partial<TestReport> {
    const failures: TestFailure[] = [];
    for (const m of out.matchAll(/^\s{2}\d+\)\s+(.+?)\s*$/gm)) {
        failures.push({ name: m[1].trim() });
    }
    const line = out.match(/(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/);
    const total = num(line?.[1]);
    const failed = num(line?.[2]);
    const pending = num(line?.[3]);
    return {
        failed: failed ?? (failures.length || undefined),
        passed: total !== undefined && failed !== undefined ? total - failed - (pending || 0) : undefined,
        skipped: pending,
        failures,
    };
}

/**
 * Render the report for the model: the tally, then failures only.
 *
 * Passing tests are deliberately omitted. Their names carry no information the
 * agent can act on, and they are the bulk of the output that made raw test runs
 * unaffordable in the first place.
 */
export function formatTestReport(report: TestReport): string {
    const counts = [
        report.passed !== undefined ? `${report.passed} passed` : undefined,
        report.failed !== undefined ? `${report.failed} failed` : undefined,
        report.skipped ? `${report.skipped} skipped` : undefined,
    ].filter(Boolean).join(', ');

    const head = `${report.framework}: ${counts || 'counts unavailable'} (exit ${report.exitCode}${report.timedOut ? ', TIMED OUT' : ''})`;

    if (report.timedOut) {
        return `${head}\nThe test command timed out — treat the result as unknown, not as a pass.`;
    }
    if (report.ok) {
        return `${head}\nAll tests passed.`;
    }
    if (!report.failures.length) {
        // Non-zero exit with nothing parseable: a build error, a missing runner, a
        // config problem. Say so plainly instead of implying the tests merely failed.
        return [
            head,
            report.unparsed
                ? `No parser for "${report.framework}"; could not classify the output.`
                : 'The run failed but no individual test failures were reported — likely a build or configuration error rather than a failing assertion.',
            'Re-run with run_command if you need the raw output.',
        ].join('\n');
    }

    const lines = report.failures.map(f => `  ✗ ${f.name}${f.message ? `\n      ${f.message}` : ''}`);
    const more = (report.failed || 0) > report.failures.length
        ? `\n  …and ${(report.failed || 0) - report.failures.length} more failure(s).`
        : '';
    return `${head}\n\nFailures:\n${lines.join('\n')}${more}`;
}
