import { ProjectProfile } from '@blackide/agent-core/core/project-profiler';
import { parseTestOutput, selectTestCommand } from '@blackide/agent-core/core/test-report';
import {
    Evidence, VerificationResult, evaluateVerification, planVerification,
    renderVerificationReport, selfCorrectionPrompt,
} from '@blackide/agent-core/core/verification';
import { ArtifactStore } from './artifact-store';
import { ToolRunner } from '../tools/tool-runner';

// ─── Running a verification (Phase 7, M40) ──────────────────────────────────
//
// `core/verification.ts` decides what is required and whether what came back is enough.
// This runs the command, attaches the evidence, and writes the `test-report` artifact that
// makes "100% of runs emit verification evidence" a measurable claim rather than a wish.
//
// It reuses Phase 1's `selectTestCommand`/`parseTestOutput` rather than shelling out and
// reading the output by eye — the same reasoning as `run_tests`: the parsers already trust
// the exit code over the parse, so a crashed runner is never reported as a pass, and that
// property is exactly what a verification step must not lose.

export interface VerifyContext {
    runId: string;
    /** Where the tests run. For a task agent this is its worktree, not the live repo. */
    cwd: string;
    profile: ProjectProfile;
    changedFiles: string[];
    artifacts: ArtifactStore;
    signal?: AbortSignal;
    log?: (message: string) => void;
    /** Screenshots/recordings already attached by the run, if any. */
    visual?: { screenshots?: string[]; recordings?: string[] };
    /**
     * Produce visual evidence when the plan requires it and the run supplied none.
     *
     * Injected rather than imported so the decision to *own a browser* stays with the
     * caller: a task agent has its own `BrowserTool` per run (see `task-agent-entry.ts`),
     * the pipeline shares one, and the headless CLI has none at all. A runner that reached
     * for a browser itself would give the CLI one it cannot use and give four concurrent
     * agents one they would fight over.
     */
    captureVisual?: () => Promise<{ screenshots: string[]; unavailable?: string }>;
    timeoutMs?: number;
}

export interface VerifyOutcome {
    result: VerificationResult;
    evidence: Evidence;
    /** The artifact written. Present even when verification failed — especially then. */
    reportPath: string;
    /** The instruction for a self-correction attempt, when one is warranted. */
    correctionPrompt?: string;
}

/**
 * Verify a change and record the evidence.
 *
 * Writes the report **on every path**, including the one where no suite could be run. That
 * is the difference between a contract and a happy-path nicety: a run with no artifact and
 * a run that verified clean are indistinguishable from the outside, so the unverifiable
 * case has to produce a document that says it was unverifiable.
 */
export async function runVerification(context: VerifyContext): Promise<VerifyOutcome> {
    const selected = selectTestCommand(context.profile);
    const plan = planVerification(context.changedFiles, selected);
    const evidence: Evidence = {
        screenshots: context.visual?.screenshots,
        recordings: context.visual?.recordings,
    };

    if (!selected) {
        evidence.testsUnavailable = 'No test command could be selected for this project\'s detected stack.';
    } else {
        context.log?.(`[Verify] ${selected.command}`);
        try {
            const run = await ToolRunner.executeCommand(
                selected.command,
                context.cwd,
                context.timeoutMs ?? 300_000,
                context.signal,
            );
            evidence.tests = parseTestOutput(selected.framework, run, selected.command);
        } catch (err: any) {
            // A runner that could not start is *unverifiable*, not failed. Reporting it as
            // a failing suite would send the agent into a self-correction attempt against
            // a problem no edit can fix — a missing binary, a bad cwd, a killed process.
            evidence.testsUnavailable = `The test command could not be run: ${err?.message || err}`;
        }
    }

    /*
     * Visual evidence (Phase 7, M40's third gate clause).
     *
     * Only when the plan asks for it, and only when the run did not already produce one —
     * an agent that drove the browser itself and screenshotted the thing it changed has
     * better evidence than a capture of the app's front page, and capturing anyway would
     * spend two seconds of Chromium to append a worse picture.
     *
     * Never throws outward: `captureVisual` is contracted not to, and this catches anyway,
     * because the failure mode being designed against is "the verification step broke the
     * run" and a contract is not an enforcement.
     */
    if (plan.required.includes('screenshot') && !(evidence.screenshots || []).length && context.captureVisual) {
        try {
            const captured = await context.captureVisual();
            if (captured.screenshots.length) evidence.screenshots = captured.screenshots;
            else evidence.visualUnavailable = captured.unavailable;
        } catch (err: any) {
            evidence.visualUnavailable = `Visual capture failed: ${err?.message || err}`;
        }
    }

    const result = evaluateVerification(plan, evidence, 0);
    const report = context.artifacts.save(
        context.runId,
        'test-report',
        `Verification ${result.outcome}`,
        renderVerificationReport(plan, evidence, result),
    );

    context.log?.(`[Verify] ${result.outcome} — ${result.summary}`);

    return {
        result,
        evidence,
        reportPath: report.path,
        correctionPrompt: result.shouldSelfCorrect ? selfCorrectionPrompt(evidence) : undefined,
    };
}

/**
 * Re-verify after a self-correction attempt.
 *
 * `attempt` is passed through so `evaluateVerification` stops offering corrections — the
 * bound lives in the pure function, and this exists so the caller cannot accidentally
 * restart the count by calling `runVerification` again.
 */
export async function reverifyAfterCorrection(context: VerifyContext): Promise<VerifyOutcome> {
    const outcome = await runVerification(context);
    const plan = planVerification(context.changedFiles, selectTestCommand(context.profile));
    const result = evaluateVerification(plan, outcome.evidence, 1);
    return { ...outcome, result, correctionPrompt: undefined };
}
