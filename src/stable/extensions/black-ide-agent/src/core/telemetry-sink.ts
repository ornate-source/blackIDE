import * as fs from 'fs';
import * as path from 'path';

// ─── Agent Telemetry ─────────────────────────────────────────────────────────
// A privacy-safe subscriber on the EventBus: counts, durations, and coarse types
// only — never prompts, file paths, file contents, or tool output. Local-first:
// writes a rotating JSONL the user can export for self-diagnosis, independent of
// whether anonymous remote telemetry is ever enabled. Telemetry must never throw
// into the agent runtime, so every write is defensively swallowed.

export interface TelemetryRecord {
    type: string;
    ts: number;
    [k: string]: unknown;
}

/**
 * Maps an error message to a coarse class — never the raw text (which can contain
 * paths, commands, or snippets). Pure/exported for testing.
 */
export function classifyError(msg: string): string {
    const m = (msg || '').toLowerCase();
    if (m.includes('budget')) return 'budget';
    if (m.includes('abort') || m.includes('cancel')) return 'cancelled';
    if (m.includes('timeout') || m.includes('timed out')) return 'timeout';
    if (m.includes('network') || m.includes('econn') || m.includes('fetch') || m.includes('socket')) return 'network';
    if (m.includes('policy') || m.includes('deny')) return 'policy';
    if (m.includes('not found') || m.includes('no llm') || m.includes('configuration')) return 'config';
    return 'other';
}

/**
 * Projects a bus envelope to a privacy-safe telemetry record, or null to drop it.
 * The allow-list is deliberate: only aggregate, non-content-bearing signals pass;
 * everything streaming or content-bearing (prompts, tool args/output, terminal
 * chunks, file paths, reasoning, logs) is dropped. Pure/exported for testing.
 */
export function toTelemetryRecord(env: any): TelemetryRecord | null {
    if (!env || typeof env.type !== 'string') return null;
    const base = { ts: typeof env.ts === 'number' ? env.ts : Date.now(), traceId: env.traceId };
    switch (env.type) {
        case 'TaskStarted':          return { type: env.type, ...base, mode: env.mode, model: env.model };
        case 'TaskCompleted':        return { type: env.type, ...base, turns: env.turns, durationMs: env.durationMs };
        case 'TaskFailed':           return { type: env.type, ...base, durationMs: env.durationMs, errorClass: classifyError(env.error) };
        case 'TaskCancelled':        return { type: env.type, ...base, durationMs: env.durationMs };
        case 'ToolFinished':         return { type: env.type, ...base, name: env.name, ok: env.ok, durationMs: env.durationMs };
        case 'TokenUsage':           return { type: env.type, ...base, inputTokens: env.inputTokens, outputTokens: env.outputTokens, cost: env.cost };
        case 'PipelineStarted':      return { type: env.type, ...base, phaseCount: Array.isArray(env.phases) ? env.phases.length : undefined };
        case 'PipelinePhaseStarted': return { type: env.type, ...base, phase: env.phase, index: env.index };
        case 'PipelinePhaseCompleted': return { type: env.type, ...base, phase: env.phase };
        case 'PipelinePhaseError':   return { type: env.type, ...base, phase: env.phase, errorClass: classifyError(env.error) };
        case 'PipelineCompleted':    return { type: env.type, ...base };
        default:                     return null;
    }
}

export interface TelemetrySinkOptions {
    filePath: string;
    /** Read fresh each call so toggling the setting takes effect without a restart. */
    enabled: () => boolean;
    /** Rotate to `<file>.1` once the live file exceeds this. Default 2 MiB. */
    maxBytes?: number;
    /** Injected line writer (tests capture; prod appends to disk). Defaults to fs append. */
    write?: (line: string) => void;
}

export class TelemetrySink {
    constructor(private readonly opts: TelemetrySinkOptions) {}

    /** Record one bus envelope. No-op when disabled or when the event is not projectable. */
    record(env: unknown): void {
        try {
            if (!this.opts.enabled()) return;
            const rec = toTelemetryRecord(env);
            if (!rec) return;
            const line = JSON.stringify(rec);
            if (this.opts.write) { this.opts.write(line); return; }
            this.appendToDisk(line);
        } catch {
            // Telemetry is best-effort and must never disrupt the agent run.
        }
    }

    private appendToDisk(line: string): void {
        const max = this.opts.maxBytes ?? 2 * 1024 * 1024;
        const dir = path.dirname(this.opts.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        try {
            if (fs.existsSync(this.opts.filePath) && fs.statSync(this.opts.filePath).size > max) {
                try { fs.renameSync(this.opts.filePath, this.opts.filePath + '.1'); } catch {}
            }
        } catch {}
        fs.appendFileSync(this.opts.filePath, line + '\n', 'utf8');
    }
}
