import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentMode, LLMConfigEntry, ChatMessage, ToolCall } from '../core/types';
import { LLMClient, supportsNativeTools } from '../core/llm-client';
import { TokenTracker } from '../core/token-tracker';
import { toolsForMode, renderToolDocs } from '../core/tools';
import { advertisedTools, applyToolToggles, toolPanelEntries } from '../core/tool-toggles';
import { CheckpointManager, diffStat } from '../core/checkpoint-manager';
import { CodebaseIndex } from '../core/codebase-index';
import { KnowledgeBase } from '../core/knowledge-base';
import { SecretManager } from '../core/secret-manager';
import { ModeLoader } from '../core/mode-loader';
import { SessionManager, TaskEmitter } from '../core/session-manager';
import { PromptBuilder } from '../core/prompt-builder';
import { ContextManager } from '../core/context-manager';
import { loadModelRouter, providerHealth } from '../core/model-router-loader';
import { noModelGuidance, probeLocalRuntimes } from '../core/local-models';
import { buildReranker } from '../core/rerank-setup';
import { buildFastApply } from '../core/fast-apply-setup';
import { createSummarizer } from '../core/summarizer';
import { describeMindmap, readMindmap, renderMindmapContext } from '../core/mindmap-readback';
import { UNTRUSTED_CONTENT_POSTURE } from '../core/untrusted-content';
import { pickSearchSettings } from '../tools/search-providers';
import { ChatSession } from '../core/chat-session';
import { Rule, selectRules, renderRules, renderRequestableRules } from '../core/rules';
import { ContextProviderRegistry } from '../core/context-providers';
import { resolveMentions } from '../core/mention-resolver';
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
import { ArtifactStore } from './artifact-store';
import { runVerification } from './verify-runner';
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
    /** All discovered rules; which of them apply is decided per turn by selectRules. */
    rules: Rule[];
    /** Records finished commands for the `@terminal` provider (Phase 3, M19). */
    recordTerminal?: (command: string, output: string) => void;
    /** Resolves `@`-mentions in the user's prompt (Phase 3, M19). */
    contextProviders: ContextProviderRegistry;
    /** The live view. Read once at entry, as the original did. */
    view: vscode.WebviewView | undefined;
    getProjectProfile(): Promise<ProjectProfile>;
    /** Fire-and-forget conversation naming; stays on the provider (touches the webview). */
    generateConversationTitle(userPrompt: string, modelConfig: LLMConfigEntry): Promise<void>;
    /** Re-entrant: a scheduled task calls back into a new chat task. */
    scheduleAgentTask(tc: ToolCall, modelId: string, webview: vscode.Webview, mode: AgentMode): void;
    /**
     * Where a chat build task's `test-report` artifact lands (Phase 7, M40).
     *
     * Optional so a caller that has not wired it degrades to the pre-M40 behaviour rather
     * than throwing — but the extension always supplies it, and `verification-wiring`
     * asserts that.
     */
    artifacts?: ArtifactStore;
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
        // Model resolution goes through the router (Phase 4, M23) rather than reading
        // `selectedModelId` here. The chat dropdown's `modelId` is passed as the override
        // because it is a decision about *this* turn and outranks a standing role mapping.
        const { router, configs, settings } = await loadModelRouter(deps.secretManager);
        const resolved = router.resolve('chat', modelId);
        if (!resolved) {
            // Zero-config first run (M27): before reporting a dead end, look for a local
            // runtime the user already has. The offer is surfaced, never auto-enabled —
            // silently routing prompts to a local server the user forgot was running is a
            // surprise even when nothing leaves the machine.
            const detections = await probeLocalRuntimes();
            if (detections.length) {
                webview.postMessage({
                    type: 'localModelsAvailable',
                    value: detections.flatMap(d => d.configs),
                });
            }
            throw new Error(noModelGuidance(detections));
        }
        const modelConfig = resolved.config;
        if (modelId && modelConfig.id !== modelId) {
            log(`[Model] "${modelId}" is not configured; using ${modelConfig.name} (${resolved.reason}).`);
        }
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
        
        // One construction of "what this mode advertises", shared with the session
        // panel's pre-turn view — see `advertisedTools`.
        let tools = advertisedTools(effectiveMode, customModeDef?.tools);

        // Browser gating (B1/B2): honor the user's settings on the BrowserTool, and hide
        // the browser_* tools entirely unless the browser is enabled AND a Playwright
        // runtime is installed — so the model is never offered a tool that would fail.
        const browserSettings = readBrowserSettings(settings);
        browserTool.configure(browserSettings);
        const browserUsable = isBrowserUsable(browserSettings, browserRuntimeAvailable());
        tools = filterToolsForBrowser(tools, browserUsable);

        // Session tool toggles (Phase 2, M10). The panel is built from the list as it
        // stands *here* — after the mode and browser filters, before the user's toggles —
        // because that is the set of tools the toggles can actually decide about. A
        // switch for a tool this mode never had would do nothing when flipped off and
        // appear to grant a forbidden capability when flipped on.
        const toolsBeforeToggles = tools;
        tools = applyToolToggles(tools, deps.session.disabledTools);
        webview.postMessage({
            type: 'toolsAvailable',
            value: toolPanelEntries(toolsBeforeToggles, deps.session.disabledTools),
        });
        if (deps.session.disabledTools.length) {
            log(`[Tools] ${deps.session.disabledTools.length} switched off for this session: ${deps.session.disabledTools.join(', ')}`);
        }

        // Everything from here publishes with a task envelope: sessionId, taskId, traceId.
        task = deps.sessions.beginTask(userPrompt, effectiveMode, modelConfig.model || modelId);

        // The rerank stage, now that the `rerank` role exists (Phase 4 closes M17).
        // Assigned per turn because the user can point the role at a different model
        // between turns, and re-deriving it costs nothing next to a search.
        codebaseIndex.reranker = buildReranker(router, settings, (reason) => log(`[Rerank] ${reason}`));

        // Incremental: a warm index only re-reads the files that actually changed.
        try {
            const t0 = Date.now();
            const stats = await codebaseIndex.build(deps.secretManager);
            log(`[Index] ${codebaseIndex.size} chunks — ${stats.indexed} indexed, ${stats.reused} reused, ${stats.removed} removed (${Date.now() - t0}ms).`);
        } catch (e: any) { log(`[Index] Skipped: ${e?.message || e}`); }

        // Project-aware skills (Phase 2/4): resolve by (agent role + detected stack + prompt),
        // including the bundled built-in packs, not prompt keywords alone.
        await skillsManager.discover(deps.bundledSkillsDir, rootPath);
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

        /*
         * Mindmap read-back (Phase 8, M46).
         *
         * The write half has shipped since plan.md's Phase 5 — every pipeline run syncs the
         * detected stack into `project_mindmap.md` — and nothing has ever read it. So the
         * file has been a write-only log: the agent recomputes what it already wrote down,
         * and any convention a *human* added to it ("we use the repository pattern, not the
         * ORM directly") has been invisible to every run, in a file the agent itself
         * maintains and the user therefore assumes it reads.
         */
        const mindmap = readMindmap(rootPath);
        const mindmapContext = renderMindmapContext(mindmap);
        if (mindmapContext) log(`[Memory] ${describeMindmap(mindmap)}`);

        // Rules v2 (Phase 2). Was a single unconditional read of `.blackide/AGENTS.md`;
        // now every rule source is resolved and only the ones that apply to *this* turn
        // are injected. `AGENTS.md` is still loaded — as an always-on project rule — so a
        // project that only has that file gets byte-identical behaviour.
        //
        // `activePaths` is what glob rules key off: the file the user is looking at plus
        // anything they attached. Without it a glob rule could never fire.
        const activePaths = collectActivePaths(attachments);
        const selectedRules = selectRules({
            rules: deps.rules,
            activePaths,
            enabled: deps.session.enabledRules,
            disabled: deps.session.disabledRules,
            requested: deps.session.requestedRules,
        });
        const projectRules = renderRules(selectedRules);
        const requestableRules = renderRequestableRules(deps.rules);
        if (selectedRules.length) {
            log(`[Rules] ${selectedRules.length} active: ${selectedRules.map(r => `${r.rule.name} (${r.reason})`).join(', ')}`);
        }
        // The session panel (M10) renders exactly this, so it cannot drift from what was
        // actually assembled — it is the same array, not a reconstruction. Posted straight
        // to the webview rather than onto the bus: rule names are user-authored and can
        // encode project detail, so they must not reach the telemetry sink.
        deps.session.lastRuleActivations = selectedRules;
        webview.postMessage({
            type: 'rulesFired',
            value: selectedRules.map(r => ({
                name: r.rule.name,
                scope: r.rule.scope,
                reason: r.reason,
                matchedPath: r.matchedPath,
                matchedGlob: r.matchedGlob,
            })),
        });

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

