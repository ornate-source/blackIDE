// ─── Activity Store ─────────────────────────────────────────────────────────
// A pure reducer over the agent's event stream. The UI is a projection of these
// events, which is what makes the timeline replayable: feed the same events in the
// same order and you get the same screen. Keeping it out of React also means the
// timeline can be tested without rendering anything.

export type AgentPhase = 'idle' | 'planning' | 'reasoning' | 'tool' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export interface ActivityEntry {
    id: string;
    name: string;
    summary: string;
    status: 'running' | 'ok' | 'error';
    durationMs?: number;
    startedAt: number;
    arguments?: any;
    output?: string;
}

export interface ReviewFile {
    path: string;
    relPath: string;
    kind: 'created' | 'modified' | 'deleted';
    stat: string;
    reviewState: 'pending' | 'kept' | 'restored';
    diffPreview?: string[];
}

export interface CheckpointView {
    id: string;
    messageId?: string;
    label: string;
    createdAt: number;
    files: ReviewFile[];
}

export interface AttachedFile {
    name: string;
    path: string;
    type: 'file' | 'image' | 'screenshot';
    size?: number;
}

export interface PipelineLogEntry {
    id: string;
    timestamp: number;
    phase: string;
    type: 'phase_start' | 'phase_complete' | 'file_modified' | 'file_created' | 'info' | 'error';
    message: string;
    filePath?: string;
    agentName?: string;
}

export interface Message {
    id: string;
    /** Task/checkpoint id that this user message spawned; links it to its Undo checkpoint (MF-43). */
    taskId?: string;
    sender: 'user' | 'agent';
    text: string;
    timestamp: Date;
    status?: 'running' | 'done' | 'pending';
    attachments?: AttachedFile[];
    activity?: ActivityEntry[];
    pipelineLog?: PipelineLogEntry[];
    terminal?: { stream: 'stdout' | 'stderr'; text: string }[];
    tokens?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cost: number; turns: number };
    phase?: AgentPhase;
    startedAt?: number;
    endedAt?: number;
    error?: string;
}

export interface AgentState {
    phase: AgentPhase;
    taskId?: string;
    traceId?: string;
    mode: string;
    model: string;
    turn: number;
    startedAt?: number;
    endedAt?: number;
    activity: ActivityEntry[];
    terminal: { stream: 'stdout' | 'stderr'; text: string }[];
    plan: { title: string; status: string }[];
    artifacts: { name: string; type: string; path: string }[];
    checkpoints: CheckpointView[];
    pipelineLog?: PipelineLogEntry[];
    error?: string;
    tokens?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cost: number; turns: number };
    subagents?: { id: string; name: string; task: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; progress?: string }[];
    pendingPlan?: {
        planContent: string;
        taskContent: string;
        planPath?: string;
        taskPath?: string;
    };
}

export const initialAgentState: AgentState = {
    phase: 'idle',
    mode: 'agent',
    model: '',
    turn: 0,
    activity: [],
    terminal: [],
    plan: [],
    artifacts: [],
    checkpoints: [],
    pipelineLog: [],
    subagents: [],
    pendingPlan: undefined,
};

/** Terminal output is unbounded; the panel keeps only a scrollback tail. */
const MAX_TERMINAL_CHUNKS = 500;

