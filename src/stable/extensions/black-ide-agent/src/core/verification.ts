import { ProjectProfile } from './project-profiler';
import { TestReport } from './test-report';

// ─── The verify contract (Phase 7, M40) ─────────────────────────────────────
//
// E5's framing is the whole design: **evidence, not assertions.** Before this, an executor
// finished by *saying* it was done, and the first thing that actually checked was the user
// opening the file. The pipeline could complete seven phases and hand back a broken tree
// with a confident summary, because nothing between the model and the user ever ran
// anything.
//
// So every executor now owes a verification: run the project's tests, and for UI work
// produce something a human can look at. What makes this a contract rather than a
// suggestion is that the *absence* of evidence is itself a reportable outcome — a run that
// could not verify says so, instead of reading identically to one that verified clean.
//
// ── Why "no test command" is not a pass ──────────────────────────────────────
// The tempting simplification is to treat an unverifiable repo as verified, because it
// makes the happy path uniform. It is the same error M37's ranking refuses to make: it
// converts "we do not know" into "it is fine", and the whole reason this phase exists is
// that "it is fine" was already being claimed without grounds.
//
// Pure and vscode-free: what evidence is *required*, and whether what came back is
// *sufficient*, are decisions — and they are the ones worth testing. Running the commands
// is the caller's job.

/** Files whose change implies the user can see a difference. */
const UI_PATTERNS: RegExp[] = [
    /\.(tsx|jsx|vue|svelte)$/i,
    /\.(css|scss|sass|less)$/i,
    /\.html?$/i,
    /(^|\/)(components?|pages?|views?|screens?|templates?)\//i,
];

export type EvidenceKind = 'tests' | 'screenshot' | 'recording';

export interface VerificationPlan {
    /** What this change must produce to count as verified. */
    required: EvidenceKind[];
    /** Why each item is required, for the run log and the report. */
    because: string[];
    /** The command to run, when the profile knows one. */
    testCommand?: { framework: string; command: string };
}

/**
 * What a change owes.
 *
 * Tests are always required — even when the repo has no runner, because "this project has
 * no test command" is a fact worth reporting rather than an exemption worth granting.
 * Visual evidence is required only when a UI file changed, since a screenshot of an
 * unchanged page is noise that trains people to stop looking at screenshots.
 */
export function planVerification(
    changedFiles: string[],
    testCommand?: { framework: string; command: string },
): VerificationPlan {
    const required: EvidenceKind[] = ['tests'];
    const because: string[] = [
        testCommand
            ? `the project's ${testCommand.framework} suite covers this change`
            : 'every change is tested if the project can be tested',
    ];

    if ((changedFiles || []).some(isUiFile)) {
        required.push('screenshot');
        because.push('a user-visible surface changed, so there is something to look at');
    }

    return { required, because, testCommand };
}

export function isUiFile(file: string): boolean {
    const normalized = String(file || '').replace(/\\/g, '/');
    return UI_PATTERNS.some(pattern => pattern.test(normalized));
}

/** What actually came back. */
export interface Evidence {
    tests?: TestReport;
    /** Paths of screenshots/recordings attached as artifacts. */
    screenshots?: string[];
    recordings?: string[];
    /** Set when the suite could not be run at all (no command, or the runner crashed). */
    testsUnavailable?: string;
    /**
     * Set when visual evidence was required and could not be produced — no dev server, no
     * browser, no configured URL.
     *
     * A separate field from `missing` because they answer different questions: `missing`
     * says *what* the contract did not get, and this says *why*, which is the half that
     * tells the user whether to start a server or change a setting. `incomplete` with no
     * "why" is the permanent warning this milestone existed to remove.
     */
    visualUnavailable?: string;
}

export type VerificationOutcome = 'verified' | 'failed' | 'unverifiable' | 'incomplete';

export interface VerificationResult {
    outcome: VerificationOutcome;
    /** True when the executor should attempt exactly one self-correction. */
    shouldSelfCorrect: boolean;
    /** True when this must reach a human rather than another automated attempt. */
    escalate: boolean;
    summary: string;
    missing: EvidenceKind[];
}

/**
 * Judge the evidence.
 *
 * Four outcomes, deliberately not three:
 *   - **verified** — the suite ran and passed, and everything required is present.
 *   - **failed** — the suite ran and something broke. This is the *correctable* case, and
 *     the only one that earns a self-correction attempt.
 *   - **unverifiable** — the suite could not run. Not a pass and not a failure: retrying
 *     cannot fix a missing test runner, so it escalates immediately rather than burning a
 *     correction attempt on something no edit will change.
 *   - **incomplete** — the tests are green but required visual evidence is missing. The
 *     code may well be right; the contract was not met, and quietly upgrading that to
 *     "verified" is how the evidence requirement decays into an optional extra.
 */
