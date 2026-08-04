import { describe, expect, it } from 'vitest';
import { TestReport } from '@blackide/agent-core/core/test-report';
import {
    Evidence, evaluateVerification, isUiFile, planVerification, renderVerificationReport,
    selfCorrectionPrompt,
} from '@blackide/agent-core/core/verification';

/**
 * Phase 7, M40 — the verify contract.
 *
 * E5's framing is the design: **evidence, not assertions.** Before this an executor
 * finished by *saying* it was done, and the first thing that actually checked was the user
 * opening the file.
 *
 * The judgement worth testing is the four-way outcome, and specifically the refusal to
 * collapse it to three. "The suite could not run" is not a pass, and "tests pass but the
 * required screenshot is missing" is not a pass either — both are the same error M37's
 * ranking refuses to make, which is converting *we do not know* into *it is fine*.
 */

const green = (over: Partial<TestReport> = {}): TestReport => ({
    framework: 'vitest', command: 'npx vitest run', passed: 12, failed: 0,
    failures: [], ok: true, exitCode: 0, ...over,
});

const red = (failures = 2): TestReport => ({
    framework: 'vitest', command: 'npx vitest run', passed: 10, failed: failures,
    failures: Array.from({ length: failures }, (_, i) => ({ name: `suite > case ${i}`, message: 'expected true' })),
    ok: false, exitCode: 1,
});

const codePlan = () => planVerification(['src/core/retry.ts'], { framework: 'vitest', command: 'npx vitest run' });
const uiPlan = () => planVerification(['src/components/Button.tsx'], { framework: 'vitest', command: 'npx vitest run' });

describe('what a change owes', () => {
    it('always requires tests', () => {
        expect(codePlan().required).toEqual(['tests']);
    });

    it('requires tests even when the project has no runner', () => {
        // "This project has no test command" is a fact worth reporting, not an exemption.
        expect(planVerification(['src/a.ts']).required).toContain('tests');
    });

    it('requires visual evidence when a user-visible surface changed', () => {
        expect(uiPlan().required).toEqual(['tests', 'screenshot']);
    });

    it('does not require a screenshot of an unchanged page', () => {
        // Screenshots of nothing train people to stop looking at screenshots.
        expect(codePlan().required).not.toContain('screenshot');
    });

    it('explains why each requirement applies', () => {
        expect(uiPlan().because.join(' ')).toContain('user-visible surface changed');
    });
});

describe('isUiFile', () => {
    it('recognises component and style files', () => {
        for (const file of ['a/Button.tsx', 'x.jsx', 'App.vue', 'a.svelte', 'main.css', 'theme.scss', 'index.html']) {
            expect(isUiFile(file), file).toBe(true);
        }
    });

    it('recognises files under UI directories whatever their extension', () => {
        expect(isUiFile('src/components/helper.ts')).toBe(true);
        expect(isUiFile('app/views/list.py')).toBe(true);
    });

    it('leaves ordinary code alone', () => {
        for (const file of ['src/core/retry.ts', 'server.go', 'main.rs', 'README.md']) {
            expect(isUiFile(file), file).toBe(false);
        }
    });

    it('handles Windows separators', () => {
        expect(isUiFile('src\\components\\Button.ts')).toBe(true);
    });
});

// ─── The four-way outcome ───────────────────────────────────────────────────

describe('verified', () => {
    it('passes when the suite is green and nothing else is owed', () => {
        const result = evaluateVerification(codePlan(), { tests: green() });
        expect(result.outcome).toBe('verified');
        expect(result.escalate).toBe(false);
        expect(result.shouldSelfCorrect).toBe(false);
        expect(result.summary).toContain('12 tests passing');
    });

    it('passes UI work once the screenshot is there', () => {
        const result = evaluateVerification(uiPlan(), { tests: green(), screenshots: ['/a/shot.png'] });
        expect(result.outcome).toBe('verified');
    });
});

describe('failed — the only correctable outcome', () => {
    it('earns exactly one self-correction attempt', () => {
        const first = evaluateVerification(codePlan(), { tests: red() }, 0);
        expect(first.outcome).toBe('failed');
        expect(first.shouldSelfCorrect).toBe(true);
        expect(first.escalate).toBe(false);
    });

    it('escalates on the second failure rather than looping', () => {
        // A loop that keeps correcting against a red suite spends an afternoon and a
        // budget converging on nothing; the second failure is the signal for a human.
        const second = evaluateVerification(codePlan(), { tests: red() }, 1);
        expect(second.shouldSelfCorrect).toBe(false);
        expect(second.escalate).toBe(true);
    });

    it('counts the failures in the summary', () => {
        expect(evaluateVerification(codePlan(), { tests: red(3) }).summary).toContain('3 tests failing');
        expect(evaluateVerification(codePlan(), { tests: red(1) }).summary).toContain('1 test failing');
    });
});