export function agentReducer(state: AgentState, event: any): AgentState {
    switch (event.type) {
        case 'TaskStarted':
            // A new task resets the per-run surfaces but keeps checkpoints, which
            // deliberately outlive the task that produced them.
            return {
                ...initialAgentState,
                checkpoints: state.checkpoints,
                phase: 'planning',
                taskId: event.taskId,
                traceId: event.traceId,
                mode: event.mode,
                model: event.model,
                startedAt: event.ts,
            };

        case 'TurnStarted':
            return { ...state, phase: 'reasoning', turn: event.turn };

        case 'ToolStarted':
            return {
                ...state,
                phase: 'tool',
                activity: [...state.activity, {
                    id: event.toolCallId,
                    name: event.name,
                    summary: event.summary,
                    status: 'running',
                    startedAt: event.ts,
                    arguments: event.arguments,
                }],
            };

        case 'ToolFinished':
            return {
                ...state,
                activity: state.activity.map(a => a.id === event.toolCallId
                    ? { 
                        ...a, 
                        status: event.ok ? 'ok' : 'error', 
                        durationMs: event.durationMs, 
                        summary: event.ok ? a.summary : event.summary,
                        output: event.output
                      }
                    : a),
            };

        case 'TerminalChunk':
            return {
                ...state,
                terminal: [...state.terminal, { stream: event.stream, text: event.text }].slice(-MAX_TERMINAL_CHUNKS),
            };

        case 'PlanUpdated':
            return { ...state, plan: event.steps };

        case 'ArtifactCreated':
            return {
                ...state,
                artifacts: [...state.artifacts.filter(a => a.path !== event.artifact.path), event.artifact],
            };

        case 'TokenUsage':
            return {
                ...state,
                tokens: {
                    inputTokens: event.inputTokens,
                    outputTokens: event.outputTokens,
                    cachedInputTokens: event.cachedInputTokens,
                    cost: event.cost,
                    turns: event.turns,
                },
            };

        case 'PipelineStarted':
            return {
                ...state,
                phase: 'planning',
                pipelineLog: [
                    ...(state.pipelineLog || []),
                    {
                        id: `pl_start_${event.ts || Date.now()}`,
                        timestamp: event.ts || Date.now(),
                        phase: 'Orchestrator',
                        type: 'info',
                        message: `Pipeline started with phases: ${event.phases.join(', ')}`
                    }
                ]
            };

        case 'PipelinePhaseStarted':
            return {
                ...state,
                // A retried phase re-announces itself as started — clear a prior
                // 'failed' status (and its error banner) so the UI reflects that
                // the pipeline is actually still running, not dead.
                phase: state.phase === 'failed' ? 'planning' : state.phase,
                error: state.phase === 'failed' ? undefined : state.error,
                pipelineLog: [
                    ...(state.pipelineLog || []),
                    {
                        id: `pl_${event.ts || Date.now()}`,
                        timestamp: event.ts || Date.now(),
                        phase: event.phase,
                        type: 'phase_start',
                        message: `Started phase: ${event.phase} (${event.index}/${event.total})`
                    }
                ]
            };

        case 'PipelinePhaseCompleted':
            return {
                ...state,
                pipelineLog: [
                    ...(state.pipelineLog || []),
                    {
                        id: `pl_${event.ts || Date.now()}`,
                        timestamp: event.ts || Date.now(),
                        phase: event.phase,
                        type: 'phase_complete',
                        message: `Completed phase: ${event.phase}`
                    }
                ]
            };

        case 'PipelinePhaseError':
            return {
                ...state,
                phase: 'failed',
                error: event.error,
                pipelineLog: [
                    ...(state.pipelineLog || []),
                    {
                        id: `pl_${event.ts || Date.now()}`,
                        timestamp: event.ts || Date.now(),
                        phase: event.phase,
                        type: 'error',
                        message: `Phase ${event.phase} failed: ${event.error}`
                    }
                ]
            };

        case 'FileChanged':
            return {
                ...state,
                pipelineLog: [
                    ...(state.pipelineLog || []),
                    {
                        id: `pl_${event.ts || Date.now()}`,
                        timestamp: event.ts || Date.now(),
                        phase: state.phase, // we could extract active phase
                        type: event.kind === 'created' ? 'file_created' : 'file_modified',
                        message: `${event.kind === 'created' ? 'Created' : 'Modified'} ${event.path}`,
                        filePath: event.path
                    }
                ]
            };

        case 'MindmapUpdated':
            return {
                ...state,
                pipelineLog: [
                    ...(state.pipelineLog || []),
                    {
                        id: `pl_${event.ts || Date.now()}`,
                        timestamp: event.ts || Date.now(),
                        phase: 'Orchestrator',
                        type: 'file_modified',
                        message: `Updated OpenSpec Mindmap`,
                        filePath: event.path
                    }
                ]
            };

        case 'PipelineCompleted':
            return {
                ...state,
                pipelineLog: [
                    ...(state.pipelineLog || []),
                    {
                        id: `pl_${event.ts || Date.now()}`,
                        timestamp: event.ts || Date.now(),
                        phase: 'Orchestrator',
                        type: 'file_created',
                        message: `Pipeline complete — overview.md generated`,
                        filePath: event.overviewPath
                    }
                ]
            };

        case 'TaskCompleted':
            return { ...state, phase: 'completed', endedAt: event.ts };

        case 'TaskFailed':
            return { ...state, phase: 'failed', endedAt: event.ts, error: event.error };

        case 'TaskCancelled':
            return { ...state, phase: 'cancelled', endedAt: event.ts };

        // Not an agent event — pushed by the extension when checkpoints change.
        case 'checkpoints':
            return { ...state, checkpoints: event.value };

        case 'setCheckpointDiff':
            return {
                ...state,
                checkpoints: state.checkpoints.map(cp => cp.id === event.checkpointId ? {
                    ...cp,
                    files: cp.files.map(f => f.path === event.path ? {
                        ...f,
                        diffPreview: event.diff
                    } : f)
                } : cp)
            };

        case 'SubagentStarted':
            return {
                ...state,
                subagents: [
                    ...(state.subagents || []).filter(sa => sa.id !== event.subagentId),
                    {
                        id: event.subagentId,
                        name: event.name,
                        task: event.task,
                        status: 'running',
                        progress: 'Starting worktree environment...'
                    }
                ]
            };

        case 'SubagentProgress':
            return {
                ...state,
                subagents: (state.subagents || []).map(sa => sa.id === event.subagentId
                    ? { ...sa, progress: event.progress }
                    : sa)
            };

        case 'SubagentFinished':
            return {
                ...state,
                subagents: (state.subagents || []).map(sa => sa.id === event.subagentId
                    ? { ...sa, status: event.ok ? 'completed' : 'failed', progress: event.ok ? 'Finished task successfully' : event.error || 'Failed task' }
                    : sa)
            };

        case 'SubagentCancelled':
            return {
                ...state,
                subagents: (state.subagents || []).map(sa => sa.id === event.subagentId
                    ? { ...sa, status: 'cancelled', progress: 'Cancelled by user' }
                    : sa)
            };

        case 'ResetTask':
            return {
                ...state,
                phase: 'idle',
                taskId: undefined,
                traceId: undefined,
                turn: 0,
                startedAt: undefined,
                endedAt: undefined,
                activity: [],
                terminal: [],
                plan: [],
                artifacts: [],
                error: undefined,
                tokens: undefined,
                subagents: [],
                pendingPlan: undefined,
            };

        case 'PlanApprovalRequested':
            return {
                ...state,
                phase: 'awaiting_approval',
                pendingPlan: {
                    planContent: event.planContent,
                    taskContent: event.taskContent,
                    planPath: event.planPath,
                    taskPath: event.taskPath,
                },
            };

        case 'PlanApproved':
            return {
                ...state,
                phase: 'planning',
                pendingPlan: undefined,
            };

        case 'PlanRejected':
            return {
                ...state,
                phase: 'cancelled',
                pendingPlan: undefined,
                endedAt: event.ts,
            };

        default:
            return state;
    }
}