${UNTRUSTED_CONTENT_POSTURE}

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
            .add({ name: 'requestable_rules', budgetTokens: 300, content: requestableRules })
            .add({ name: 'user_instructions', budgetTokens: 800, content: settings.customSystemPrompt ? `User Custom Instructions:\n${settings.customSystemPrompt}` : '' })
            .add({ name: 'skills', budgetTokens: 1500, content: skillInstructions })
            .add({ name: 'mcp_tools', budgetTokens: 1200, content: mcpToolDocs ? `External MCP tools available:\n${mcpToolDocs}` : '' })
            .add({ name: 'knowledge', budgetTokens: 2000, content: knowledgeContext })
            // Budgeted separately from `knowledge` for the reason Phase 2 settled for rules
            // and skills: one merged section would have to arbitrate two unrelated ranking
            // schemes into a single allowance, and neither can starve the other this way.
            .add({ name: 'mindmap', budgetTokens: 800, content: mindmapContext })
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

        // Resolve `@`-mentions into their content (Phase 3, M19). Before this, a
        // mention was only ever *text* — the model saw `@src/a.ts` and had to spend a
        // turn on read_file to find out what the user was pointing at, and had no way
        // at all to act on `@problems` or `@git`. Each provider's budget is applied by
        // the registry, and a truncation is stated in the injected text rather than
        // being silent.
        const mentions = await resolveMentions(userPrompt, deps.contextProviders);
        if (mentions.resolved.length) {
            log(`[Context] ${mentions.resolved.map(r => r.mention).join(', ')}`);
        }

        const initialMessage: ChatMessage = {
            role: 'user',
            content: [
                userPrompt,
                mentions.text,
                attachText ? `\n${attachText}` : '',
            ].filter(Boolean).join(''),
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
            recordTerminal: (command, output) => deps.recordTerminal?.(command, output),
            onFileChanged: (p, kind) => {
                emit({ type: 'FileChanged', path: p, kind });
                if (p.endsWith('features_plan.md') || p.endsWith('project_mindmap.md')) {
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p));
                }
            },
            // Enforce the selected mode's allowlist at the executor, not just in what we
            // advertise — see the second gate in tool-executor.ts.
            allowedTools: customModeDef?.tools?.length ? customModeDef.tools : undefined,
            // Fast-apply on the `apply` role (M25). Undefined unless the user named a
            // model for it, in which case `edit_file`'s `intent` is refused and the model
            // is asked for explicit blocks — never applied unverified.
            fastApply: buildFastApply(router, settings, log),
            // Keyed search with DDG as the default (Phase 3, M21). Read from the same
            // settings blob the rest of this turn uses, so a key added between turns applies
            // on the next one.
            searchSettings: pickSearchSettings(settings),
            // The user's session toggles, enforced here rather than only unadvertised —
            // a model that calls a tool it saw two turns ago must still be refused.
            deniedTools: deps.session.disabledTools,
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
                // A subagent inherits the session's tool toggles for the same reason it
                // inherits the mode: otherwise `spawn_subagent` is a one-line bypass for
                // every switch the user flipped. `subDeps` carries `deniedTools` through
                // `baseDeps`, so the executor gate applies to the delegate as well.
                subTools = applyToolToggles(subTools, deps.session.disabledTools);
                
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

        const contextManager = new ContextManager(modelLimit);

        const result = await runAgentLoop({
            modelConfig, system, initialMessage,
            priorMessages: deps.session.conversation,
            tools, executor, maxLoops, signal,
            context: contextManager,
            // Rolling summarization (M30). It refuses while an approval gate is open, so
            // the session's live gate state is read at call time rather than captured.
            summarizer: createSummarizer({
                router,
                health: providerHealth,
                maxTokens: modelLimit,
                estimate: (m) => contextManager.estimateMessageTokens(m),
                pendingApproval: () => deps.session.hasPendingApproval,
                signal,
            }),
            // Cross-provider failover (M24). The substitution is announced, never silent:
            // a run that quietly finishes on a different model produces output the user
            // cannot account for, and the model is part of what makes a result reproducible.
            failover: {
                chain: router.chainFor('chat', modelId),
                health: providerHealth,
                onSubstitution: (s) => {
                    log(`[Model] ${s.from.name} failed (${s.because}) — continuing on ${s.to.name}.`);
                    webview.postMessage({
                        type: 'modelSubstituted',
                        value: { from: s.from.name, to: s.to.name, because: s.because },
                    });
                },
            },
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
                onSummarized: (folded) =>
                    log(`[Context] Summarized ${folded} earlier messages into the task so their reasoning survives.`),
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

        /*
         * Verify a chat *build* task (Phase 7, M40's second gate clause).
         *
         * "Build task" is defined as **the run changed a file**, and the definition is the
         * design decision. The alternative — classifying the user's prompt as a build
         * request — is a guess that is wrong in both directions: "explain this and fix the
         * typo" would not verify, "how do I add a test" would spend a suite run on a
         * question. What a run *did* is observable; what it was for is not.
         *
         * The changed set comes from the checkpoint commit rather than a second tally.
         * Checkpointing already has to know exactly which files moved, and a parallel
         * counter is a second answer to the same question that drifts from the first.
         *
         * Never blocks and never fails the turn: the agent's work stands either way, and
         * the report says whether it can be trusted.
         */
        const changedForVerification = committed?.files.map(f => f.relPath) ?? [];
        if (deps.artifacts && changedForVerification.length && !result.aborted && effectiveMode === 'agent') {
            try {
                const outcome = await runVerification({
                    runId: messageId,
                    cwd: rootPath,
                    profile: await deps.getProjectProfile(),
                    changedFiles: changedForVerification,
                    artifacts: deps.artifacts,
                    signal,
                    log,
                });
                emit({ type: 'VerificationCompleted', outcome: outcome.result.outcome, summary: outcome.result.summary, reportPath: outcome.reportPath });
                webview.postMessage({
                    type: 'verificationResult',
                    value: {
                        outcome: outcome.result.outcome,
                        summary: outcome.result.summary,
                        reportPath: outcome.reportPath,
                        missing: outcome.result.missing,
                    },
                });
            } catch (verifyErr: any) {
                log(`[Verify] could not run: ${verifyErr?.message || verifyErr}`);
            }
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

/**
 * Workspace-relative paths in play this turn, for glob-rule activation.
 *
 * The active editor is the strongest signal for "what is the user working on"; a
 * visible-editor sweep is included because a side-by-side diff or split view is a
 * normal way to work, and attachments because an explicitly attached file is an
 * explicit statement of relevance.
 */
export function collectActivePaths(attachments?: any[]): string[] {
    const paths = new Set<string>();
    const add = (fsPath?: string) => {
        if (!fsPath) return;
        paths.add(vscode.workspace.asRelativePath(fsPath, false).replace(/\\/g, '/'));
    };

    add(vscode.window.activeTextEditor?.document.uri.fsPath);
    for (const editor of vscode.window.visibleTextEditors) add(editor.document.uri.fsPath);
    for (const att of attachments || []) add(att?.path);

    return [...paths];
}
