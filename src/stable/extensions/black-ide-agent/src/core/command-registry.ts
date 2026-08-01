import * as vscode from 'vscode';
import * as path from 'path';
import { SecretManager } from './secret-manager';
import { InlineChatController } from './inline-chat-controller';
import { browserRuntimeAvailable } from '../tools/browser-capability';
import { installBrowserSupport } from '../tools/browser-install';
import { installSkillPacks, listBundledPacks } from '../tools/skill-install';
import { CRAWL_DEFAULTS, DocsStore, crawlDocs, suggestDocSets } from './docs-index';

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
    /** Detected stacks, for suggesting doc sets to crawl (Phase 3, M20). */
    detectedStacks?(): Promise<string[]>;
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
    /** Where `@docs` sets are stored (Phase 3, M20). */
    docsStore?: DocsStore,
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

    // ── @docs sets (Phase 3, M20) ───────────────────────────────────────────
    //
    // Crawling somebody else's site is an explicit, user-initiated act, never something
    // that happens because a stack was detected: the profiler *suggests*, the user
    // confirms. A network fetch triggered by opening a project would be a surprise, and a
    // surprise involving egress is the kind we have committed not to spring (G4).
    context.subscriptions.push(
        vscode.commands.registerCommand('black-ide.addDocs', async () => {
            if (!docsStore) { vscode.window.showErrorMessage('Docs indexing is unavailable in this window.'); return; }

            const existing = await docsStore.list();
            const stacks = (await host.detectedStacks?.()) || [];
            const suggestions = suggestDocSets(stacks, existing.map(e => e.name));

            const picks: (vscode.QuickPickItem & { url?: string; name?: string })[] = [
                ...suggestions.map(s => ({ label: s.name, description: s.url, detail: 'Suggested for this project\'s detected stack', name: s.name, url: s.url })),
                { label: '$(link) Enter a URL…', description: 'Crawl any documentation site' },
            ];
            const picked = await vscode.window.showQuickPick(picks, { placeHolder: 'Choose a documentation set to index' });
            if (!picked) return;

            let url = picked.url;
            let name = picked.name;
            if (!url) {
                url = await vscode.window.showInputBox({
                    prompt: 'Documentation URL to crawl (only pages under this path are fetched)',
                    placeHolder: 'https://docs.example.com/en/stable/',
                    validateInput: (v) => /^https?:\/\//.test(v.trim()) ? undefined : 'Enter an http(s) URL',
                });
                if (!url) return;
                name = await vscode.window.showInputBox({
                    prompt: 'Name for this doc set (used as @docs:<name>)',
                    value: guessName(url),
                });
                if (!name) return;
            }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Indexing ${name} docs`, cancellable: false },
                async (progress) => {
                    const set = await crawlDocs(name!, url!, {
                        onProgress: (fetched, queued, current) => progress.report({
                            message: `${fetched}/${CRAWL_DEFAULTS.maxPages} pages · ${queued} queued · ${short(current)}`,
                        }),
                    });
                    if (!set.pages.length) {
                        vscode.window.showWarningMessage(`No readable pages found at ${url}. Nothing was saved.`);
                        return;
                    }
                    await docsStore.save(set);
                    vscode.window.showInformationMessage(`Indexed ${set.pages.length} pages as @docs:${set.name}.`);
                },
            );
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('black-ide.manageDocs', async () => {
            if (!docsStore) return;
            const sets = await docsStore.list();
            if (!sets.length) {
                const add = await vscode.window.showInformationMessage('No doc sets indexed yet.', 'Add one');
                if (add) vscode.commands.executeCommand('black-ide.addDocs');
                return;
            }
            const picked = await vscode.window.showQuickPick(
                sets.map(s => ({
                    label: s.name,
                    description: `${s.pages} pages`,
                    detail: `${s.rootUrl} — indexed ${new Date(s.crawledAt).toLocaleString()}`,
                })),
                { placeHolder: 'Select a doc set' },
            );
            if (!picked) return;
            const action = await vscode.window.showQuickPick(['Re-crawl', 'Delete'], { placeHolder: `@docs:${picked.label}` });
            if (action === 'Delete') {
                await docsStore.remove(picked.label);
                vscode.window.showInformationMessage(`Removed @docs:${picked.label}.`);
            } else if (action === 'Re-crawl') {
                const set = sets.find(s => s.name === picked.label)!;
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Re-indexing ${set.name} docs` },
                    async () => {
                        const fresh = await crawlDocs(set.name, set.rootUrl, {});
                        // Only overwrite on a *successful* crawl: replacing a good index with
                        // an empty one because the site was briefly unreachable would lose
                        // working context and look like the feature broke.
                        if (fresh.pages.length) {
                            await docsStore.save(fresh);
                            vscode.window.showInformationMessage(`Re-indexed ${fresh.pages.length} pages for @docs:${set.name}.`);
                        } else {
                            vscode.window.showWarningMessage(`Re-crawl of ${set.rootUrl} returned no pages; the existing index was kept.`);
                        }
                    },
                );
            }
        }),
    );
}

/** `https://docs.djangoproject.com/en/stable/` → `docs-djangoproject-com`. */
function guessName(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-');
    } catch {
        return 'docs';
    }
}

function short(url: string): string {
    return url.length > 60 ? url.slice(0, 57) + '…' : url;
}
