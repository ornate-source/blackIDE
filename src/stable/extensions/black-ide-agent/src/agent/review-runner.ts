import { CheckpointManager } from '../core/checkpoint-manager';
import {
    ReviewFinding, ReviewRequest, ReviewSummary, REVIEW_TIER, REVIEW_TOOLS,
    buildReviewPrompt, offersFix, parseFindings, renderReviewArtifact, summariseReview,
} from '../core/code-review';
import { ArtifactRecord } from '../core/artifacts';
import { ArtifactStore } from './artifact-store';

// ─── Running a review (Phase 9, M47 · P9-2) ────────────────────────────────
//
// `core/code-review.ts` decides what the reviewer is asked and what counts as a finding.
// This gets the diff, makes the call, writes the artifact into the panel Phase 7 built,
// and applies a fix when the user asks for one.
//
// ── Why the model call is injected ──────────────────────────────────────────
// `complete` is a function the caller supplies rather than an import of `LLMClient`. The
// same runner then serves the palette command (an editor with a configured model), the
// pipeline lane (a run with its own budget), and the eval harness — which needs to drive
// it with a recorded response and no network at all. A runner that reached for the client
// itself would be measurable only by mocking a module, which is a test of the mock.
//
// ── Read-only is enforced twice, on purpose ─────────────────────────────────
// `REVIEW_TOOLS` is the acting allowlist and `REVIEW_TIER` is the sandbox. Neither is
// redundant: the allowlist is a TypeScript array that an unrelated edit could widen by
// accident, and the tier is a property of the process that would still hold if it did.
// The cost of the belt is one constant; the cost of being wrong is a model reading an
// untrusted diff with the network open.

export interface ReviewContext {
    runId: string;
    /** Unified diff of the working tree. Empty means nothing to review. */
    diff: string;
    /** Files the diff touches, for the artifact header. */
    changedFiles: string[];
    artifacts: ArtifactStore;
    /** Makes the model call. Injected — see the module header. */
    complete: (prompt: string) => Promise<string>;
    /** Files the reviewer asked to see, already read. */
    context?: { path: string; content: string }[];
    intent?: string;
    model?: string;
    log?: (message: string) => void;
}

export interface ReviewOutcome {
    findings: ReviewFinding[];
    summary: ReviewSummary;
    /** The `review` artifact. Written on every path, including "nothing found". */
    artifact: ArtifactRecord;
    /** Findings confident enough to offer a one-click, checkpointed fix. */
    fixable: ReviewFinding[];
    /** Set when no review happened, and why. */
    skipped?: string;
}

/** What the acting agent is restricted to while reviewing. */
export const REVIEWER_CONSTRAINTS = { tools: REVIEW_TOOLS, tier: REVIEW_TIER } as const;

/**
 * Review a working diff.
 *
 * Writes an artifact on every path that reaches the model, including the clean one, for
 * the same reason `runVerification` does: a run that produced no artifact and a run that
 * found nothing are indistinguishable from the outside, and the first is a bug while the
 * second is a result.
 *
 * An empty diff is the one case that produces no artifact, because there is no run to
 * document — "you have no changes" is a message, not a finding.
 */
export async function runReview(context: ReviewContext): Promise<ReviewOutcome> {
    const diff = String(context.diff || '').trim();
    if (!diff) {
        return {
            findings: [], summary: summariseReview([]), fixable: [],
            artifact: undefined as unknown as ArtifactRecord,
            skipped: 'There are no uncommitted changes to review.',
        };
    }

    const request: ReviewRequest = { diff, context: context.context, intent: context.intent };
    let findings: ReviewFinding[] = [];
    let failure: string | undefined;

    try {
        const response = await context.complete(buildReviewPrompt(request));
        findings = parseFindings(response, context.runId);
    } catch (error: any) {
        // A failed review is recorded as a failed review, not as a clean one. The
        // difference decides whether somebody looks at the diff themselves, and "the
        // reviewer found nothing" is the most expensive possible way to say "the
        // reviewer did not run".
        failure = error?.message || String(error);
        context.log?.(`[Review] The model call failed: ${failure}`);
    }

    const content = failure
        ? [
            '# Review of the working diff',
            '',
            '**The review did not complete.**',
            '',
            `The model call failed: ${failure}`,
            '',
            'This is not a clean review. Nothing about the diff has been checked.',
            '',
        ].join('\n')
        : renderReviewArtifact(findings, {
            filesChanged: context.changedFiles.length,
            model: context.model,
        });

    const artifact = context.artifacts.save(context.runId, 'review', 'Working diff review', content);
    const summary = summariseReview(findings);
    context.log?.(failure
        ? '[Review] Recorded a failed review.'
        : `[Review] ${summary.total} finding(s), ${summary.fixable} with an offered fix.`);

    return {
        findings, summary, artifact,
        fixable: findings.filter(offersFix),
        skipped: failure ? `The review did not complete: ${failure}` : undefined,
    };
}

