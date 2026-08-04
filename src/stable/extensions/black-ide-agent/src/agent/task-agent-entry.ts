import * as vscode from 'vscode';
import * as path from 'path';
import { ChatMessage } from '@blackide/agent-core/core/types';
import { SecretManager } from '@blackide/agent-core/core/secret-manager';
import { CodebaseIndex } from '@blackide/agent-core/core/codebase-index';
import { ModeLoader } from '../core/mode-loader';
import { ProjectProfile } from '@blackide/agent-core/core/project-profiler';
import { CheckpointManager } from '../core/checkpoint-manager';
import { TokenTracker } from '../core/token-tracker';
import { ContextManager } from '@blackide/agent-core/core/context-manager';
import { loadModelRouter, providerHealth } from '../core/model-router-loader';
import { toolsForMode } from '@blackide/agent-core/core/tools';
import { AgentToolExecutor, ExecutorDeps } from './tool-executor';
import { runAgentLoop } from '@blackide/agent-core/agent/agent-loop';
import { TaskRunParams, TaskWorktreeOps } from '@blackide/agent-core/agent/task-agent-registry';
import { TaskAgentDiff, parseNumstat } from '@blackide/agent-core/core/task-agents';
import { worktreeManager } from './worktree-manager';
import { ToolRunner } from '../tools/tool-runner';
import { BrowserTool } from '../tools/browser-tool';
import { MCPClient } from '../tools/mcp-client';
import { ArtifactManager } from '@blackide/agent-core/agent/artifact-manager';
import { KnowledgeStore } from '../memory/knowledge-store';
import { ArtifactStore } from './artifact-store';
import { runVerification } from './verify-runner';
import { captureVisualEvidence } from './visual-capture';
import { readBrowserSettings, browserRuntimeAvailable, isBrowserUsable } from '../tools/browser-capability';
import { describeSteering } from '@blackide/agent-core/core/steering';

// ─── Running one task agent (Phase 6, M31) ──────────────────────────────────
//
// `TaskAgentRegistry` owns the lifecycle and knows nothing about models, tools or git.
// This is the other half: it assembles an executor rooted **in the agent's worktree** and
// runs the shared agent loop inside it.
//
// The single most important line in this file is `rootPath: params.cwd`. Every file tool,
// every `run_command`, every grep the agent performs resolves against that, so pointing it
// at the worktree is what makes four concurrent agents unable to see each other's edits —
// and pointing it at the live root by accident is what would make this feature destroy a
// user's working tree. It is a one-word mistake with no compiler protection, which is why
// the registry's tests assert `cwd !== rootPath` on every run.

export interface TaskAgentEntryDeps {
    context: vscode.ExtensionContext;
    /** Where the verify step writes its `test-report` (Phase 7, M40). */
    artifacts: ArtifactStore;
    secretManager: SecretManager;
    codebaseIndex: CodebaseIndex;
    modeLoader: ModeLoader;
    getProjectProfile: (rootPath: string) => Promise<ProjectProfile>;
    log: (message: string) => void;
}

/**
 * The registry's `runTask`, bound to the real executor.
 *
 * Approvals are auto-denied rather than prompted. A task agent is unattended by
 * construction — the user launched four of them and looked away — so a modal asking about
 * a shell command would block a run nobody is watching, which is the exact failure M34's
 * inbox exists to surface. Reads and edits inside the worktree need no approval because
 * the worktree *is* the sandbox: nothing there reaches the user's tree until they apply it.
 */
