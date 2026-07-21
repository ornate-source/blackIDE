import { AgentEvent, EventBus, Envelope, EventMeta } from './event-bus';
import { AgentMode } from './types';

// ─── Session Manager ────────────────────────────────────────────────────────
// Owns identity and lifecycle: one Session per activation, a Conversation per
// chat thread, a Task per user prompt. Everything published to the bus carries
// these ids, which is what makes a run traceable and replayable after the fact.

let counter = 0;
function id(prefix: string): string {
    counter += 1;
    return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export type TaskState = 'created' | 'planning' | 'reasoning' | 'tool_execution' | 'validation' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

/** Terminal states cannot transition further; a late event must not resurrect a task. */
const TERMINAL: TaskState[] = ['completed', 'failed', 'cancelled'];

export interface TaskRecord {
    taskId: string;
    conversationId: string;
    traceId: string;
    prompt: string;
    mode: AgentMode;
    model: string;
    state: TaskState;
    startedAt: number;
    endedAt?: number;
    turns: number;
    error?: string;
}

/**
 * Publishes to the bus with a task's correlation envelope already attached.
 * Handed to the agent runtime so it never has to know about session identity.
 */
export interface TaskEmitter {
    readonly meta: Omit<EventMeta, 'ts'>;
    emit(event: AgentEvent): void;
}

export class SessionManager {
    readonly sessionId = id('sess');
    private conversationId = id('conv');
    private tasks = new Map<string, TaskRecord>();

    constructor(private readonly bus: EventBus) {}

    /** Start a new chat thread. Tasks are scoped to the conversation they ran in. */
    newConversation(): string {
        this.conversationId = id('conv');
        return this.conversationId;
    }

    get currentConversationId(): string {
        return this.conversationId;
    }

    beginTask(prompt: string, mode: AgentMode, model: string): TaskEmitter {
        const record: TaskRecord = {
            taskId: id('task'),
            conversationId: this.conversationId,
            traceId: id('trace'),
            prompt, mode, model,
            state: 'created',
            startedAt: Date.now(),
            turns: 0,
        };
        this.tasks.set(record.taskId, record);

        const meta = {
            sessionId: this.sessionId,
            conversationId: record.conversationId,
            taskId: record.taskId,
            traceId: record.traceId,
        };

        const emitter: TaskEmitter = {
            meta,
            emit: (event: AgentEvent) => {
                this.applyToRecord(record, event);
                this.bus.emit({ ...event, ...meta, ts: Date.now() } as Envelope);
            },
        };

        emitter.emit({ type: 'TaskStarted', prompt, mode, model });
        return emitter;
    }

    /** Keep the task record in step with the event stream — the record is a projection. */
    private applyToRecord(record: TaskRecord, event: AgentEvent): void {
        if (TERMINAL.includes(record.state)) return;
        switch (event.type) {
            case 'TaskStarted': record.state = 'planning'; break;
            case 'TurnStarted': record.state = 'reasoning'; record.turns = event.turn; break;
            case 'ToolStarted': record.state = 'tool_execution'; break;
            case 'ToolFinished': record.state = 'validation'; break;
            case 'PlanApprovalRequested': record.state = 'awaiting_approval'; break;
            case 'PlanApproved': record.state = 'planning'; break;
            case 'PlanRejected': record.state = 'cancelled'; record.endedAt = Date.now(); break;
            case 'TaskCompleted':
                record.state = 'completed';
                record.endedAt = Date.now();
                record.turns = event.turns;
                break;
            case 'TaskFailed':
                record.state = 'failed';
                record.endedAt = Date.now();
                record.error = event.error;
                break;
            case 'TaskCancelled':
                record.state = 'cancelled';
                record.endedAt = Date.now();
                break;
        }
    }

    getTask(taskId: string): TaskRecord | undefined {
        return this.tasks.get(taskId);
    }

    /** Tasks for a conversation, oldest first. Drives history and replay. */
    tasksFor(conversationId: string): TaskRecord[] {
        return Array.from(this.tasks.values())
            .filter(t => t.conversationId === conversationId)
            .sort((a, b) => a.startedAt - b.startedAt);
    }

    get activeTask(): TaskRecord | undefined {
        return Array.from(this.tasks.values()).find(t => !TERMINAL.includes(t.state));
    }
}
