import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentMode, LLMConfigEntry, ChatMessage, ToolCall } from '../core/types';
import { LLMClient, supportsNativeTools } from '../core/llm-client';
import { TokenTracker } from '../core/token-tracker';
import { toolsForMode, renderToolDocs } from '../core/tools';
import { CheckpointManager, diffStat } from '../core/checkpoint-manager';
import { CodebaseIndex } from '../core/codebase-index';
import { KnowledgeBase } from '../core/knowledge-base';
import { SecretManager } from '../core/secret-manager';
import { ModeLoader } from '../core/mode-loader';
import { SessionManager, TaskEmitter } from '../core/session-manager';
import { PromptBuilder } from '../core/prompt-builder';
import { ContextManager } from '../core/context-manager';
import { ChatSession } from '../core/chat-session';
import { ProjectProfile } from '../core/project-profiler';
import { BrowserTool } from '../tools/browser-tool';
import { readBrowserSettings, browserRuntimeAvailable, isBrowserUsable, filterToolsForBrowser } from '../tools/browser-capability';
import { MCPClient } from '../tools/mcp-client';
import { HistoryStore } from '../memory/history-store';
import { KnowledgeStore } from '../memory/knowledge-store';
import { PlanningEngine } from './planning-engine';
import { SkillsManager } from './skills-manager';
import { resolveSkills, renderSkills, roleForMode, skillsFiredEvent } from './skill-resolver';
import { SkillDiagnostics } from './skill-diagnostics';
import { ArtifactManager } from './artifact-manager';
import { AgentScheduler } from './scheduler';
import { AgentHooks } from './hooks';
import { AgentToolExecutor, ExecutorDeps, readAttachments } from './tool-executor';
import { runAgentLoop } from './agent-loop';
import { worktreeManager } from './worktree-manager';
import { buildApprovalGate, trackAndEmitUsage } from './pipeline-entry';

/**
 * The chat-triggered agent task: the single-agent path behind the sidebar.
 *
 * Extracted from `BlackIdeChatProvider._runAgentTask` (Phase 0, M2 follow-up). The
 * blocker on the first attempt was that this function *reassigns* conversation and
 * approval state partway through, so handing it individual values would have given
 * later readers a stale snapshot. `ChatSession` solves that by holding the mutable
 * state in one object shared by reference — see core/chat-session.ts.
 *
 * Dependencies are explicit rather than a provider reference, matching
 * `runPipelineCore`, because that is the shape the Phase 11 vscode-free `agent-core`
 * extraction needs.
 */
export interface ChatTaskDeps {
    context: vscode.ExtensionContext;
    secretManager: SecretManager;
    historyStore: HistoryStore;
    checkpoints: CheckpointManager;
    codebaseIndex: CodebaseIndex;
    modeLoader: ModeLoader;
    sessions: SessionManager;
    scheduler: AgentScheduler;
    skillDiagnostics: SkillDiagnostics;
    bundledSkillsDir: string;
    /** Mutable lane state, shared by reference with the provider and the webview handler. */
    session: ChatSession;
    /** The live view. Read once at entry, as the original did. */
    view: vscode.WebviewView | undefined;
    getProjectProfile(): Promise<ProjectProfile>;
    /** Fire-and-forget conversation naming; stays on the provider (touches the webview). */
    generateConversationTitle(userPrompt: string, modelConfig: LLMConfigEntry): Promise<void>;
    /** Re-entrant: a scheduled task calls back into a new chat task. */
    scheduleAgentTask(tc: ToolCall, modelId: string, webview: vscode.Webview, mode: AgentMode): void;
}

/**
 * Shrink tool results before they are persisted to session memory: cap long output
 * and drop image payloads, which are large and useless on replay. Pure.
 */
