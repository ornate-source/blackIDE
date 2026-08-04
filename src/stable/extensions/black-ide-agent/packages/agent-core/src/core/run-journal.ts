import { redactDeep } from './redaction';
import { narrate } from './office-narrate';

// ─── The run journal ────────────────────────────────────────────────────────
//
// A content-bearing, on-disk record of what a run actually did. This module is the pure
// half: one event in, zero or more journal lines out. The file handles live in
// `agent/journal-store.ts`.
//
// ── Why this is not `TelemetrySink` ──────────────────────────────────────────
// `TelemetrySink` already writes JSONL to disk, and widening it would have been the
// obvious move. It is also exactly wrong: its allow-list drops prompts, tool arguments,
// tool output, terminal chunks, file paths and `Log` lines *by design*, with the privacy
// reasoning written into the file. That posture is the whole value of it — it is the file
// that may one day be exported. This is the file that never leaves the machine.
//
//   TelemetrySink   aggregates · never content · exportable · 2 MiB rotating
//   RunJournal      the run in full · content-bearing · local only · per-run, aged out
//
// ── Depth is assigned by the producer ────────────────────────────────────────
// The reader picks a depth and sees everything at or below it. The *assignment* happens
// here, because only the producer knows whether a given line is a heading or a detail —
// a `Log` line reading "3 skills fired" is scaffolding, and one reading "verification
// failed" is the answer. A reader-side filter would have to guess from the text.

export type JournalDepth = 'summary' | 'normal' | 'verbose';
export type JournalLevel = 'info' | 'warn' | 'error';

export type JournalKind =
    | 'run' | 'turn' | 'tool' | 'file' | 'phase' | 'steer' | 'model'
    | 'context' | 'verify' | 'approval' | 'artifact' | 'usage' | 'terminal' | 'log' | 'end';

export interface JournalLine {
    ts: number;
    /** Monotonic within a run, so two events in the same millisecond keep their order. */
    seq: number;
    id: string;
    lane: string;
    kind: JournalKind;
    level: JournalLevel;
    depth: JournalDepth;
    /** The human-readable head of the line: `opened`, `turn 3 / 25`, `run finished`. */
    verb: string;
    /** What the verb acts on, when there is one. Absent, never `''`, when there is not. */
    target?: string;
    /** Structured extras. Redacted and size-capped before it is written. */
    detail?: Record<string, unknown>;
    durationMs?: number;
    /** Pointer to a body too large to inline. See `journal-store.ts`. */
    payloadRef?: string;
    /** A body the store should spill to a payload file rather than inline. */
    payload?: string;
}

export const DEPTH_ORDER: Record<JournalDepth, number> = { summary: 0, normal: 1, verbose: 2 };

/** Inline `detail` is capped hard: a journal is a record, not a second copy of the repo. */
export const MAX_DETAIL_BYTES = 2_048;
/** Bodies over this are spilled to a side file and referenced. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

export function atOrBelow(line: JournalDepth, selected: JournalDepth): boolean {
    return DEPTH_ORDER[line] <= DEPTH_ORDER[selected];
}

export interface JournalContext {
    id: string;
    lane: string;
    seq: number;
}

/**
 * Project one event into journal lines.
 *
 * Returns an array because a few events are genuinely two lines and most are zero or one.
 * An unrecognised event produces **nothing** rather than a generic line: a journal whose
 * bulk is `{"type":"SomethingUnhandled"}` is one nobody reads, and a line that says only
 * that something happened is indistinguishable from the silence it was meant to fix.
 */
