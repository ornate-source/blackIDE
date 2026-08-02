import * as vscode from 'vscode';
import * as path from 'path';
import { ChatMessage } from '../core/types';
import { SecretManager } from '../core/secret-manager';
import { CodebaseIndex } from '../core/codebase-index';
import { ModeLoader } from '../core/mode-loader';
import { ProjectProfile } from '../core/project-profiler';
import { CheckpointManager } from '../core/checkpoint-manager';
import { TokenTracker } from '../core/token-tracker';
import { ContextManager } from '../core/context-manager';
import { loadModelRouter, providerHealth } from '../core/model-router-loader';
import { toolsForMode } from '../core/tools';
import { AgentToolExecutor, ExecutorDeps } from './tool-executor';
import { runAgentLoop } from './agent-loop';
import { TaskRunParams, TaskWorktreeOps } from './task-agent-registry';
import { TaskAgentDiff, parseNumstat } from '../core/task-agents';
import { worktreeManager } from './worktree-manager';
import { ToolRunner } from '../tools/tool-runner';
import { BrowserTool } from '../tools/browser-tool';
import { MCPClient } from '../tools/mcp-client';
import { ArtifactManager } from './artifact-manager';
import { KnowledgeStore } from '../memory/knowledge-store';

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
        const checkpoints = new CheckpointManager();
        const tokenTracker = new TokenTracker();
        const browserTool = new BrowserTool();
        const mcpClient = new MCPClient();
        const artifactManager = new ArtifactManager(deps.context);
        const knowledgeStore = new KnowledgeStore(deps.context);

        const executorDeps: ExecutorDeps = {
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
            callbacks: {
                onToolCall: (tc) => params.emit({ type: 'ToolCallStarted', name: tc.name }),
                onUsage: (promptChars, response) => {
                    const entry = tokenTracker.track(modelConfig.model || '', 'x'.repeat(promptChars), response);
                    params.onUsage?.(entry.inputTokens + entry.outputTokens, entry.estimatedCost);
                },
            },
        });

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

/** Where a task agent's worktree lives, for the "open it" affordance in the panel. */
export function worktreeUriFor(rootPath: string, branch: string): vscode.Uri {
    return vscode.Uri.file(path.join(rootPath, '..', branch.replace(/[\\/]/g, '_')));
}
