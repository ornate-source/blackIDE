import * as vscode from 'vscode';
import { SecretManager } from './secret-manager';
import { performFetchModels } from '../agent/model-fetcher';

/**
 * The ✦ Black IDE Settings webview panel.
 *
 * Extracted verbatim from the `openSettingsPanel` closure inside `activate()`
 * (Phase 0, M2). The closure variable `settingsPanel` becomes `this._panel`; every
 * read still goes through the field rather than a captured local, so a panel
 * disposed mid-`await` behaves exactly as before.
 *
 * Depends on the chat provider only through `SettingsPanelHost`, so this module
 * does not import `extension.ts` — that would be a cycle.
 */

/** The narrow slice of the chat provider this panel needs. All members are public API. */
export interface SettingsPanelHost {
    getHtmlForWebview(webview: vscode.Webview, viewType: 'chat' | 'settings' | 'manager'): string;
    readonly activeWebview: vscode.Webview | undefined;
    onSettingsSaved(): Promise<void>;
}

export class SettingsPanel {
    private _panel?: vscode.WebviewPanel;

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _secretManager: SecretManager,
        private readonly _host: SettingsPanelHost,
    ) {}

    public open(): void {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.Active);
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'black-ide-settings',
            '✦ Black IDE Settings',
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

        this._panel.webview.html = this._host.getHtmlForWebview(this._panel.webview, 'settings');

        // Settings changes must reach both surfaces: the panel that made the edit and
        // the chat view that renders with it.
        const broadcastMessage = (message: any) => {
            if (this._host.activeWebview) {
                this._host.activeWebview.postMessage(message);
            }
            if (this._panel) {
                this._panel.webview.postMessage(message);
            }
        };

        this._panel.webview.onDidReceiveMessage(async (data: any) => {
            switch (data.type) {
                case 'showError':
                    vscode.window.showErrorMessage(data.value);
                    break;
                case 'showInfo':
                    vscode.window.showInformationMessage(data.value);
                    break;
                case 'loadLlmConfig':
                    const config = await this._secretManager.getKey('llm-config');
                    this._panel?.webview.postMessage({ type: 'setLlmConfig', value: config });
                    break;
                case 'saveLlmConfig':
                    await this._secretManager.saveKey('llm-config', data.value);
                    vscode.window.showInformationMessage(`LLM Configuration saved successfully!`);
                    broadcastMessage({ type: 'setLlmConfig', value: data.value });
                    break;
                case 'loadSettings':
                    {
                        const settingsJson = await this._secretManager.getKey('general-settings');
                        this._panel?.webview.postMessage({
                            type: 'setSettings',
                            value: settingsJson
                        });
                    }
                    break;
                case 'openEditorSettings':
                    vscode.commands.executeCommand('workbench.action.openSettings');
                    break;
                case 'openExtensions':
                    vscode.commands.executeCommand('workbench.action.showExtensions');
                    break;
                case 'installBrowserSupport':
                    vscode.commands.executeCommand('black-ide.installBrowserSupport');
                    break;
                case 'saveSettings':
                    await this._secretManager.saveKey('general-settings', data.value);
                    broadcastMessage({ type: 'setSettings', value: data.value });
                    await this._host.onSettingsSaved();
                    break;
                case 'fetchModels':
                    try {
                        const fetched = await performFetchModels(data.value);
                        this._panel?.webview.postMessage({
                            type: 'fetchedModelsResult',
                            success: true,
                            provider: data.value?.provider,
                            value: fetched
                        });
                    } catch (err: any) {
                        this._panel?.webview.postMessage({
                            type: 'fetchedModelsResult',
                            success: false,
                            provider: data.value?.provider,
                            error: err.message || 'Discovery connection failed'
                        });
                    }
                    break;
            }
        });

        this._panel.onDidDispose(() => {
            this._panel = undefined;
        }, null, this._context.subscriptions);
    }
}
