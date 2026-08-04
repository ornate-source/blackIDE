import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { runAgentLoop, LoopCallbacks } from '@blackide/agent-core/agent/agent-loop';
import { providerHealth } from '../core/model-router-loader';
import { AgentToolExecutor } from './tool-executor';
import { LLMConfigEntry, ToolDefinition, ChatMessage } from '@blackide/agent-core/core/types';
import { CustomMode } from '../core/mode-loader';
import { worktreeManager } from './worktree-manager';
import { scheduleTasks, toParallelWaves } from '../core/task-scheduler';
import { capSections } from '../core/text-cap';
import { parsePlanTasks, PlanTask } from '../core/plan-parser';
import { OutputMode } from '@blackide/agent-core/core/git-pr';

export interface PipelinePhase {
    modeId: string;
    description: string;
}

/**
 * The execution-phase dependency graph (plan.md "Dependency Graph"): which tag selects a
 * phase, and which phases must precede it. Design & backend are independent (parallelizable
 * — see toParallelWaves); frontend needs both (design tokens + APIs); testing needs the
 * production code. Encoding it as a graph (rather than a hardcoded sequence) makes the
 * ordering explicit, correct when a phase is skipped, and ready for a parallel executor.
 */
const EXECUTION_PHASE_GRAPH: Record<string, { tag: string; dependsOn: string[] }> = {
    'Design Executor':   { tag: '[design]',   dependsOn: [] },
    'Backend Executor':  { tag: '[backend]',  dependsOn: [] },
    'Frontend Executor': { tag: '[frontend]', dependsOn: ['Design Executor', 'Backend Executor'] },
    'Testing Executor':  { tag: '[testing]',  dependsOn: ['Frontend Executor'] },
};

/**
 * Determines which execution phases the approved features_plan.md calls for (by tag) and
 * orders them by dependency via the scheduler. A plan with no [backend] tasks skips the
 * Backend Executor entirely; a phase's dependency on a skipped phase is simply satisfied.
 * Pure — exported so it's unit-testable without exercising the full LLM-driven pipeline.
 */
export function selectExecutionPhases(planContent: string): string[] {
    const present = Object.entries(EXECUTION_PHASE_GRAPH)
        .filter(([, v]) => planContent.includes(v.tag))
        .map(([name]) => name);
    const { order } = scheduleTasks(present.map(name => ({ id: name, dependsOn: EXECUTION_PHASE_GRAPH[name].dependsOn })));
    return order.map(t => t.id);
}

/**
 * The execution phases grouped by dependency depth.
 *
 * Retained after Phase 6 deleted the parallel *executor* (M35): this is what renders
 * `dependency_graph.md`, which tells a human which phases are independent of each other.
 * Describing the shape of the work is useful on its own and carries none of the risk of
 * running it that way.
 */
export function selectExecutionWaves(planContent: string): string[][] {
    const present = Object.entries(EXECUTION_PHASE_GRAPH)
        .filter(([, v]) => planContent.includes(v.tag))
        .map(([name]) => name);
    const { waves } = toParallelWaves(present.map(name => ({ id: name, dependsOn: EXECUTION_PHASE_GRAPH[name].dependsOn })));
    return waves.map(w => w.map(t => t.id));
}

/**
 * Renders the plan's execution waves as `dependency_graph.md` (plan.md deliverable):
 * which phases run, in which order, and which can run in parallel. Pure/exported for
 * testing. Empty string when the plan has no tagged execution phases.
 */
