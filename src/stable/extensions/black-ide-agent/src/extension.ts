import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ─── Module Imports ─────────────────────────────────────────────────────────
import { SecretManager } from './core/secret-manager';
import { LLMClient, supportsNativeTools } from './core/llm-client';
import { AgentMode, LLMConfigEntry, ChatMessage, ToolCall, ToolResult } from './core/types';
import { TokenTracker } from './core/token-tracker';
import { BlackIdeInlineCompletionProvider } from './core/inline-completion';
import { InlineChatController } from './core/inline-chat-controller';
import { toolsForMode, renderToolDocs } from './core/tools';
import { PipelineOrchestrator, buildPipelineContextSummary, isOverTokenBudget } from './agent/pipeline-orchestrator';
import { CheckpointManager, diffStat } from './core/checkpoint-manager';
import { CommandPolicy } from './core/command-policy';
import { CodebaseIndex } from './core/codebase-index';
import { EventBus } from './core/event-bus';
import { TelemetrySink } from './core/telemetry-sink';
import { PipelineRunSummary, reconcileInterruptedRuns, capRunHistory, mergeRunViews } from './core/pipeline-runs';
import { KnowledgeBase, summarizeRepoStructure } from './core/knowledge-base';
import { SessionManager, TaskEmitter } from './core/session-manager';
import { PromptBuilder } from './core/prompt-builder';
import { ContextManager } from './core/context-manager';
import { ToolRunner } from './tools/tool-runner';
import { gitMutex } from './agent/git-mutex';
import { resolveOutputMode, buildPrCommands, compareUrlFallback, shellQuote } from './core/git-pr';
import { summarizeRequest, formatReleaseNotes, formatChangelogEntry, prependChangelogEntry } from './core/completion-docs';
import { DiffContentProvider } from './tools/diff-provider';
import { BrowserTool } from './tools/browser-tool';
import { readBrowserSettings, browserRuntimeAvailable, isBrowserUsable, filterToolsForBrowser } from './tools/browser-capability';
import { installBrowserSupport } from './tools/browser-install';
import { MCPClient } from './tools/mcp-client';
import { HistoryStore } from './memory/history-store';
import { KnowledgeStore } from './memory/knowledge-store';
import { ModeLoader } from './core/mode-loader';
import { performFetchModels } from './agent/model-fetcher';
import { PlanningEngine } from './agent/planning-engine';
import { SkillsManager } from './agent/skills-manager';
import { ArtifactManager } from './agent/artifact-manager';
import { AgentScheduler } from './agent/scheduler';
import { AgentHooks } from './agent/hooks';
import { AgentToolExecutor, ApprovalRequest, ExecutorDeps, readAttachments } from './agent/tool-executor';
import { runAgentLoop } from './agent/agent-loop';
import { worktreeManager } from './agent/worktree-manager';

