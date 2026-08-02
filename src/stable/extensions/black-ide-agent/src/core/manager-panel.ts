import * as vscode from 'vscode';
import { SecretManager } from './secret-manager';
import { PipelineRunSummary } from './pipeline-runs';
import { TaskAgentSummary } from './task-agents';

/**
 * The ✦ Pipeline Manager webview panel — launches and monitors concurrent
 * multi-agent pipeline runs.
 *
 * Extracted verbatim from the `openManagerPanel` closure inside `activate()`
 * (Phase 0, M2). As in the original, the message handler bails out early when the
 * panel is gone and otherwise reads the panel through the field on every access,
 * preserving the original disposal semantics exactly.
 */

/** The narrow slice of the chat provider this panel needs. All members are public API. */
export interface ManagerPanelHost {
    getHtmlForWebview(webview: vscode.Webview, viewType: 'chat' | 'settings' | 'manager'): string;
    startManagedPipelineRun(prompt: string, modelId: string, managerWebview: vscode.Webview): { runId: string } | { error: string };
    cancelManagedPipelineRun(runId: string): void;
    approveManagedPipelineRun(runId: string): void;
    rejectManagedPipelineRun(runId: string): void;
    listManagedPipelineRuns(): PipelineRunSummary[];
    /** The Phase 6 lane. Typed loosely here to keep this file free of agent imports. */
    readonly taskAgents: {
        launch(prompt: string, modelId: string, mode: string | undefined, rootPath: string):
            { agent: TaskAgentSummary } | { error: string };
        cancel(id: string): void;
        apply(id: string): Promise<{ ok: true } | { error: string }>;
        discard(id: string): Promise<{ ok: true } | { error: string }>;
        list(): TaskAgentSummary[];
        startRace(prompt: string, modelIds: string[], rootPath: string): { raceId: string } | { error: string };
        steer(id: string, text: string, options?: { artifactPath?: string; region?: string }): { ok: true } | { error: string };
        raceOutcome(raceId: string): unknown;
        inbox(): unknown[];
        configureFromSettings(): Promise<void>;
    };
}

export class ManagerPanel {
    private _panel?: vscode.WebviewPanel;

    /**
     * The live panel, so background lanes can push to it without holding a reference.
     *
     * Static because the pushers (the task-agent lane's inbox poller) outlive any
     * particular panel: the panel is opened and closed by the user, while agents keep
     * running. A posted message with no panel open is dropped, which is correct — the
     * state is re-sent on mount, so nothing is lost by not being watched.
     */
    private static _live?: ManagerPanel;