export interface FixApplication {
    applied: boolean;
    /** The checkpoint the fix can be undone from. Present only when one was applied. */
    checkpointId?: string;
    reason?: string;
}

/**
 * Apply one finding's suggested fix, behind a checkpoint.
 *
 * The checkpoint is taken **before** the write and is the reason a fix may be offered at
 * all. A one-click change to code the user did not ask to be changed is only acceptable
 * when undoing it is also one click, and `CheckpointManager` is what already makes every
 * other agent edit reversible — using it here rather than inventing a review-specific
 * undo is what keeps "revert everything this session did" a single, complete operation.
 *
 * Re-reads and re-checks the target rather than trusting the finding. A review is a
 * snapshot of a diff, the user has had the time it took to read it, and applying a
 * remembered edit to a file that has since changed is how an assistant corrupts work.
 */
export async function applyFix(
    finding: ReviewFinding,
    file: { read: () => Promise<string>; write: (content: string) => Promise<void>; absolutePath: string },
    checkpoint: CheckpointManager,
): Promise<FixApplication> {
    if (!offersFix(finding)) {
        return { applied: false, reason: 'This finding is not confident enough to offer a fix for.' };
    }

    let current: string;
    try {
        current = await file.read();
    } catch (error: any) {
        return { applied: false, reason: `Could not read ${finding.file}: ${error?.message || error}` };
    }

    const lines = current.split(/\r?\n/);
    if (finding.line > lines.length) {
        return {
            applied: false,
            reason: `${finding.file} has changed since the review — it now has ${lines.length} lines `
                + `and the finding is on line ${finding.line}. Re-run the review.`,
        };
    }

    /*
     * Keep the original line's indentation, and splice a multi-line fix as multiple lines.
     *
     * Both halves were wrong in the obvious implementation. Flattening a multi-line
     * suggestion onto one line produces syntactically valid nonsense in most languages
     * and a syntax error in Python; dropping the indentation produces a syntax error in
     * Python and a diff full of noise everywhere else. A fix button whose output has to
     * be hand-repaired is worse than no button, because the user has already accepted
     * the change by the time they see it.
     */
    const indent = (lines[finding.line - 1].match(/^[\t ]*/) || [''])[0];
    const replacement = reindent(finding.suggestedFix!, indent);

    checkpoint.snapshot(file.absolutePath);
    lines.splice(finding.line - 1, 1, ...replacement);
    await file.write(lines.join('\n'));
    return { applied: true, checkpointId: file.absolutePath };
}

/**
 * Re-indent a suggested fix to sit where the line it replaces sat.
 *
 * Strips the fix's own common indent first, then applies the target's. Applying the
 * target's indent to every line without stripping would double the indentation of a
 * fix the model already indented; stripping without re-applying would flatten a fix
 * into column zero. Relative structure inside the fix is preserved either way, which is
 * what makes the result compile in a whitespace-significant language.
 */
export function reindent(fix: string, indent: string): string[] {
    const lines = fix.replace(/\s+$/, '').split(/\r?\n/);
    const common = lines
        .filter(line => line.trim())
        .reduce<number>((least, line) => Math.min(least, (line.match(/^[\t ]*/) || [''])[0].length), Infinity);
    const strip = Number.isFinite(common) ? common : 0;
    return lines.map(line => (line.trim() ? indent + line.slice(strip) : ''));
}
