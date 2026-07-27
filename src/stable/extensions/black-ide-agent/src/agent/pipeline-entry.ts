import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LLMConfigEntry } from '../core/types';
import { TokenTracker } from '../core/token-tracker';
import { toolsForMode } from '../core/tools';
import { PipelineOrchestrator, isOverTokenBudget } from './pipeline-orchestrator';
import { CheckpointManager } from '../core/checkpoint-manager';
import { CommandPolicy } from '../core/command-policy';
import { CodebaseIndex } from '../core/codebase-index';
import { KnowledgeBase } from '../core/knowledge-base';
import { SecretManager } from '../core/secret-manager';
import { ModeLoader } from '../core/mode-loader';
import { ToolRunner } from '../tools/tool-runner';
import { gitMutex } from './git-mutex';
import { resolveOutputMode, buildPrCommands, compareUrlFallback, shellQuote } from '../core/git-pr';
import { summarizeRequest, formatReleaseNotes, formatChangelogEntry, prependChangelogEntry } from '../core/completion-docs';
import { DiffContentProvider } from '../tools/diff-provider';
import { BrowserTool } from '../tools/browser-tool';
import { readBrowserSettings, browserRuntimeAvailable, isBrowserUsable, filterToolsForBrowser } from '../tools/browser-capability';
import { MCPClient } from '../tools/mcp-client';
import { KnowledgeStore } from '../memory/knowledge-store';
import { PlanningEngine } from './planning-engine';
import { SkillsManager } from './skills-manager';
import { resolveSkills, renderSkills, roleForMode, skillsFiredEvent } from './skill-resolver';
import { ProjectProfile } from '../core/project-profiler';
import { ArtifactManager } from './artifact-manager';
import { AgentToolExecutor, ApprovalRequest, ExecutorDeps } from './tool-executor';

/**
 * Pipeline mechanics, shared by the chat-triggered flow and concurrent
 * Manager-panel runs.
 *
 * Extracted verbatim from `BlackIdeChatProvider._runPipelineCore`,
 * `_buildApprovalGate` and `_trackAndEmitUsage` (Phase 0, M2). This split was the
 * safest of the three big ones because the original method mutated *no* provider
 * state — it only read nine members, which are now the explicit `PipelineCoreDeps`
 * below. The two helpers touched no instance state at all, so they became free
 * functions.
 *
 * Keeping the dependencies explicit (rather than passing the provider) is
 * deliberate: it is the same shape the vscode-free `agent-core` extraction needs
 * later, so this does not have to be redone then.
 */

/** Exactly the provider members `runPipelineCore` reads. It mutates none of them. */
export interface PipelineCoreDeps {
    context: vscode.ExtensionContext;
    secretManager: SecretManager;
    modeLoader: ModeLoader;
    codebaseIndex: CodebaseIndex;
    bundledSkillsDir: string;
    getProjectProfile(): Promise<ProjectProfile>;
    syncStackToMindmap(profile: ProjectProfile, rootPath: string): void;
}

export function trackAndEmitUsage(
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

export function buildApprovalGate(opts: {
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

export async function runPipelineCore(deps: PipelineCoreDeps, params: {
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
        const configJson = await deps.secretManager.getKey('llm-config');
        if (!configJson) throw new Error('No LLM configurations found.');
        const configs: LLMConfigEntry[] = JSON.parse(configJson);
        const modelConfig = configs.find(c => c.id === modelId);
        if (!modelConfig) throw new Error(`Configuration for model "${modelId}" not found.`);

        const allModes = deps.modeLoader.getAllModes();

        // Project-aware skills for the pipeline executors (Phase 4). Until now the pipeline
        // agents received NO skills; this resolves stack+role-appropriate packs per phase and
        // appends them to each executor's system prompt via the orchestrator's skillsForMode.
        const pipelineSkills = new SkillsManager();
        await pipelineSkills.discover(deps.bundledSkillsDir);
        const pipelineProfile = await deps.getProjectProfile();
        // Phase 5: reflect the detected stack in the project mindmap (idempotent).
        if (rootPath && pipelineProfile.stacks.length) deps.syncStackToMindmap(pipelineProfile, rootPath);
        const skillsForMode = (modeId: string): string => {
            const picked = resolveSkills({
                skills: pipelineSkills.getAll(),
                role: roleForMode(modeId),
                profile: pipelineProfile,
                prompt: userPrompt,
            });
            if (picked.length) log(`[Skills] ${modeId}: ${picked.map(s => s.name).join(', ')}`);
            if (picked.length) emit(skillsFiredEvent(modeId, picked));
            return renderSkills(picked);
        };

        browserTool = new BrowserTool();
        mcpClient = new MCPClient();
        const artifactManager = new ArtifactManager(deps.context);
        const knowledgeStore = new KnowledgeStore(deps.context);

        // Opt-in: auto-open every file the pipeline touches, not just the plan/
        // mindmap/overview artifacts. Off by default — a multi-file pipeline run
        // would otherwise flood the tab bar. Lives in the same 'general-settings'
        // blob as the rest of this extension's user settings (see openSettingsPanel).
        let generalSettings: any = {};
        try {
            const s = await deps.secretManager.getKey('general-settings');
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
            codebaseIndex: deps.codebaseIndex, checkpoint: runCheckpoints,
            log, approve: buildApprovalGate({ settings: generalSettings, interactive: false, log }),
            signal, commandTimeoutMs: 120000,
            onPlan: () => {}, onArtifact: () => {}, onTerminalChunk: () => {},
            scheduleTask: () => Promise.resolve(), cancelTask: () => {}, spawnSubagent: async () => 'n/a',
            // Phase 1: the Testing Executor can now run the suite through run_tests and
            // get a failures-only report instead of shelling out and parsing by eye.
            getProjectProfile: deps.getProjectProfile
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
            const mDef = deps.modeLoader.getMode(modeId);
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
                        const u = trackAndEmitUsage(tokenTracker, modelConfig.model || '', promptChars, response, emit);
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
            parallelExecution,
            skillsForMode
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
