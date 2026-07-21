import { AgentMode } from './types';

// ─── Typed Event Bus ────────────────────────────────────────────────────────
// Every subsystem publishes here instead of reaching for the webview. The UI is
// one subscriber among several (logger, activity timeline, metrics), so adding a
// consumer never means touching the runtime.

export interface EventMeta {
    sessionId: string;
    conversationId: string;
    taskId: string;
    traceId: string;
    ts: number;
}

export type AgentEvent =
    | { type: 'TaskStarted'; prompt: string; mode: AgentMode; model: string }
    | { type: 'TaskCompleted'; finalText: string; turns: number; durationMs: number }
    | { type: 'TaskFailed'; error: string; durationMs: number }
    | { type: 'TaskCancelled'; durationMs: number }
    | { type: 'TurnStarted'; turn: number }
    | { type: 'ReasoningChunk'; text: string }
    | { type: 'ToolStarted'; toolCallId: string; name: string; summary: string; arguments?: any }
    | { type: 'ToolFinished'; toolCallId: string; name: string; ok: boolean; durationMs: number; summary: string; output?: string }
    | { type: 'TerminalChunk'; stream: 'stdout' | 'stderr'; text: string }
    | { type: 'FileChanged'; path: string; kind: 'created' | 'modified' | 'deleted' }
    | { type: 'CheckpointCreated'; checkpointId: string; files: string[] }
    | { type: 'PlanUpdated'; steps: { title: string; status: string }[] }
    | { type: 'ArtifactCreated'; artifact: { name: string; type: string; path: string } }
    | { type: 'TokenUsage'; inputTokens: number; outputTokens: number; cachedInputTokens?: number; cost: number; turns: number }
    | { type: 'Log'; level: 'info' | 'warn' | 'error'; message: string }
    | { type: 'PlanApprovalRequested'; planPath: string; taskPath: string; planContent: string; taskContent: string }
    | { type: 'PlanApproved' }
    | { type: 'PlanRejected'; feedback?: string }
    | { type: 'PipelineStarted'; phases: string[] }
    | { type: 'PipelinePhaseStarted'; phase: string; index: number; total: number }
    | { type: 'PipelinePhaseCompleted'; phase: string }
    | { type: 'PipelinePhaseError'; phase: string; error: string }
    | { type: 'PipelineCompleted'; overviewPath: string }
    | { type: 'MindmapUpdated'; path: string };

/** An event as it travels the bus: the payload plus its correlation envelope. */
export type Envelope<E extends AgentEvent = AgentEvent> = E & EventMeta;

type Handler = (e: Envelope) => void;

export class EventBus {
    private handlers = new Map<string, Set<Handler>>();
    private anyHandlers = new Set<Handler>();

    /** Subscribe to one event type. Returns an unsubscribe function. */
    on<T extends AgentEvent['type']>(
        type: T,
        handler: (e: Envelope<Extract<AgentEvent, { type: T }>>) => void,
    ): () => void {
        let set = this.handlers.get(type);
        if (!set) { set = new Set(); this.handlers.set(type, set); }
        set.add(handler as Handler);
        return () => set!.delete(handler as Handler);
    }

    /** Subscribe to every event. Used by the logger, timeline and telemetry sinks. */
    onAny(handler: Handler): () => void {
        this.anyHandlers.add(handler);
        return () => this.anyHandlers.delete(handler);
    }

    /**
     * Dispatch synchronously. A throwing subscriber must never take down the agent
     * run that published the event, so failures are isolated and reported, not raised.
     */
    emit(event: Envelope): void {
        for (const h of this.handlers.get(event.type) || []) {
            try { h(event); } catch (err) { this.reportHandlerError(event, err); }
        }
        for (const h of this.anyHandlers) {
            try { h(event); } catch (err) { this.reportHandlerError(event, err); }
        }
    }

    private reportHandlerError(event: Envelope, err: unknown): void {
        // Never re-enter emit() from here: a failing Log subscriber would loop forever.
        console.error(`[EventBus] subscriber threw on ${event.type}:`, err);
    }

    dispose(): void {
        this.handlers.clear();
        this.anyHandlers.clear();
    }
}