export function formatDependencyGraph(planContent: string): string {
    const waves = selectExecutionWaves(planContent);
    if (waves.length === 0) return '';
    const lines = [
        `# Dependency Graph`,
        ``,
        `Execution proceeds wave by wave. Phases in the same wave are independent and may run`,
        `in parallel; each wave depends on all earlier waves.`,
        ``,
    ];
    // Per-task detail (P3): the tasks the plan assigns to each phase, scheduled by the same
    // dependency rules. Falls back to the phase-only view when the plan has no parsable
    // checkbox tasks, so a terse plan still produces a valid graph.
    const tasks = parsePlanTasks(planContent, EXECUTION_PHASE_GRAPH);
    const tasksByPhase = new Map<string, PlanTask[]>();
    for (const t of tasks) {
        const list = tasksByPhase.get(t.phase) || [];
        list.push(t);
        tasksByPhase.set(t.phase, list);
    }

    waves.forEach((wave, i) => {
        lines.push(`## Wave ${i + 1}${wave.length > 1 ? ' (parallel)' : ''}`);
        for (const phase of wave) {
            const phaseTasks = tasksByPhase.get(phase) || [];
            if (phaseTasks.length === 0) { lines.push(`- ${phase}`); continue; }
            lines.push(`- **${phase}** — ${phaseTasks.length} task(s)`);
            for (const t of phaseTasks) {
                const blockedBy = t.dependsOn.length ? ` _(after ${t.dependsOn.length} upstream task(s))_` : '';
                lines.push(`  - [${t.done ? 'x' : ' '}] ${t.text || '_untitled_'}${blockedBy}`);
            }
        }
        lines.push('');
    });
    return lines.join('\n');
}

/**
 * Resolves which model a given pipeline phase should use: its override if the user
 * assigned one and it still resolves to a configured model, otherwise the pipeline-wide
 * default. Pure — exported so it's unit-testable without exercising the full pipeline.
 */
export function resolveModelForPhase(
    modeId: string,
    defaultModel: LLMConfigEntry,
    availableModels: LLMConfigEntry[],
    phaseModelOverrides: Record<string, string>
): LLMConfigEntry {
    const overrideId = phaseModelOverrides[modeId];
    if (!overrideId) return defaultModel;
    return availableModels.find(m => m.id === overrideId) ?? defaultModel;
}

/**
 * The failover order for a phase: its own model, then the healthy alternatives with a
 * *different provider* first.
 *
 * Same reasoning as `ModelRouter.chainFor` — when a provider is down, another of its
 * models is behind the same outage. This is a local build rather than a router call
 * because the orchestrator is handed `availableModels` and a resolved per-phase model
 * already, and threading a router through five call sites to re-derive what it has would
 * be more coupling for the same list. Pure, so it is unit-testable with the rest of the
 * phase-model logic.
 */
export function failoverChain(primary: LLMConfigEntry, available: LLMConfigEntry[]): LLMConfigEntry[] {
    const rest = available.filter(m => m.id !== primary.id && m.enabled !== false);
    return [
        primary,
        ...rest.filter(m => m.type !== primary.type),
        ...rest.filter(m => m.type === primary.type),
    ];
}

/**
 * True when a run should stop for exceeding its cumulative token budget. A budget of 0
 * (or negative) means unlimited — the guardrail is off. Pure/exported for unit testing,
 * so the "0 = unlimited" semantics is locked and can't silently regress into "0 = stop
 * immediately".
 */
export function isOverTokenBudget(cumulativeTokens: number, budget: number): boolean {
    return budget > 0 && cumulativeTokens > budget;
}

/**
 * Builds the compact assistant-turn summary spliced into chat conversation context after
 * a pipeline run, so follow-up messages remember what was built. The full 7-loop message
 * history would blow the token budget; overview.md (phase log + file table) is the
 * intended digest. Pure — exported for unit testing; the fs read stays in the caller.
 */
export function buildPipelineContextSummary(overviewContent: string | null): string {
    if (!overviewContent || !overviewContent.trim()) {
        return 'A multi-agent pipeline run completed, but no overview.md summary was generated.';
    }
    return overviewContent.slice(0, 4000);
}

