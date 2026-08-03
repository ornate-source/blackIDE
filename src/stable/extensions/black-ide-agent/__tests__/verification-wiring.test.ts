import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Verification reaches every lane (Phase 7, M40's first two gate clauses).
 *
 * Phase 7 shipped `core/verification.ts` and `agent/verify-runner.ts` and wired them into
 * the **task-agent lane only**, so two of the phase's four gate clauses read *not met*:
 * "100% of pipeline runs emit a test-report artifact" and "≥80% of chat build tasks emit
 * verification evidence". Neither was hard; nothing carried the artifact store into those
 * lanes.
 *
 * These are structural assertions over the source, and that choice needs defending. The
 * behavioural half — four outcomes, one bounded self-correction, a report on every path —
 * is already asserted against the pure functions in `verification.test.ts`, and running a
 * real pipeline in a unit test would mean standing up seven modes, a worktree and a model.
 * What was actually missing was a *call site*, and a call site is exactly the thing a
 * structural test can pin. The failure this guards against is a future refactor quietly
 * dropping one lane's verification and nothing noticing, which is how it came to be
 * missing from two lanes in the first place.
 */

const src = (...parts: string[]) => fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8');

describe('every lane that can change a file verifies', () => {
    it('the task lane calls runVerification — the one that already did', () => {
        expect(src('agent', 'task-agent-entry.ts')).toMatch(/runVerification\(/);
    });

    it('the pipeline lane calls it, through a callback the orchestrator invokes', () => {
        // Split deliberately: the orchestrator is free of ToolRunner and vscode, so it
        // decides *when* and the host supplies the runner.
        expect(src('agent', 'pipeline-orchestrator.ts')).toMatch(/verifyRun\?:/);
        expect(src('agent', 'pipeline-orchestrator.ts')).toMatch(/this\.callbacks\.verifyRun/);
        expect(src('agent', 'pipeline-entry.ts')).toMatch(/verifyRun:\s*async/);
        expect(src('agent', 'pipeline-entry.ts')).toMatch(/runVerification\(/);
    });

    it('the chat lane calls it', () => {
        expect(src('agent', 'chat-task.ts')).toMatch(/runVerification\(/);
    });

    it('all three use the same runner rather than three implementations that agree today', () => {
        for (const file of [['agent', 'task-agent-entry.ts'], ['agent', 'pipeline-entry.ts'], ['agent', 'chat-task.ts']]) {
            expect(src(...file), file.join('/')).toMatch(/from '\.\/verify-runner'/);
        }
    });
});

describe('the pipeline verifies where the result is attributable', () => {
    const orchestrator = src('agent', 'pipeline-orchestrator.ts');

    it('runs inside the worktree, before the delta is applied to the live tree', () => {
        const verifyAt = orchestrator.indexOf('this.callbacks.verifyRun');
        const applyAt = orchestrator.indexOf('applyDelta(branchName, baselineSha, executionSha)');
        expect(verifyAt).toBeGreaterThan(0);
        expect(applyAt).toBeGreaterThan(0);
        // After the delta lands, a red suite could equally be the user's uncommitted work.
        expect(verifyAt).toBeLessThan(applyAt);
        expect(orchestrator).toMatch(/verifyRun\(\{ runId: branchName, cwd: worktreeDir/);
    });

    it('never lets a failed verification discard the run\'s work', () => {
        // The call is inside a try that reports and continues. Burying real edits because
        // a test command was missing is worse than an honest `unverifiable`.
        const slice = orchestrator.slice(orchestrator.indexOf('if (this.callbacks.verifyRun)'), orchestrator.indexOf('const executionSha'));
        expect(slice).toMatch(/catch \(verifyErr/);
        expect(slice).not.toMatch(/throw/);
    });
});

describe('the chat lane verifies a build task and only a build task', () => {
    const chat = src('agent', 'chat-task.ts');
    const block = chat.slice(chat.indexOf('const changedForVerification'), chat.indexOf('Plan Detection'));

    it('decides "build task" by what the run did, not by what the prompt looked like', () => {
        // Classifying the prompt is wrong in both directions: "explain this and fix the
        // typo" would skip, "how do I add a test" would spend a suite run on a question.
        expect(block).toMatch(/changedForVerification\.length/);
        expect(block).not.toMatch(/userPrompt/);
    });

    it('takes the changed set from the checkpoint rather than keeping a second tally', () => {
        expect(chat).toMatch(/const changedForVerification = committed\?\.files\.map/);
    });

    it('does not verify in a read-only mode', () => {
        expect(block).toMatch(/effectiveMode === 'agent'/);
    });

    it('does not verify an aborted run', () => {
        expect(block).toMatch(/!result\.aborted/);
    });

    it('never fails the turn on a verification error', () => {
        expect(block).toMatch(/catch \(verifyErr/);
        expect(block).not.toMatch(/throw/);
    });
});

describe('the artifact store reaches both new lanes', () => {
    it('is a declared dependency of the pipeline and the chat task', () => {
        expect(src('agent', 'pipeline-entry.ts')).toMatch(/artifacts: ArtifactStore;/);
        expect(src('agent', 'chat-task.ts')).toMatch(/artifacts\?: ArtifactStore;/);
    });

    it('is supplied by the extension to both, so the optional one is never actually absent', () => {
        const extension = src('extension.ts');
        // Three call sites: the task lane (Phase 6), the pipeline and the chat task.
        expect(extension.match(/artifacts: this\._artifacts/g)?.length).toBeGreaterThanOrEqual(3);
    });
});

describe('the outcome is on the bus, so evidence is one query rather than three conventions', () => {
    const bus = src('core', 'event-bus.ts');

    it('declares a verification event for the chat and pipeline lanes', () => {
        expect(bus).toMatch(/'VerificationCompleted'/);
        expect(bus).toMatch(/'PipelineVerified'/);
    });

    it('carries the report path, not just the verdict', () => {
        // A verdict with no document behind it is an assertion, which is the thing this
        // whole phase exists to stop being made.
        expect(bus).toMatch(/'VerificationCompleted';[^}]*reportPath: string/);
        expect(bus).toMatch(/'PipelineVerified';[^}]*reportPath: string/);
    });
});
