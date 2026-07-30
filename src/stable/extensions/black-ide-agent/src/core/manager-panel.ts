import * as vscode from 'vscode';
import { SecretManager } from './secret-manager';
import { PipelineRunSummary } from './pipeline-runs';

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
}

export class ManagerPanel {
    private _panel?: vscode.WebviewPanel;

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
                case 'loadLlmConfig': {
                    const config = await this._secretManager.getKey('llm-config');
                    this._panel.webview.postMessage({ type: 'setLlmConfig', value: config });
                    break;
                }
            }
        });

        this._panel.onDidDispose(() => {
            this._panel = undefined;
        }, null, this._context.subscriptions);
    }
}
