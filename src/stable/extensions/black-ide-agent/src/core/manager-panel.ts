import * as vscode from 'vscode';
import * as fs from 'fs';
import { SecretManager } from '@blackide/agent-core/core/secret-manager';
import { PipelineRunSummary } from '@blackide/agent-core/core/pipeline-runs';
import { TaskAgentSummary } from '@blackide/agent-core/core/task-agents';
import { ArtifactRecord, ArtifactType } from './artifacts';
import { buildReviewView, reviewCounts, routeComment } from './artifact-review';
import { buildMemoryView } from './memory-view';
import { MemoryEntry } from '@blackide/agent-core/core/memory-model';
import { ExtractionCandidate } from '@blackide/agent-core/core/memory-lifecycle';

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
        /** Ids of agents that still have a turn left to steer (Phase 7, M38/M39). */
        liveIds(): string[];
    };
    /**
     * The durable-memory loop (Phase 8, M45). Structurally typed for the same reason
     * `taskAgents` and `artifacts` are, and optional because a window with no workspace
     * folder open has no memory file to show.
     */
    readonly memory?: {
        entries(): MemoryEntry[];
        readonly pending: ExtractionCandidate[];
        readonly filePath: string;
        confirm(text: string): MemoryEntry[];
        reject(text: string): void;
    };
    /**
     * The typed artifact store (Phase 7, M38). Structurally typed rather than imported so
     * this file stays free of `agent/` imports, exactly as `taskAgents` does.
     */
    readonly artifacts: {
        readonly directory: string;
        list(): ArtifactRecord[];
        comment(artifactId: string, text: string, region?: string): ArtifactRecord | undefined;
        markCommentsDelivered(artifactId: string, commentIds: string[]): void;
        open(record: ArtifactRecord): Promise<void>;
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
                    vscode.Uri.joinPath(this._context.extensionUri, 'resources'),
                    // The artifact directory, so the review panel can render a screenshot
                    // inline (M38). Scoped to that one directory rather than opened to the
                    // workspace: a review surface has no business reading the repository,
                    // and a webview root is a read grant, not a hint.
                    vscode.Uri.file(this._host.artifacts.directory),
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
                // ── The artifact review panel (Phase 7, M38) ────────────────
                case 'listArtifacts':
                    this.postArtifacts(data.value?.type);
                    break;
                case 'readArtifact': {
                    // Text is read here rather than shipped with the listing: a run's
                    // artifacts include diffs and plans, and pushing every body into the
                    // webview on every sync would send megabytes to render one card.
                    const record = this.findArtifact(data.value?.artifactId);
                    if (!record) break;
                    let content = '';
                    let error: string | undefined;
                    try {
                        content = fs.readFileSync(record.path, 'utf8');
                    } catch (err: any) {
                        // The index is a cache and the file is the truth; a record whose
                        // file is gone is a real state, and saying so beats an empty pane.
                        error = `This artifact's file could not be read: ${err?.message || err}`;
                    }
                    this._panel.webview.postMessage({
                        type: 'artifactContentSync',
                        value: { artifactId: record.id, content, error },
                    });
                    break;
                }
                case 'openArtifact': {
                    const record = this.findArtifact(data.value?.artifactId);
                    if (record) await this._host.artifacts.open(record);
                    break;
                }
                /*
                 * Comment on an artifact region → the running agent (M38 → M39).
                 *
                 * The path this panel exists to provide. The comment is persisted on the
                 * artifact **first**, so it survives whether or not anything is running,
                 * and is marked delivered only once the steering queue has actually taken
                 * it — a comment recorded as delivered that never reached an agent is the
                 * one outcome a review surface must not produce.
                 */
                case 'commentArtifact': {
                    const record = this.findArtifact(data.value?.artifactId);
                    if (!record) break;

                    const routing = routeComment({
                        artifact: record,
                        text: data.value?.text || '',
                        region: data.value?.region,
                        liveRunIds: this._host.taskAgents.liveIds(),
                    });

                    const updated = this._host.artifacts.comment(record.id, data.value?.text || '', routing.note?.region);
                    if (!updated) {
                        vscode.window.showWarningMessage(routing.message);
                        break;
                    }

                    let message = routing.message;
                    if (routing.delivery === 'steered' && routing.note) {
                        const result = this._host.taskAgents.steer(routing.runId!, routing.note.text, {
                            artifactPath: routing.note.artifactPath,
                            region: routing.note.region,
                        });
                        if ('error' in result) {
                            // The agent finished between the listing and the click. The
                            // comment is still saved; only the claim about delivery changes.
                            message = `Comment saved. ${result.error}`;
                        } else {
                            const latest = updated.comments?.[updated.comments.length - 1];
                            if (latest) this._host.artifacts.markCommentsDelivered(record.id, [latest.id]);
                        }
                    }

                    vscode.window.setStatusBarMessage(message, 5000);
                    this.postArtifacts(data.value?.type);
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

                // ── The memory panel (Phase 8, M45) ─────────────────────────
                case 'listMemory':
                    this.postMemory(data.value);
                    break;
                case 'confirmMemory':
                    this._host.memory?.confirm(String(data.value?.text || ''));
                    this.postMemory();
                    break;
                case 'rejectMemory':
                    this._host.memory?.reject(String(data.value?.text || ''));
                    this.postMemory();
                    break;
                case 'openMemoryFile': {
                    /*
                     * Opening the file is the panel's most important button, not a
                     * convenience.
                     *
                     * ADR 007 makes `memory.md` a *user file* — the agent preserves
                     * anything it did not write, and decay archives rather than deletes.
                     * A panel that could only be read through would quietly make it an
                     * opaque store the user is shown a rendering of, which is the
                     * opposite of that decision. Editing the markdown is the supported
                     * way to correct a memory, so the panel says so and opens it.
                     */
                    const filePath = this._host.memory?.filePath;
                    if (!filePath) break;
                    try {
                        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filePath));
                    } catch {
                        vscode.window.showInformationMessage(
                            'No memories have been written yet, so there is no memory.md to open.');
                    }
                    break;
                }
            }
        });

        // Artifacts arrive from background lanes, so the panel is pushed a fresh listing
        // on mount and after every comment rather than polling for one.
        this.postArtifacts();

        this._panel.onDidDispose(() => {
            this._panel = undefined;
            if (ManagerPanel._live === this) ManagerPanel._live = undefined;
        }, null, this._context.subscriptions);
    }

    private findArtifact(artifactId: string): ArtifactRecord | undefined {
        return this._host.artifacts.list().find(record => record.id === artifactId);
    }

    /**
     * Push the review listing.
     *
     * Binary artifacts carry a webview URI alongside the path: a `file://` src is blocked
     * by the webview's CSP, so a screenshot rendered from its path is a broken image icon
     * where the evidence should be — which is exactly the shape of "the artifact exists but
     * nobody can see it" that this panel was built to end.
     */
    /**
     * Push the memory view (M45).
     *
     * Reads from disk on every call rather than caching. `memory.md` is a file in the
     * user's repository that they may be editing in the next tab — the store itself
     * re-reads before every mutation for exactly this reason — and a panel showing a
     * cached copy would be the one surface that disagrees with the file it claims to
     * display.
     */
    private postMemory(filter?: { status?: string; type?: string; query?: string }): void {
        if (!this._panel) return;
        const memory = this._host.memory;
        if (!memory) {
            this._panel.webview.postMessage({
                type: 'memorySync',
                value: buildMemoryView([], [], {}),
            });
            return;
        }
        this._panel.webview.postMessage({
            type: 'memorySync',
            value: buildMemoryView(memory.entries(), memory.pending, {
                status: filter?.status && filter.status !== 'all' ? filter.status as any : undefined,
                type: filter?.type && filter.type !== 'all' ? filter.type as any : undefined,
                query: filter?.query,
                filePath: memory.filePath,
            }),
        });
    }

    private postArtifacts(type?: string): void {
        if (!this._panel) return;
        const records = this._host.artifacts.list();
        const groups = buildReviewView(records, {
            liveRunIds: this._host.taskAgents.liveIds(),
            type: type && type !== 'all' ? (type as ArtifactType) : undefined,
        });

        const webview = this._panel.webview;
        this._panel.webview.postMessage({
            type: 'artifactListSync',
            value: {
                groups: groups.map(group => ({
                    ...group,
                    artifacts: group.artifacts.map(artifact => ({
                        ...artifact,
                        src: artifact.binary ? webview.asWebviewUri(vscode.Uri.file(artifact.path)).toString() : undefined,
                    })),
                })),
                counts: reviewCounts(records),
            },
        });
    }
}
