import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { LLMClient } from './llm-client';
import { loadModelRouter } from './model-router-loader';
import { SecretManager } from './secret-manager';
import { CheckpointManager } from './checkpoint-manager';
import { ReviewFinding, offersFix } from './code-review';
import { ArtifactStore } from '../agent/artifact-store';
import { REVIEWER_CONSTRAINTS, applyFix, runReview } from '../agent/review-runner';

// ─── `black-ide.reviewChanges` (Phase 9, M47 · P9-2) ────────────────────────
//
// The palette entry point for Reviewer mode: read the working diff, review it, write a
// `review` artifact into the panel Phase 7 built, and offer to apply the fixes the
// reviewer was confident enough about.
//
// In its own module rather than inline in `command-registry.ts` for the reason
// `extension.ts` has a line gate: the registry is a list of registrations, and a handler
// with a git call, a model call, a QuickPick flow and a checkpointed write in it stops
// being a registration.
//
// ── `execFile`, not `exec` ──────────────────────────────────────────────────
// The diff is fetched with `execFile('git', [...])` — an argv, no shell. Every other git
// call in this codebase predates the rule and uses `exec` with an interpolated string;
// none of them interpolate anything a model wrote, which is why they are still there. This
// one is new, so it starts correct.

/** Diff bigger than this and the review is worth less than the tokens. */
const MAX_DIFF_CHARS = 120_000;

export interface ReviewCommandDeps {
    secretManager: SecretManager;
    artifacts: ArtifactStore;
    checkpoints: CheckpointManager;
}

export function registerReviewCommand(
    context: vscode.ExtensionContext,
    deps: ReviewCommandDeps,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('black-ide.reviewChanges', () => reviewChanges(deps)),
    );
}

async function reviewChanges(deps: ReviewCommandDeps): Promise<void> {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }

    const { router } = await loadModelRouter(deps.secretManager);
    // The `review` role if one is configured, then `edit`, then whatever is selected.
    // Reviewing is a reasoning task over a diff, so it is *not* one to point at the
    // cheapest model by default — but a user who has configured a role gets it.
    const modelConfig = router.resolve('review')?.config || router.resolve('edit')?.config;
    if (!modelConfig) {
        vscode.window.showErrorMessage('No model configured. Set one up in Black IDE Settings first.');
        return;
    }

    const outcome = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Reviewing your working changes…', cancellable: false },
        async () => {
            const diff = await workingDiff(rootPath);
            if (!diff.text) return { empty: true as const, reason: diff.reason };

            const runId = `review-${Date.now().toString(36)}`;
            return {
                empty: false as const,
                result: await runReview({
                    runId,
                    diff: diff.text,
                    changedFiles: diff.files,
                    artifacts: deps.artifacts,
                    model: modelConfig.model,
                    complete: async (prompt) => {
                        let text = '';
                        await LLMClient.streamCompletion(modelConfig, prompt, token => { text += token; });
                        return text;
                    },
                }),
            };
        },
    );

    if (outcome.empty) {
        vscode.window.showInformationMessage(outcome.reason || 'There are no uncommitted changes to review.');
        return;
    }

    const { result } = outcome;
    if (result.skipped) {
        vscode.window.showErrorMessage(result.skipped);
        // The artifact still exists and still says the review did not complete, so the
        // panel does not show a clean review that never happened.
        if (result.artifact) void vscode.window.showTextDocument(vscode.Uri.file(result.artifact.path));
        return;
    }

    await presentFindings(result.findings, result.artifact.path, rootPath, deps.checkpoints);
}

/**
 * Show the findings and let the user act on them.
 *
 * A QuickPick over the findings rather than a wall of text, because the artifact is
 * already the wall of text and the thing the palette can add is *acting on one*. Fixes
 * are offered per finding and never in bulk: "apply all 6 fixes" is a button whose worst
 * case is six wrong edits the user accepted in one click, and the fix offer is only
 * defensible because each one is a decision.
 */
async function presentFindings(
    findings: ReviewFinding[],
    artifactPath: string,
    rootPath: string,
    checkpoints: CheckpointManager,
): Promise<void> {
    if (!findings.length) {
        const choice = await vscode.window.showInformationMessage(
            'Review complete — no findings. The reviewer read the diff and could not ground a defect in a concrete failure.',
            'Open review',
        );
        if (choice) void vscode.window.showTextDocument(vscode.Uri.file(artifactPath));
        return;
    }

    const items = findings.map(finding => ({
        label: `${finding.severity === 'high' ? '$(error)' : finding.severity === 'medium' ? '$(warning)' : '$(info)'} ${finding.summary}`,
        description: `${finding.file}${finding.line ? `:${finding.line}` : ''} · ${finding.category}`,
        detail: `${finding.failureScenario}${offersFix(finding) ? '   ⟶ a fix is available' : ''}`,
        finding,
    }));

    const picked = await vscode.window.showQuickPick(
        [...items, { label: '$(book) Open the full review', description: '', detail: '', finding: undefined as any }],
        {
            title: `${findings.length} finding(s) — ${findings.filter(offersFix).length} with an offered fix`,
            matchOnDetail: true,
            ignoreFocusOut: true,
        },
    );
    if (!picked) return;
    if (!picked.finding) {
        void vscode.window.showTextDocument(vscode.Uri.file(artifactPath));
        return;
    }

    await actOnFinding(picked.finding, rootPath, checkpoints);
}