    static post(message: any): void {
        ManagerPanel._live?._panel?.webview.postMessage(message);
    }

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _secretManager: SecretManager,
        private readonly _host: ManagerPanelHost,
    ) {}

    public open(): void {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.Active);
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'black-ide-pipeline-manager',
            '✦ Pipeline Manager',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this._context.extensionUri, 'dist'),
                    vscode.Uri.joinPath(this._context.extensionUri, 'resources')
                ]
            }
        );

        ManagerPanel._live = this;
        this._panel.webview.html = this._host.getHtmlForWebview(this._panel.webview, 'manager');

        this._panel.webview.onDidReceiveMessage(async (data: any) => {
            if (!this._panel) return;
            switch (data.type) {
                case 'startPipelineRun': {
                    const result = this._host.startManagedPipelineRun(data.value?.prompt || '', data.value?.modelId || '', this._panel.webview);
                    if ('error' in result) {
                        vscode.window.showWarningMessage(result.error);
                        this._panel.webview.postMessage({ type: 'pipelineRunStartFailed', value: result.error });
                    } else {
                        this._panel.webview.postMessage({ type: 'pipelineRunListSync', value: this._host.listManagedPipelineRuns() });
                    }
                    break;
                }
                case 'cancelPipelineRun':
                    this._host.cancelManagedPipelineRun(data.value?.runId);
                    break;
                case 'approvePipelineRun':
                    this._host.approveManagedPipelineRun(data.value?.runId);
                    break;
                case 'rejectPipelineRun':
                    this._host.rejectManagedPipelineRun(data.value?.runId);
                    this._panel.webview.postMessage({ type: 'pipelineRunListSync', value: this._host.listManagedPipelineRuns() });
                    break;
                case 'listPipelineRuns':
                    // Sent on mount — repopulates the panel with in-flight/completed runs
                    // if it was closed and reopened while the extension host stayed alive.
                    this._panel.webview.postMessage({ type: 'pipelineRunListSync', value: this._host.listManagedPipelineRuns() });
                    break;
                // ── Task agents (Phase 6) ───────────────────────────────────
                case 'startTaskAgent': {
                    await this._host.taskAgents.configureFromSettings();
                    const root = data.value?.rootPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                    const result = this._host.taskAgents.launch(data.value?.prompt || '', data.value?.modelId || '', data.value?.mode, root);
                    if ('error' in result) vscode.window.showWarningMessage(result.error);
                    this._panel.webview.postMessage({ type: 'taskAgentListSync', value: this._host.taskAgents.list() });
                    break;
                }
                case 'cancelTaskAgent':
                    this._host.taskAgents.cancel(data.value?.agentId);
                    break;
                case 'applyTaskAgent': {
                    const result = await this._host.taskAgents.apply(data.value?.agentId);
                    if ('error' in result) vscode.window.showErrorMessage(result.error);
                    else vscode.window.showInformationMessage('Applied the agent\'s changes to your workspace.');
                    this._panel.webview.postMessage({ type: 'taskAgentListSync', value: this._host.taskAgents.list() });
                    break;
                }
                case 'discardTaskAgent': {
                    const result = await this._host.taskAgents.discard(data.value?.agentId);
                    if ('error' in result) vscode.window.showErrorMessage(result.error);
                    this._panel.webview.postMessage({ type: 'taskAgentListSync', value: this._host.taskAgents.list() });
                    break;
                }
                case 'startModelRace': {
                    await this._host.taskAgents.configureFromSettings();
                    const root = data.value?.rootPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                    const result = this._host.taskAgents.startRace(data.value?.prompt || '', data.value?.modelIds || [], root);
                    if ('error' in result) vscode.window.showWarningMessage(result.error);
                    this._panel.webview.postMessage({ type: 'taskAgentListSync', value: this._host.taskAgents.list() });
                    break;
                }
                // ── Mid-run steering (Phase 7, M39) ─────────────────────────
                case 'steerAgent': {
                    const result = this._host.taskAgents.steer(
                        data.value?.agentId || '',
                        data.value?.text || '',
                        { artifactPath: data.value?.artifactPath, region: data.value?.region },
                    );
                    if ('error' in result) vscode.window.showWarningMessage(result.error);
                    else vscode.window.setStatusBarMessage('Correction queued — it reaches the agent on its next turn.', 4000);
                    break;
                }
                case 'raceOutcome':
                    this._panel.webview.postMessage({
                        type: 'raceOutcomeSync',
                        value: this._host.taskAgents.raceOutcome(data.value?.raceId),
                    });
                    break;
                case 'listTaskAgents':
                    this._panel.webview.postMessage({ type: 'taskAgentListSync', value: this._host.taskAgents.list() });
                    this._panel.webview.postMessage({ type: 'agentInboxSync', value: { items: this._host.taskAgents.inbox() } });
                    break;
                case 'loadLlmConfig': {
                    const config = await this._secretManager.getKey('llm-config');
                    this._panel.webview.postMessage({ type: 'setLlmConfig', value: config });
                    break;
                }
            }
        });

        this._panel.onDidDispose(() => {
            this._panel = undefined;
            if (ManagerPanel._live === this) ManagerPanel._live = undefined;
        }, null, this._context.subscriptions);
    }
}