export function evaluateVerification(
    plan: VerificationPlan,
    evidence: Evidence,
    attempt = 0,
): VerificationResult {
    const missing: EvidenceKind[] = [];
    if (plan.required.includes('screenshot') && !(evidence.screenshots || []).length) missing.push('screenshot');
    if (plan.required.includes('recording') && !(evidence.recordings || []).length) missing.push('recording');

    if (!evidence.tests || evidence.testsUnavailable) {
        return {
            outcome: 'unverifiable',
            shouldSelfCorrect: false,
            escalate: true,
            missing: ['tests', ...missing],
            summary: evidence.testsUnavailable
                || 'No test suite could be run for this project, so this change is unverified.',
        };
    }

    if (!evidence.tests.ok) {
        const failed = evidence.tests.failed ?? evidence.tests.failures.length;
        return {
            outcome: 'failed',
            // Exactly one attempt. A loop that keeps correcting itself against a failing
            // suite is how an agent spends an afternoon and a budget converging on nothing;
            // the second failure is the signal that a human should look.
            shouldSelfCorrect: attempt < 1,
            escalate: attempt >= 1,
            missing,
            summary: `${failed} test${failed === 1 ? '' : 's'} failing after this change.`,
        };
    }

    if (missing.length) {
        return {
            outcome: 'incomplete',
            shouldSelfCorrect: false,
            escalate: true,
            missing,
            summary: evidence.visualUnavailable
                ? `Tests pass, but this change owes ${missing.join(' and ')}. ${evidence.visualUnavailable}`
                : `Tests pass, but this change owes ${missing.join(' and ')} and produced none.`,
        };
    }

    return {
        outcome: 'verified',
        shouldSelfCorrect: false,
        escalate: false,
        missing: [],
        summary: describePass(evidence.tests),
    };
}

function describePass(report: TestReport): string {
    const passed = report.passed;
    return passed
        ? `${passed} test${passed === 1 ? '' : 's'} passing (${report.framework}).`
        : `The ${report.framework} suite passed.`;
}

/**
 * The `test-report` artifact's body.
 *
 * Markdown rather than JSON because its primary reader is a human deciding whether to
 * trust a run, and its secondary reader is a model on the self-correction turn — both read
 * markdown better than they read a serialized object. Failures come first: a report whose
 * useful part is below forty lines of passing-test names is one nobody scrolls.
 */
export function renderVerificationReport(
    plan: VerificationPlan,
    evidence: Evidence,
    result: VerificationResult,
): string {
    const lines: string[] = [
        `# Verification — ${result.outcome}`,
        '',
        result.summary,
        '',
    ];

    if (evidence.tests) {
        lines.push('## Tests', '', `- framework: ${evidence.tests.framework}`, `- command: \`${evidence.tests.command}\``);
        if (evidence.tests.passed !== undefined) lines.push(`- passed: ${evidence.tests.passed}`);
        if (evidence.tests.failed !== undefined) lines.push(`- failed: ${evidence.tests.failed}`);
        lines.push('');
        if (evidence.tests.failures.length) {
            lines.push('### Failures', '');
            for (const failure of evidence.tests.failures) {
                lines.push(`- **${failure.name}**${failure.message ? ` — ${failure.message}` : ''}`);
            }
            lines.push('');
        }
    } else {
        lines.push('## Tests', '', evidence.testsUnavailable || 'Not run.', '');
    }

    const visual = [...(evidence.screenshots || []), ...(evidence.recordings || [])];
    if (visual.length) {
        lines.push('## Evidence', '', ...visual.map(p => `- ${p}`), '');
    }

    if (result.missing.length) {
        lines.push('## Missing', '', ...result.missing.map(m => `- ${m}`), '');
        // The actionable half. Without it the section says "screenshot" and leaves the
        // reader to work out whether that means "start your dev server" or "install
        // Playwright" — two very different afternoons.
        if (evidence.visualUnavailable) lines.push(evidence.visualUnavailable, '');
    }

    lines.push('## Why this was required', '', ...plan.because.map(b => `- ${b}`));
    return lines.join('\n');
}

/**
 * The instruction handed back to the executor for its single correction attempt.
 *
 * Names the failures and forbids the two escapes a model reaches for when a suite is red —
 * deleting the test, and marking it skipped. Both make the report green and the change
 * wrong, and both are what an agent optimising for "tests pass" will find first.
 */
export function selfCorrectionPrompt(evidence: Evidence): string {
    const failures = (evidence.tests?.failures || []).slice(0, 10);
    return [
        'The tests you must satisfy are failing after your change. Fix the cause.',
        '',
        ...failures.map(f => `- ${f.name}${f.message ? `: ${f.message}` : ''}`),
        '',
        'Rules for this attempt:',
        '1. Do not delete, rename, or skip a failing test to make the suite pass.',
        '2. Do not weaken an assertion so that it accepts the current behaviour.',
        '3. If the test is genuinely wrong, say so and stop — do not change it silently.',
        'You get one attempt; after it the result goes to the user either way.',
    ].join('\n');
}