export interface PipelineCallbacks {
    onPipelineStarted: () => void;
    onPhaseStarted: (modeId: string) => void;
    onPhaseCompleted: (modeId: string) => void;
    onPhaseError: (modeId: string, error: string) => void;
    onPipelineCompleted: (overviewPath: string) => void;
    /**
     * A genuine, unrecoverable pipeline failure (retries exhausted, features_plan.md
     * never generated, worktree/merge reconciliation failed, etc.) — distinct from a
     * user rejecting the plan or cancelling, both of which are expected, silent
     * outcomes. Without this, run() swallows the error internally (only a native
     * vscode.window.showErrorMessage toast) and the caller never learns the run is
     * over, leaving its UI state stuck showing "in progress" forever.
     */
    onPipelineFailed?: (error: string) => void;
    /** The user cancelled mid-run (AbortController). Same "caller must learn it's over" need as onPipelineFailed. */
    onPipelineCancelled?: () => void;
    /**
     * PR output mode only: the run's work is committed on `branch` and the live tree was
     * deliberately left untouched. The host publishes it (push + `gh pr create`, falling
     * back to a compare URL) — kept out of the orchestrator so this module stays free of
     * ToolRunner/vscode and remains unit-testable.
     */
    onPipelinePullRequest?: (info: {
        branch: string; worktreeDir: string; baselineSha: string; executionSha: string; userPrompt: string;
    }) => Promise<void>;
    requestApproval: (planContent: string, planPath: string) => Promise<boolean>;
    /**
     * Files touched by the given phase since it started, with how each was touched.
     * Backed by the same onFileChanged stream the checkpoint/undo system already uses —
     * used to build a deterministic mindmap entry and overview.md even if the executor
     * agent never calls the update_mindmap tool itself.
     */
    getFilesForPhase?: (modeId: string) => TouchedFile[];
    /**
     * Verify the finished work and emit a `test-report` artifact (Phase 7, M40).
     *
     * A callback for the same reason `onPipelinePullRequest` is one: the orchestrator is
     * deliberately free of `ToolRunner`/`vscode`, and running a test command is exactly the
     * kind of thing that would drag both back in. The host supplies the runner.
     *
     * Called with the **worktree** as its cwd, which is what makes the result attributable:
     * the suite runs against this run's change in isolation, not against whatever the user
     * happens to have uncommitted in the live tree at the same moment.
     */
    verifyRun?: (info: { runId: string; cwd: string; changedFiles: string[] }) => Promise<void>;
    loopCallbacks?: LoopCallbacks;
}

export interface TouchedFile {
    path: string;
    kind: 'created' | 'modified' | 'deleted';
}

interface PhaseLogEntry {
    modeId: string;
    durationMs: number;
    files: TouchedFile[];
}

export class PipelineOrchestrator {
    private phaseLog: PhaseLogEntry[] = [];
    private pipelineStartedAt = 0;

    /** ~100KB — well above a healthy mindmap, low enough to protect the token budget. */
    static readonly MINDMAP_MAX_BYTES = 100 * 1024;

    constructor(
        private workspaceRoot: string,
        private modelConfig: LLMConfigEntry,
        private modes: CustomMode[],
        private executorFactory: (mode: CustomMode, rootPathOverride?: string) => AgentToolExecutor,
        private callbacks: PipelineCallbacks,
        private signal: AbortSignal,
        private getToolsForMode: (modeId: string) => ToolDefinition[],
        /** Every model the user has configured — used to resolve phaseModelOverrides. */
        private availableModels: LLMConfigEntry[] = [],
        /** Mode name (e.g. "Backend Executor") -> LLMConfigEntry id. Phases with no entry
         *  here, or whose id doesn't resolve, fall back to the pipeline-wide modelConfig —
         *  e.g. a cheaper/faster model for HLD/LLD scaffolding, a stronger one for execution. */
        private phaseModelOverrides: Record<string, string> = {},
        /**
         * What to do with the finished work. Defaults to 'apply' (the proven path that
         * reconciles onto the live tree); 'pr' leaves it on its branch for review. Resolve
         * user input through resolveOutputMode so an unrecognised value degrades to 'apply'.
         */
        private outputMode: OutputMode = 'apply',
        /**
         * Project-aware skills (Phase 4): returns extra system-prompt text (resolved skill packs)
         * for a given phase mode, appended to that mode's system prompt. Without it, the pipeline
         * executors run with their static prompts only — which is what they did before this existed.
         */
        private skillsForMode?: (modeId: string) => string
    ) {}