export function pruneForPersistence(messages: ChatMessage[]): ChatMessage[] {
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

export async function runAgentTask(
    deps: ChatTaskDeps,
    userPrompt: string,
    modelId: string,
    attachments?: any[],
    mode?: string,
): Promise<void> {
    if (!deps.view) return;
    const webview = deps.view.webview;

    // Cancellation: abort any in-flight task, start a fresh controller.
    deps.session.abortController?.abort();
    const controller = new AbortController();
    deps.session.abortController = controller;
    const signal = controller.signal;
    deps.session.isGenerating = true;

    const tokenTracker = new TokenTracker();
    const startedAt = Date.now();

    const browserTool = new BrowserTool();
    const mcpClient = new MCPClient();
    const skillsManager = new SkillsManager();
    const artifactManager = new ArtifactManager(deps.context);
    const knowledgeStore = new KnowledgeStore(deps.context);
    const hooks = new AgentHooks();
    const checkpoint = deps.checkpoints;
    const codebaseIndex = deps.codebaseIndex;

    // `task` is created below once we know the mode and model; until then, log to
    // the bus without a task envelope is not possible, so config errors surface via
    // the catch block on the raw webview channel.
    let task: TaskEmitter | undefined;
    const log = (msg: string) => {
        if (task) task.emit({ type: 'Log', level: 'info', message: msg });
        else webview.postMessage({ type: 'log', value: msg });
    };

    try {
        const configJson = await deps.secretManager.getKey('llm-config');
        if (!configJson) throw new Error('No LLM configurations found. Configure a model in Settings first.');
        const configs: LLMConfigEntry[] = JSON.parse(configJson);
        const modelConfig = configs.find(c => c.id === modelId);
        if (!modelConfig) throw new Error(`Configuration for model "${modelId}" not found in Settings.`);

        let settings: any = {};
        try { const s = await deps.secretManager.getKey('general-settings'); if (s) settings = JSON.parse(s); } catch {}
        // Reasoning display (B6): gate the reasoning stream on the user's toggle. Default
        // on (unset === true) so existing behavior is preserved; only an explicit `false`
        // silences it. Controls display only — the model still reasons either way.
        const showReasoning = settings.enableReasoningDisplay !== false;
        // Default 25, configurable to 500. Safe to raise only because the context is
        // now bounded by token budget rather than message count — a long run compacts
        // instead of overflowing the window.
        const customModeDef = deps.modeLoader.getMode(mode || 'agent');
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
        task = deps.sessions.beginTask(userPrompt, effectiveMode, modelConfig.model || modelId);

        // Incremental: a warm index only re-reads the files that actually changed.
        try {
            const t0 = Date.now();
            const stats = await codebaseIndex.build(deps.secretManager);
            log(`[Index] ${codebaseIndex.size} chunks — ${stats.indexed} indexed, ${stats.reused} reused, ${stats.removed} removed (${Date.now() - t0}ms).`);
        } catch (e: any) { log(`[Index] Skipped: ${e?.message || e}`); }

        // Project-aware skills (Phase 2/4): resolve by (agent role + detected stack + prompt),
        // including the bundled built-in packs, not prompt keywords alone.
        await skillsManager.discover(deps.bundledSkillsDir);
        // Surface malformed/unreachable user packs in the Problems panel (M5). Done
        // on every discovery so fixing a SKILL.md clears its warning on the next run.
        deps.skillDiagnostics.publish(skillsManager.getProblems());
        const profile = await deps.getProjectProfile();
        const skillRole = roleForMode(customModeDef?.name || effectiveMode);
        const relevantSkills = resolveSkills({ skills: skillsManager.getAll(), role: skillRole, profile, prompt: userPrompt });
        const skillInstructions = renderSkills(relevantSkills);
        if (relevantSkills.length) log(`[Skills] Loaded ${relevantSkills.length}: ${relevantSkills.map(s => s.name).join(', ')}`);
        if (relevantSkills.length) task.emit(skillsFiredEvent(customModeDef?.name || effectiveMode, relevantSkills));

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
Work in a loop: think, call a tool, observe the result, repeat. Prefer codebase_search to locate code, read a file before editing it, and verify your work. When finished, call complete_task with a concise summary.

Tool selection matters — you are running inside a full IDE with live language servers, so use them instead of guessing from text:
- "Where is X defined?" → go_to_definition, not grep_search. "What uses X?" → find_references. "Where does X live?" → workspace_symbols. "What type is X?" → hover.
- Before changing or deleting anything, call find_references to see what depends on it.
- To rename something everywhere, use rename_symbol — it is scope- and import-aware. Never rename by find-and-replace across files.
- To check your work compiles, call get_diagnostics. To run tests, call run_tests (it reports failures only); use run_command for other commands.
- grep_search is still right for non-code text: strings, config values, comments, TODOs.
These tools degrade to a text search when no language server is available for a file type, and will tell you when that happens.`,
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

        const approve = buildApprovalGate({ settings, interactive: true, log });

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
            scheduleTask: (tc) => deps.scheduleAgentTask(tc, modelId, webview, effectiveMode),
            cancelTask: (id) => deps.scheduler.cancel(id),
            spawnSubagent,
            // Lets run_tests pick this project's test command (Phase 1). Cached by
            // _getProjectProfile, so repeated calls in one task cost nothing.
            getProjectProfile: () => deps.getProjectProfile(),
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
            deps.session.subagentAbortControllers.set(subagentId, subController);

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
                // store (not the shared deps.checkpoints) so worktree-path snapshots
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
                const subModeDef = deps.modeLoader.getMode(subMode);
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
                deps.session.subagentAbortControllers.delete(subagentId);
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
            priorMessages: deps.session.conversation,
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
                    const u = trackAndEmitUsage(tokenTracker, modelConfig.model || '', promptChars, response, emit);
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
        deps.session.conversation = result.messages;

        // Persist pruned conversation so multi-turn memory survives window reload
        const pruned = pruneForPersistence(deps.session.conversation);
        await deps.historyStore.setConversationState(deps.session.activeThreadId, pruned);

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

                deps.session.pendingApproval = {
                    planContent, taskContent,
                    planPath: planArtifact.path,
                    taskPath: taskArtifact.path,
                    originalPrompt: userPrompt,
                    modelId, attachments, mode,
                };

                // Persist so approval survives a window reload
                try {
                    await deps.historyStore.setConversationState(
                        `pending-plan-${deps.session.activeThreadId}`,
                        [{ role: 'user', content: JSON.stringify(deps.session.pendingApproval) }]
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
            deps.generateConversationTitle(userPrompt, modelConfig).catch(e => log(`[Title] Failed to generate title: ${e.message}`));
        }

        webview.postMessage({ type: 'taskComplete' });
    } catch (error: any) {
        task?.emit({ type: 'TaskFailed', error: error.message, durationMs: Date.now() - startedAt });
        log(`[Agent Error] ${error.message}`);
        await hooks.run('onError', { error: error.message });
        webview.postMessage({ type: 'taskError', value: error.message });
        vscode.window.showErrorMessage(error.message);
    } finally {
        deps.session.isGenerating = false;
        if (deps.session.abortController === controller) deps.session.abortController = undefined;
        try { await browserTool.close(); } catch {}
        try { await mcpClient.disconnectAll(); } catch {}
    }
}

// ─── Phase 2: Execution Loop (Antigravity Pattern) ──────────────────
// Runs after the user approves the plan. Uses full agent mode with the
// approved plan + task list injected into the system prompt.
