import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ─── Module Imports ─────────────────────────────────────────────────────────
import { SecretManager } from '@blackide/agent-core/core/secret-manager';
import { AgentMode, ToolCall } from '@blackide/agent-core/core/types';
import { registerEditorFeatures } from './core/editor-features';
import { compactSession } from './core/compact-session';
import { ArtifactStore } from './agent/artifact-store';
import { MemoryTurn } from './agent/memory-turn';
import { buildMemoryTurn } from './core/memory-setup';
import { CheckpointManager, diffStat } from './core/checkpoint-manager';
import { CodebaseIndex } from '@blackide/agent-core/core/codebase-index';
import { EventBus } from './core/event-bus';
import { TelemetrySink } from './core/telemetry-sink';
import { PipelineRunSummary } from '@blackide/agent-core/core/pipeline-runs';
import { seedArchitectureOnce } from './core/architecture-seed';
import { SessionManager } from './core/session-manager';
import { HistoryStore } from './memory/history-store';
import { ModeLoader } from './core/mode-loader';
import { PlanningEngine } from './agent/planning-engine';
import { ProjectProfile, stackMindmapSection, upsertMarkdownSection, STACK_MINDMAP_HEADING } from '@blackide/agent-core/core/project-profiler';
import { ProjectProfileCache } from './core/project-profile-cache';
import { AgentScheduler } from './agent/scheduler';
import { generateCommitMessage as generateCommitMessageCore } from './core/commit-message';
import { getHtmlForWebview as buildWebviewHtml } from './core/webview-html';
import { SettingsPanel } from './core/settings-panel';
import { ManagerPanel } from './core/manager-panel';
import { Office, OfficeHub, createOffice } from './core/office-setup';
import { registerCommands } from './core/command-registry';
import { registerReviewCommand } from './core/review-command';
import { runPipelineCore, runChatPipeline, PipelineCoreDeps } from './agent/pipeline-entry';
import { ManagedRunRegistry } from './agent/managed-runs';
import { buildChatTaskDeps } from './core/chat-task-setup';
import { SkillDiagnostics } from './agent/skill-diagnostics';
import { ChatSession } from './core/chat-session';
import { RulesLoader } from './core/rules-loader';
import { buildContextProviders, currentWorkspaceRoot, docsAndWebSources } from './core/context-provider-setup';
import { DocsStore } from './core/docs-index';
import { TerminalHistory, ContextProviderRegistry } from './core/context-providers';
import { SkillsManager } from '@blackide/agent-core/agent/skills-manager';
import { PromptLibrary } from './core/prompt-library-loader';
import { runAgentTask } from './agent/chat-task';
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

    // Inline completion + next-edit prediction (Phase 5, M28) — see core/editor-features.ts.
    registerEditorFeatures(context, secretManager, { codeGraph: () => provider.codeGraph });

    registerCommands(context, secretManager, provider, {
        openSettingsPanel: () => settingsPanel!.open(),
        openManagerPanel: () => managerPanel.open(),
    }, provider.docsStore);

    // Reviewer mode's palette entry (Phase 9, M47). Registered separately because it
    // needs the artifact store and the checkpoint manager, and threading two more
    // parameters through `registerCommands` for one command would make every future
    // command's dependencies that command's problem too.
    registerReviewCommand(context, {
        secretManager,
        artifacts: provider.artifacts,
        checkpoints: provider.checkpoints,
    });
}

