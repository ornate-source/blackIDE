import { GovernorSnapshot } from '@blackide/agent-core/core/agent-governor';
import { InboxItem } from '@blackide/agent-core/core/agent-inbox';
import { PipelineRunSummary } from '@blackide/agent-core/core/pipeline-runs';
import { TaskAgentSummary } from '@blackide/agent-core/core/task-agents';
import { narrate } from '@blackide/agent-core/core/office-narrate';
import {
    ChatSubagentSummary, DaemonResultSummary, LiveTelemetry, OfficeSnapshot, buildOffice,
} from '@blackide/agent-core/core/office-model';
import { PatchCoalescer } from '@blackide/agent-core/core/office-telemetry';
import { JournalQuery } from '@blackide/agent-core/core/journal-reader';
import { formatJournalLine } from '@blackide/agent-core/core/run-journal';
import { JournalStore } from '../agent/journal-store';

// ─── The Agent Office's extension-host half ─────────────────────────────────
//
// One object that holds *live* telemetry — the things a lane computes during a run and
// then throws away — and pushes it to whichever Office surfaces are open.
//
// ── Why this exists rather than a field on each summary ──────────────────────
// `TaskAgentSummary` is persisted to `globalState` and reconciled across reloads. Putting
// "which tool is running, on what, since when" on it would persist a value that is false
// the moment the host restarts, and `reconcileInterruptedAgents` would have to know to
// clear it. Live telemetry is *session* state about a *running* process: it belongs beside
// the run, is discarded when the run retires, and is simply absent for anything the
// current host did not run. A desk for a reloaded agent renders `—` in those cells, which
// is the truth.
//
// ── The publish rule ─────────────────────────────────────────────────────────
// Nothing is computed when no surface is open. The Manager panel already drops posts with
// no panel (`manager-panel.ts:84`), but that is the consumer declining after the producer
// has already built the snapshot and serialised it. `hasSurface` is checked at the top of
// every push instead.

/** How often staged patches are handed to the surfaces. */
const DRAIN_INTERVAL_MS = 250;

/** Files reported per run before the table stops growing. */
const MAX_FILES_IN_PLAY = 40;

/** After one of these, a run is finished and its journal may be swept. */
const TERMINAL_EVENTS = new Set(['TaskCompleted', 'TaskFailed', 'TaskCancelled']);

export interface FileInPlay {
    path: string;
    /** The item that touched it — so the table can say *who*, which is its whole value. */
    by: string;
    kind: 'created' | 'modified' | 'deleted';
    at: number;
}

export interface OfficeHubDeps {
    /**
     * The durable half (M82).
     *
     * Held by the hub rather than beside it because the Office is one feature with two
     * surfaces — the desks are a projection of now, the log is the record of then — and a
     * consumer that has the hub should not need a second reference to ask either question.
     */
    journal?: JournalStore;
    listAgents(): TaskAgentSummary[];
    listPipelines(): PipelineRunSummary[];
    listInbox(): InboxItem[];
    governorSnapshot(): GovernorSnapshot;
    /** Chat subagents, which live in the chat lane's own state today. */
    listChatSubagents?(): ChatSubagentSummary[];
    listDaemonResults?(): DaemonResultSummary[];
    /** Ordered phase names per pipeline run, when known. R3: a position, not a schedule. */
    phasesFor?(runId: string): { names: string[]; current?: string } | undefined;
    /** Post to every open Office surface. Returns false when none is open. */
    post(message: any): boolean;
    now?(): number;
}

export class OfficeHub {
    private readonly live = new Map<string, LiveTelemetry>();
    private readonly files = new Map<string, FileInPlay[]>();
    private readonly coalescer = new PatchCoalescer(DRAIN_INTERVAL_MS);
    private timer?: ReturnType<typeof setInterval>;

    constructor(private readonly d: OfficeHubDeps) {}

    private now(): number {
        return this.d.now ? this.d.now() : Date.now();
    }