async function actOnFinding(
    finding: ReviewFinding,
    rootPath: string,
    checkpoints: CheckpointManager,
): Promise<void> {
    const absolutePath = path.isAbsolute(finding.file) ? finding.file : path.join(rootPath, finding.file);

    const actions = ['Go to code'];
    if (offersFix(finding)) actions.unshift('Apply the fix');
    const choice = await vscode.window.showInformationMessage(
        `${finding.summary}\n\nFails when: ${finding.failureScenario}`,
        { modal: true },
        ...actions,
    );

    if (choice === 'Go to code') {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
        const editor = await vscode.window.showTextDocument(document);
        const line = Math.max(0, finding.line - 1);
        editor.selection = new vscode.Selection(line, 0, line, 0);
        editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
        return;
    }

    if (choice !== 'Apply the fix') return;

    const application = await applyFix(finding, {
        absolutePath,
        read: async () => fs.promises.readFile(absolutePath, 'utf8'),
        write: async (content) => fs.promises.writeFile(absolutePath, content, 'utf8'),
    }, checkpoints);

    if (!application.applied) {
        vscode.window.showWarningMessage(application.reason || 'The fix was not applied.');
        return;
    }
    // Naming the undo path in the same breath as the change, because the checkpoint is
    // the reason the button was offered at all and a user who does not know it exists has
    // been given an irreversible edit as far as they can tell.
    vscode.window.showInformationMessage(
        `Applied the fix to ${finding.file}. Undo it from the checkpoint timeline in the chat panel.`,
    );
    void vscode.window.showTextDocument(vscode.Uri.file(absolutePath));
}

interface WorkingDiff {
    text: string;
    files: string[];
    reason?: string;
}

/**
 * The working diff: tracked changes plus untracked files as add-only hunks.
 *
 * Untracked files are included for the same reason `commit-message.ts` includes them —
 * `git diff HEAD` does not show them, so a change consisting entirely of new files
 * produces an empty diff and a reviewer that reports nothing wrong with code it never
 * saw. That is the worst possible output from a review tool, so the case is handled
 * rather than documented.
 */
async function workingDiff(rootPath: string): Promise<WorkingDiff> {
    const status = await git(rootPath, ['status', '--porcelain']);
    if (!status.trim()) return { text: '', files: [], reason: 'There are no uncommitted changes to review.' };

    const tracked = await git(rootPath, ['diff', 'HEAD', '--no-color']);
    const files = new Set<string>();
    let untracked = '';

    for (const line of status.trim().split(/\r?\n/)) {
        const file = line.slice(3).trim();
        if (!file) continue;
        files.add(file);
        if (!line.startsWith('??')) continue;

        try {
            const absolute = path.join(rootPath, file);
            if (!fs.statSync(absolute).isFile()) continue;
            const content = fs.readFileSync(absolute, 'utf8');
            // Binary files produce a diff nobody can review and blow the budget doing it.
            if (content.includes(String.fromCharCode(0))) continue;
            const lines = content.split('\n');
            untracked += `\n\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n`
                + lines.map(l => `+${l}`).join('\n');
        } catch { /* unreadable or a directory — skipped rather than guessed at */ }
    }

    let text = (tracked + untracked).trim();
    if (text.length > MAX_DIFF_CHARS) {
        // Truncated *and said so*, in the diff itself where the model will read it. A
        // silently truncated diff makes the reviewer confidently report that the second
        // half of the change is fine.
        text = `${text.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated at ${MAX_DIFF_CHARS} characters — `
            + 'later files in this change were NOT reviewed]';
    }
    return { text, files: [...files] };
}

function git(cwd: string, args: string[]): Promise<string> {
    return new Promise(resolve => {
        execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
            // An empty answer rather than a rejection: a repository with no commits has no
            // `HEAD` to diff against, and that is a normal state for a new project, not a
            // failure worth an error dialogue.
            resolve(error ? '' : String(stdout || ''));
        });
    });
}

/** Re-exported so the mode surface and the tests read the constraints from one place. */
export { REVIEWER_CONSTRAINTS };