export function buildTaskRunner(deps: TaskAgentEntryDeps) {
    return async function runTask(params: TaskRunParams): Promise<void> {
        const { router } = await loadModelRouter(deps.secretManager);
        const resolved = router.resolve('chat', params.modelId);
        if (!resolved) throw new Error('No model is configured. Add one in Black IDE Settings.');
        const modelConfig = resolved.config;

        const mode = deps.modeLoader.getMode(params.mode);
        const system = mode?.systemPrompt
            || 'You are an autonomous coding agent working in an isolated copy of the user\'s repository. '
            + 'Read before you edit, verify your work with the project\'s tests, and call complete_task when done.';

        // Everything stateful is per-run, and with four agents in flight that is not a
        // style preference. One shared `BrowserTool` means four agents driving one
        // Chromium session, so agent B navigates away from the page agent A is asserting
        // on; one shared `MCPClient` means four agents on one stdio pipe. The same
        // reasoning gave pipeline runs their own checkpoint store (see pipeline-entry.ts):
        // concurrent runs sweeping each other's pending snapshots is the bug that made it
        // necessary there, and there are four times as many agents here.
        // What the agent wrote, for `planVerification`'s "did a user-visible surface
        // change" question. Collected from the executor's own notifications rather than
        // from git, because the question is about the files this agent touched.
        const touched = new Set<string>();
        const checkpoints = new CheckpointManager();
        const tokenTracker = new TokenTracker();
        const browserTool = new BrowserTool();
        const mcpClient = new MCPClient();
        const artifactManager = new ArtifactManager(deps.context.globalStorageUri.fsPath, {
            // The editor *can* show a file, so it says so. See ArtifactManager's header.
            openFile: async p => { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(p), { preview: false }); },
        });
        const knowledgeStore = new KnowledgeStore(deps.context);

        const executorDeps: ExecutorDeps = {
            // The editor can apply a WorkspaceEdit and save what it touched, so it says
            // so (M62 · P11-1). `applyEdit` leaves documents dirty; without the save the
            // change is invisible to git, to the test runner, and to the next tool call.
            applyWorkspaceEdit: async (edit, files) => {
                if (!await vscode.workspace.applyEdit(edit as vscode.WorkspaceEdit)) return false;
                for (const file of files) {
                    try {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                        if (doc.isDirty) await doc.save();
                    } catch { /* a file the provider touched but we cannot reopen */ }
                }
                return true;
            },
            mode: 'agent',
            allowedTools: mode?.tools?.length ? mode.tools : undefined,
            // THE isolation line. See this file's header.
            rootPath: params.cwd,
            browserTool,
            mcpClient,
            artifactManager,
            knowledgeStore,
            codebaseIndex: deps.codebaseIndex,
            checkpoint: checkpoints,
            log: (message) => deps.log(`[${params.agentId}] ${message}`),
            // Unattended: nothing here can prompt. Edits are already contained by the
            // worktree; commands are refused rather than silently allowed, because a
            // command can reach outside the worktree in ways a file write cannot.
            approve: async (request) => request.kind === 'edit' || request.kind === 'create',
            signal: params.signal,
            commandTimeoutMs: 120_000,
            onPlan: () => {},
            onArtifact: () => {},
            onTerminalChunk: () => {},
            onFileChanged: (file) => { touched.add(file); },
            getProjectProfile: () => deps.getProjectProfile(params.rootPath),
        };

        const initialMessage: ChatMessage = { role: 'user', content: params.prompt };
        const tools = mode?.tools?.length
            ? toolsForMode('agent').filter(t => mode.tools!.includes(t.name))
            : toolsForMode('agent');

        const result = await runAgentLoop({
            modelConfig,
            system,
            initialMessage,
            tools,
            executor: new AgentToolExecutor(executorDeps),
            maxLoops: mode?.maxIterations ?? 25,
            signal: params.signal,
            context: new ContextManager(ContextManager.getModelLimit(modelConfig.model || '')),
            failover: {
                chain: router.chainFor('chat', params.modelId),
                health: providerHealth,
                onSubstitution: (s) => deps.log(`[${params.agentId}] ${s.from.name} failed — continuing on ${s.to.name}.`),
            },
            // Mid-run steering (M39). The loop drains this at the top of each turn.
            steering: params.steering,
            callbacks: {
                onToolCall: (tc) => params.emit({ type: 'ToolCallStarted', name: tc.name }),
                onSteering: (notes) => {
                    for (const note of notes) deps.log(`[${params.agentId}] ${describeSteering(note)}`);
                    params.emit({ type: 'SteeringApplied', count: notes.length });
                },
                onUsage: (promptChars, response) => {
                    const entry = tokenTracker.track(modelConfig.model || '', 'x'.repeat(promptChars), response);
                    params.onUsage?.(entry.inputTokens + entry.outputTokens, entry.estimatedCost);
                },
            },
        });

        /*
         * Verify before reporting done (Phase 7, M40).
         *
         * Inside the agent's *worktree*, which is the whole reason this is cheap to do
         * here: the suite runs against the change in isolation, so a red result is
         * attributable to this agent and to nothing else running at the same time.
         *
         * A failure to verify never fails the run. The agent did its work; the report
         * says whether it can be trusted, and burying real edits because the test command
         * was missing would be a worse outcome than an honest "unverifiable".
         */
        let verification: Parameters<NonNullable<TaskRunParams['onVerified']>>[0];
        try {
            const verifyProfile = await deps.getProjectProfile(params.rootPath);
            const generalSettings = await readGeneralSettings(deps.secretManager);
            const browserSettings = readBrowserSettings(generalSettings);
            const outcome = await runVerification({
                runId: params.agentId,
                cwd: params.cwd,
                profile: verifyProfile,
                changedFiles: [...touched],
                artifacts: deps.artifacts,
                signal: params.signal,
                log: deps.log,
                // Visual evidence (M40). This agent already owns a private `BrowserTool`
                // for its own run; the capture gets a fresh one rather than reusing it,
                // because the agent may have left a page mid-flow and a screenshot of a
                // half-filled form it was testing is not evidence about the change.
                captureVisual: () => captureVisualEvidence({
                    runId: params.agentId,
                    artifacts: deps.artifacts,
                    profile: verifyProfile,
                    browserSettings,
                    browserUsable: isBrowserUsable(browserSettings, browserRuntimeAvailable()),
                    configuredUrl: generalSettings.verificationPreviewUrl,
                    log: deps.log,
                    signal: params.signal,
                }),
            });
            verification = {
                outcome: outcome.result.outcome,
                testsRan: !!outcome.evidence.tests,
                passed: outcome.evidence.tests?.passed,
                failed: outcome.evidence.tests?.failed,
                reportPath: outcome.reportPath,
            };
        } catch (err: any) {
            deps.log(`[${params.agentId}] verification could not run: ${err?.message || err}`);
        }

        params.onVerified?.(verification);
        params.emit({ type: 'TaskCompleted', text: result.finalText });
    };
}