    /**
     * @param rootPathOverride When set (execution phases only — see run()), the phase's
     * AgentToolExecutor operates against an isolated git worktree instead of the live
     * workspace, so a failed or rejected run never touches the user's actual files.
     */
    private async runPhase(phase: PipelinePhase, initialPrompt: string, priorMessages: ChatMessage[] = [], maxRetries = 2, rootPathOverride?: string): Promise<ChatMessage[]> {
        const mode = this.modes.find(m => m.name.toLowerCase() === phase.modeId.toLowerCase());
        if (!mode) throw new Error(`Mode ${phase.modeId} not found`);

        let retryCount = 0;
        const startedAt = Date.now();
        const modelConfig = resolveModelForPhase(phase.modeId, this.modelConfig, this.availableModels, this.phaseModelOverrides);

        while (retryCount <= maxRetries) {
            try {
                this.callbacks.onPhaseStarted(phase.modeId);

                const initialMessage: ChatMessage = { role: 'user', content: initialPrompt };
                const tools = this.getToolsForMode(phase.modeId);
                const executor = this.executorFactory(mode, rootPathOverride);

                const skillText = this.skillsForMode?.(phase.modeId) || '';
                const result = await runAgentLoop({
                    modelConfig,
                    system: skillText ? `${mode.systemPrompt}\n\n${skillText}` : mode.systemPrompt,
                    initialMessage,
                    priorMessages,
                    tools,
                    executor,
                    maxLoops: mode.maxIterations ?? 15,
                    signal: this.signal,
                    callbacks: this.callbacks.loopCallbacks,
                    /*
                     * Cross-provider failover (Phase 4, M24) — and it matters more here
                     * than in chat. A pipeline run is unattended and minutes long across
                     * seven phases; before this, one 529 from the provider in phase five
                     * failed the whole run, discarding four phases of completed work. The
                     * chain is built from the models the user already configured, and a
                     * substitution is reported as a phase log line rather than silently,
                     * because the model is part of what makes a phase's output explainable.
                     */
                    failover: {
                        chain: failoverChain(modelConfig, this.availableModels),
                        health: providerHealth,
                        onSubstitution: (s) => this.callbacks.loopCallbacks?.onToken?.(
                            `\n[Model] ${s.from.name} failed (${s.because}) — continuing on ${s.to.name}.\n`,
                        ),
                    },
                });

                if (result.aborted) {
                    throw new Error('Aborted by user');
                }

                if (!result.completed && !result.finalText) {
                    throw new Error('Agent exhausted loop budget without completing the task');
                }

                this.callbacks.onPhaseCompleted(phase.modeId);
                const files = this.callbacks.getFilesForPhase?.(phase.modeId) ?? [];
                this.phaseLog.push({ modeId: phase.modeId, durationMs: Date.now() - startedAt, files });
                return result.messages;
            } catch (err: any) {
                if (err.message === 'Aborted by user') {
                    throw err; // bubble up cancellation immediately
                }
                
                this.callbacks.onPhaseError(phase.modeId, err.message);
                
                const userChoice = await vscode.window.showErrorMessage(
                    `Pipeline Phase [${phase.modeId}] failed (attempt ${retryCount + 1} of ${maxRetries + 1}): ${err.message}`,
                    'Retry Phase', 'Cancel Pipeline'
                );
                
                if (userChoice === 'Retry Phase') {
                    retryCount++;
                    // Do NOT call onPhaseStarted here — the top of the while loop calls it
                    // again on the next iteration. Calling it here too double-announced
                    // every retry (two "Started phase" log lines for one actual attempt).
                } else {
                    throw new Error(`Pipeline failed at phase: ${phase.modeId}`);
                }
            }
        }
        throw new Error(`Pipeline failed at phase: ${phase.modeId} after retries`);
    }