    /** Start draining staged patches. Idempotent, so a second surface opening is harmless. */
    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => this.drain(), DRAIN_INTERVAL_MS);
    }

    dispose(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    /** The whole state, for a surface that just mounted. */
    snapshot(): OfficeSnapshot {
        return buildOffice({
            agents: this.d.listAgents(),
            pipelines: this.d.listPipelines(),
            chat: this.d.listChatSubagents?.(),
            daemon: this.d.listDaemonResults?.(),
            inbox: this.d.listInbox(),
            governor: this.d.governorSnapshot(),
            live: Object.fromEntries(this.live),
            phases: this.phaseMap(),
            now: this.now(),
        });
    }

    /**
     * Push the full state.
     *
     * Called on mount and whenever the roster's *shape* changes — a launch, a retire, an
     * apply. Field changes go through `record` instead: re-sending four full summaries
     * because one agent's turn counter moved is the whole-array-replacement cost the patch
     * channel exists to remove.
     */
    sync(): void {
        if (!this.post({ type: 'officeSync', value: this.snapshot() })) return;
        // Anything staged is now redundant — the sync carried it — and posting it again
        // would make the desk flicker back through a value it has already passed.
        this.coalescer.flush(this.now());
    }

    /** Push the governor alone, for the header tiles. */
    syncGovernor(): void {
        this.post({ type: 'officeGovernor', value: this.d.governorSnapshot() });
    }

    /** Push the files-in-play table. Cheap, and only when something moved. */
    syncFiles(): void {
        this.post({ type: 'officeFiles', value: this.filesInPlay() });
    }

    /**
     * One event from a run, folded into that item's live telemetry.
     *
     * Accepts the task lane's private event shape *and* the bus envelope shape, because
     * the two lanes publish differently today and normalising here is cheaper than a
     * migration that would touch every lane at once. Unknown events are ignored rather
     * than logged: this is on the hot path of every tool call.
     */
    record(id: string, event: any): void {
        if (!id || !event?.type) return;
        const now = this.now();

        switch (event.type) {
            case 'ToolCallStarted':
            case 'ToolStarted': {
                const activity = narrate({
                    name: event.name,
                    arguments: event.arguments,
                    ts: typeof event.ts === 'number' ? event.ts : now,
                });
                this.stage(id, { activity });
                break;
            }
            case 'ToolCallFinished':
            case 'ToolFinished': {
                // The activity is cleared rather than left showing a finished tool: a desk
                // that reads `editing NavHeader.tsx` for the thirty seconds the model then
                // spends thinking is actively misleading about where the time went.
                const current = this.live.get(id)?.activity;
                if (!current || current.tool === event.name) this.stage(id, { activity: undefined });
                break;
            }
            case 'TurnStarted':
                if (typeof event.turn === 'number' && typeof event.maxTurns === 'number') {
                    this.stage(id, { progress: { turn: event.turn, maxTurns: event.maxTurns } });
                }
                break;
            case 'ContextUsed': {
                const { usedTokens, limitTokens } = event;
                if (typeof usedTokens === 'number' && typeof limitTokens === 'number' && limitTokens > 0) {
                    this.stage(id, {
                        context: {
                            usedTokens,
                            limitTokens,
                            // Rounded once, here, so three surfaces cannot round it three ways.
                            percent: Math.min(100, Math.round((usedTokens / limitTokens) * 100)),
                        },
                    });
                }
                break;
            }
            case 'FileChanged':
                this.recordFile(id, event.path, event.kind, now);
                break;
            case 'TaskCompleted':
            case 'TaskFailed':
            case 'TaskCancelled':
                // The run is over; a staged activity is now a claim about the past.
                this.stage(id, { activity: undefined });
                this.coalescer.flush(now).forEach(patch => this.postPatch(patch));
                break;
        }
    }

    // ── The log ─────────────────────────────────────────────────────────────

    /**
     * Journal one event, from any lane.
     *
     * The guard is here rather than at each of the three call sites: an event with no run
     * to belong to cannot be read back by anybody, so writing it would grow the file
     * without ever answering a question.
     */
    journalEvent(runId: string | undefined, lane: string, event: any): void {
        if (!runId || !this.d.journal) return;
        this.d.journal.record(runId, lane, event);
        if (TERMINAL_EVENTS.has(event?.type)) {
            // Releases the run from the "a live run is never pruned" rule, and is the only
            // moment a sweep can safely reclaim it.
            this.d.journal.close(runId);
            this.d.journal.sweep();
        }
    }

    /** A page of a run's log, for the Logs tab and for `read_run_log`. */
    readLog(runId: string, query: JournalQuery = {}) {
        return this.d.journal?.read(runId, query);
    }

    /** Runs that have a log, newest first. */
    listLogs(limit?: number) {
        return this.d.journal?.list(limit) ?? [];
    }

    /** A spilled body, for the tab's expander. */
    logPayload(runId: string, ref: string): string | undefined {
        return this.d.journal?.payload(runId, ref);
    }

    /** The log's path on disk, for "open as file". */
    logFile(runId: string): string | undefined {
        return this.d.journal?.fileFor(runId);
    }

    /**
     * A run's log rendered for a model (M84).
     *
     * Plain lines rather than JSON: the model reads prose far more cheaply than it reads
     * an object per line, and every field the JSON carries that a reader would act on —
     * the time, the verb, the target, the duration — is in the rendered form. The header
     * states the depth and the truncation, because a model handed 60 of 2,000 lines with
     * no indication would reason as though it had seen the run.
     */
    readLogForModel(params: {
        runId?: string; depth?: string; filter?: string; problemsOnly?: boolean; limit?: number;
    }): string | undefined {
        if (!params.runId) return undefined;
        const depth = (['summary', 'normal', 'verbose'] as const)
            .find(d => d === params.depth) ?? 'summary';
        const limit = Math.max(1, Math.min(400, params.limit ?? 60));

        const page = this.d.journal?.read(params.runId, {
            depth, filter: params.filter, problemsOnly: params.problemsOnly, limit,
        });
        if (!page) return undefined;
        if (!page.lines.length) {
            return `Run ${params.runId} has no ${depth}-level lines`
                + `${params.filter ? ` matching "${params.filter}"` : ''}.`
                + (depth === 'summary' ? ' Try depth "normal" to see individual tool calls.' : '');
        }

        const head = `Run ${params.runId} — ${page.summary.turns} turns, ${page.summary.tools} tool calls, `
            + `${page.summary.errors} errors. Showing ${page.lines.length} of ${page.matched} lines at "${depth}" depth.`;
        return [head, '', ...page.lines.map(formatJournalLine)].join('\n');
    }

    /** Forget an item that retired, so its telemetry cannot outlive it. */
    forget(id: string): void {
        this.live.delete(id);
        this.files.delete(id);
        this.coalescer.forget(id);
    }

    /** The flat table: what is being touched, and by whom. */
    filesInPlay(): FileInPlay[] {
        const out: FileInPlay[] = [];
        for (const rows of this.files.values()) out.push(...rows);
        return out.sort((a, b) => b.at - a.at).slice(0, MAX_FILES_IN_PLAY);
    }

    // ── internals ───────────────────────────────────────────────────────────

    private stage(id: string, fields: Partial<LiveTelemetry>): void {
        this.live.set(id, { ...(this.live.get(id) || {}), ...fields });
        this.coalescer.record(id, fields);
    }

    private drain(): void {
        const patches = this.coalescer.drain(this.now());
        if (!patches.length) return;
        for (const patch of patches) this.postPatch(patch);
    }

    private postPatch(patch: { id: string; fields: Partial<LiveTelemetry> }): void {
        this.post({ type: 'officePatch', value: patch });
    }

    private post(message: any): boolean {
        return this.d.post(message);
    }

    private recordFile(id: string, path: string, kind: FileInPlay['kind'], at: number): void {
        if (!path) return;
        const rows = this.files.get(id) || [];
        const existing = rows.findIndex(r => r.path === path);
        const row: FileInPlay = { path, by: id, kind: kind || 'modified', at };
        if (existing >= 0) rows[existing] = row;
        else rows.push(row);
        // Bounded per run: an agent that rewrites 400 files is a real thing, and the table
        // answers "is anything touching what I have open", not "list the diff".
        this.files.set(id, rows.slice(-MAX_FILES_IN_PLAY));
        this.syncFiles();
    }

    private phaseMap(): Record<string, { names: string[]; current?: string }> | undefined {
        if (!this.d.phasesFor) return undefined;
        const out: Record<string, { names: string[]; current?: string }> = {};
        for (const run of this.d.listPipelines()) {
            const phases = this.d.phasesFor(run.id);
            if (phases) out[run.id] = phases;
        }
        return Object.keys(out).length ? out : undefined;
    }
}
