import * as vscode from 'vscode';
import { TaskAgentSummary } from '@blackide/agent-core/core/task-agents';
import { ToolRunner } from '../tools/tool-runner';
import { worktreeUriFor } from '../agent/task-agent-entry';

// ─── What the Office's buttons actually do ──────────────────────────────────
//
// R2 says a button exists only where a transition exists. `affordancesFor` decides which
// buttons are rendered; this decides what they do, and the two must not drift — a rendered
// button whose message nobody handles is the same defect as a disabled one, arrived at
// from the other direction. The Office's affordance test asserts the first half; this
// module is the second, and every affordance the model can produce has a case here.
//
// Kept out of `manager-panel.ts` because these reach for git and the editor's window API,
// and that file is deliberately a message router.

export interface OfficeActionHost {
    findAgent(id: string): TaskAgentSummary | undefined;
    steer(id: string, text: string): { ok: true } | { error: string };
}

/**
 * Open an agent's work as a patch.
 *
 * A branch diff rather than a file diff, because a task agent's unit of work is the whole
 * run: it may have touched six files, and six side-by-side editors is not a review. The
 * text is opened as a `diff` document so the editor colours it, and read-only by
 * construction — an untitled document the user could edit would invite them to fix
 * something in a buffer that is not connected to anything.
 *
 * Read from the **live repo**, not the worktree: worktrees of one repo share an object
 * database so the commits are visible from either, and the live root is guaranteed to
 * still exist even if the worktree was pruned.
 */
export async function showAgentDiff(agent: TaskAgentSummary | undefined): Promise<void> {
    if (!agent) return;
    if (!agent.baselineSha || !agent.resultSha) {
        vscode.window.showInformationMessage(
            `${agent.id} has not committed anything yet, so there is no diff to show. `
            + 'A diff appears once the run reaches its first commit.');
        return;
    }

    const result = await ToolRunner.executeCommand(
        `git diff ${agent.baselineSha} ${agent.resultSha}`, agent.rootPath);
    if (result.exitCode !== 0) {
        vscode.window.showWarningMessage(
            `Could not read the diff for ${agent.id}: ${result.stderr || 'git failed'}. `
            + `The work is still on branch "${agent.branch}".`);
        return;
    }
    if (!result.stdout.trim()) {
        vscode.window.showInformationMessage(`${agent.id} finished without changing any files.`);
        return;
    }

    const document = await vscode.workspace.openTextDocument({ content: result.stdout, language: 'diff' });
    await vscode.window.showTextDocument(document, { preview: false });
}

/**
 * Open the agent's worktree.
 *
 * In a new window, which is the only presentation that is actually useful: the worktree is
 * a second checkout of the same repository, and opening it in *this* window would replace
 * the user's workspace with the agent's copy — losing their editor layout to look at a
 * branch. A new window is also trivially reversible.
 */
export async function openAgentWorktree(agent: TaskAgentSummary | undefined): Promise<void> {
    if (!agent) return;
    const uri = worktreeUriFor(agent.rootPath, agent.branch);
    try {
        await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
    } catch {
        // The worktree may have been pruned, or the fork may refuse the command. Either
        // way the branch is the durable handle, so the message names it rather than
        // reporting that a folder is missing.
        vscode.window.showWarningMessage(
            `Could not open ${uri.fsPath}. The work is on branch "${agent.branch}" — `
            + `check it out with 'git switch ${agent.branch}'.`);
    }
}

/**
 * Send a mid-run correction.
 *
 * An input box rather than the `window.prompt()` the agent card still uses: `prompt` is a
 * browser modal inside a webview, which the host may refuse outright and which cannot say
 * what happened afterwards. The distinction the steering queue already makes — *delivered*
 * versus *queued for the next turn* — is reported, because a correction the user believes
 * arrived and did not is the one outcome this feature must never produce.
 *
 * The full Desk textarea with correction history is M78; this is the working half of it.
 */
export async function steerAgent(host: OfficeActionHost, id: string): Promise<void> {
    const agent = host.findAgent(id);
    if (!agent) return;

    const text = await vscode.window.showInputBox({
        title: `Correct ${agent.id}`,
        prompt: 'This reaches the model on its next turn.',
        placeHolder: 'e.g. use the existing useBreakpoint hook rather than adding a listener',
        ignoreFocusOut: true,
    });
    if (!text?.trim()) return;

    const result = host.steer(id, text.trim());
    if ('error' in result) vscode.window.showWarningMessage(result.error);
    else vscode.window.setStatusBarMessage('Correction queued — it reaches the agent on its next turn.', 4000);
}

/**
 * Retry a failed agent.
 *
 * Deliberately *not* automatic. It fills the launcher with the original prompt and lets
 * the user press the button, because a failed run failed for a reason — a bad prompt, a
 * missing dependency, a model that was down — and a one-click relaunch of the identical
 * request is most often a second identical failure that also costs money. Retrying is a
 * decision; the button removes the retyping, not the decision.
 */
export function retryPrompt(agent: TaskAgentSummary | undefined): { prompt: string; modelId: string } | undefined {
    return agent ? { prompt: agent.prompt, modelId: agent.modelId } : undefined;
}