    public async run(userPrompt: string): Promise<void> {
        this.phaseLog = [];
        this.pipelineStartedAt = Date.now();
        this.callbacks.onPipelineStarted();

        try {
            // 1. Architecture & Design Phase
            let messages = await this.runPhase(
                { modeId: 'Sr Architect HLD', description: 'Architecture Analysis' }, 
                `Generate HLD for the following requirement:\n\n${userPrompt}`
            );

            messages = await this.runPhase(
                { modeId: 'Sr Engineer LLD', description: 'Low Level Design' },
                `Based on your previous HLD analysis, generate the Low-Level Design (LLD) task list.`,
                messages
            );

            messages = await this.runPhase(
                { modeId: 'Planner', description: 'Feature Planning' },
                `Aggregate the HLD and LLD into a features_plan.md artifact.`,
                messages
            );

            // 2. Approval Gate
            const planPath = path.join(this.workspaceRoot, '.blackIDE', 'features_plan.md');
            if (fs.existsSync(planPath)) {
                const planContent = fs.readFileSync(planPath, 'utf8');
                const approved = await this.callbacks.requestApproval(planContent, planPath);
                if (!approved) {
                    throw new Error('Pipeline cancelled: Plan rejected by user.');
                }
            } else {
                throw new Error('Pipeline failed: features_plan.md was not generated.');
            }

            // 3. Execution Phases based on Plan — isolated in a git worktree so a failed
            // or still-running pipeline never touches the user's live working tree.
            const planContent = fs.readFileSync(planPath, 'utf8');
            const phases = selectExecutionPhases(planContent);

            // Emit the dependency_graph.md deliverable (plan.md) next to the plan.
            try {
                const graph = formatDependencyGraph(planContent);
                if (graph) fs.writeFileSync(path.join(this.workspaceRoot, '.blackIDE', 'dependency_graph.md'), graph, 'utf8');
            } catch { /* non-critical artifact */ }

            const branchName = 'pipeline-' + Date.now().toString(36);

            // Parallel path (default-OFF, see core/parallel-execution.ts). Taken only when
            // the setting is on AND the plan actually has a wave worth parallelizing.
            // PR mode is deliberately excluded: it promises ONE reviewable branch, while
            // the parallel path produces one branch per phase and merges them into the live
            // tree. Silently combining them would leave the user's tree modified by a run
            // that promised not to touch it, so the safer contract wins and we stay
            // sequential.
            let worktreeDir = '';
            let baselineSha = '';
            try {
                worktreeDir = await worktreeManager.createWorktree(branchName);
                // git worktree add only clones from committed HEAD — without this, the
                // worktree wouldn't contain features_plan.md (or anything else) the
                // analysis phases just wrote to the live, uncommitted workspace.
                await worktreeManager.syncUncommittedChanges(branchName);
                // A real commit to diff from later. Its content mirrors the live
                // workspace's own uncommitted state exactly, so it introduces nothing new
                // relative to live — only what happens after this point counts as "the
                // pipeline's work" for reconciliation purposes (see applyDelta below).
                baselineSha = await worktreeManager.commitWorktreeChanges(branchName, 'pipeline: sync baseline');
            } catch (err: any) {
                if (worktreeDir) await worktreeManager.removeWorktree(branchName).catch(() => {});
                throw new Error(`Pipeline failed: could not prepare an isolated workspace (${err.message}). Nothing was changed.`);
            }

            let executionContext: ChatMessage[] = [];
            try {
                for (const phaseMode of phases) {
                    executionContext = await this.runPhase(
                        { modeId: phaseMode, description: `${phaseMode} Execution` },
                        `Execute your assigned tasks from features_plan.md. Be sure to update the OpenSpec Mindmap when finished.`,
                        executionContext,
                        2,
                        worktreeDir
                    );
                    // Deterministic sync: don't rely on the executor agent remembering to call
                    // update_mindmap — append what it actually touched regardless. Written
                    // into the worktree, not the live workspace: an execution agent's own
                    // update_mindmap tool call also lands in the worktree copy, and writing
                    // both sides of the same file outside git tracking would make the final
                    // reconciliation conflict on exactly this file.
                    this.autoSyncMindmap(phaseMode, worktreeDir);
                }
            } catch (err) {
                // Nothing in the live workspace was ever touched — safe to discard everything.
                await worktreeManager.removeWorktree(branchName).catch(() => {});
                throw err;
            }

            /*
             * Verify before reconciling (Phase 7, M40's first gate clause).
             *
             * Here rather than after `applyDelta`, because here the change is still isolated:
             * a red suite in the worktree is this run's doing, while a red suite after the
             * delta lands could equally be the user's uncommitted work. Attributability is
             * the entire value of running it at all.
             *
             * **A failed verification never fails the run**, exactly as in the task lane. The
             * agent did the work; the report says whether it can be trusted. Discarding real
             * edits because a test command was missing is a worse outcome than an honest
             * `unverifiable` — and `unverifiable` is a document that gets written, which is
             * what makes "100% of pipeline runs emit evidence" a measurable claim rather than
             * a wish.
             */
            if (this.callbacks.verifyRun) {
                const changedFiles = [...new Set(this.phaseLog.flatMap(entry => entry.files.map(f => f.path)))];
                try {
                    await this.callbacks.verifyRun({ runId: branchName, cwd: worktreeDir, changedFiles });
                } catch (verifyErr: any) {
                    this.callbacks.onPhaseError('Verification', verifyErr?.message || String(verifyErr));
                }
            }

            try {
                const executionSha = await worktreeManager.commitWorktreeChanges(branchName, `Pipeline execution: ${userPrompt.slice(0, 60)}`);
                if (this.outputMode === 'pr') {
                    // PR mode: the work is already committed on `branchName`, so publishing
                    // it is push + create — no delta to apply and nothing to reconcile. The
                    // live tree is deliberately left untouched, and the worktree/branch are
                    // deliberately NOT removed: they are the deliverable.
                    await this.callbacks.onPipelinePullRequest?.({
                        branch: branchName, worktreeDir, baselineSha, executionSha, userPrompt,
                    });
                } else {
                    // Deliberately not a `git merge` — see applyDelta's doc comment for why a
                    // whole-branch merge would spuriously conflict on every file the live
                    // workspace already had uncommitted before the pipeline even started.
                    await worktreeManager.applyDelta(branchName, baselineSha, executionSha);
                }
            } catch (reconcileErr: any) {
                // Execution succeeded but bringing its changes back failed (e.g. the user
                // concurrently edited a file the pipeline also touched) — the AI's work is
                // real and shouldn't be silently discarded, so leave the worktree in place
                // instead of cleaning it up.
                throw new Error(
                    `Pipeline execution succeeded, but applying its changes to the live workspace failed: ` +
                    `${reconcileErr.message}. The completed work is preserved on git branch "${branchName}" at ` +
                    `${worktreeDir} (baseline ${baselineSha.slice(0, 8)}) — resolve manually, or discard it with ` +
                    `'git worktree remove --force "${worktreeDir}"'.`
                );
            }
            // In PR mode the branch and its worktree ARE the deliverable — removing them
            // would destroy the very work the user asked to review.
            if (this.outputMode !== 'pr') await worktreeManager.removeWorktree(branchName).catch(() => {});

            const overviewPath = this.generateOverview(userPrompt);
            this.callbacks.onPipelineCompleted(overviewPath);

        } catch (err: any) {
            if (err.message === 'Aborted by user') {
                this.callbacks.onPipelineCancelled?.();
                return;
            }
            // Plan rejection is resolved (and its UI state fully handled) at the
            // approvePlan/rejectPlan call site that unblocked requestApproval — this is
            // just the expected unwind back out of run(), not a failure to report.
            const rejected = err.message === 'Pipeline cancelled: Plan rejected by user.';
            if (rejected) return;

            vscode.window.showErrorMessage(`Pipeline Error: ${err.message}`);
            this.callbacks.onPipelineFailed?.(err.message);
        }
    }

