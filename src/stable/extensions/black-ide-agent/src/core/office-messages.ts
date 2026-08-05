import * as vscode from 'vscode';
import { PipelineRunSummary } from '@blackide/agent-core/core/pipeline-runs';
import { TaskAgentSummary } from '@blackide/agent-core/core/task-agents';
import { ArtifactRecord } from './artifacts';
import { openAgentWorktree, retryPrompt, showAgentDiff, steerAgent } from './office-actions';

// ─── Every message an Office surface can send ───────────────────────────────
//
// Extracted from `manager-panel.ts` when the Front Desk arrived (M73), because the Office
// now renders in two places — an editor tab and a sidebar view — and R2 does not care
// which one the user clicked in. A button that works on the floor and does nothing at the
// front desk is the same defect as a button that does nothing at all, and the only way to
// be sure it cannot happen is for there to be exactly one implementation of what each
// button means.
//
// ── What belongs here ────────────────────────────────────────────────────────
// The union of `OfficeView`'s `ACTIONS` table plus the two messages the surface sends on
// its own behalf (`listOffice`, `openSettings`). Deliberately *not* everything the Manager
// panel handles: launching a pipeline, reading an artifact and editing `memory.md` belong
// to tabs the sidebar does not have, and hoisting them here would make this module "the
// manager panel's switch statement, elsewhere".
//
// The Logs tab stays in `manager-panel.ts` for the same reason — it is a reader for one
// surface, and the sidebar routes to it rather than reimplementing it.

/** Where a reply goes. Narrower than `vscode.Webview` so a test can pass an array. */
export interface MessageSink {
    postMessage(message: any): void;
}

/** The slice of the chat provider these handlers need. A subset of `ManagerPanelHost`. */
export interface OfficeMessageHost {
    listManagedPipelineRuns(): PipelineRunSummary[];
    approveManagedPipelineRun(runId: string): void;
    rejectManagedPipelineRun(runId: string): void;
    readonly taskAgents: {
        cancel(id: string): void;
        apply(id: string): Promise<{ ok: true } | { error: string }>;
        discard(id: string): Promise<{ ok: true } | { error: string }>;
        list(): TaskAgentSummary[];
        steer(id: string, text: string, options?: { artifactPath?: string; region?: string }): { ok: true } | { error: string };
        acknowledgeDaemonResult(id: string): void;
    };
    readonly office?: {
        sync(): void;
        filesInPlay(): unknown[];
    };
    readonly artifacts: {
        list(): ArtifactRecord[];
        open(record: ArtifactRecord): Promise<void>;
    };
}

/**
 * Handle one message from an Office surface.
 *
 * Returns whether it was handled, so a host with tabs of its own can fall through to them
 * rather than having to know this module's vocabulary. A boolean rather than a thrown
 * "unknown message": an unrecognised message is the *normal* case for the Manager panel,
 * which sends a dozen of its own.
 */
export async function handleOfficeMessage(
    host: OfficeMessageHost,
    data: any,
    webview: MessageSink,
): Promise<boolean> {
    const agentId = String(data?.value?.agentId || '');
    const findAgent = (id: string) => host.taskAgents.list().find(a => a.id === id);

    switch (data?.type) {
        /*
         * One message serves the whole surface on mount.
         *
         * The Office is a projection of four lanes plus the governor plus live telemetry,
         * and asking for them separately would render a floor with desks but no capacity,
         * or capacity but no desks, for however long the round trips took. `officeSync`
         * carries the lot; everything after it is a patch.
         */
        case 'listOffice':
            host.office?.sync();
            webview.postMessage({ type: 'officeFiles', value: host.office?.filesInPlay() ?? [] });
            return true;

        // ── The floor's per-item verbs ──────────────────────────────────────
        case 'cancelTaskAgent':
            host.taskAgents.cancel(agentId);
            return true;

        case 'applyTaskAgent': {
            const result = await host.taskAgents.apply(agentId);
            if ('error' in result) vscode.window.showErrorMessage(result.error);
            else vscode.window.showInformationMessage('Applied the agent\'s changes to your workspace.');
            webview.postMessage({ type: 'taskAgentListSync', value: host.taskAgents.list() });
            return true;
        }

        case 'discardTaskAgent': {
            const result = await host.taskAgents.discard(agentId);
            if ('error' in result) vscode.window.showErrorMessage(result.error);
            webview.postMessage({ type: 'taskAgentListSync', value: host.taskAgents.list() });
            return true;
        }

        case 'approvePipelineRun':
            host.approveManagedPipelineRun(data.value?.runId);
            return true;

        case 'rejectPipelineRun':
            host.rejectManagedPipelineRun(data.value?.runId);
            webview.postMessage({ type: 'pipelineRunListSync', value: host.listManagedPipelineRuns() });
            return true;

        case 'acknowledgeDaemonResult':
            host.taskAgents.acknowledgeDaemonResult(String(data.value?.id || ''));
            host.office?.sync();
            return true;

        case 'officeSteer':
            await steerAgent({ findAgent, steer: (id, text) => host.taskAgents.steer(id, text) }, agentId);
            return true;

        case 'officeDiff':
            await showAgentDiff(findAgent(agentId));
            return true;

        case 'officeWorktree':
            await openAgentWorktree(findAgent(agentId));
            return true;

        case 'officeRetry': {
            // Fills the launcher rather than relaunching. A failed run failed for a reason,
            // and a one-click repeat of the identical request is most often a second
            // identical failure that also costs money.
            const failed = retryPrompt(findAgent(agentId));
            if (failed) webview.postMessage({ type: 'officePrefill', value: failed });
            return true;
        }

        case 'officeReadPlan': {
            const plan = host.artifacts.list()
                .find(a => a.runId === data.value?.runId && a.type === 'plan');
            if (plan) await host.artifacts.open(plan);
            else vscode.window.showInformationMessage(
                'This run has not written a plan artifact yet. The Review tab lists everything it has produced.');
            return true;
        }

        case 'openSettings':
            await vscode.commands.executeCommand('black-ide.openSettings');
            return true;
    }

    return false;
}