describe('unverifiable — not a pass, and not correctable', () => {
    it('reports a missing suite as unverified', () => {
        const result = evaluateVerification(planVerification(['a.ts']), {});
        expect(result.outcome).toBe('unverifiable');
        expect(result.escalate).toBe(true);
    });

    it('does not spend a correction attempt on it', () => {
        // No edit fixes a missing test runner.
        const result = evaluateVerification(planVerification(['a.ts']), { testsUnavailable: 'no runner found' }, 0);
        expect(result.shouldSelfCorrect).toBe(false);
        expect(result.summary).toContain('no runner found');
    });

    it('is distinguishable from a pass, which is the entire point', () => {
        const unverified = evaluateVerification(codePlan(), {});
        const verified = evaluateVerification(codePlan(), { tests: green() });
        expect(unverified.outcome).not.toBe(verified.outcome);
    });
});

describe('incomplete — green tests do not excuse missing evidence', () => {
    it('refuses to call UI work verified with no screenshot', () => {
        const result = evaluateVerification(uiPlan(), { tests: green() });
        expect(result.outcome).toBe('incomplete');
        expect(result.missing).toEqual(['screenshot']);
        expect(result.escalate).toBe(true);
    });

    it('does not self-correct — the code may be right, the contract was not met', () => {
        expect(evaluateVerification(uiPlan(), { tests: green() }).shouldSelfCorrect).toBe(false);
    });

    it('reports a missing recording too', () => {
        const plan = { required: ['tests', 'recording'] as const, because: [] };
        const result = evaluateVerification({ ...plan, required: [...plan.required] }, { tests: green() });
        expect(result.missing).toEqual(['recording']);
    });

    it('a failing suite outranks missing evidence in the outcome', () => {
        // Both are wrong; the failing suite is the one to act on first.
        const result = evaluateVerification(uiPlan(), { tests: red() });
        expect(result.outcome).toBe('failed');
    });
});

// ─── The report ─────────────────────────────────────────────────────────────

describe('renderVerificationReport', () => {
    it('leads with the outcome and the summary', () => {
        const plan = codePlan();
        const evidence: Evidence = { tests: red() };
        const report = renderVerificationReport(plan, evidence, evaluateVerification(plan, evidence));
        expect(report.startsWith('# Verification — failed')).toBe(true);
    });

    it('lists failures by name so the report is actionable', () => {
        const plan = codePlan();
        const evidence: Evidence = { tests: red(2) };
        const report = renderVerificationReport(plan, evidence, evaluateVerification(plan, evidence));
        expect(report).toContain('suite > case 0');
        expect(report).toContain('expected true');
    });

    it('says plainly when nothing was run', () => {
        const plan = planVerification(['a.ts']);
        const evidence: Evidence = { testsUnavailable: 'no runner' };
        const report = renderVerificationReport(plan, evidence, evaluateVerification(plan, evidence));
        expect(report).toContain('no runner');
    });

    it('lists the visual evidence and what is missing', () => {
        const plan = uiPlan();
        const evidence: Evidence = { tests: green(), recordings: ['/a/run.webm'] };
        const report = renderVerificationReport(plan, evidence, evaluateVerification(plan, evidence));
        expect(report).toContain('/a/run.webm');
        expect(report).toContain('## Missing');
        expect(report).toContain('- screenshot');
    });

    it('records why the requirements applied', () => {
        const plan = uiPlan();
        const evidence: Evidence = { tests: green(), screenshots: ['s.png'] };
        expect(renderVerificationReport(plan, evidence, evaluateVerification(plan, evidence)))
            .toContain('Why this was required');
    });
});

describe('selfCorrectionPrompt', () => {
    it('names the failures', () => {
        expect(selfCorrectionPrompt({ tests: red(2) })).toContain('suite > case 1');
    });

    it('forbids deleting or skipping the test', () => {
        // The two escapes a model reaches for when a suite is red. Both make the report
        // green and the change wrong, and both are what "make tests pass" finds first.
        const prompt = selfCorrectionPrompt({ tests: red() });
        expect(prompt).toContain('Do not delete, rename, or skip');
        expect(prompt).toContain('Do not weaken an assertion');
    });

    it('says the attempt is the only one', () => {
        expect(selfCorrectionPrompt({ tests: red() })).toContain('one attempt');
    });

    it('caps the failure list rather than pasting a whole suite', () => {
        const many: TestReport = { ...red(1), failures: Array.from({ length: 50 }, (_, i) => ({ name: `t${i}` })) };
        const prompt = selfCorrectionPrompt({ tests: many });
        expect(prompt).toContain('t9');
        expect(prompt).not.toContain('t10');
    });
});