    /**
     * Appends a structured, timestamped entry for the given phase's file changes.
     * `targetRoot` is the worktree during execution phases (see run()) — the mindmap
     * only lands in the live workspace once the worktree merges, same as everything
     * else the execution phases produce.
     */
    private autoSyncMindmap(phaseName: string, targetRoot: string): void {
        const entry = this.phaseLog[this.phaseLog.length - 1];
        if (!entry || entry.files.length === 0) return;

        const mindmapPath = path.join(targetRoot, '.blackIDE', 'mindmap', 'project_mindmap.md');
        const dir = path.dirname(mindmapPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const existing = fs.existsSync(mindmapPath) ? fs.readFileSync(mindmapPath, 'utf8') : '';
        const timestamp = new Date().toISOString();
        const fileList = entry.files.map(f => `- \`${path.relative(this.workspaceRoot, f.path)}\` (${f.kind})`).join('\n');
        const section = `\n\n## ${phaseName} — Auto-Sync (${timestamp})\nFiles touched:\n${fileList}\n`;
        fs.writeFileSync(mindmapPath, PipelineOrchestrator.capMindmap(existing + section), 'utf8');
    }

    /**
     * The auto-sync appends forever; unbounded growth would eventually poison the token
     * savings that justify the mindmap. When the file exceeds MINDMAP_MAX_BYTES, drop the
     * OLDEST auto-generated "Auto-Sync" sections (they are regenerable from git history)
     * while preserving the head (architecture, agent-authored sections). Exported-shaped
     * as a static pure method so it's unit-testable.
     */
    static capMindmap(content: string, maxBytes = PipelineOrchestrator.MINDMAP_MAX_BYTES): string {
        // Drop oldest Auto-Sync sections first — they are regenerable from git history;
        // agent-authored sections are never dropped. See core/text-cap.ts for the strategy,
        // which the knowledge base's ADR log shares.
        return capSections(content, maxBytes, {
            notice: `\n\n> _Older auto-sync entries were pruned to bound file size; full history is in git._\n`,
            droppable: s => s.includes('— Auto-Sync ('),
        });
    }

    /** Writes .blackIDE/overview.md and returns its absolute path. */
    private generateOverview(userPrompt: string): string {
        const overviewPath = path.join(this.workspaceRoot, '.blackIDE', 'overview.md');
        const totalMs = Date.now() - this.pipelineStartedAt;
        const duration = `${Math.floor(totalMs / 60000)}m ${Math.round((totalMs % 60000) / 1000)}s`;

        const phaseLines = this.phaseLog
            .map(p => `- [x] ${p.modeId} — ${(p.durationMs / 1000).toFixed(1)}s`)
            .join('\n') || '_No phases recorded._';

        const fileRows = this.phaseLog
            .flatMap(p => p.files.map(f => {
                const action = f.kind.charAt(0).toUpperCase() + f.kind.slice(1);
                return `| \`${path.relative(this.workspaceRoot, f.path)}\` | ${action} | ${p.modeId} |`;
            }))
            .join('\n') || '| _none_ | | |';

        const overview = [
            `# Execution Overview`,
            ``,
            `**Request:** "${userPrompt}"`,
            `**Completed:** ${new Date().toISOString()}`,
            `**Pipeline Duration:** ${duration}`,
            ``,
            `## Phase Execution Log`,
            phaseLines,
            ``,
            `## Files Created/Modified`,
            `| File | Action | Agent |`,
            `|------|--------|-------|`,
            fileRows,
            ``,
            `## Mindmap`,
            `Updated at: \`.blackIDE/mindmap/project_mindmap.md\``,
            ``,
        ].join('\n');

        const dir = path.dirname(overviewPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(overviewPath, overview, 'utf8');
        return overviewPath;
    }
}