/** @public — exercised by the test harness (test/harness.js). */
export function elapsedMs(state: AgentState, now = Date.now()): number {
    if (!state.startedAt) return 0;
    return (state.endedAt ?? now) - state.startedAt;
}

/** @public — exercised by the test harness (test/harness.js). */
export function phaseLabel(state: AgentState): string {
    switch (state.phase) {
        case 'planning': return 'Planning…';
        case 'reasoning': return 'Thinking…';
        case 'tool': {
            const running = state.activity.find(a => a.status === 'running');
            return running ? `${running.name}${running.summary ? ` — ${running.summary}` : ''}` : 'Working…';
        }
        case 'completed': return 'Completed';
        case 'failed': return 'Failed';
        case 'cancelled': return 'Cancelled';
        case 'awaiting_approval': return 'Awaiting Plan Approval…';
        default: return 'Idle';
    }
}

/**
 * Files still awaiting a Keep/Restore decision, newest checkpoint first.
 * @public — exercised by the test harness (test/harness.js).
 */
export function pendingReview(state: AgentState): { checkpointId: string; file: ReviewFile }[] {
    const out: { checkpointId: string; file: ReviewFile }[] = [];
    for (const cp of state.checkpoints) {
        for (const file of cp.files) {
            if (file.reviewState === 'pending') out.push({ checkpointId: cp.id, file });
        }
    }
    return out;
}