/**
 * The registry's git operations, bound to the real `WorktreeManager`.
 *
 * Every one takes the agent's declared root (M36) rather than reaching for
 * `workspaceFolders[0]`, which is what lets an agent in the React root of a two-root
 * workspace create its worktree from the React repo rather than the Django one.
 */
export function buildWorktreeOps(): TaskWorktreeOps {
    return {
        create: (branch, root) => worktreeManager.createWorktree(branch, root),
        sync: (branch, root) => worktreeManager.syncUncommittedChanges(branch, root),
        commit: (branch, message, root) => worktreeManager.commitWorktreeChanges(branch, message, root),
        apply: (branch, from, to, root) => worktreeManager.applyDelta(branch, from, to, root),
        remove: (branch, root) => worktreeManager.removeWorktree(branch, root),
        async diffStat(branch, from, to, root): Promise<TaskAgentDiff> {
            // Read from the live repo rather than the worktree: worktrees of one repo
            // share an object database, so the commits are visible from either, and the
            // live root is guaranteed to still exist even if the worktree was pruned.
            const result = await ToolRunner.executeCommand(`git diff --numstat ${from} ${to}`, root);
            return parseNumstat(result.exitCode === 0 ? result.stdout : '');
        },
    };
}

/**
 * The persisted `general-settings` blob, or an empty one.
 *
 * A task agent runs unattended, so a settings read that throws must degrade to defaults
 * rather than take the run down — the blob is a preference, and losing it costs a
 * screenshot, not the work.
 */
async function readGeneralSettings(secretManager: SecretManager): Promise<any> {
    try {
        const raw = await secretManager.getKey('general-settings');
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

/** Where a task agent's worktree lives, for the "open it" affordance in the panel. */
export function worktreeUriFor(rootPath: string, branch: string): vscode.Uri {
    return vscode.Uri.file(path.join(rootPath, '..', branch.replace(/[\\/]/g, '_')));
}
