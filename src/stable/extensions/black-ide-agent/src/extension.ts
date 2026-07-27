import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ─── Module Imports ─────────────────────────────────────────────────────────
import { SecretManager } from './core/secret-manager';
import { LLMClient } from './core/llm-client';
import { AgentMode, LLMConfigEntry, ChatMessage, ToolCall, ToolResult } from './core/types';
import { TokenTracker } from './core/token-tracker';
import { BlackIdeInlineCompletionProvider } from './core/inline-completion';
import { buildPipelineContextSummary } from './agent/pipeline-orchestrator';
import { CheckpointManager, diffStat } from './core/checkpoint-manager';
import { CommandPolicy } from './core/command-policy';
import { CodebaseIndex } from './core/codebase-index';
import { EventBus } from './core/event-bus';
import { TelemetrySink } from './core/telemetry-sink';
import { PipelineRunSummary, reconcileInterruptedRuns, capRunHistory, mergeRunViews } from './core/pipeline-runs';
import { KnowledgeBase, summarizeRepoStructure } from './core/knowledge-base';
import { SessionManager } from './core/session-manager';
import { HistoryStore } from './memory/history-store';
import { ModeLoader } from './core/mode-loader';
import { PlanningEngine } from './agent/planning-engine';
import { detectProjectProfile, formatProfileLine, MANIFEST_FILENAMES, ProjectProfile, stackMindmapSection, upsertMarkdownSection, STACK_MINDMAP_HEADING } from './core/project-profiler';
import { AgentScheduler } from './agent/scheduler';
import { ApprovalRequest } from './agent/tool-executor';
import { generateCommitMessage as generateCommitMessageCore } from './core/commit-message';
import { getHtmlForWebview as buildWebviewHtml } from './core/webview-html';
import { SettingsPanel } from './core/settings-panel';
import { ManagerPanel } from './core/manager-panel';
import { registerCommands } from './core/command-registry';
import { runPipelineCore, buildApprovalGate, trackAndEmitUsage } from './agent/pipeline-entry';
import { SkillDiagnostics } from './agent/skill-diagnostics';
import { ChatSession } from './core/chat-session';
import { RulesLoader } from './core/rules-loader';
import { PromptLibrary } from './core/prompt-library-loader';
import { runAgentTask, pruneForPersistence } from './agent/chat-task';
import { handleWebviewMessage, WebviewMessageHost } from './core/webview-message-handler';