export function toJournalLines(event: any, context: JournalContext): JournalLine[] {
    if (!event?.type) return [];
    const base = {
        ts: typeof event.ts === 'number' ? event.ts : Date.now(),
        seq: context.seq,
        id: context.id,
        lane: context.lane,
        level: 'info' as JournalLevel,
    };
    const line = (over: Partial<JournalLine> & Pick<JournalLine, 'kind' | 'depth' | 'verb'>): JournalLine[] =>
        [sanitize({ ...base, ...over })];

    switch (event.type) {
        // ── The spine: visible at every depth ───────────────────────────────
        case 'TaskStarted':
            return line({
                kind: 'run', depth: 'summary', verb: 'run started',
                target: event.model,
                detail: { mode: event.mode, model: event.model, prompt: event.prompt },
            });

        case 'TaskCompleted':
            return line({
                kind: 'end', depth: 'summary', verb: 'run finished',
                detail: { turns: event.turns, durationMs: event.durationMs },
                durationMs: event.durationMs,
            });

        case 'TaskFailed':
            return line({
                kind: 'end', depth: 'summary', verb: 'run failed', level: 'error',
                detail: { error: event.error, durationMs: event.durationMs },
                durationMs: event.durationMs,
            });

        case 'TaskCancelled':
            return line({
                kind: 'end', depth: 'summary', verb: 'run cancelled', level: 'warn',
                durationMs: event.durationMs,
            });

        case 'TurnStarted':
            return line({
                kind: 'turn', depth: 'summary',
                verb: event.maxTurns ? `turn ${event.turn} / ${event.maxTurns}` : `turn ${event.turn}`,
            });

        case 'PlanApprovalRequested':
            return line({ kind: 'approval', depth: 'summary', verb: 'waiting for plan approval', target: event.planPath });
        case 'PlanApproved':
            return line({ kind: 'approval', depth: 'summary', verb: 'plan approved' });
        case 'PlanRejected':
            return line({ kind: 'approval', depth: 'summary', verb: 'plan rejected', level: 'warn', detail: { feedback: event.feedback } });

        case 'SteeringApplied':
            return line({ kind: 'steer', depth: 'summary', verb: 'steered', detail: { count: event.count } });

        case 'VerificationCompleted':
        case 'PipelineVerified':
            return line({
                kind: 'verify', depth: 'summary',
                verb: `verification ${event.outcome}`,
                level: event.outcome === 'verified' ? 'info' : 'warn',
                target: event.reportPath,
                detail: { summary: event.summary },
            });

        // ── The body of the log: what the agent did ─────────────────────────
        case 'ToolStarted':
        case 'ToolCallStarted': {
            const activity = narrate({ name: event.name, arguments: event.arguments });
            return line({
                kind: 'tool', depth: 'normal',
                verb: activity?.verb || event.name,
                target: activity?.target,
                detail: { tool: event.name, toolCallId: event.toolCallId },
                // The full arguments are verbose-only material and can be large — a
                // `write_file` carries the whole file — so they ride as a payload the
                // store decides where to put.
                payload: event.arguments !== undefined ? safeStringify(event.arguments) : undefined,
            });
        }

        case 'ToolFinished':
        case 'ToolCallFinished':
            return line({
                kind: 'tool', depth: 'normal',
                verb: event.ok === false ? `${event.name} failed` : `${event.name} finished`,
                level: event.ok === false ? 'error' : 'info',
                durationMs: event.durationMs,
                detail: { tool: event.name, toolCallId: event.toolCallId, summary: event.summary },
                payload: event.output || undefined,
            });

        case 'FileChanged':
            return line({
                kind: 'file', depth: 'normal',
                verb: event.kind === 'created' ? 'created' : event.kind === 'deleted' ? 'deleted' : 'changed',
                target: event.path,
            });

        case 'PipelinePhaseStarted':
            return line({
                kind: 'phase', depth: 'summary',
                verb: `phase ${event.index} / ${event.total}`, target: event.phase,
            });
        case 'PipelinePhaseCompleted':
            return line({ kind: 'phase', depth: 'summary', verb: 'phase finished', target: event.phase });
        case 'PipelinePhaseError':
            return line({ kind: 'phase', depth: 'summary', verb: 'phase failed', level: 'error', target: event.phase, detail: { error: event.error } });
        case 'PipelineStarted':
            return line({ kind: 'run', depth: 'summary', verb: 'pipeline started', detail: { phases: event.phases } });
        case 'PipelineCompleted':
            return line({ kind: 'end', depth: 'summary', verb: 'pipeline finished', target: event.overviewPath });

        case 'ArtifactCreated':
            return line({
                kind: 'artifact', depth: 'normal', verb: 'wrote',
                target: event.artifact?.path, detail: { type: event.artifact?.type, name: event.artifact?.name },
            });

        // ── Verbose: the pre-flight and the machinery ───────────────────────
        /*
         * `Log` is the reason the journal closes the "thinking, but doing nothing" defect.
         *
         * Every pre-flight step — the index build, skill resolution, rule activation, MCP
         * connection, prompt assembly — already calls `log()`, and every one of those lines
         * has, until now, gone to a two-line collapsed strip in the chat panel and nowhere
         * else. Here they land in a file, in order, with timestamps, so "it hung and I
         * closed the window" stops destroying the evidence.
         */
        case 'Log':
            return line({
                kind: 'log', depth: 'verbose',
                verb: event.message || '',
                level: (event.level === 'warn' || event.level === 'error') ? event.level : 'info',
            });

        case 'ContextUsed':
            return line({
                kind: 'context', depth: 'verbose', verb: 'context',
                detail: { usedTokens: event.usedTokens, limitTokens: event.limitTokens },
            });

        case 'TokenUsage':
            return line({
                kind: 'usage', depth: 'verbose', verb: 'usage',
                detail: {
                    inputTokens: event.inputTokens, outputTokens: event.outputTokens,
                    cachedInputTokens: event.cachedInputTokens, cost: event.cost, turns: event.turns,
                },
            });

        case 'TerminalChunk':
            return line({
                kind: 'terminal', depth: 'verbose', verb: event.stream,
                level: event.stream === 'stderr' ? 'warn' : 'info',
                payload: event.text,
            });

        case 'SkillsFired':
            return line({
                kind: 'log', depth: 'verbose', verb: 'skills fired',
                detail: { mode: event.mode, total: event.total, bundled: event.bundled, userCount: event.userCount },
            });

        case 'CheckpointCreated':
            return line({
                kind: 'file', depth: 'verbose', verb: 'checkpoint',
                detail: { checkpointId: event.checkpointId, files: event.files?.length },
            });

        case 'PlanUpdated':
            return line({ kind: 'log', depth: 'verbose', verb: 'plan updated', detail: { steps: event.steps?.length } });

        case 'MindmapUpdated':
            return line({ kind: 'file', depth: 'verbose', verb: 'mindmap updated', target: event.path });

        /*
         * Reasoning is deliberately not journalled.
         *
         * It arrives token by token — thousands of events for one turn — and it is already
         * streamed to the panel that wants it. Writing it here would make the journal
         * mostly prose, push every mechanical line off the screen, and multiply the file
         * size by an order of magnitude for content that is not a record of what the agent
         * *did*. This is the one omission worth stating, because its absence looks like a
         * gap rather than a decision.
         */
        case 'ReasoningChunk':
            return [];

        default:
            return [];
    }
}