export function deactivate() {}

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
    private readonly _docsStore: DocsStore;
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

    /** Recent agent-run commands, feeding the `@terminal` provider (Phase 3, M19). */
    private readonly _terminalHistory = new TerminalHistory();

    /** Task agents, the governor, the inbox and the Office watching them (Phase 6 · M74–M77). */
    private _office!: Office;

    /** Typed artifacts and their review comments (Phase 7, M38). */
    private readonly _artifacts: ArtifactStore;

    /** Durable memory across turns (Phase 8, M41). Absent with no workspace open. */
    private readonly _memory: MemoryTurn | undefined;

    /**
     * `@`-mention providers (Phase 3, M19). Assembled in the constructor rather than
     * here because it needs `_historyStore`, which arrives as a constructor
     * parameter — a field initializer would read it before it is assigned.
     */
    private _contextProviders!: ContextProviderRegistry;

    /** Skills for the `@skills` provider. Discovered once, refreshed on settings save. */
    private readonly _skillsForMentions = new SkillsManager();

    /**
     * The Manager panel's concurrency lane — every run the user launches there, plus
     * its durable history. A separate lane from `_session` by design: a Manager run
     * must never touch the chat's streaming state. See agent/managed-runs.ts.
     */
    private readonly _managedRuns: ManagedRunRegistry;

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

        this._artifacts = new ArtifactStore(_context);
        this._memory = buildMemoryTurn(_secretManager, m => console.log(m));
        this._sessions = new SessionManager(this._bus);
        this._checkpoints = new CheckpointManager(storageDir);
        /*
         * The editor's own file index, not a directory walk (M62 · P11-1).
         *
         * `CodebaseIndex` no longer reaches for `vscode` itself, but the editor still
         * supplies `findFiles` here rather than falling back to `directoryFileSource` —
         * and that is not just about the boundary. The editor's index already honours the
         * user's `files.exclude` and their `.gitignore`, so a walk would quietly index
         * the things they told the editor to hide.
         */
        this._index = new CodebaseIndex(storageDir, {
            find: async (limit) => (await vscode.workspace.findFiles(
                '**/*', '**/{node_modules,dist,out,build,.git}/**', limit,
            )).map(u => u.fsPath),
            relative: (absolute) => vscode.workspace.asRelativePath(absolute),
        });
        // Doc sets live in extension storage, not the user's repo: a crawl is a cache of
        // somebody else's content (Phase 3, M20).
        this._docsStore = new DocsStore(path.join(storageDir, 'docs'));
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

        // The single place the runtime meets the UI. Every subsystem publishes to the bus;
        // the webview is one subscriber, so adding a consumer never means threading a
        // callback through the loop. The journal is the newest (M82) — and is what stops a
        // closed panel destroying the evidence of a run.
        this._bus.onAny((event) => {
            this._view?.webview.postMessage({ type: 'agentEvent', value: event });
            this._telemetry.record(event);
            this._office?.hub.journalEvent(event.taskId, 'chat', event);
        });

        // Reads and reconciles the persisted run history in its constructor, so runs a
        // reload interrupted show as 'failed' rather than as ghost "running" rows.
        this._managedRuns = new ManagedRunRegistry({
            context: this._context,
            runPipelineCore: (params) => runPipelineCore(this._pipelineCoreDeps, params),
            onRunEvent: (runId, e) => this._office?.hub.journalEvent(runId, 'pipeline', e),
        });

        // Phase 6 and the Office watching it, after `_managedRuns`: the inbox reads both lanes.
        this._office = createOffice({
            context: _context, secretManager: _secretManager,
            codebaseIndex: this._index, modeLoader: this._modeLoader,
            artifacts: this._artifacts,
            getProjectProfile: () => this._getProjectProfile(),
            log: (m) => console.log(m),
            listPipelineRuns: () => this._managedRuns.list(),
        });

        this._contextProviders = buildContextProviders({
            getRules: () => this._rulesLoader.getRules(),
            getSkills: () => this._skillsForMentions.getAll(),
            historyStore: this._historyStore,
            terminalHistory: this._terminalHistory,
            workspaceRoot: currentWorkspaceRoot,
            codeGraph: () => this._index.graph,
            // `@docs` and `@web` (Phase 3, M20/M21) — assembled in the provider-setup
            // module, which is also what keeps this file inside the ≤700 LOC gate.
            ...docsAndWebSources(this._docsStore, _secretManager),
        });
        // Best-effort: the dropdown simply offers no skills until discovery lands.
        this._skillsForMentions.discover(this._bundledSkillsDir, currentWorkspaceRoot()).catch(() => {});

        // Seed the knowledge base's architecture.md from a first-run repo scan, so the
        // read side (KnowledgeBase.readContext) has real content to inject on the very
        // first task instead of an empty header. Fire-and-forget: nothing about activation
        // should wait on, or fail because of, a best-effort scan.
        void seedArchitectureOnce(this._context);
    }

    /** Absolute path to the bundled built-in skill packs shipped with the extension. */
    private get _bundledSkillsDir(): string {
        return path.join(this._context.extensionUri.fsPath, 'resources', 'skills');
    }

    /** Cached project profile (Phase 1). Detected once per window, refreshed lazily. */
    /** Per-root stack detection (Phase 6, M36). */
    private readonly _profiles = new ProjectProfileCache();

    /**
     * The project's stack, per workspace root (Phase 6, M36).
     *
     * Delegates to `core/project-profile-cache.ts`, which answers about the root the user
     * is actually in rather than about folder zero — see that file for what the old
     * single-profile version did to a two-root workspace.
     */
    private _getProjectProfile(): Promise<ProjectProfile> {
        return this._profiles.current();
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
    /**
     * Search configuration for `@web` and the `web_search` tool (Phase 3, M21).
     *
     * Read on demand rather than cached: a key added in Settings must work on the next
     * turn, and a stale cached "no key" would look like the key was rejected. Keys are in
     * `SecretStorage` with the model config (G2), never in settings.json.
     */
    /** The `@docs` store, shared with the `black-ide.addDocs` command (Phase 3, M20). */
    public get docsStore(): DocsStore { return this._docsStore; }

    /**
     * Detected stacks for the commands that key off them.
     *
     * `CommandHost.detectedStacks` has been declared optional and never implemented since
     * Phase 3, so `black-ide.addDocs` has always called it, always got `undefined`, and
     * always offered zero suggestions — M20's "suggest doc sets from the detected stack"
     * was wired to a method nobody wrote. Phase 5's terminal Cmd+K became the second
     * caller, which is what surfaced it.
     */
    public async detectedStacks(): Promise<string[]> {
        return (await this._getProjectProfile()).stacks;
    }

    /** The Phase 6 lane: task agents, governor, inbox, race. */
    public get taskAgents(): Office['lane'] { return this._office.lane; }
    public get office(): OfficeHub { return this._office.hub; } // desks + journal (M74–M82)

    /** Typed artifacts, for the review surface (Phase 7, M38). */
    public get artifacts(): ArtifactStore { return this._artifacts; }

    /** Checkpoints, so M47's offered fixes are undoable through the existing timeline. */
    public get checkpoints(): CheckpointManager { return this._checkpoints; }

    /** `/compact`'s palette twin (Phase 5, M30) — same path as the slash command. */
    public compactConversation() {
        return compactSession({ session: this._session, secretManager: this._secretManager, historyStore: this._historyStore, webview: this.activeWebview });
    }

    /**
     * Phase 3's code graph, for next-edit's one-hop neighbourhood (Phase 5, M28). Exposed
     * rather than handed a second index: two indexes over the same repo disagree the
     * moment one rebuilds, and prediction must see the edges `impact_analysis` sees.
     */
    public get codeGraph() { return this._index.graph; }

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
            contextProviders: this._contextProviders,
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
    // Mechanics live in agent/pipeline-entry.ts (shared by both lanes) and the
    // Manager lane's state lives in agent/managed-runs.ts. What stays here is only
    // the wiring: which provider members each one reads.

    /** Dependencies of the shared pipeline core — exactly the members it reads, mutating none. */
    private get _pipelineCoreDeps(): PipelineCoreDeps {
        return {
            context: this._context,
            secretManager: this._secretManager,
            modeLoader: this._modeLoader,
            codebaseIndex: this._index,
            bundledSkillsDir: this._bundledSkillsDir,
            getProjectProfile: () => this._getProjectProfile(),
            syncStackToMindmap: (profile, rootPath) => this._syncStackToMindmap(profile, rootPath),
            artifacts: this._artifacts,
        };
    }

    /** Chat-sidebar pipeline run. Owns the chat lane's abort/approval state via `_session`. */
    private async _runPipeline(userPrompt: string, modelId: string) {
        return runChatPipeline({
            ...this._pipelineCoreDeps,
            session: this._session,
            sessions: this._sessions,
            historyStore: this._historyStore,
            view: this._view,
        }, userPrompt, modelId);
    }

    // ─── Manager Panel: concurrent pipeline run tracking ────────────────
    // Public surface the Manager webview panel (registered in activate()) calls into.
    // The registry owns the run state; these five methods exist because ManagerPanelHost
    // is declared against the provider.

    public startManagedPipelineRun(prompt: string, modelId: string, managerWebview: vscode.Webview): { runId: string } | { error: string } {
        return this._managedRuns.start(prompt, modelId, managerWebview);
    }

    public cancelManagedPipelineRun(runId: string): void { this._managedRuns.cancel(runId); }

    public approveManagedPipelineRun(runId: string): void { this._managedRuns.approve(runId); }

    public rejectManagedPipelineRun(runId: string): void { this._managedRuns.reject(runId); }

    public listManagedPipelineRuns(): PipelineRunSummary[] { return this._managedRuns.list(); }

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
        return runAgentTask(buildChatTaskDeps({
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
            terminalHistory: this._terminalHistory,
            contextProviders: this._contextProviders,
            view: this._view,
            artifacts: this._artifacts,
            memoryTurn: this._memory,
            office: this._office?.hub,
            getProjectProfile: () => this._getProjectProfile(),
            scheduleAgentTask: (tc, id, wv, m) => this._scheduleAgentTask(tc, id, wv, m),
        }), userPrompt, modelId, attachments, mode);
    }

    /**
     * The durable-memory loop (Phase 8, M41 · P8-1), owned here rather than per turn.
     *
     * Its confirm queue is read by the memory panel *between* runs, so a per-turn
     * instance would empty it every time — the candidates would be produced, banded,
     * queued, and thrown away before anything could show them.
     */
    public get memory(): MemoryTurn | undefined { return this._memory; }

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