// ─── Extension Activation ───────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    console.log('Black IDE Agent active!');

    const secretManager = new SecretManager(context.secrets);
    const historyStore = new HistoryStore(context.workspaceState);

    // Declared before the provider because the provider's settings callback opens the
    // panel, and the panel's host is the provider — assigned immediately below.
    let settingsPanel: SettingsPanel | undefined;

    const provider = new BlackIdeChatProvider(context, secretManager, historyStore, () => settingsPanel?.open());

    settingsPanel = new SettingsPanel(context, secretManager, provider);
    const managerPanel = new ManagerPanel(context, secretManager, provider);

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

    registerCommands(context, secretManager, provider, {
        openSettingsPanel: () => settingsPanel!.open(),
        openManagerPanel: () => managerPanel.open(),
    });
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
    /**
     * All mutable state for this chat lane. A single object rather than a set of
     * fields so the chat task can be moved out of this file without readers seeing
     * a stale snapshot after it reassigns `conversation` — see core/chat-session.ts.
     */
    private readonly _session = new ChatSession();
    private readonly _scheduler = new AgentScheduler();

    // Infrastructure lives for the whole session, not one task. Checkpoints and the
    // codebase index are only useful if they outlive the run that created them.
    private readonly _bus = new EventBus();
    private readonly _sessions: SessionManager;
    private readonly _checkpoints: CheckpointManager;
    private readonly _index: CodebaseIndex;
    private readonly _modeLoader: ModeLoader;
    /** Long-lived owner of the skills Problems-panel collection (per-task managers must not own one). */
    private readonly _skillDiagnostics = new SkillDiagnostics();
    /**
     * Rules v2 (Phase 2). Long-lived because it owns a Problems-panel collection and
     * file watchers; the per-turn selection happens in the chat task.
     */
    private readonly _rulesLoader = new RulesLoader();
    /** User-defined slash commands (Phase 2, M12). Same lifecycle as rules. */
    private readonly _promptLibrary = new PromptLibrary();

    /** Prior turns, replayed into each task so the agent remembers the conversation. */
    /** Active thread identity, used to key conversation persistence in Memento. */

    /** Pending plan approval state — survives between the two loop invocations (Antigravity pattern). */

    /**
     * Pending pipeline-plan approval — mirrors _pendingApproval's role but for
     * PipelineOrchestrator.run(), which is awaiting a live Promise<boolean> rather
     * than being safe to simply re-invoke. Only survives an extension-host restart
     * as poorly as the native dialog it replaced did; a webview-only reload is fine
     * since the resolver reference stays alive in this class instance.
     */

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

        // Owned by the extension lifetime so the Problems-panel collection is torn down
        // on deactivate rather than lingering with stale skill warnings.
        _context.subscriptions.push(this._skillDiagnostics);
        _context.subscriptions.push(this._rulesLoader);
        _context.subscriptions.push(this._promptLibrary);

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

    /** Absolute path to the bundled built-in skill packs shipped with the extension. */
    private get _bundledSkillsDir(): string {
        return path.join(this._context.extensionUri.fsPath, 'resources', 'skills');
    }

    /** Cached project profile (Phase 1). Detected once per window, refreshed lazily. */
    private _projectProfile?: ProjectProfile;

    /**
     * Detect the project's stack from its manifests (package.json, Cargo.toml, *.csproj, …) so the
     * skill resolver can pick stack-appropriate packs. Cached; best-effort — any failure yields an
     * empty profile, which simply means "inject no stack skills" (fail safe).
     */
    private async _getProjectProfile(): Promise<ProjectProfile> {
        if (this._projectProfile) return this._projectProfile;
        const empty: ProjectProfile = { languages: [], frameworks: [], testFrameworks: [], packageManagers: [], stacks: [], confidence: 0, evidence: [] };
        try {
            const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!rootPath) return empty;

            const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,out,build,.next,coverage,vendor,target,bin,obj}/**', 4000);
            const files = uris.map(u => vscode.workspace.asRelativePath(u));

            const manifests: Record<string, string> = {};
            const readIfExists = (rel: string, key: string) => {
                try { manifests[key] = fs.readFileSync(path.join(rootPath, rel), 'utf8'); } catch { /* absent */ }
            };
            for (const name of MANIFEST_FILENAMES) readIfExists(name, name);
            // Globbed manifests: grab the first .csproj/.sln content, if any.
            const csproj = files.find(f => /\.csproj$/i.test(f));
            if (csproj) readIfExists(csproj, 'csproj');
            const sln = files.find(f => /\.sln$/i.test(f));
            if (sln) readIfExists(sln, 'sln');

            this._projectProfile = detectProjectProfile(files, manifests);
            if (this._projectProfile.stacks.length) {
                console.log(`[Profiler] Detected stack — ${formatProfileLine(this._projectProfile)}`);
            }
            return this._projectProfile;
        } catch {
            return empty;
        }
    }

    /**
     * Sync the detected stack into the project mindmap as a stable, idempotent section (Phase 5),
     * so the "Project Stack & Conventions" block reflects reality and re-syncing never duplicates
     * it. Best-effort; a mindmap write must never break a run.
     */
    private _syncStackToMindmap(profile: ProjectProfile, rootPath: string): void {
        try {
            const section = stackMindmapSection(profile);
            if (!section) return;
            const mindmapPath = path.join(rootPath, '.blackIDE', 'mindmap', 'project_mindmap.md');
            fs.mkdirSync(path.dirname(mindmapPath), { recursive: true });
            const existing = fs.existsSync(mindmapPath) ? fs.readFileSync(mindmapPath, 'utf8') : '';
            fs.writeFileSync(mindmapPath, upsertMarkdownSection(existing, STACK_MINDMAP_HEADING, section), 'utf8');
        } catch { /* mindmap sync is best-effort */ }
    }

    /** Reads the anonymous-telemetry toggle from settings into the cached flag. */
    private async _refreshTelemetryEnabled(): Promise<void> {
        try {
            const s = await this._secretManager.getKey('general-settings');
            if (s) this._telemetryEnabled = JSON.parse(s).allowAnonymousTelemetry !== false;
        } catch { /* keep the default */ }
    }

    /**
     * Adapter onto `WebviewMessageHost`. The provider's members are private and
     * underscore-prefixed, so it cannot satisfy the interface structurally; naming the
     * mapping here keeps the router's dependencies explicit. Rebuilt per message, which
     * is what keeps `view` current — `session` is the same object either way.
     */
    /**
     * Rule metadata for the session panel. Deliberately excludes rule bodies: the panel
     * shows what is available and what fired, and shipping every body to the webview on
     * every reload would be pointless traffic.
     */
    private _ruleSummaries() {
        return this._rulesLoader.getRules().map(r => ({
            name: r.name,
            description: r.description,
            activation: r.activation,
            scope: r.scope,
            globs: r.globs,
            file: r.file,
        }));
    }

    private get _webviewHost(): WebviewMessageHost {
        return {
            session: this._session,
            view: this._view,
            context: this._context,
            secretManager: this._secretManager,
            historyStore: this._historyStore,
            checkpoints: this._checkpoints,
            modeLoader: this._modeLoader,
            sessions: this._sessions,
            onOpenSettings: this._onOpenSettings,
            promptLibrary: this._promptLibrary,
            rules: this._rulesLoader.getRules(),
            getHtmlForWebview: (wv, vt) => this.getHtmlForWebview(wv, vt),
            getActiveEditorSelectionContext: () => this._getActiveEditorSelectionContext(),
            postCheckpoints: (wv) => this._postCheckpoints(wv),
            reportUndo: (r, wv) => this._reportUndo(r, wv),
            refreshTelemetryEnabled: () => this._refreshTelemetryEnabled(),
            runAgentTask: (p, m, a, mo) => this._runAgentTask(p, m, a, mo),
            runAgentTaskExecution: (op, m, pc, tc, a, mo) => this._runAgentTaskExecution(op, m, pc, tc, a, mo),
            runPipeline: (p, m) => this._runPipeline(p, m),
            exportDiagnostics: () => this.exportDiagnostics(),
        };
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
        this._session.conversation = this._historyStore.getConversationState(this._session.activeThreadId) || [];

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

        // Rules v2: same lifecycle as modes — load once, then hot-reload on save so an
        // edited rule takes effect on the next turn without a window reload.
        const postRules = () => webviewView.webview.postMessage({ type: 'rulesLoaded', value: this._ruleSummaries() });
        void this._rulesLoader.loadAll(rootPath).then(postRules);
        this._rulesLoader.watchForChanges(rootPath, postRules);

        const postPrompts = () => webviewView.webview.postMessage({
            type: 'promptsLoaded',
            value: this._promptLibrary.getAll().map(p => ({ name: p.name, description: p.description, steps: p.steps })),
        });
        void this._promptLibrary.loadAll(rootPath).then(postPrompts);
        this._promptLibrary.watchForChanges(rootPath, postPrompts);

        // Restore pending plan approval if it survived a window reload (Antigravity pattern)
        try {
            const pendingRaw = this._historyStore.getConversationState(`pending-plan-${this._session.activeThreadId}`);
            if (pendingRaw && pendingRaw.length > 0) {
                const pending = JSON.parse(pendingRaw[0].content);
                this._session.pendingApproval = pending;
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
            await handleWebviewMessage(this._webviewHost, webviewView.webview, data);
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
        return trackAndEmitUsage(tokenTracker, model, promptChars, response, emit);
    }

    private _buildApprovalGate(opts: {
        settings: any;
        interactive: boolean;
        log: (m: string) => void;
    }): (req: ApprovalRequest) => Promise<boolean> {
        return buildApprovalGate(opts);
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

        this._session.abortController?.abort();
        const controller = new AbortController();
        this._session.abortController = controller;
        this._session.isGenerating = true;

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
                    this._session.pendingPipelineApproval = { planContent, planPath, resolve };
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
                    this._session.conversation.push(
                        { role: 'user', content: userPrompt },
                        { role: 'assistant', content: buildPipelineContextSummary(overviewContent) },
                    );
                    await this._historyStore.setConversationState(
                        this._session.activeThreadId, pruneForPersistence(this._session.conversation));
                    if (modelConfig) {
                        this._generateConversationTitle(userPrompt, modelConfig).catch(() => {});
                    }
                } catch { /* context splice is best-effort; never fail the run over it */ }
            }
        } finally {
            this._session.isGenerating = false;
        }
    }

    /**
     * Shared pipeline mechanics — model/settings resolution, worktree-aware executor
     * wiring, and the PipelineOrchestrator invocation itself. Deliberately takes no
     * dependency on `this._view`/`this._session.abortController`/`this._session.isGenerating`/
     * `this._session.pendingPipelineApproval`: every caller-specific concern (where events go,
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
        return runPipelineCore({
            context: this._context,
            secretManager: this._secretManager,
            modeLoader: this._modeLoader,
            codebaseIndex: this._index,
            bundledSkillsDir: this._bundledSkillsDir,
            getProjectProfile: () => this._getProjectProfile(),
            syncStackToMindmap: (profile, rootPath) => this._syncStackToMindmap(profile, rootPath),
        }, params);
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
        return runAgentTask({
            context: this._context,
            secretManager: this._secretManager,
            historyStore: this._historyStore,
            checkpoints: this._checkpoints,
            codebaseIndex: this._index,
            modeLoader: this._modeLoader,
            sessions: this._sessions,
            scheduler: this._scheduler,
            skillDiagnostics: this._skillDiagnostics,
            bundledSkillsDir: this._bundledSkillsDir,
            session: this._session,
            rules: this._rulesLoader.getRules(),
            view: this._view,
            getProjectProfile: () => this._getProjectProfile(),
            generateConversationTitle: (p, m) => this._generateConversationTitle(p, m),
            scheduleAgentTask: (tc, id, wv, m) => this._scheduleAgentTask(tc, id, wv, m),
        }, userPrompt, modelId, attachments, mode);
    }

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
        if (!this._session.activeThreadId) return;
        const threads = this._historyStore.getThreads();
        const thread = threads.find((t: any) => t.id === this._session.activeThreadId);
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
                    await this._historyStore.saveThread(this._session.activeThreadId, finalTitle, []);
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
            if (this._session.isGenerating) { webview.postMessage({ type: 'log', value: `[Scheduler] Skipped "${id}" — agent busy.` }); return; }
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
        return generateCommitMessageCore(this._secretManager);
    }

    public getHtmlForWebview(webview: vscode.Webview, viewType: 'chat' | 'settings' | 'manager' = 'chat'): string {
        return buildWebviewHtml(webview, this._context.extensionUri, viewType);
    }
}