/**
 * Redact and cap.
 *
 * On write, not on read, for two reasons: the Logs tab offers an "open as file" button, so
 * a journal that is only clean when rendered leaks the moment anyone takes it up on that;
 * and redacting on read costs CPU on every scroll of a 400 KB file.
 *
 * The cost is that a false positive is unrecoverable. That is the right trade for a local
 * diagnostic file, and it is the same one `RawOutputStore` already makes.
 */
function sanitize(line: JournalLine): JournalLine {
    const out: JournalLine = { ...line };

    if (out.target) out.target = redactString(out.target);
    if (out.verb) out.verb = redactString(out.verb);

    if (out.detail) {
        const redacted = redactDeep(out.detail);
        const encoded = safeStringify(redacted);
        out.detail = encoded.length > MAX_DETAIL_BYTES
            // Truncation is *stated*, so a reader can tell a short value from a cut one.
            ? { truncated: true, preview: encoded.slice(0, MAX_DETAIL_BYTES) }
            : redacted;
    }

    if (out.payload !== undefined) {
        const redacted = redactString(out.payload);
        out.payload = redacted.length > MAX_PAYLOAD_BYTES
            ? `${redacted.slice(0, MAX_PAYLOAD_BYTES)}\n…(truncated at ${MAX_PAYLOAD_BYTES} bytes)`
            : redacted;
    }

    return out;
}

function redactString(value: string): string {
    const wrapped = redactDeep({ v: String(value) }) as { v: string };
    return wrapped.v;
}

/** Never throws on a cycle or a BigInt — a journal write must not fail a run. */
function safeStringify(value: unknown): string {
    try {
        const seen = new WeakSet();
        return JSON.stringify(value, (_key, v) => {
            if (typeof v === 'bigint') return String(v);
            if (typeof v === 'object' && v !== null) {
                if (seen.has(v as object)) return '[circular]';
                seen.add(v as object);
            }
            return v;
        }) ?? '';
    } catch {
        return '';
    }
}

/** Render one line the way the Logs tab shows it. Pure, so it is testable without React. */
export function formatJournalLine(line: JournalLine): string {
    const time = new Date(line.ts).toISOString().slice(11, 23);
    const duration = line.durationMs !== undefined ? `  ${(line.durationMs / 1000).toFixed(1)}s` : '';
    const target = line.target ? `  ${line.target}` : '';
    return `${time}  ${line.verb}${target}${duration}`;
}