// ─── Extension Activation ───────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    console.log('Black IDE Agent active!');

    const secretManager = new SecretManager(context.secrets);
    const historyStore = new HistoryStore(context.workspaceState);

    let settingsPanel: vscode.WebviewPanel | undefined = undefined;

    function openSettingsPanel() {
        if (settingsPanel) {
            settingsPanel.reveal(vscode.ViewColumn.Active);
            return;
        }

        settingsPanel = vscode.window.createWebviewPanel(
            'black-ide-settings',
            '✦ Black IDE Settings',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'dist'),
                    vscode.Uri.joinPath(context.extensionUri, 'resources')
                ]
            }
        );

        settingsPanel.webview.html = provider.getHtmlForWebview(settingsPanel.webview, 'settings');

        const broadcastMessage = (message: any) => {
            if (provider.activeWebview) {
                provider.activeWebview.postMessage(message);
            }
            if (settingsPanel) {
                settingsPanel.webview.postMessage(message);
            }
        };

        settingsPanel.webview.onDidReceiveMessage(async (data: any) => {
            switch (data.type) {
                case 'showError':
                    vscode.window.showErrorMessage(data.value);
                    break;
                case 'showInfo':
                    vscode.window.showInformationMessage(data.value);
                    break;
                case 'loadLlmConfig':
                    const config = await secretManager.getKey('llm-config');
                    settingsPanel?.webview.postMessage({ type: 'setLlmConfig', value: config });
                    break;
                case 'saveLlmConfig':
                    await secretManager.saveKey('llm-config', data.value);
                    vscode.window.showInformationMessage(`LLM Configuration saved successfully!`);
                    broadcastMessage({ type: 'setLlmConfig', value: data.value });
                    break;
                case 'loadSettings':
                    {
                        const settingsJson = await secretManager.getKey('general-settings');
                        settingsPanel?.webview.postMessage({
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
                    await secretManager.saveKey('general-settings', data.value);
                    broadcastMessage({ type: 'setSettings', value: data.value });
                    await provider.onSettingsSaved();
                    break;
                case 'fetchModels':
                    try {
                        const fetched = await performFetchModels(data.value);
                        settingsPanel?.webview.postMessage({
                            type: 'fetchedModelsResult',
                            success: true,
                            provider: data.value?.provider,
                            value: fetched
                        });
                    } catch (err: any) {
                        settingsPanel?.webview.postMessage({
                            type: 'fetchedModelsResult',
                            success: false,
                            provider: data.value?.provider,
                            error: err.message || 'Discovery connection failed'
                        });
                    }
                    break;
            }
        });

        settingsPanel.onDidDispose(() => {
            settingsPanel = undefined;
        }, null, context.subscriptions);
    }

    let managerPanel: vscode.WebviewPanel | undefined = undefined;

    function openManagerPanel() {
        if (managerPanel) {
            managerPanel.reveal(vscode.ViewColumn.Active);
            return;
        }

        managerPanel = vscode.window.createWebviewPanel(
            'black-ide-pipeline-manager',
            '✦ Pipeline Manager',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'dist'),
                    vscode.Uri.joinPath(context.extensionUri, 'resources')
                ]
            }
        );

        managerPanel.webview.html = provider.getHtmlForWebview(managerPanel.webview, 'manager');

        managerPanel.webview.onDidReceiveMessage(async (data: any) => {
            if (!managerPanel) return;
            switch (data.type) {
                case 'startPipelineRun': {
                    const result = provider.startManagedPipelineRun(data.value?.prompt || '', data.value?.modelId || '', managerPanel.webview);
                    if ('error' in result) {
                        vscode.window.showWarningMessage(result.error);
                        managerPanel.webview.postMessage({ type: 'pipelineRunStartFailed', value: result.error });
                    } else {
                        managerPanel.webview.postMessage({ type: 'pipelineRunListSync', value: provider.listManagedPipelineRuns() });
                    }
                    break;
                }
                case 'cancelPipelineRun':
                    provider.cancelManagedPipelineRun(data.value?.runId);
                    break;
                case 'approvePipelineRun':
                    provider.approveManagedPipelineRun(data.value?.runId);
                    break;
                case 'rejectPipelineRun':
                    provider.rejectManagedPipelineRun(data.value?.runId);
                    managerPanel.webview.postMessage({ type: 'pipelineRunListSync', value: provider.listManagedPipelineRuns() });
                    break;
                case 'listPipelineRuns':
                    // Sent on mount — repopulates the panel with in-flight/completed runs
                    // if it was closed and reopened while the extension host stayed alive.
                    managerPanel.webview.postMessage({ type: 'pipelineRunListSync', value: provider.listManagedPipelineRuns() });
                    break;
                case 'loadLlmConfig': {
                    const config = await secretManager.getKey('llm-config');
                    managerPanel.webview.postMessage({ type: 'setLlmConfig', value: config });
                    break;
                }
            }
        });

        managerPanel.onDidDispose(() => {
            managerPanel = undefined;
        }, null, context.subscriptions);
    }

    const provider = new BlackIdeChatProvider(context, secretManager, historyStore, () => openSettingsPanel());

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            BlackIdeChatProvider.viewType,
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' },
            new BlackIdeInlineCompletionProvider(secretManager)
        )
    );

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
                    openSettingsPanel();
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
            await provider.generateCommitMessage();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('black-ide.inlineEdit', async () => {
            await InlineChatController.start(context, secretManager);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('black-ide.openPipelineManager', () => {
            openManagerPanel();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('black-ide.exportDiagnostics', () => {
            provider.exportDiagnostics();
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
}

export function deactivate() {}

/** One concurrently-running (or completed) pipeline instance tracked by the Manager panel. */
// The live in-memory record: the serializable PipelineRunSummary (see core/pipeline-runs.ts)
// plus the non-serializable runtime handles that die with the extension host.
interface PipelineRunRecord extends PipelineRunSummary {
    abortController: AbortController;
    pendingApproval?: {
        planContent: string;
        planPath: string;
        resolve: (approved: boolean) => void;
    };
}

// ─── Webview View Provider & Main Extension Bridge ──────────────────────────

class BlackIdeChatProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'black-ide-chat-view';
    private _view?: vscode.WebviewView;
    private _abortController?: AbortController;
    private _isGenerating = false;
    private readonly _scheduler = new AgentScheduler();

    // Infrastructure lives for the whole session, not one task. Checkpoints and the
    // codebase index are only useful if they outlive the run that created them.
    private readonly _bus = new EventBus();
    private readonly _sessions: SessionManager;
    private readonly _checkpoints: CheckpointManager;
    private readonly _index: CodebaseIndex;
    private readonly _modeLoader: ModeLoader;
    private readonly _subagentAbortControllers = new Map<string, AbortController>();

    /** Prior turns, replayed into each task so the agent remembers the conversation. */
    private _conversation: ChatMessage[] = [];
    /** Active thread identity, used to key conversation persistence in Memento. */
    private _activeThreadId: string = 'default';

    /** Pending plan approval state — survives between the two loop invocations (Antigravity pattern). */
    private _pendingApproval: {
        planContent: string;
        taskContent: string;
        planPath: string;
        taskPath: string;
        originalPrompt: string;
        modelId: string;
        attachments?: any[];
        mode?: string;
    } | null = null;

    /**
     * Pending pipeline-plan approval — mirrors _pendingApproval's role but for
     * PipelineOrchestrator.run(), which is awaiting a live Promise<boolean> rather
     * than being safe to simply re-invoke. Only survives an extension-host restart
     * as poorly as the native dialog it replaced did; a webview-only reload is fine
     * since the resolver reference stays alive in this class instance.
     */
    private _pendingPipelineApproval: {
        planContent: string;
        planPath: string;
        resolve: (approved: boolean) => void;
    } | null = null;

    /**
     * Concurrent pipeline runs started from the Manager panel — a separate concurrency
     * lane from the chat sidebar's single _abortController/_isGenerating/
     * _pendingPipelineApproval, keyed by runId, mirroring the existing
     * _subagentAbortControllers Map pattern. In-memory only, like _managerPanel itself:
     * doesn't survive an extension-host restart, same limitation _pendingPipelineApproval
     * already has.
     */
    private readonly _pipelineRuns = new Map<string, PipelineRunRecord>();
    private _managerPanel?: vscode.WebviewPanel;
    private static readonly MAX_CONCURRENT_PIPELINE_RUNS = 4;

    /**
     * Durable, reload-surviving history of Manager pipeline runs (serializable summaries),
     * persisted to globalState. Loaded and reconciled in the constructor so runs a reload
     * interrupted show as 'failed' rather than ghost 'running'. The live _pipelineRuns Map
     * is the source of truth for the CURRENT session; this is everything before it.
     */
    private _runHistory: PipelineRunSummary[] = [];
    private static readonly RUN_HISTORY_KEY = 'pipeline-run-history';

    // Local-first operational telemetry (see core/telemetry-sink.ts).
    private readonly _telemetry: TelemetrySink;
    private readonly _telemetryPath: string;
    private _telemetryEnabled = true;

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _secretManager: SecretManager,
        private readonly _historyStore: HistoryStore,
        private readonly _onOpenSettings?: () => void
    ) {
        const storageDir = (_context.storageUri ?? _context.globalStorageUri).fsPath;
        try { fs.mkdirSync(storageDir, { recursive: true }); } catch {}

        this._sessions = new SessionManager(this._bus);
        this._checkpoints = new CheckpointManager(storageDir);
        this._index = new CodebaseIndex(storageDir);
        this._modeLoader = new ModeLoader();

        // Local-first operational telemetry — a second bus subscriber alongside the UI.
        // Setting-gated (default on, matching DEFAULT_SETTINGS) and privacy-safe by
        // construction (see telemetry-sink.ts). Refreshed from settings async below and
        // whenever settings are saved.
        this._telemetryPath = path.join(storageDir, 'telemetry', 'agent-telemetry.jsonl');
        this._telemetry = new TelemetrySink({
            filePath: this._telemetryPath,
            enabled: () => this._telemetryEnabled,
        });
        this._refreshTelemetryEnabled();

        // The single place the runtime meets the UI. Every subsystem publishes to the
        // bus; the webview is just one subscriber, so adding a consumer (telemetry, a
        // log file) never means threading a callback through the agent loop again.
        this._bus.onAny((event) => {
            this._view?.webview.postMessage({ type: 'agentEvent', value: event });
            this._telemetry.record(event);
        });

        // Reload any Manager pipeline runs from a prior window and flip ones the reload
        // interrupted to a terminal 'failed' state, so they don't linger as ghost
        // "running" rows (durability — see _reconcilePersistedRuns).
        this._runHistory = reconcileInterruptedRuns(
            this._context.globalState.get<PipelineRunSummary[]>(BlackIdeChatProvider.RUN_HISTORY_KEY) || []
        );

        // Seed the knowledge base's architecture.md from a first-run repo scan, so the
        // read side (KnowledgeBase.readContext) has real content to inject on the very
        // first task instead of an empty header. Fire-and-forget: nothing about activation
        // should wait on, or fail because of, a best-effort scan.
        void this._seedArchitectureOnce();
    }

    /** globalState key prefix for the once-per-workspace discovery scan. */
    private static readonly ARCH_SCAN_KEY = 'blackIde.architectureScan';

    /**
     * One-time repository-discovery scan per workspace (P1). Guarded three ways, because
     * this runs unprompted on activation: a globalState flag so it runs once, an unseeded
     * check so it can never overwrite human or agent edits, and a total try/catch so a
     * scan failure can never break activation.
     */
    private async _seedArchitectureOnce(): Promise<void> {
        try {
            const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!rootPath) return;

            const key = `${BlackIdeChatProvider.ARCH_SCAN_KEY}:${rootPath}`;
            if (this._context.globalState.get<boolean>(key)) return;

            const kb = new KnowledgeBase(rootPath);
            // Check before scanning — the scan is the expensive part and is pointless if
            // architecture.md already says something.
            if (!kb.isArchitectureUnseeded()) {
                await this._context.globalState.update(key, true);
                return;
            }

            const uris = await vscode.workspace.findFiles(
                '**/*',
                '**/{node_modules,.git,dist,out,build,.next,coverage,vendor}/**',
                4000
            );
            if (uris.length === 0) return; // empty/unopened workspace — try again next time

            let pkgJson: any;
            try { pkgJson = JSON.parse(fs.readFileSync(path.join(rootPath, 'package.json'), 'utf8')); } catch {}

            kb.ensureScaffold();
            if (kb.scaffoldArchitecture(summarizeRepoStructure(uris.map(u => vscode.workspace.asRelativePath(u)), pkgJson))) {
                // console, not the event bus: bus envelopes carry session/task metadata that
                // does not exist at activation time, and no run is in flight to attribute to.
                console.log(`[Knowledge] Seeded architecture.md from a scan of ${uris.length} files.`);
            }
            await this._context.globalState.update(key, true);
        } catch { /* best-effort; the knowledge base must never break activation */ }
    }

    /** Reads the anonymous-telemetry toggle from settings into the cached flag. */
    private async _refreshTelemetryEnabled(): Promise<void> {
        try {
            const s = await this._secretManager.getKey('general-settings');
            if (s) this._telemetryEnabled = JSON.parse(s).allowAnonymousTelemetry !== false;
        } catch { /* keep the default */ }
    }

    public get activeWebview(): vscode.Webview | undefined {
        return this._view?.webview;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri]
        };

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview, 'chat');

        // Restore conversation context from last session so multi-turn memory survives reload
        this._conversation = this._historyStore.getConversationState(this._activeThreadId) || [];

        // Broadcast persisted checkpoints so the timeline is visible immediately after reload
        this._postCheckpoints(webviewView.webview);

        // Initialize Custom Modes
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const globalConfigPath = path.join(os.homedir(), '.blackide');
        
        // Only user-selectable modes reach the picker — internal pipeline-phase modes
        // (HLD/LLD/Planner) stay hidden from the chat mode dropdown.
        this._modeLoader.loadAll(rootPath, globalConfigPath).then(() => {
            webviewView.webview.postMessage({ type: 'modesLoaded', value: this._modeLoader.getSelectableModes() });
        });

        this._modeLoader.watchForChanges(rootPath, () => {
            webviewView.webview.postMessage({ type: 'modesLoaded', value: this._modeLoader.getSelectableModes() });
        });

        // Restore pending plan approval if it survived a window reload (Antigravity pattern)
        try {
            const pendingRaw = this._historyStore.getConversationState(`pending-plan-${this._activeThreadId}`);
            if (pendingRaw && pendingRaw.length > 0) {
                const pending = JSON.parse(pendingRaw[0].content);
                this._pendingApproval = pending;
                // Re-post the plan approval card to the webview
                webviewView.webview.postMessage({
                    type: 'planApprovalRequested',
                    value: {
                        planContent: pending.planContent,
                        taskContent: pending.taskContent,
                        planPath: pending.planPath,
                        taskPath: pending.taskPath,
                    }
                });
            }
        } catch {}

        // Receive commands from Webview (bridge)
        webviewView.webview.onDidReceiveMessage(async (data: any) => {
            switch (data.type) {
                case 'openSettingsPanel':
                    if (this._onOpenSettings) {
                        this._onOpenSettings();
                    }
                    break;
                case 'showError':
                    vscode.window.showErrorMessage(data.value);
                    break;
                case 'showInfo':
                    vscode.window.showInformationMessage(data.value);
                    break;
                case 'loadLlmConfig':
                    const config = await this._secretManager.getKey('llm-config');
                    webviewView.webview.postMessage({ type: 'setLlmConfig', value: config });
                    break;
                case 'saveLlmConfig':
                    await this._secretManager.saveKey('llm-config', data.value);
                    vscode.window.showInformationMessage(`LLM Configuration saved successfully!`);
                    webviewView.webview.postMessage({ type: 'llmConfigSaved', success: true });
                    break;
                case 'loadSettings':
                    {
                        const settingsJson = await this._secretManager.getKey('general-settings');
                        webviewView.webview.postMessage({
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
                case 'saveSettings':
                    await this._secretManager.saveKey('general-settings', data.value);
                    // Pick up an anonymous-telemetry toggle without needing a restart.
                    await this._refreshTelemetryEnabled();
                    break;
                case 'exportDiagnostics':
                    await this.exportDiagnostics();
                    break;
                case 'installBrowserSupport':
                    vscode.commands.executeCommand('black-ide.installBrowserSupport');
                    break;
                case 'fetchModels':
                    try {
                        const fetched = await performFetchModels(data.value);
                        webviewView.webview.postMessage({
                            type: 'fetchedModelsResult',
                            success: true,
                            provider: data.value?.provider,
                            value: fetched
                        });
                    } catch (err: any) {
                        webviewView.webview.postMessage({
                            type: 'fetchedModelsResult',
                            success: false,
                            provider: data.value?.provider,
                            error: err.message || 'Discovery connection failed'
                        });
                    }
                    break;
                case 'attachFile':
                    const fileUris = await vscode.window.showOpenDialog({
                        canSelectMany: false,
                        openLabel: 'Attach',
                        filters: {
                            'All Files': ['*'],
                            'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
                            'Documents': ['md', 'txt', 'pdf', 'json', 'yaml', 'yml'],
                        }
                    });
                    if (fileUris && fileUris.length > 0) {
                        const uri = fileUris[0];
                        const fileName = path.basename(uri.fsPath);
                        const ext = path.extname(fileName).toLowerCase();
                        const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext);
                        webviewView.webview.postMessage({
                            type: 'fileAttached',
                            value: {
                                name: fileName,
                                path: uri.fsPath,
                                type: isImage ? 'image' : 'file',
                            }
                        });
                    }
                    break;
                case 'startAgentTask':
                    // Guard: block new messages while a plan is pending review
                    if (this._pendingApproval || this._pendingPipelineApproval) {
                        vscode.window.showWarningMessage('A plan is pending review. Please approve or reject it before sending a new message.');
                        break;
                    }
                    // Intercept slash commands — Feature 7: Enhanced slash commands
                    let modifiedPrompt = data.prompt || '';
                    if (modifiedPrompt.startsWith('/explain')) {
                        const codeContext = await this._getActiveEditorSelectionContext();
                        modifiedPrompt = `Explain the following code block:\n\n\`\`\`\n${codeContext}\n\`\`\`\n\nUser Question: ${modifiedPrompt.replace('/explain', '').trim()}`;
                    } else if (modifiedPrompt.startsWith('/test')) {
                        const codeContext = await this._getActiveEditorSelectionContext();
                        modifiedPrompt = `Write comprehensive unit tests for the following code block:\n\n\`\`\`\n${codeContext}\n\`\`\`\n\nUser Request: ${modifiedPrompt.replace('/test', '').trim()}`;
                    } else if (modifiedPrompt.startsWith('/fix')) {
                        const codeContext = await this._getActiveEditorSelectionContext();
                        modifiedPrompt = `Find bugs, issues, or compile errors in the following code block and suggest fixes:\n\n\`\`\`\n${codeContext}\n\`\`\`\n\nUser Request: ${modifiedPrompt.replace('/fix', '').trim()}`;
                    } else if (modifiedPrompt.startsWith('/commit')) {
                        await this._runAgentTask(`Generate a conventional commit message for the git diff.`, data.modelId, data.attachments, data.mode);
                        return;
                    } else if (modifiedPrompt.startsWith('/refactor')) {
                        const codeContext = await this._getActiveEditorSelectionContext();
                        modifiedPrompt = `Refactor the following code for better readability, performance, and maintainability:\n\n\`\`\`\n${codeContext}\n\`\`\`\n\nUser Request: ${modifiedPrompt.replace('/refactor', '').trim()}`;
                    } else if (modifiedPrompt.startsWith('/docs')) {
                        const codeContext = await this._getActiveEditorSelectionContext();
                        modifiedPrompt = `Generate comprehensive documentation (JSDoc/docstrings/comments) for:\n\n\`\`\`\n${codeContext}\n\`\`\`\n\n${modifiedPrompt.replace('/docs', '').trim()}`;
                    } else if (modifiedPrompt.startsWith('/search')) {
                        modifiedPrompt = `Search the workspace for: ${modifiedPrompt.replace('/search', '').trim()}. Use the grep_search tool to find relevant code.`;
                    } else if (modifiedPrompt.startsWith('/plan')) {
                        modifiedPrompt = modifiedPrompt.replace('/plan', '').trim();
                        // Planning mode will be auto-detected by PlanningEngine
                    }
                    
                    if (PlanningEngine.shouldOrchestrate(modifiedPrompt, data.mode)) {
                        modifiedPrompt = modifiedPrompt.replace('/orchestrate', '').trim();
                        await this._runPipeline(modifiedPrompt, data.modelId);
                    } else {
                        // Strip the /single opt-out marker so it never reaches the model.
                        modifiedPrompt = modifiedPrompt.replace(/^\/single\b/, '').trim();
                        await this._runAgentTask(modifiedPrompt, data.modelId, data.attachments, data.mode);
                    }
                    break;
                case 'openModeSelector':
                    const allModes = this._modeLoader.getSelectableModes();
                    const currentMode = data.value || 'agent';
                    const items = allModes.map(m => ({
                        label: `${m.icon ? `$(${m.icon}) ` : ''}${m.name}`,
                        description: m.description,
                        detail: `Source: ${m.source}`,
                        modeName: m.name.toLowerCase()
                    }));
                    
                    const selected = await vscode.window.showQuickPick(items, {
                        placeHolder: 'Select Agent Mode',
                        matchOnDescription: true
                    });
                    
                    if (selected) {
                        webviewView.webview.postMessage({ type: 'setMode', value: selected.modeName });
                    }
                    break;
                case 'stopAgentTask':
                    if (this._abortController) {
                        this._abortController.abort();
                        webviewView.webview.postMessage({ type: 'log', value: '[Agent] Cancellation requested.' });
                    }
                    break;
                case 'restoreCheckpoint': {
                    // Undo a whole task by id, or the most recent one if none is given.
                    const target = data.value?.checkpointId || this._checkpoints.latest?.id;
                    if (!target) { vscode.window.showInformationMessage('No checkpoint available to restore.'); break; }
                    this._reportUndo(this._checkpoints.undo(target), webviewView.webview);
                    break;
                }
                case 'undoMessage': {
                    // Per-message undo: revert exactly the files that one agent response changed.
                    const cp = this._checkpoints.forMessage(data.value);
                    if (!cp) { vscode.window.showInformationMessage('That response made no file changes.'); break; }
                    this._reportUndo(this._checkpoints.undo(cp.id), webviewView.webview);
                    break;
                }
                case 'redoCheckpoint': {
                    const r = this._checkpoints.redo(data.value?.checkpointId);
                    vscode.window.showInformationMessage(`Re-applied ${r.restored.length} file(s).`);
                    this._postCheckpoints(webviewView.webview);
                    break;
                }
                case 'keepFile':
                    this._checkpoints.keepFile(data.value?.checkpointId, data.value?.path);
                    this._postCheckpoints(webviewView.webview);
                    break;
                case 'restoreFile': {
                    const r = this._checkpoints.restoreFile(data.value?.checkpointId, data.value?.path);
                    this._reportUndo(r, webviewView.webview);
                    break;
                }
                case 'listCheckpoints':
                    this._postCheckpoints(webviewView.webview);
                    break;
                case 'getCheckpointDiff': {
                    const diffLines = this._checkpoints.getInlineDiffPreview(data.value?.checkpointId, data.value?.path);
                    webviewView.webview.postMessage({ 
                        type: 'checkpointDiffResult', 
                        value: { checkpointId: data.value?.checkpointId, path: data.value?.path, diff: diffLines } 
                    });
                    break;
                }
                case 'cancelSubagent': {
                    const controller = this._subagentAbortControllers.get(data.value);
                    if (controller) {
                        controller.abort();
                    }
                    break;
                }
                case 'approvePlan': {
                    if (this._pendingPipelineApproval) {
                        const pending = this._pendingPipelineApproval;
                        this._pendingPipelineApproval = null;
                        pending.resolve(true);
                        break;
                    }
                    if (!this._pendingApproval) {
                        vscode.window.showErrorMessage('No pending plan to approve.');
                        break;
                    }
                    const pending = this._pendingApproval;
                    this._pendingApproval = null;
                    // Clear persisted pending state
                    await this._historyStore.clearConversationState(`pending-plan-${this._activeThreadId}`);
                    // Run execution phase with the approved plan injected as context
                    await this._runAgentTaskExecution(
                        pending.originalPrompt,
                        pending.modelId,
                        pending.planContent,
                        pending.taskContent,
                        pending.attachments,
                        pending.mode
                    );
                    break;
                }
                case 'rejectPlan': {
                    const feedback = data.value?.feedback || '';
                    if (this._pendingPipelineApproval) {
                        const pending = this._pendingPipelineApproval;
                        this._pendingPipelineApproval = null;
                        pending.resolve(false);
                        webviewView.webview.postMessage({ type: 'planRejected', value: feedback });
                        webviewView.webview.postMessage({ type: 'taskComplete' });
                        vscode.window.showInformationMessage('Pipeline plan rejected.');
                        break;
                    }
                    this._pendingApproval = null;
                    // Clear persisted pending state
                    await this._historyStore.clearConversationState(`pending-plan-${this._activeThreadId}`);
                    webviewView.webview.postMessage({ type: 'planRejected', value: feedback });
                    webviewView.webview.postMessage({ type: 'taskComplete' });
                    if (feedback) {
                        vscode.window.showInformationMessage('Plan rejected. Send a new message with revised instructions.');
                    } else {
                        vscode.window.showInformationMessage('Plan rejected.');
                    }
                    break;
                }
                case 'newConversation':
                    // A fresh thread starts with a clean memory, or the agent answers the
                    // new question in terms of the old one.
                    this._conversation = [];
                    this._activeThreadId = data.value || `thread-${Date.now()}`;
                    this._sessions.newConversation();
                    await this._historyStore.clearConversationState(this._activeThreadId);
                    break;
                case 'switchThread': {
                    // Abort any in-flight generation to prevent cross-thread contamination
                    if (this._isGenerating && this._abortController) {
                        this._abortController.abort();
                        this._isGenerating = false;
                    }
                    this._activeThreadId = data.value;
                    this._conversation = this._historyStore.getConversationState(data.value) || [];
                    this._sessions.newConversation(); // Reset session for the new thread
                    // Clear any pending plan approval to prevent cross-thread contamination
                    this._pendingApproval = null;
                    // The pipeline's approval Promise isn't tied to _abortController — resolve
                    // it as rejected so orchestrator.run() doesn't hang forever on an orphaned thread.
                    if (this._pendingPipelineApproval) {
                        this._pendingPipelineApproval.resolve(false);
                        this._pendingPipelineApproval = null;
                    }
                    break;
                }
                case 'openArtifact':
                    try {
                        const doc = await vscode.workspace.openTextDocument(data.value);
                        await vscode.window.showTextDocument(doc, { preview: false });
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Could not open artifact: ${e.message}`);
                    }
                    break;
                case 'loadHistory':
                    const threads = this._historyStore.getThreads();
                    webviewView.webview.postMessage({ type: 'setHistory', value: threads });
                    break;
                case 'saveHistoryThread':
                    const { id, title, messages } = data.value;
                    await this._historyStore.saveThread(id, title, messages);
                    webviewView.webview.postMessage({ type: 'setHistory', value: this._historyStore.getThreads() });
                    break;
                case 'deleteHistoryThread':
                    await this._historyStore.deleteThread(data.value);
                    webviewView.webview.postMessage({ type: 'setHistory', value: this._historyStore.getThreads() });
                    break;
                case 'clearHistory':
                    await this._historyStore.clear();
                    webviewView.webview.postMessage({ type: 'setHistory', value: [] });
                    break;
                case 'searchFiles':
                    const query = data.value || '';
                    const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 100);
                    const matchingFiles = files
                        .map((file: vscode.Uri) => vscode.workspace.asRelativePath(file))
                        .filter((f: string) => f.toLowerCase().includes(query.toLowerCase()))
                        .slice(0, 15);
                    webviewView.webview.postMessage({ type: 'searchFilesResponse', value: matchingFiles });
                    break;
                case 'autoDetectOllama':
                    try {
                        const ollamaResponse = await fetch('http://localhost:11434/api/tags');
                        if (ollamaResponse.ok) {
                            const ollamaData: any = await ollamaResponse.json();
                            if (ollamaData && Array.isArray(ollamaData.models)) {
                                const detectedModels = ollamaData.models.map((m: any) => ({
                                    id: `ollama-${m.name}`,
                                    name: `Ollama: ${m.name}`,
                                    type: 'local',
                                    url: 'http://localhost:11434/v1/chat/completions',
                                    model: m.name,
                                    enabled: true
                                }));
                                webviewView.webview.postMessage({ type: 'ollamaDetected', value: detectedModels });
                                vscode.window.showInformationMessage(`Successfully auto-detected ${detectedModels.length} Ollama models!`);
                            } else {
                                vscode.window.showWarningMessage('Ollama responded but returned no models.');
                            }
                        } else {
                            vscode.window.showErrorMessage('Ollama server returned an error.');
                        }
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Ollama server unreachable: ${e.message}`);
                    }
                    break;
            }
        });
    }

    /** A conflicted file is one the patch could no longer locate — say so, do not pretend. */
    private _reportUndo(result: { restored: string[]; conflicted: string[] }, webview: vscode.Webview) {
        if (result.conflicted.length) {
            vscode.window.showWarningMessage(
                `Restored ${result.restored.length} file(s). ${result.conflicted.length} could not be reverted — they changed too much since the checkpoint: ${result.conflicted.map(p => path.basename(p)).join(', ')}`
            );
        } else if (result.restored.length) {
            vscode.window.showInformationMessage(`Reverted ${result.restored.length} file(s).`);
        } else {
            vscode.window.showInformationMessage('Nothing to revert.');
        }
        this._postCheckpoints(webview);
    }

    private _postCheckpoints(webview: vscode.Webview) {
        webview.postMessage({
            type: 'setCheckpoints',
            value: this._checkpoints.list().map(c => ({
                id: c.id,
                messageId: c.messageId,
                label: c.label,
                createdAt: c.createdAt,
                files: c.files.map(f => ({
                    path: f.path,
                    relPath: f.relPath,
                    kind: f.kind,
                    stat: diffStat(f),
                    reviewState: f.reviewState,
                })),
            })),
        });
    }

    /**
     * Prune tool result content blocks to prevent Memento storage bloat.
     * Targets `msg.toolResults[].content` — ChatMessage has no 'tool' role;
     * tool results are embedded in user-role messages as ToolResult objects.
     */
    private _pruneForPersistence(messages: ChatMessage[]): ChatMessage[] {
        return messages.map(msg => {
            if (!msg.toolResults?.length) return msg;
            return {
                ...msg,
                toolResults: msg.toolResults.map(tr => ({
                    ...tr,
                    content: tr.content.length > 500
                        ? tr.content.slice(0, 500) + '\n…(truncated for session memory)'
                        : tr.content,
                    // Strip binary image data — not useful in replay and massive in storage
                    images: undefined,
                })),
            };
        });
    }

    private async _getActiveEditorSelectionContext(): Promise<string> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return 'No active file open';
        const selection = editor.selection;
        const text = editor.document.getText(selection) || editor.document.getText();
        return text.slice(0, 4000);
    }

    // ─── Multi-Agent Pipeline Orchestration ─────────────────────────────
    
    /**
     * Builds the executor approval gate. Two behaviors from one place so the chat flow
     * and the pipeline flow can never drift apart on policy:
     *
     * - `interactive: true` (chat) — may raise diff/confirm modals for edits, creates,
     *   and needs-confirmation commands, exactly as the single-agent flow always has.
     * - `interactive: false` (pipeline) — never raises a modal (a Manager-panel run has
     *   no chat surface, and a 7-agent run must not stall on per-file prompts). File
     *   edits/creates are auto-allowed because execution is git-worktree-isolated and
     *   reviewed at the plan-approval gate plus the final diff; commands are still run
     *   through the user's allow/deny CommandPolicy, but a command that WOULD prompt in
     *   chat is refused-and-logged rather than silently auto-run — and `autoApprove`
     *   (auto-approve-terminal) is deliberately NOT honored here, keeping the unattended
     *   lane strictly on the allow-list.
     */
    /**
     * Records one turn's token usage and emits a TokenUsage event. Shared by the chat
     * flow and the pipeline flow so cost accounting cannot drift between them (DRY): both
     * consume the same TokenTracker heuristic and the same event shape the activity/cost
     * UI already renders. Returns the run's cumulative totals so the caller can enforce a
     * budget or drive a status bar.
     */
    private _trackAndEmitUsage(
        tokenTracker: TokenTracker,
        model: string,
        promptChars: number,
        response: string,
        emit: (e: any) => void,
    ): { turnTokens: number; totalTokens: number; totalCost: number; summary: ReturnType<TokenTracker['getSessionSummary']> } {
        const usage = tokenTracker.track(model, 'x'.repeat(Math.min(promptChars, 2_000_000)), response);
        const summary = tokenTracker.getSessionSummary();
        const cachedInput = (summary as any).cachedInput;
        emit({
            type: 'TokenUsage',
            inputTokens: summary.totalInput,
            outputTokens: summary.totalOutput,
            ...(cachedInput ? { cachedInputTokens: cachedInput } : {}),
            cost: summary.totalCost,
            turns: summary.turns,
        });
        return {
            turnTokens: usage.inputTokens + usage.outputTokens,
            totalTokens: summary.totalInput + summary.totalOutput,
            totalCost: summary.totalCost,
            summary,
        };
    }

    private _buildApprovalGate(opts: {
        settings: any;
        interactive: boolean;
        log: (m: string) => void;
    }): (req: ApprovalRequest) => Promise<boolean> {
        const { settings, interactive, log } = opts;
        const autoEdits = !!settings.autoApproveFileEdits;
        const autoCreate = !!settings.autoApproveFileCreate;
        const commandPolicy = new CommandPolicy({
            allow: settings.commandAllowList,
            deny: settings.commandDenyList,
            autoApprove: interactive ? !!settings.autoApproveTerminal : false,
        });

        return async (req: ApprovalRequest): Promise<boolean> => {
            if (req.kind === 'edit') {
                if (autoEdits || !interactive) return true;
                const a = await DiffContentProvider.showDiff(req.originalContent || '', req.updatedContent || '', req.path || 'file');
                return a === 'Apply';
            }
            if (req.kind === 'create') {
                if (autoCreate || !interactive) return true;
                const a = await DiffContentProvider.showDiff(req.originalContent || '', req.updatedContent || '', req.path || 'new file');
                return a === 'Apply';
            }
            if (req.kind === 'exec') {
                const verdict = commandPolicy.evaluate(req.command || '');
                if (verdict.decision === 'deny') { log(`[Policy] ${verdict.reason} (${req.command})`); return false; }
                if (verdict.decision === 'allow') return true;
                if (!interactive) { log(`[Policy] Command needs confirmation — refused in unattended pipeline run: ${req.command}`); return false; }
                const a = await vscode.window.showWarningMessage(`Run command?\n\n${req.command}`, { modal: true }, 'Run');
                return a === 'Run';
            }
            if (req.kind === 'mcp') {
                if (!interactive) { log(`[Policy] MCP tool "${req.toolName}" refused in unattended pipeline run.`); return false; }
                const a = await vscode.window.showInformationMessage(`Allow MCP tool "${req.toolName}"?`, 'Allow', 'Deny');
                return a === 'Allow';
            }
            return false;
        };
    }

    /**
     * The chat-triggered pipeline entry point. Owns everything specific to running
     * inside the main chat sidebar: the shared `_abortController`/`_isGenerating`
     * singleton state, the session/event-bus `emit` path (which broadcasts to
     * `this._view` — see the constructor's `_bus.onAny`), and `_pendingPipelineApproval`.
     * Delegates the actual pipeline mechanics to `_runPipelineCore`, which is also used
     * by Manager-panel-initiated runs (see `_runPipelineInManager`).
     */
    private async _runPipeline(userPrompt: string, modelId: string) {
        if (!this._view) return;
        const webview = this._view.webview;

        this._abortController?.abort();
        const controller = new AbortController();
        this._abortController = controller;
        this._isGenerating = true;

        // Resolved again inside _runPipelineCore for the actual run — this lookup is
        // only to preserve the exact prior beginTask() label (the model's own `.model`
        // name rather than its LLMConfigEntry id) and to feed title generation below, and
        // tolerates failure since a bad modelId still surfaces as a proper thrown error
        // from the core.
        let modelLabel = modelId;
        let modelConfig: LLMConfigEntry | undefined;
        try {
            const configJson = await this._secretManager.getKey('llm-config');
            const configs: LLMConfigEntry[] = configJson ? JSON.parse(configJson) : [];
            modelConfig = configs.find(c => c.id === modelId);
            modelLabel = modelConfig?.model || modelId;
        } catch {}
        const task = this._sessions.beginTask(userPrompt, 'agent', modelLabel);
        const emit = (e: any) => task.emit(e);

        try {
            const completed = await this._runPipelineCore({
                userPrompt, modelId,
                signal: controller.signal,
                emit,
                // In-chat approval gate — reuses the same PlanApprovalRequested card and
                // approvePlan/rejectPlan handlers the single-agent flow already has,
                // instead of a blocking native dialog. See _pendingPipelineApproval.
                requestApproval: (planContent, planPath) => new Promise<boolean>((resolve) => {
                    this._pendingPipelineApproval = { planContent, planPath, resolve };
                    webview.postMessage({
                        type: 'planApprovalRequested',
                        value: {
                            planContent,
                            taskContent: 'Pipeline plans are self-contained — the Sequential Task List section above already breaks work into design/backend/frontend/testing phases.',
                            planPath,
                            taskPath: planPath,
                        }
                    });
                }),
            });

            // Give follow-up chat turns memory of what the pipeline built (spec F14).
            // Only on genuine completion — a rejected/cancelled/failed run must not
            // pollute the thread with phantom context. Manager-panel runs never reach
            // here; they are not part of any chat thread.
            if (completed) {
                try {
                    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                    const overviewPath = path.join(rootPath, '.blackIDE', 'overview.md');
                    const overviewContent = fs.existsSync(overviewPath) ? fs.readFileSync(overviewPath, 'utf8') : null;
                    this._conversation.push(
                        { role: 'user', content: userPrompt },
                        { role: 'assistant', content: buildPipelineContextSummary(overviewContent) },
                    );
                    await this._historyStore.setConversationState(
                        this._activeThreadId, this._pruneForPersistence(this._conversation));
                    if (modelConfig) {
                        this._generateConversationTitle(userPrompt, modelConfig).catch(() => {});
                    }
                } catch { /* context splice is best-effort; never fail the run over it */ }
            }
        } finally {
            this._isGenerating = false;
        }
    }

    /**
     * Shared pipeline mechanics — model/settings resolution, worktree-aware executor
     * wiring, and the PipelineOrchestrator invocation itself. Deliberately takes no
     * dependency on `this._view`/`this._abortController`/`this._isGenerating`/
     * `this._pendingPipelineApproval`: every caller-specific concern (where events go,
     * how approval is surfaced, cancellation) is a parameter, so this same method can
     * back both the chat-triggered flow and concurrent Manager-panel runs without the
     * two ever touching each other's state.
     */
    private async _runPipelineCore(params: {
        userPrompt: string;
        modelId: string;
        signal: AbortSignal;
        emit: (e: any) => void;
        requestApproval: (planContent: string, planPath: string) => Promise<boolean>;
    }): Promise<boolean> {
        const { userPrompt, modelId, emit } = params;
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const log = (msg: string) => emit({ type: 'Log', level: 'info', message: msg });

        // True only if the pipeline reached onPipelineCompleted — orchestrator.run()
        // resolves normally on rejection/cancellation/failure too, so callers that need
        // to know it genuinely succeeded (e.g. the chat wrapper's conversation-context
        // splice) must check this, not just that the await returned.
        let completed = false;

        // Budget guard: a runaway pipeline (7 loops × up to 40 turns) against a paid API is
        // the highest-cost operation in the product. When the per-run token budget trips,
        // this controller aborts the run; it is combined with the caller's cancel signal
        // below so either can stop the loops. `budgetExceeded` disambiguates the two so a
        // budget stop reads as a failure, not a silent user cancellation.
        const budgetController = new AbortController();
        let budgetExceeded = false;
        const signal = AbortSignal.any([params.signal, budgetController.signal]);

        // Hoisted so the finally can close them regardless of where the try exits.
        let browserTool: BrowserTool | undefined;
        let mcpClient: MCPClient | undefined;

        try {
            const configJson = await this._secretManager.getKey('llm-config');
            if (!configJson) throw new Error('No LLM configurations found.');
            const configs: LLMConfigEntry[] = JSON.parse(configJson);
            const modelConfig = configs.find(c => c.id === modelId);
            if (!modelConfig) throw new Error(`Configuration for model "${modelId}" not found.`);

            const allModes = this._modeLoader.getAllModes();

            browserTool = new BrowserTool();
            mcpClient = new MCPClient();
            const artifactManager = new ArtifactManager(this._context);
            const knowledgeStore = new KnowledgeStore(this._context);

            // Opt-in: auto-open every file the pipeline touches, not just the plan/
            // mindmap/overview artifacts. Off by default — a multi-file pipeline run
            // would otherwise flood the tab bar. Lives in the same 'general-settings'
            // blob as the rest of this extension's user settings (see openSettingsPanel).
            let generalSettings: any = {};
            try {
                const s = await this._secretManager.getKey('general-settings');
                if (s) generalSettings = JSON.parse(s);
            } catch {}
            const autoOpenAllFiles = !!generalSettings.pipelineAutoOpenAllFiles;
            // Browser gating (B1/B2), same policy as the chat flow: configure the shared
            // BrowserTool from settings and decide whether browser_* tools are offered at all.
            const browserSettings = readBrowserSettings(generalSettings);
            browserTool!.configure(browserSettings);
            const browserUsable = isBrowserUsable(browserSettings, browserRuntimeAvailable());
            // Mode name -> LLMConfigEntry id, e.g. routing HLD/LLD scaffolding to a
            // cheap/fast model and execution phases to a stronger one.
            const phaseModelOverrides: Record<string, string> = generalSettings.pipelinePhaseModels || {};
            // Cumulative (input+output) token ceiling for the whole run. 0 = unlimited.
            const pipelineTokenBudget = Math.max(0, Number(generalSettings.pipelineTokenBudget) || 0);
            // 'apply' (default) reconciles onto the live tree; 'pr' leaves the work on its
            // branch and opens a pull request. Anything unrecognised degrades to 'apply'.
            const outputMode = resolveOutputMode(generalSettings.pipelineOutputMode);
            // Default OFF — see core/parallel-execution.ts. Only an explicit `true` enables
            // it, so a malformed settings blob can never silently opt a user into the
            // unproven path.
            const parallelExecution = generalSettings.pipelineParallelExecution === true;

            // Tracks which files each phase touched, keyed by mode id, so the orchestrator
            // can build a deterministic mindmap entry + overview.md without depending on
            // the executor agent remembering to call update_mindmap itself.
            let currentPhaseModeId = '';
            // modeId -> (livePath -> kind). A file created then edited in the same phase
            // stays 'created' (net effect from the pipeline's view is a new file).
            const filesByPhase = new Map<string, Map<string, 'created' | 'modified' | 'deleted'>>();

            // Per-run, in-memory checkpoint store — NOT the shared this._checkpoints.
            // Every executor snapshots into its deps.checkpoint; sharing one instance
            // meant a pipeline's (worktree-path) snapshots bled into the next chat task's
            // commit, and with concurrent Manager runs, multiple pipelines would sweep
            // each other's pending snapshots. Isolating the store fixes both. Pipeline
            // execution changes reach the live tree via git (applyDelta) and are
            // git-undoable; this run-local store is discarded when the run ends.
            const runCheckpoints = new CheckpointManager();

            // rootPath/onFileChanged are per-call (see executorFactory below) — execution
            // phases run against an isolated worktree, not the live workspace directly.
            const baseDeps: Omit<ExecutorDeps, 'rootPath' | 'onFileChanged'> = {
                mode: 'agent', browserTool: browserTool!, mcpClient: mcpClient!, artifactManager, knowledgeStore,
                codebaseIndex: this._index, checkpoint: runCheckpoints,
                log, approve: this._buildApprovalGate({ settings: generalSettings, interactive: false, log }),
                signal, commandTimeoutMs: 120000,
                onPlan: () => {}, onArtifact: () => {}, onTerminalChunk: () => {},
                scheduleTask: () => Promise.resolve(), cancelTask: () => {}, spawnSubagent: async () => 'n/a'
            };

            // rootPathOverride is set only for execution phases (Design/Backend/Frontend/
            // Testing), which PipelineOrchestrator runs inside an isolated git worktree.
            const executorFactory = (mode: any, rootPathOverride?: string) => {
                const deps: ExecutorDeps = {
                    ...baseDeps,
                    rootPath: rootPathOverride || rootPath,
                    onFileChanged: (p, k) => {
                        // Translate worktree-local paths back to where the file will actually
                        // live once the pipeline merges — that's what the chat log, mindmap,
                        // overview, and auto-open should all reference, even though it doesn't
                        // exist there yet mid-run.
                        const liveP = rootPathOverride ? path.join(rootPath, path.relative(rootPathOverride, p)) : p;
                        emit({ type: 'FileChanged', path: liveP, kind: k });
                        if (currentPhaseModeId) {
                            if (!filesByPhase.has(currentPhaseModeId)) filesByPhase.set(currentPhaseModeId, new Map());
                            const m = filesByPhase.get(currentPhaseModeId)!;
                            // Keep 'created' sticky: a file created and then edited this phase is still a creation.
                            m.set(liveP, m.get(liveP) === 'created' ? 'created' : k);
                        }
                        if (liveP.endsWith('features_plan.md') || liveP.endsWith('project_mindmap.md')) {
                            // These are only ever written outside worktree isolation (Planner,
                            // and the deterministic mindmap sync — both target the live path
                            // or the worktree directly, never through this callback while
                            // isolated), so liveP === p here and the file already exists.
                            if (!rootPathOverride) vscode.commands.executeCommand('vscode.open', vscode.Uri.file(liveP));
                        } else if (autoOpenAllFiles && k !== 'deleted' && !rootPathOverride) {
                            // Suppressed while isolated — the live file doesn't exist (or is
                            // stale) until the pipeline actually merges.
                            vscode.workspace.openTextDocument(liveP).then(
                                doc => vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true }),
                                () => {}
                            );
                        }
                    },
                };
                return new AgentToolExecutor(deps);
            };

            const getToolsForMode = (modeId: string) => {
                let tools = toolsForMode('agent');
                const mDef = this._modeLoader.getMode(modeId);
                if (mDef?.tools) {
                    tools = tools.filter(t => mDef.tools!.includes(t.name));
                }
                return filterToolsForBrowser(tools, browserUsable);
            };

            // One tracker across all phases — the run's cumulative spend. Shared with the
            // loopCallbacks below (which every phase's runAgentLoop reports into) so cost
            // and the budget guard see the whole run, not per-phase slices.
            const tokenTracker = new TokenTracker();
            const toolStartedAt = new Map<string, number>();

            let phaseCount = 0;
            const orchestrator = new PipelineOrchestrator(
                rootPath, modelConfig, allModes, executorFactory,
                {
                    onPipelineStarted: () => {
                        emit({ type: 'PipelineStarted', phases: ['Architecture Analysis', 'Low Level Design', 'Feature Planning', 'Execution'], ts: Date.now() });
                    },
                    onPhaseStarted: (modeId) => {
                        phaseCount++;
                        currentPhaseModeId = modeId;
                        emit({ type: 'PipelinePhaseStarted', phase: modeId, index: phaseCount, total: 4, ts: Date.now() });
                    },
                    onPhaseCompleted: (modeId) => {
                        emit({ type: 'PipelinePhaseCompleted', phase: modeId, ts: Date.now() });
                    },
                    onPhaseError: (modeId, err) => {
                        emit({ type: 'PipelinePhaseError', phase: modeId, error: err, ts: Date.now() });
                    },
                    getFilesForPhase: (modeId) =>
                        Array.from(filesByPhase.get(modeId) || []).map(([p, kind]) => ({ path: p, kind })),
                    // Per-phase agent-loop instrumentation. Was never provided before, so a
                    // 7-agent run showed no tool activity and reported zero token cost — the
                    // most expensive operation in the product was invisible.
                    loopCallbacks: {
                        onToolCall: (tc) => {
                            toolStartedAt.set(tc.id, Date.now());
                            const arg = tc.arguments?.path || tc.arguments?.command || tc.arguments?.query || '';
                            emit({ type: 'ToolStarted', toolCallId: tc.id, name: tc.name, summary: String(arg).slice(0, 200), arguments: tc.arguments });
                        },
                        onToolResult: (tc, r) => {
                            emit({
                                type: 'ToolFinished', toolCallId: tc.id, name: tc.name, ok: !r.isError,
                                durationMs: Date.now() - (toolStartedAt.get(tc.id) ?? Date.now()),
                                summary: (r.content || '').slice(0, 200), output: r.content || '',
                            });
                        },
                        onUsage: (promptChars, response) => {
                            const u = this._trackAndEmitUsage(tokenTracker, modelConfig.model || '', promptChars, response, emit);
                            if (isOverTokenBudget(u.totalTokens, pipelineTokenBudget) && !budgetExceeded) {
                                budgetExceeded = true;
                                log(`[Budget] Token budget of ${pipelineTokenBudget} exceeded (${u.totalTokens} used) — stopping the run.`);
                                budgetController.abort();
                            }
                        },
                    },
                    onPipelineCompleted: (overviewPath) => {
                        completed = true;
                        emit({ type: 'PipelineCompleted', overviewPath, ts: Date.now() });
                        emit({ type: 'TaskCompleted', ts: Date.now() });
                        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(overviewPath));
                        vscode.window.showInformationMessage('Multi-Agent Pipeline Complete! See overview.md.');
                        // Long-term memory: record what was built so future sessions (and the
                        // user) have a durable, curated record beyond the machine mindmap.
                        try {
                            const kb = new KnowledgeBase(rootPath);
                            kb.ensureScaffold();
                            kb.recordFeature({ feature: userPrompt.slice(0, 80), status: 'done', notes: 'Delivered by the multi-agent pipeline; see overview.md.' });
                        } catch { /* memory update is best-effort */ }
                        // Doc regime (P4): keep the project's own CHANGELOG current. Written
                        // to the live tree, so it is skipped in PR mode where the deliverable
                        // is the branch and the live tree is deliberately untouched.
                        if (outputMode !== 'pr') {
                            try {
                                const run = {
                                    prompt: userPrompt,
                                    phases: [...filesByPhase.keys()],
                                    files: [...filesByPhase.entries()].flatMap(([, m]) =>
                                        [...m.entries()].map(([p, kind]) => ({ path: path.relative(rootPath, p), kind }))),
                                };
                                const changelogPath = path.join(rootPath, 'CHANGELOG.md');
                                const existing = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
                                fs.writeFileSync(changelogPath, prependChangelogEntry(existing, formatChangelogEntry(run)), 'utf8');
                            } catch { /* doc regime is best-effort */ }
                        }
                    },
                    // PR output mode: publish the run's branch instead of applying it. Runs
                    // under gitMutex because it pushes — concurrent Manager runs would
                    // otherwise contend on the same repo's refs.
                    onPipelinePullRequest: async ({ branch, userPrompt: prPrompt }) => {
                        const title = summarizeRequest(prPrompt);
                        const body = formatReleaseNotes({ prompt: prPrompt, phases: [], files: [], branch });
                        await gitMutex.run(async () => {
                            const ghCheck = await ToolRunner.executeCommand('gh --version', rootPath, 10000, signal);
                            if (ghCheck.exitCode === 0) {
                                for (const cmd of buildPrCommands({ branch, title, body })) {
                                    const res = await ToolRunner.executeCommand(cmd, rootPath, 120000, signal);
                                    if (res.exitCode !== 0) throw new Error(`${cmd.split(' ').slice(0, 3).join(' ')} failed: ${res.stderr || res.stdout}`);
                                }
                                log(`[PR] Opened a pull request from "${branch}".`);
                                vscode.window.showInformationMessage(`Pipeline complete — pull request opened from "${branch}".`);
                                return;
                            }
                            // No `gh`: still push, then hand the user a compare URL. Pushing
                            // matters most — without it the branch is local-only and the URL
                            // would 404.
                            const push = await ToolRunner.executeCommand(`git push -u origin ${shellQuote(branch)}`, rootPath, 120000, signal);
                            if (push.exitCode !== 0) throw new Error(`git push failed: ${push.stderr || push.stdout}`);
                            const remote = await ToolRunner.executeCommand('git remote get-url origin', rootPath, 10000, signal);
                            const url = compareUrlFallback((remote.stdout || '').trim(), branch);
                            if (url) {
                                log(`[PR] gh not found — opening the compare page instead: ${url}`);
                                vscode.env.openExternal(vscode.Uri.parse(url));
                            } else {
                                vscode.window.showInformationMessage(`Pipeline complete — work pushed to branch "${branch}". Open a PR manually.`);
                            }
                        });
                    },
                    // Without these, a genuinely failed or cancelled run leaves the caller's
                    // UI state stuck "in progress" forever — orchestrator.run() otherwise
                    // swallows both outcomes internally and returns normally either way.
                    onPipelineFailed: (error) => {
                        emit({ type: 'TaskFailed', error, durationMs: 0 });
                    },
                    onPipelineCancelled: () => {
                        // A budget stop reaches here (it aborts the run), but it is a failure,
                        // not a user cancellation — surface it as such with a clear message.
                        if (budgetExceeded) {
                            emit({ type: 'TaskFailed', error: `Pipeline stopped: exceeded the ${pipelineTokenBudget}-token budget. Raise or clear it in Settings → Pipeline Token Budget.`, durationMs: 0 });
                        } else {
                            emit({ type: 'TaskCancelled', durationMs: 0 });
                        }
                    },
                    requestApproval: params.requestApproval,
                },
                signal,
                getToolsForMode,
                configs,
                phaseModelOverrides,
                outputMode,
                parallelExecution
            );

            // Long-term memory (read side): start the run aware of prior decisions, feature
            // status, and known tech debt from .blackIDE/knowledge/, instead of re-deriving.
            const knowledgeDigest = new KnowledgeBase(rootPath).readContext();
            if (knowledgeDigest) log('[Memory] Injected existing project knowledge into the run.');

            // Requirement discovery: surface unspecified dimensions to the analysis phases
            // so they resolve them or state explicit assumptions, rather than guessing silently.
            const openQuestions = PlanningEngine.detectMissingRequirements(userPrompt);
            if (openQuestions.length) log(`[Requirements] ${openQuestions.length} open question(s) flagged for the Architect.`);

            const runPrompt = [
                userPrompt,
                knowledgeDigest ? `\n\n## Existing Project Knowledge (from .blackIDE/knowledge/)\n${knowledgeDigest}` : '',
                openQuestions.length ? `\n\n## Open questions to resolve (or state your assumptions if unanswered):\n${openQuestions.map(q => `- ${q}`).join('\n')}` : '',
            ].join('');

            await orchestrator.run(runPrompt);

        } catch (e: any) {
            vscode.window.showErrorMessage(`Pipeline Error: ${e.message}`);
            emit({ type: 'TaskFailed', error: e.message, durationMs: 0 });
        } finally {
            // Mirror _runAgentTask's finally — a pipeline whose Testing Executor opened a
            // browser would otherwise leak a headless Chromium (and MCP connections) until
            // the extension host dies. Keep in sync with the chat-flow cleanup.
            try { await browserTool?.close(); } catch {}
            try { await mcpClient?.disconnectAll(); } catch {}
        }
        return completed;
    }

    /**
     * Manager-panel entry point — runs concurrently with the chat sidebar's own flow
     * (and with other Manager runs) via a per-run AbortController rather than the
     * shared `_abortController`/`_isGenerating`. Events go straight to the Manager
     * panel webview tagged with `runId`, never through `this._bus`/`this._view` — see
     * `_runPipelineCore`'s doc comment for why that separation matters (a shared path
     * would let concurrent runs corrupt the chat's own streaming message).
     */
    private async _runPipelineInManager(runId: string, userPrompt: string, modelId: string, managerWebview: vscode.Webview) {
        const record = this._pipelineRuns.get(runId);
        if (!record) return;

        const emit = (e: any) => {
            let mutated = true;
            switch (e.type) {
                case 'PipelinePhaseStarted':
                    record.currentPhase = e.phase;
                    break;
                case 'TaskCompleted':
                    record.status = 'completed';
                    record.endedAt = Date.now();
                    break;
                case 'TaskFailed':
                    record.status = 'failed';
                    record.error = e.error;
                    record.endedAt = Date.now();
                    break;
                case 'TaskCancelled':
                    record.status = 'cancelled';
                    record.endedAt = Date.now();
                    break;
                default:
                    mutated = false;
            }
            // Persist on every state change so a reload finds an accurate, terminal-or-not
            // snapshot (reconcileInterruptedRuns handles the "was still running" case).
            if (mutated) this._persistRunHistory();
            managerWebview.postMessage({ type: 'pipelineRunEvent', runId, value: e });
        };

        try {
            await this._runPipelineCore({
                userPrompt, modelId,
                signal: record.abortController.signal,
                emit,
                requestApproval: (planContent, planPath) => new Promise<boolean>((resolve) => {
                    record.status = 'awaiting_approval';
                    record.pendingApproval = { planContent, planPath, resolve };
                    this._persistRunHistory();
                    // Same AgentEvent type (and agentReducer case) the chat approval card
                    // already relies on — ManagerPanel folds this into pendingPlan the
                    // same way, via the shared reducer, not a bespoke event shape.
                    managerWebview.postMessage({
                        type: 'pipelineRunEvent',
                        runId,
                        value: {
                            type: 'PlanApprovalRequested',
                            planPath, taskPath: planPath, planContent,
                            taskContent: 'Pipeline plans are self-contained — the Sequential Task List section above already breaks work into design/backend/frontend/testing phases.',
                            ts: Date.now(),
                        },
                    });
                }),
            });
        } finally {
            // Defensive fallback only: _runPipelineCore should always resolve a terminal
            // status via onPipelineCompleted/onPipelineFailed/onPipelineCancelled (or the
            // rejectPipelineRun handler, for a rejected plan), but a run must never sit
            // silently "running" forever in the Manager panel if some future code path
            // fails to signal one.
            if (record.status === 'running' || record.status === 'awaiting_approval') {
                record.status = 'failed';
                record.error = record.error || 'Pipeline ended without a definitive result.';
                record.endedAt = Date.now();
                managerWebview.postMessage({
                    type: 'pipelineRunEvent',
                    runId,
                    value: { type: 'TaskFailed', error: record.error, durationMs: 0, ts: Date.now() },
                });
            }
        }
    }

    // ─── Manager Panel: concurrent pipeline run tracking ────────────────
    // Public surface the Manager webview panel (registered in activate()) calls into.
    // Kept here rather than on the panel itself so run state lives with the rest of
    // this provider's session-lifetime state (same reasoning as _checkpoints/_index).

    /** Starts a new concurrent pipeline run, or returns an error if the concurrency cap is hit. */
    public startManagedPipelineRun(prompt: string, modelId: string, managerWebview: vscode.Webview): { runId: string } | { error: string } {
        const activeCount = Array.from(this._pipelineRuns.values())
            .filter(r => r.status === 'running' || r.status === 'awaiting_approval').length;
        if (activeCount >= BlackIdeChatProvider.MAX_CONCURRENT_PIPELINE_RUNS) {
            return { error: `Already running ${activeCount} pipeline${activeCount === 1 ? '' : 's'} — the limit is ${BlackIdeChatProvider.MAX_CONCURRENT_PIPELINE_RUNS}. Wait for one to finish or cancel it first.` };
        }

        const runId = 'run_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const record: PipelineRunRecord = {
            id: runId, prompt, modelId, status: 'running', startedAt: Date.now(),
            abortController: new AbortController(),
        };
        this._pipelineRuns.set(runId, record);
        this._persistRunHistory();

        // Fire-and-forget: the caller (a webview message handler) must not block on the
        // whole pipeline run. _runPipelineInManager reports its own progress/completion
        // via managerWebview.postMessage, keyed by runId.
        this._runPipelineInManager(runId, prompt, modelId, managerWebview).catch(() => {});

        return { runId };
    }

    public cancelManagedPipelineRun(runId: string): void {
        // The abort flows to onPipelineCancelled → the emit switch sets status + persists.
        this._pipelineRuns.get(runId)?.abortController.abort();
    }

    public approveManagedPipelineRun(runId: string): void {
        const record = this._pipelineRuns.get(runId);
        if (!record?.pendingApproval) return;
        const pending = record.pendingApproval;
        record.pendingApproval = undefined;
        record.status = 'running';
        this._persistRunHistory();
        pending.resolve(true);
    }

    public rejectManagedPipelineRun(runId: string): void {
        const record = this._pipelineRuns.get(runId);
        if (!record?.pendingApproval) return;
        const pending = record.pendingApproval;
        record.pendingApproval = undefined;
        // Set the terminal state before resolving — orchestrator.run() unwinds a
        // rejection silently (see pipeline-orchestrator.ts's catch), so nothing else
        // will mark this run as done.
        record.status = 'cancelled';
        record.endedAt = Date.now();
        this._persistRunHistory();
        pending.resolve(false);
    }

    public listManagedPipelineRuns(): PipelineRunSummary[] {
        return mergeRunViews(this._runHistory, Array.from(this._pipelineRuns.values()).map(r => this._toRunSummary(r)));
    }

    /** Serializable projection of a live run record (drops the AbortController/resolver). */
    private _toRunSummary(r: PipelineRunRecord): PipelineRunSummary {
        return {
            id: r.id, prompt: r.prompt, modelId: r.modelId, status: r.status,
            startedAt: r.startedAt, endedAt: r.endedAt, currentPhase: r.currentPhase, error: r.error,
        };
    }

    /** Fold the live runs into the durable history and persist. Called on every transition. */
    private _persistRunHistory(): void {
        const live = Array.from(this._pipelineRuns.values()).map(r => this._toRunSummary(r));
        this._runHistory = capRunHistory(mergeRunViews(this._runHistory, live));
        this._context.globalState.update(BlackIdeChatProvider.RUN_HISTORY_KEY, this._runHistory);
    }

    /** Re-read settings-derived caches after the user saves settings (from either panel). */
    public async onSettingsSaved(): Promise<void> {
        await this._refreshTelemetryEnabled();
    }

    /** Opens the local telemetry JSONL for self-diagnosis, or explains why there's none. */
    public async exportDiagnostics(): Promise<void> {
        try {
            if (!fs.existsSync(this._telemetryPath)) {
                vscode.window.showInformationMessage(
                    this._telemetryEnabled
                        ? 'No agent diagnostics recorded yet — run an agent task first.'
                        : 'Agent telemetry is turned off (Settings → anonymous telemetry). No diagnostics were recorded.'
                );
                return;
            }
            const doc = await vscode.workspace.openTextDocument(this._telemetryPath);
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (e: any) {
            vscode.window.showErrorMessage(`Could not open diagnostics: ${e.message}`);
        }
    }

    // ─── Agentic Loop Orchestrator ──────────────────────────────────────
    // Native tool calling + structured messages + cancellation + checkpoints +
    // honored auto-approve + activated hooks + semantic index + real subagents.

    private async _runAgentTask(userPrompt: string, modelId: string, attachments?: any[], mode?: string) {
        if (!this._view) return;
        const webview = this._view.webview;

        // Cancellation: abort any in-flight task, start a fresh controller.
        this._abortController?.abort();
        const controller = new AbortController();
        this._abortController = controller;
        const signal = controller.signal;
        this._isGenerating = true;

        const tokenTracker = new TokenTracker();
        const startedAt = Date.now();

        const browserTool = new BrowserTool();
        const mcpClient = new MCPClient();
        const skillsManager = new SkillsManager();
        const artifactManager = new ArtifactManager(this._context);
        const knowledgeStore = new KnowledgeStore(this._context);
        const hooks = new AgentHooks();
        const checkpoint = this._checkpoints;
        const codebaseIndex = this._index;

        // `task` is created below once we know the mode and model; until then, log to
        // the bus without a task envelope is not possible, so config errors surface via
        // the catch block on the raw webview channel.
        let task: TaskEmitter | undefined;
        const log = (msg: string) => {
            if (task) task.emit({ type: 'Log', level: 'info', message: msg });
            else webview.postMessage({ type: 'log', value: msg });
        };

        try {
            const configJson = await this._secretManager.getKey('llm-config');
            if (!configJson) throw new Error('No LLM configurations found. Configure a model in Settings first.');
            const configs: LLMConfigEntry[] = JSON.parse(configJson);
            const modelConfig = configs.find(c => c.id === modelId);
            if (!modelConfig) throw new Error(`Configuration for model "${modelId}" not found in Settings.`);

            let settings: any = {};
            try { const s = await this._secretManager.getKey('general-settings'); if (s) settings = JSON.parse(s); } catch {}
            // Reasoning display (B6): gate the reasoning stream on the user's toggle. Default
            // on (unset === true) so existing behavior is preserved; only an explicit `false`
            // silences it. Controls display only — the model still reasons either way.
            const showReasoning = settings.enableReasoningDisplay !== false;
            // Default 25, configurable to 500. Safe to raise only because the context is
            // now bounded by token budget rather than message count — a long run compacts
            // instead of overflowing the window.
            const customModeDef = this._modeLoader.getMode(mode || 'agent');
            if (customModeDef) {
                log(`[Telemetry] modes.selected: ${customModeDef.name} (${customModeDef.source})`);
            }

            const customMaxLoops = customModeDef?.maxIterations;
            const maxLoops = Math.min(500, Math.max(1, customMaxLoops || Number(settings.maxLoopIterations) || 25));

            const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

            let effectiveMode: AgentMode = (customModeDef?.name.toLowerCase() === 'ask' || customModeDef?.name.toLowerCase() === 'plan')
                ? customModeDef.name.toLowerCase() as AgentMode
                : 'agent';

            // Classify intent (plan.md "Request Classification"). Logged for visibility and
            // used to right-size: a pure question never needs the plan-first workflow.
            const classification = PlanningEngine.classifyRequest(userPrompt);
            log(`[Classify] ${classification.kind}${classification.isProgramming ? '' : ' (non-programming)'}`);

            if (effectiveMode === 'agent' && classification.kind !== 'question'
                && PlanningEngine.shouldPlan(userPrompt)) effectiveMode = 'plan';
            
            let tools = toolsForMode(effectiveMode);
            if (customModeDef && customModeDef.tools && customModeDef.tools.length > 0) {
                tools = tools.filter(t => customModeDef.tools!.includes(t.name));
            }

            // Browser gating (B1/B2): honor the user's settings on the BrowserTool, and hide
            // the browser_* tools entirely unless the browser is enabled AND a Playwright
            // runtime is installed — so the model is never offered a tool that would fail.
            const browserSettings = readBrowserSettings(settings);
            browserTool.configure(browserSettings);
            const browserUsable = isBrowserUsable(browserSettings, browserRuntimeAvailable());
            tools = filterToolsForBrowser(tools, browserUsable);

            // Everything from here publishes with a task envelope: sessionId, taskId, traceId.
            task = this._sessions.beginTask(userPrompt, effectiveMode, modelConfig.model || modelId);

            // Incremental: a warm index only re-reads the files that actually changed.
            try {
                const t0 = Date.now();
                const stats = await codebaseIndex.build(this._secretManager);
                log(`[Index] ${codebaseIndex.size} chunks — ${stats.indexed} indexed, ${stats.reused} reused, ${stats.removed} removed (${Date.now() - t0}ms).`);
            } catch (e: any) { log(`[Index] Skipped: ${e?.message || e}`); }

            await skillsManager.discover();
            const relevantSkills = skillsManager.findRelevant(userPrompt);
            const skillInstructions = skillsManager.getInstructions(relevantSkills);

            // MCP tools are exec-class: they hand arguments to an arbitrary external
            // process. Only Agent mode may call them, so only Agent mode pays the cost
            // of spawning the servers.
            let mcpToolDocs = '';
            if (effectiveMode === 'agent') {
                const mcpConfigs = await mcpClient.loadConfigs();
                for (const mc of mcpConfigs) { log(`[MCP] Connecting: ${mc.name}...`); await mcpClient.connectServer(mc); }
                mcpToolDocs = mcpClient.getToolDescriptions();
            }

            await hooks.loadFromWorkspace(rootPath);
            const knowledgeContext = await knowledgeStore.getRelevantContext(userPrompt);

            let projectRules = '';
            const rulesPath = path.join(rootPath, '.blackide', 'AGENTS.md');
            if (rootPath && fs.existsSync(rulesPath)) { try { projectRules = `Project Rules:\n${fs.readFileSync(rulesPath, 'utf8')}`; } catch {} }

            const useNative = supportsNativeTools(modelConfig);
            const modeRules =
                (customModeDef && customModeDef.systemPrompt) ? customModeDef.systemPrompt
                : effectiveMode === 'plan' ? PlanningEngine.getPlanningPromptExtension()
                : effectiveMode === 'ask' ? 'ASK MODE: read-only. Answer using read/search tools only; do not edit files or run commands.'
                : '';
            if (effectiveMode === 'plan') log('[Agent] Plan mode: research first, then propose a plan.');

            // Sections are budgeted independently, so a 500KB AGENTS.md or a chatty MCP
            // server can only ever spend its own allowance — it cannot squeeze out the
            // agent's own instructions, which is what plain concatenation allowed.
            const modelLimit = ContextManager.getModelLimit(modelConfig.model || '');
            const promptBudget = Math.min(12000, Math.floor(modelLimit * 0.15));
            const built = new PromptBuilder()
                .add({
                    name: 'system', required: true, budgetTokens: 1200,
                    content: `You are the Black IDE Agent, an autonomous coding assistant working in the user's workspace at ${rootPath || '(no folder)'}.
Work in a loop: think, call a tool, observe the result, repeat. Prefer codebase_search to locate code, read a file before editing it, and verify your work with run_command. When finished, call complete_task with a concise summary.`,
                })
                .add({ name: 'mode', required: true, budgetTokens: 600, content: modeRules })
                .add({
                    name: 'tool_protocol', required: true, budgetTokens: 2500,
                    content: useNative ? '' : `To act, output ONE JSON tool call in a \`\`\`json fenced block:\n${renderToolDocs(tools)}`,
                })
                .add({ name: 'project_rules', budgetTokens: 1500, content: projectRules })
                .add({ name: 'user_instructions', budgetTokens: 800, content: settings.customSystemPrompt ? `User Custom Instructions:\n${settings.customSystemPrompt}` : '' })
                .add({ name: 'skills', budgetTokens: 1500, content: skillInstructions })
                .add({ name: 'mcp_tools', budgetTokens: 1200, content: mcpToolDocs ? `External MCP tools available:\n${mcpToolDocs}` : '' })
                .add({ name: 'knowledge', budgetTokens: 2000, content: knowledgeContext })
                .build(promptBudget);

            const system = built.text;
            const overflowed = built.sections.filter(s => s.truncated || s.dropped);
            if (overflowed.length) {
                log(`[Prompt] ${built.totalTokens}/${promptBudget} tokens — ${overflowed.map(s => `${s.name} ${s.dropped ? 'dropped' : 'truncated'}`).join(', ')}.`);
            }

            webview.postMessage({ type: 'agentMode', value: effectiveMode });

            // Advertise each MCP tool with the server's real input schema. Empty outside
            // Agent mode, since we never connected there.
            tools.push(...mcpClient.getToolDefinitions());

            const { images, text: attachText } = readAttachments(attachments);
            const initialMessage: ChatMessage = {
                role: 'user',
                content: `${userPrompt}${attachText ? `\n${attachText}` : ''}`,
                images: images.length ? images : undefined,
            };

            const approve = this._buildApprovalGate({ settings, interactive: true, log });

            const emit = (e: Parameters<TaskEmitter['emit']>[0]) => task?.emit(e);

            const baseDeps = (spawnSubagent?: ExecutorDeps['spawnSubagent']): ExecutorDeps => ({
                mode: effectiveMode,
                rootPath, browserTool, mcpClient, artifactManager, knowledgeStore, codebaseIndex, checkpoint,
                log, approve, signal, commandTimeoutMs: 120000,
                onPlan: (steps) => emit({ type: 'PlanUpdated', steps }),
                onArtifact: (artifact) => emit({ type: 'ArtifactCreated', artifact }),
                onTerminalChunk: (stream, text) => emit({ type: 'TerminalChunk', stream, text }),
                onFileChanged: (p, kind) => {
                    emit({ type: 'FileChanged', path: p, kind });
                    if (p.endsWith('features_plan.md') || p.endsWith('project_mindmap.md')) {
                        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p));
                    }
                },
                scheduleTask: (tc) => this._scheduleAgentTask(tc, modelId, webview, effectiveMode),
                cancelTask: (id) => this._scheduler.cancel(id),
                spawnSubagent,
            });

            // A subagent inherits the parent's mode. Handing it toolsForMode('agent')
            // would let a read-only Ask/Plan session edit files and run commands through
            // a delegate that outranks its own parent.
            const spawnSubagent = async (name: string, task: string, targetMode?: string): Promise<string> => {
                const subMode = targetMode || effectiveMode;
                log(`[Subagent: ${name}] Starting in ${subMode} mode with git worktree isolation...`);
                
                const subagentId = 'sa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
                const branchName = 'sa-' + name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + subagentId;
                
                webview.postMessage({
                    type: 'agentEvent',
                    value: { type: 'SubagentStarted', subagentId, name, task }
                });

                const subController = new AbortController();
                this._subagentAbortControllers.set(subagentId, subController);

                let worktreeDir = '';
                // Set true if reconciling the subagent's work back to the live tree fails,
                // so the finally leaves the worktree in place instead of discarding the
                // (real, completed) work along with it.
                let preserveWorktree = false;
                try {
                    worktreeDir = await worktreeManager.createWorktree(branchName);
                    // git worktree add only clones committed HEAD — sync the parent's
                    // uncommitted live state in, then commit a baseline to diff against.
                    // Without the baseline + delta below, the old mergeWorktree() merged
                    // zero commits and every file the subagent wrote was silently dropped.
                    await worktreeManager.syncUncommittedChanges(branchName);
                    const baseline = await worktreeManager.commitWorktreeChanges(branchName, `subagent baseline: ${name}`);
                    webview.postMessage({
                        type: 'agentEvent',
                        value: { type: 'SubagentProgress', subagentId, progress: 'Isolated worktree created. Starting agent loop...' }
                    });

                    // Build deps for subagent scoped to worktree root path. Own checkpoint
                    // store (not the shared this._checkpoints) so worktree-path snapshots
                    // don't bleed into the parent chat task's undo history.
                    const subDeps = {
                        ...baseDeps(undefined),
                        rootPath: worktreeDir,
                        checkpoint: new CheckpointManager(),
                        onTerminalChunk: (stream: 'stdout' | 'stderr', text: string) => {
                            webview.postMessage({
                                type: 'agentEvent',
                                value: { type: 'SubagentProgress', subagentId, progress: text.slice(0, 100) }
                            });
                        }
                    };

                    const subExec = new AgentToolExecutor(subDeps);
                    const subSystem = `You are a focused sub-agent. Complete ONLY this task, then call complete_task with your result.`;
                    
                    let subTools = toolsForMode(subMode as AgentMode);
                    const subModeDef = this._modeLoader.getMode(subMode);
                    if (subModeDef?.tools) {
                        subTools = subTools.filter(t => subModeDef.tools!.includes(t.name));
                    }
                    
                    const res = await runAgentLoop({
                        modelConfig, system: subSystem, initialMessage: { role: 'user', content: task },
                        tools: subTools, executor: subExec, maxLoops: 15,
                        signal: subController.signal,
                        callbacks: {
                            onToolCall: (tc) => {
                                log(`[Subagent: ${name}] calling ${tc.name}`);
                                webview.postMessage({
                                    type: 'agentEvent',
                                    value: { type: 'SubagentProgress', subagentId, progress: `Calling tool: ${tc.name}` }
                                });
                            }
                        },
                    });

                    if (subController.signal.aborted) {
                        throw new Error('Cancelled by user');
                    }

                    webview.postMessage({
                        type: 'agentEvent',
                        value: { type: 'SubagentProgress', subagentId, progress: 'Loop finished. Applying changes to workspace...' }
                    });

                    // Commit the subagent's work, then apply just the baseline→exec delta to
                    // the live tree (same reconciliation the pipeline uses — a plain git merge
                    // would spuriously conflict on every file the live tree already had dirty).
                    const execSha = await worktreeManager.commitWorktreeChanges(branchName, `subagent: ${name}`);
                    try {
                        await worktreeManager.applyDelta(branchName, baseline, execSha);
                    } catch (mergeErr: any) {
                        preserveWorktree = true;
                        throw new Error(
                            `Subagent "${name}" completed, but applying its changes failed: ${mergeErr.message}. ` +
                            `The work is preserved on git branch "${branchName}" at ${worktreeDir} — apply it with ` +
                            `'git merge ${branchName}', or discard with 'git worktree remove --force "${worktreeDir}"'.`
                        );
                    }

                    webview.postMessage({
                        type: 'agentEvent',
                        value: { type: 'SubagentFinished', subagentId, ok: true }
                    });

                    log(`[Subagent: ${name}] Applied and complete.`);
                    return res.finalText;

                } catch (err: any) {
                    log(`[Subagent: ${name}] Failed: ${err.message || err}`);
                    webview.postMessage({
                        type: 'agentEvent',
                        value: { type: 'SubagentFinished', subagentId, ok: false, error: err.message || String(err) }
                    });
                    throw err;
                } finally {
                    this._subagentAbortControllers.delete(subagentId);
                    // Leave the worktree in place when reconciliation failed — removing it
                    // would discard the completed work the error message points the user to.
                    if (worktreeDir && !preserveWorktree) {
                        try {
                            await worktreeManager.removeWorktree(branchName);
                        } catch (e: any) {
                            log(`[Subagent: ${name}] Failed removing worktree ${branchName}: ${e.message}`);
                        }
                    }
                }
            };

            const executor = new AgentToolExecutor(baseDeps(spawnSubagent));

            // Tool timing is measured here, not inside the executor, so the duration in
            // the timeline is the duration the user actually waited (approval included).
            const toolStartedAt = new Map<string, number>();

            const result = await runAgentLoop({
                modelConfig, system, initialMessage,
                priorMessages: this._conversation,
                tools, executor, maxLoops, signal,
                context: new ContextManager(modelLimit),
                callbacks: {
                    onTurn: (n, maxTurns) => {
                        emit({ type: 'TurnStarted', turn: n });
                        const warningThreshold = Math.floor(maxTurns * 0.8);
                        if (n === warningThreshold) {
                            webview.postMessage({
                                type: 'loopLimitWarning',
                                value: {
                                    currentTurn: n,
                                    maxTurns,
                                    remaining: maxTurns - n,
                                }
                            });
                        }
                    },
                    onLoopLimitReached: async (currentTurn, maxTurns) => {
                        const action = await vscode.window.showWarningMessage(
                            `Agent reached the iteration limit (${maxTurns}). Would you like to continue?`,
                            'Continue (+10 iterations)',
                            'Continue (+25 iterations)',
                            'Stop'
                        );
                        if (action?.startsWith('Continue')) {
                            const extra = action.includes('+10') ? 10 : 25;
                            return { continueWith: extra };
                        }
                        return { continueWith: 0 };
                    },
                    onReasoningStart: () => { if (showReasoning) webview.postMessage({ type: 'startReasoning' }); },
                    onToken: (t) => {
                        // Reasoning tokens stream straight to the view: at 60fps an event
                        // envelope per token is pure overhead. Suppressed when the user turns
                        // reasoning display off (B6).
                        if (showReasoning) webview.postMessage({ type: 'streamReasoning', value: t });
                    },
                    onToolCall: (tc) => {
                        toolStartedAt.set(tc.id, Date.now());
                        const arg = tc.arguments?.path || tc.arguments?.command || tc.arguments?.query || '';
                        emit({ 
                            type: 'ToolStarted', 
                            toolCallId: tc.id, 
                            name: tc.name, 
                            summary: String(arg).slice(0, 200),
                            arguments: tc.arguments
                        });
                    },
                    onToolResult: async (tc, r) => {
                        emit({
                            type: 'ToolFinished',
                            toolCallId: tc.id,
                            name: tc.name,
                            ok: !r.isError,
                            durationMs: Date.now() - (toolStartedAt.get(tc.id) ?? Date.now()),
                            summary: (r.content || '').slice(0, 200),
                            output: r.content || '',
                        });
                        if (r.isError) await hooks.run('onError', { action: tc.name, error: r.content });
                        else await hooks.run('afterToolCall', { action: tc.name });
                    },
                    onCompaction: (dropped, total) =>
                        log(`[Context] Window filled — compacted ${dropped} older messages (now ~${total} tokens).`),
                    onUsage: (promptChars, response) => {
                        const u = this._trackAndEmitUsage(tokenTracker, modelConfig.model || '', promptChars, response, emit);
                        // Chat-only: the status-bar token/cost readout (the pipeline surfaces
                        // the same data through the TokenUsage event above).
                        webview.postMessage({ type: 'tokenUsage', value: {
                            turnTokens: tokenTracker.formatTokens(u.turnTokens),
                            totalTokens: tokenTracker.formatTokens(u.totalTokens),
                            totalCost: tokenTracker.formatCost(u.totalCost),
                            turns: u.summary.turns,
                        } });
                    },
                },
            });

            await hooks.run('beforeResponse', {});

            // Carry the turns forward so the next prompt is not amnesiac. ContextManager
            // bounds this on the way into the model, so it can grow without unbounding cost.
            this._conversation = result.messages;

            // Persist pruned conversation so multi-turn memory survives window reload
            const pruned = this._pruneForPersistence(this._conversation);
            await this._historyStore.setConversationState(this._activeThreadId, pruned);

            // Close the transaction. Committing produces the reverse patches that make
            // undo and per-file restore possible — and pins them to this message.
            const messageId = task.meta.taskId;
            const committed = checkpoint.commit(messageId, userPrompt.slice(0, 60), rootPath, messageId);
            if (committed) {
                checkpoint.pruneOldest(50);
                emit({ type: 'CheckpointCreated', checkpointId: committed.id, files: committed.files.map(f => f.relPath) });
                webview.postMessage({
                    type: 'checkpointAvailable',
                    value: {
                        checkpointId: committed.id,
                        messageId,
                        files: committed.files.map(f => ({
                            path: f.path,
                            relPath: f.relPath,
                            kind: f.kind,
                            stat: diffStat(f),
                            reviewState: f.reviewState,
                        })),
                    },
                });
            }

            // ── Plan Detection: Antigravity Two-Phase Gate ──────────────────────
            // If the planning loop produced implementation_plan + task_list artifacts,
            // transition to awaiting_approval instead of completing the task.
            if (!result.aborted && effectiveMode === 'plan') {
                const allArtifacts = artifactManager.list();
                const planArtifact = allArtifacts.find(a => a.name.includes('implementation_plan'));
                const taskArtifact = allArtifacts.find(a => a.name.includes('task_list'));

                if (planArtifact && taskArtifact) {
                    const planContent = fs.readFileSync(planArtifact.path, 'utf8');
                    const taskContent = fs.readFileSync(taskArtifact.path, 'utf8');

                    this._pendingApproval = {
                        planContent, taskContent,
                        planPath: planArtifact.path,
                        taskPath: taskArtifact.path,
                        originalPrompt: userPrompt,
                        modelId, attachments, mode,
                    };

                    // Persist so approval survives a window reload
                    try {
                        await this._historyStore.setConversationState(
                            `pending-plan-${this._activeThreadId}`,
                            [{ role: 'user', content: JSON.stringify(this._pendingApproval) }]
                        );
                    } catch {}

                    emit({
                        type: 'PlanApprovalRequested',
                        planPath: planArtifact.path,
                        taskPath: taskArtifact.path,
                        planContent,
                        taskContent,
                    });
                    webview.postMessage({
                        type: 'planApprovalRequested',
                        value: { planContent, taskContent, planPath: planArtifact.path, taskPath: taskArtifact.path }
                    });
                    webview.postMessage({ type: 'finalResponse', value: result.finalText });
                    webview.postMessage({ type: 'taskComplete' });
                    return; // Exit — do NOT post finalResponse again; await user approval
                }
            }

            if (result.aborted) {
                emit({ type: 'TaskCancelled', durationMs: Date.now() - startedAt });
                webview.postMessage({ type: 'finalResponse', value: 'Task cancelled by user.' });
            } else {
                emit({ type: 'TaskCompleted', finalText: result.finalText, turns: result.turns, durationMs: Date.now() - startedAt });
                webview.postMessage({ type: 'finalResponse', value: result.finalText });
                
                // Generate a title for the conversation asynchronously
                this._generateConversationTitle(userPrompt, modelConfig).catch(e => log(`[Title] Failed to generate title: ${e.message}`));
            }

            webview.postMessage({ type: 'taskComplete' });
        } catch (error: any) {
            task?.emit({ type: 'TaskFailed', error: error.message, durationMs: Date.now() - startedAt });
            log(`[Agent Error] ${error.message}`);
            await hooks.run('onError', { error: error.message });
            webview.postMessage({ type: 'taskError', value: error.message });
            vscode.window.showErrorMessage(error.message);
        } finally {
            this._isGenerating = false;
            if (this._abortController === controller) this._abortController = undefined;
            try { await browserTool.close(); } catch {}
            try { await mcpClient.disconnectAll(); } catch {}
        }
    }

    // ─── Phase 2: Execution Loop (Antigravity Pattern) ──────────────────
    // Runs after the user approves the plan. Uses full agent mode with the
    // approved plan + task list injected into the system prompt.

    private async _runAgentTaskExecution(
        originalPrompt: string,
        modelId: string,
        planContent: string,
        taskContent: string,
        attachments?: any[],
        _mode?: string,
    ) {
        if (!this._view) return;

        // The execution phase is a full _runAgentTask call with overrides:
        // 1. Mode is always 'agent' (full tool access)
        // 2. The prompt includes execution instructions + the approved plan
        // 3. PlanningEngine.shouldPlan() won't trigger because mode is explicitly 'agent'
        //    and the prompt will be structured as an execution command
        const executionPrompt = [
            `Execute the approved implementation plan for the following request:`,
            ``,
            `"${originalPrompt}"`,
            ``,
            PlanningEngine.getExecutionPromptExtension(planContent, taskContent),
        ].join('\n');

        // Run as 'agent' mode to ensure full tool access for execution.
        // The slash-command-like prefix ensures shouldPlan() doesn't re-trigger planning.
        await this._runAgentTask(executionPrompt, modelId, attachments, 'agent');
    }

    private async _generateConversationTitle(userPrompt: string, modelConfig: LLMConfigEntry) {
        if (!this._activeThreadId) return;
        const threads = this._historyStore.getThreads();
        const thread = threads.find((t: any) => t.id === this._activeThreadId);
        if (thread && thread.title && thread.title !== 'New Session' && thread.title !== 'New Conversation') return; // Already has a title

        try {
            let title = '';
            const req = {
                system: 'You are a helpful assistant. Generate a concise, 3-5 word title for the following conversation prompt. DO NOT include quotes or punctuation.',
                messages: [{ role: 'user' as const, content: userPrompt }]
            };
            
            await LLMClient.streamAgentTurn(modelConfig, req, (token) => {
                title += token;
            });
            
            if (title) {
                const finalTitle = title.trim().replace(/^["']|["']$/g, '');
                if (thread) {
                    await this._historyStore.saveThread(thread.id, finalTitle, thread.messages || []);
                } else {
                    await this._historyStore.saveThread(this._activeThreadId, finalTitle, []);
                }
                
                if (this._view) {
                    this._view.webview.postMessage({ type: 'loadHistory', value: this._historyStore.getThreads() });
                }
            }
        } catch (e: any) {
            console.error('[Title] Error generating title:', e);
        }
    }

    /**
     * Schedule a background agent task with a re-entrancy guard. The scheduled run
     * inherits the mode it was scheduled from — otherwise a read-only session could
     * schedule its way into a full-access Agent run.
     */
    private _scheduleAgentTask(tc: ToolCall, modelId: string, webview: vscode.Webview, mode: AgentMode) {
        const a = tc.arguments || {};
        const id = a.name || `schedule-${Date.now()}`;
        const run = () => {
            if (this._isGenerating) { webview.postMessage({ type: 'log', value: `[Scheduler] Skipped "${id}" — agent busy.` }); return; }
            webview.postMessage({ type: 'log', value: `[Scheduler] Running "${id}" in ${mode} mode...` });
            this._runAgentTask(a.taskPrompt, modelId, undefined, mode);
        };
        if (a.type === 'recurring') this._scheduler.scheduleRecurring(id, id, a.intervalMs || 60000, run, a.maxRuns);
        else this._scheduler.scheduleOnce(id, id, a.intervalMs || 60000, run);
    }

    public showSettings() {
        if (this._view) {
            this._view.show(true);
            this._view.webview.postMessage({ type: 'navToSettings' });
        } else {
            vscode.commands.executeCommand('workbench.view.extension.black-ide-chat').then(() => {
                setTimeout(() => {
                    if (this._view) {
                        this._view.show(true);
                        this._view.webview.postMessage({ type: 'navToSettings' });
                    }
                }, 500);
            });
        }
    }

    public async generateCommitMessage() {
        const rootPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!rootPath) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        const gitExtension = vscode.extensions.getExtension<any>('vscode.git')?.exports;
        if (!gitExtension) {
            vscode.window.showErrorMessage('Git extension not found');
            return;
        }

        const git = gitExtension.getAPI(1);
        const repo = git.repositories[0];
        if (!repo) {
            vscode.window.showErrorMessage('No Git repository found in workspace');
            return;
        }

        const { exec } = require('child_process');

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Generating commit message...",
            cancellable: false
        }, async () => {
            return new Promise<void>((resolve) => {
                // Get git status porcelain to find all changes (including untracked files)
                exec('git status --porcelain', { cwd: rootPath }, async (err: any, statusOut: string) => {
                    const lines = (statusOut || '').trim().split(/\r?\n/).filter(line => line.trim());
                    if (lines.length === 0) {
                        vscode.window.showInformationMessage('No changes detected to generate commit message.');
                        resolve();
                        return;
                    }

                    const untrackedFiles: string[] = [];
                    const trackedChanges: string[] = [];

                    for (const line of lines) {
                        const status = line.slice(0, 2);
                        const filePath = line.slice(3).replace(/^"|"$/g, '').trim();

                        if (status === '??') {
                            untrackedFiles.push(filePath);
                        } else {
                            trackedChanges.push(filePath);
                        }
                    }

                    // 1. Get diff of tracked files (both staged and unstaged against HEAD)
                    const getTrackedDiff = () => {
                        return new Promise<string>((res) => {
                            if (trackedChanges.length === 0) {
                                res('');
                                return;
                            }
                            exec('git diff HEAD', { cwd: rootPath }, (errDiff: any, stdoutDiff: string) => {
                                res(stdoutDiff || '');
                            });
                        });
                    };

                    // 2. Read contents of untracked files to construct mock diffs
                    const getUntrackedDiffs = () => {
                        let untrackedDiff = '';
                        for (const file of untrackedFiles) {
                            try {
                                const absPath = path.join(rootPath, file);
                                if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
                                    const content = fs.readFileSync(absPath, 'utf8');
                                    // limit size to prevent context overflow (e.g. max 10KB per untracked file)
                                    const preview = content.length > 10000 ? content.slice(0, 10000) + '\n... (truncated)' : content;
                                    untrackedDiff += `\n\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${preview.split('\n').length} @@\n`;
                                    untrackedDiff += preview.split('\n').map(l => '+' + l).join('\n');
                                }
                            } catch (e) {
                                // skip unreadable files
                            }
                        }
                        return untrackedDiff;
                    };

                    const trackedDiff = await getTrackedDiff();
                    const untrackedDiff = getUntrackedDiffs();

                    const diffContent = (trackedDiff + untrackedDiff).trim();

                    if (!diffContent) {
                        vscode.window.showInformationMessage('No readable changes detected.');
                        resolve();
                        return;
                    }

                    await this._requestLlmCommitMessage(diffContent, repo, resolve);
                });
            });
        });
    }

    private async _requestLlmCommitMessage(diff: string, repo: any, resolve: () => void) {
        try {
            const configJson = await this._secretManager.getKey('llm-config');
            if (!configJson) {
                vscode.window.showErrorMessage('No LLM configurations found. Please configure models in settings.');
                resolve();
                return;
            }

            const configs: LLMConfigEntry[] = JSON.parse(configJson);
            let activeModelId = '';
            try {
                const settingsRaw = await this._secretManager.getKey('general-settings');
                if (settingsRaw) {
                    const settings = JSON.parse(settingsRaw);
                    activeModelId = settings.selectedModelId || '';
                }
            } catch {}

            const modelConfig = configs.find(c => c.id === activeModelId) || configs.find(c => c.enabled !== false) || configs[0];
            if (!modelConfig) {
                vscode.window.showErrorMessage('No active or enabled model configured');
                resolve();
                return;
            }

            const prompt = `You are an expert developer. Generate a concise, high-quality git commit message following the Conventional Commits specification for the following changes. Do not include any explanations, greetings, markdown formatting, or bullet points. Output ONLY the raw commit message itself, in a single line if possible, or with a description if the changes are complex.

Here is the git diff:
${diff}`;

            let commitMessage = '';
            await LLMClient.streamCompletion(modelConfig, prompt, (token) => {
                commitMessage += token;
            });

            if (commitMessage) {
                repo.inputBox.value = commitMessage.trim();
            } else {
                vscode.window.showWarningMessage('Empty commit message generated.');
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to generate commit message: ${err.message}`);
        } finally {
            resolve();
        }
    }

    public getHtmlForWebview(webview: vscode.Webview, viewType: 'chat' | 'settings' | 'manager' = 'chat'): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'dist', 'webview', 'assets', 'index.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'dist', 'webview', 'assets', 'index.css'));
        const avatarUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'resources', 'agent-avatar.png'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Black IDE Assistant</title>
    <link href="${styleUri}" rel="stylesheet" />
    <script>
        window.agentAvatarUri = "${avatarUri}";
        window.isSettingsPanel = ${viewType === 'settings'};
        window.isManagerPanel = ${viewType === 'manager'};
    </script>
</head>
<body class="bg-background text-white select-none">
    <div id="root"></div>
    <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
