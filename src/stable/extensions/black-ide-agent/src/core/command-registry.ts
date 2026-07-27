import * as vscode from 'vscode';
import * as path from 'path';
import { SecretManager } from './secret-manager';
import { InlineChatController } from './inline-chat-controller';
import { browserRuntimeAvailable } from '../tools/browser-capability';
import { installBrowserSupport } from '../tools/browser-install';
import { installSkillPacks, listBundledPacks } from '../tools/skill-install';

/**
 * Registration of every `black-ide.*` command contributed by the extension.
 *
 * Extracted verbatim from `activate()` (Phase 0, M2). Each handler keeps its
 * original body; the only change is that the closure variables `provider`,
 * `openSettingsPanel` and `openManagerPanel` arrive as explicit parameters.
 *
 * The command IDs here must stay in sync with `contributes.commands` in
 * package.json — a command registered without being contributed is invisible in
 * the palette, and one contributed without being registered throws when invoked.
 */

/** The narrow slice of the chat provider the commands need. All members are public API. */
export interface CommandHost {
    generateCommitMessage(): Promise<void>;
    exportDiagnostics(): Promise<void>;
}

export interface CommandPanels {
    openSettingsPanel(): void;
    openManagerPanel(): void;
}

export function registerCommands(
    context: vscode.ExtensionContext,
    secretManager: SecretManager,
    host: CommandHost,
    panels: CommandPanels,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('black-ide.openSettings', async () => {
            const selection = await vscode.window.showQuickPick([
                { label: '✦ Black IDE Settings', description: 'Configure AI agents, models, permissions' },
                { label: '⚙️ Editor Settings', description: 'Open native VS Code settings' },
                { label: '🧩 Extensions', description: 'Manage installed extensions' }
            ], {
                placeHolder: 'Select a setting option to open'
            });

            if (selection) {
                if (selection.label.includes('Black IDE Settings')) {
                    panels.openSettingsPanel();
                } else if (selection.label.includes('Editor Settings')) {
                    vscode.commands.executeCommand('workbench.action.openSettings');
                } else if (selection.label.includes('Extensions')) {
                    vscode.commands.executeCommand('workbench.action.showExtensions');
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('black-ide.generateCommitMessage', async () => {
            await host.generateCommitMessage();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('black-ide.inlineEdit', async () => {
            await InlineChatController.start(context, secretManager);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('black-ide.openPipelineManager', () => {
            panels.openManagerPanel();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('black-ide.exportDiagnostics', () => {
            host.exportDiagnostics();
        })
    );

    // Opt-in browser support (Option B): Playwright is not bundled, so the browser_* tools
    // stay hidden until this installs it into the extension's node_modules. Progress streams
    // to a dedicated output channel; on success the tools become available to new tasks.
    context.subscriptions.push(
        vscode.commands.registerCommand('black-ide.installBrowserSupport', async () => {
            if (browserRuntimeAvailable()) {
                vscode.window.showInformationMessage('Browser support is already installed. Enable it in Settings → Browser.');
                return;
            }
            const channel = vscode.window.createOutputChannel('Black IDE — Browser Support');
            channel.show(true);
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Installing browser support (Playwright + Chromium)…', cancellable: false },
                    () => installBrowserSupport(context.extensionUri.fsPath, (line) => channel.appendLine(line)),
                );
                vscode.window.showInformationMessage('Browser support installed. Enable it in Settings → Browser, then start a new task.');
            } catch (e: any) {
                channel.appendLine(`\nInstall failed: ${e?.message || e}`);
                vscode.window.showErrorMessage(`Browser support install failed: ${e?.message || e}. See the "Black IDE — Browser Support" output for details.`);
            }
        })
    );

    // Materialize built-in skill packs into <repo>/.blackide/skills/ so users can see, edit, and
    // override them — and so their own project packs live in the same place (Phase 3).
    context.subscriptions.push(
        vscode.commands.registerCommand('black-ide.installSkillPacks', async () => {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!root) { vscode.window.showErrorMessage('Open a workspace folder first.'); return; }
            const bundledDir = path.join(context.extensionUri.fsPath, 'resources', 'skills');
            const packs = listBundledPacks(bundledDir);
            if (!packs.length) { vscode.window.showWarningMessage('No built-in skill packs are bundled.'); return; }

            const picked = await vscode.window.showQuickPick(
                packs.map(p => ({ label: p.name, description: [p.roles.join('/'), p.stacks.join(', ')].filter(Boolean).join(' · '), detail: p.description, picked: true })),
                { canPickMany: true, placeHolder: 'Select skill packs to install into .blackide/skills/ (already-present packs are skipped)' }
            );
            if (!picked || !picked.length) return;
            const installed = installSkillPacks(bundledDir, root, picked.map(p => p.label));
            vscode.window.showInformationMessage(
                installed.length
                    ? `Installed ${installed.length} skill pack(s) into .blackide/skills/: ${installed.join(', ')}. Edit them there to customize.`
                    : 'Selected packs already exist in .blackide/skills/ — nothing overwritten.'
            );
        })
    );
}
