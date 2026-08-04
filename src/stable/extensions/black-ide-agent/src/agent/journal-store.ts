import * as fs from 'fs';
import * as path from 'path';
import {
    JournalLine, MAX_PAYLOAD_BYTES, toJournalLines,
} from '@blackide/agent-core/core/run-journal';
import { JournalPage, JournalQuery, JournalSummary, parseJournal, readPage, readTail, summarize } from '@blackide/agent-core/core/journal-reader';

// ─── Where the journal lives ────────────────────────────────────────────────
//
// One JSONL file per run under `<globalStorage>/journal/<yyyy-mm-dd>/<runId>.jsonl`, plus
// a sibling `<runId>.payloads/` for bodies too large to inline.
//
// ── Dated directories, and why retention deletes whole days ──────────────────
// Retention could be per-file and precise. It is per-day instead, because the failure this
// bounds is a disk filling up over months, and a sweep that must `stat` every file in a
// directory of ten thousand to decide is a sweep that costs more than it reclaims.
// Deleting a day is one `rm -rf` of a directory whose name already answers the question.
//
// ── The one rule that overrides retention ────────────────────────────────────
// A run that is still live is never pruned, whatever its age. Deleting the log of a
// running agent is how you lose the exact trace you were about to need.

/** Total journal size before the oldest days are dropped. */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/** Days retained. Both bounds apply; whichever bites first wins. */
const MAX_AGE_DAYS = 14;
/** One run's directory budget. Past it, `verbose` stops being written and says so. */
const MAX_RUN_BYTES = 8 * 1024 * 1024;

export interface JournalStoreOptions {
    /** `<globalStorage>/journal`. */
    directory: string;
    /** 0 disables journalling entirely. */
    maxAgeDays?: number;
    maxTotalBytes?: number;
    maxRunBytes?: number;
    now?(): number;
    /** Called with each written line, for the Logs tab's live tail. */
    onLine?(line: JournalLine): void;
}

interface RunState {
    file: string;
    payloadDir: string;
    seq: number;
    bytes: number;
    lane: string;
    /** True once this run has been told its verbose budget is gone. */
    warnedFull: boolean;
    live: boolean;
}

export class JournalStore {
    private readonly runs = new Map<string, RunState>();
    private readonly maxAgeDays: number;
    private readonly maxTotalBytes: number;
    private readonly maxRunBytes: number;

    constructor(private readonly opts: JournalStoreOptions) {
        this.maxAgeDays = opts.maxAgeDays ?? MAX_AGE_DAYS;
        this.maxTotalBytes = opts.maxTotalBytes ?? MAX_TOTAL_BYTES;
        this.maxRunBytes = opts.maxRunBytes ?? MAX_RUN_BYTES;
    }

    get enabled(): boolean {
        return this.maxAgeDays > 0;
    }

    private now(): number {
        return this.opts.now ? this.opts.now() : Date.now();
    }

    /**
     * Record one event.
     *
     * Never throws. A journal write failing must not fail the run it is describing — the
     * user asked for a refactor, not for a log — so every path here swallows, exactly as
     * `TelemetrySink` does and for the same reason.
     */
    record(runId: string, lane: string, event: any): void {
        if (!this.enabled || !runId) return;
        try {
            const state = this.stateFor(runId, lane);
            for (const line of toJournalLines(event, { id: runId, lane, seq: state.seq })) {
                this.write(state, line);
            }
        } catch { /* see above */ }
    }

    /** Mark a run finished, so retention may consider it. */
    close(runId: string): void {
        const state = this.runs.get(runId);
        if (state) state.live = false;
    }

    /** A page of a run's journal, read from disk. */
    read(runId: string, query: JournalQuery = {}): JournalPage & { summary: JournalSummary } {
        const lines = this.lines(runId);
        const page = query.after === undefined && query.limit && !query.filter
            ? readTail(lines, query)
            : readPage(lines, query);
        return { ...page, summary: summarize(lines) };
    }

    /** Every run with a journal, newest first. */
    list(limit = 100): { id: string; file: string; bytes: number; modifiedAt: number }[] {
        const out: { id: string; file: string; bytes: number; modifiedAt: number }[] = [];
        for (const day of this.days()) {
            for (const name of safeReaddir(day)) {
                if (!name.endsWith('.jsonl')) continue;
                const file = path.join(day, name);
                try {
                    const stat = fs.statSync(file);
                    out.push({ id: name.replace(/\.jsonl$/, ''), file, bytes: stat.size, modifiedAt: stat.mtimeMs });
                } catch { /* raced with a sweep */ }
            }
        }
        return out.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, limit);
    }

    /** The absolute path of a run's log, for "open as file". */
    fileFor(runId: string): string | undefined {
        return this.runs.get(runId)?.file ?? this.list(1_000).find(r => r.id === runId)?.file;
    }

    /**
     * Drop the oldest days until both bounds hold.
     *
     * Called on construction and after each run closes rather than on a timer: the size
     * only grows when something is written, so a periodic sweep would spend most of its
     * wake-ups confirming that nothing changed.
     */
    sweep(): void {
        if (!this.enabled) return;
        try {
            const cutoff = this.now() - this.maxAgeDays * 24 * 60 * 60_000;
            const live = new Set(
                [...this.runs.values()].filter(r => r.live).map(r => path.dirname(r.file)));

            const days = this.days().sort();
            for (const day of days) {
                // A day holding a running agent's log is never dropped, whatever its age.
                if (live.has(day)) continue;
                if (dayTimestamp(day) < cutoff) removeDirectory(day);
            }

            let total = this.totalBytes();
            for (const day of this.days().sort()) {
                if (total <= this.maxTotalBytes) break;
                if (live.has(day)) continue;
                total -= directoryBytes(day);
                removeDirectory(day);
            }
        } catch { /* a sweep that fails must not take anything down with it */ }
    }

    // ── internals ───────────────────────────────────────────────────────────

    private lines(runId: string): JournalLine[] {
        const file = this.fileFor(runId);
        if (!file) return [];
        try {
            return parseJournal(fs.readFileSync(file, 'utf8'));
        } catch {
            return [];
        }
    }

    private stateFor(runId: string, lane: string): RunState {
        const existing = this.runs.get(runId);
        if (existing) return existing;

        const day = path.join(this.opts.directory, dayStamp(this.now()));
        fs.mkdirSync(day, { recursive: true });
        const state: RunState = {
            file: path.join(day, `${safeName(runId)}.jsonl`),
            payloadDir: path.join(day, `${safeName(runId)}.payloads`),
            seq: 0,
            bytes: 0,
            lane,
            warnedFull: false,
            live: true,
        };
        this.runs.set(runId, state);
        return state;
    }

    private write(state: RunState, line: JournalLine): void {
        /*
         * The per-run budget degrades rather than stops.
         *
         * Past the cap, `verbose` lines are dropped and everything at `normal` and
         * `summary` keeps being written — so a runaway agent producing a hundred megabytes
         * of terminal output still leaves a readable record of which tools it called and
         * how it ended. Dropping the whole journal at the cap would lose the summary too,
         * which is the part somebody will actually read.
         */
        if (state.bytes >= this.maxRunBytes && line.depth === 'verbose') {
            if (!state.warnedFull) {
                state.warnedFull = true;
                this.write(state, {
                    ...line,
                    kind: 'log', depth: 'summary', level: 'warn',
                    verb: `journal reached its ${Math.round(this.maxRunBytes / 1024 / 1024)} MB budget — `
                        + 'verbose lines are no longer being written for this run',
                    target: undefined, detail: undefined, payload: undefined, payloadRef: undefined,
                });
            }
            return;
        }

        const { payload, ...rest } = line;
        const record: JournalLine = { ...rest, seq: state.seq++ };

        if (payload) {
            // Small bodies inline; large ones spill. The threshold is the difference
            // between a log you can grep and one you have to page through.
            if (payload.length <= 512) record.detail = { ...(record.detail || {}), body: payload };
            else record.payloadRef = this.spill(state, record.seq, payload);
        }

        const encoded = `${JSON.stringify(record)}\n`;
        fs.appendFileSync(state.file, encoded, 'utf8');
        state.bytes += encoded.length;
        this.opts.onLine?.(record);
    }

    private spill(state: RunState, seq: number, body: string): string | undefined {
        try {
            fs.mkdirSync(state.payloadDir, { recursive: true });
            const name = `p_${seq}.txt`;
            fs.writeFileSync(path.join(state.payloadDir, name), body.slice(0, MAX_PAYLOAD_BYTES), 'utf8');
            state.bytes += Math.min(body.length, MAX_PAYLOAD_BYTES);
            return name;
        } catch {
            return undefined;
        }
    }

    /** A spilled body, for the Logs tab's expander. */
    payload(runId: string, ref: string): string | undefined {
        const state = this.runs.get(runId);
        const dir = state?.payloadDir
            ?? (this.fileFor(runId) ? this.fileFor(runId)!.replace(/\.jsonl$/, '.payloads') : undefined);
        if (!dir || !/^p_\d+\.txt$/.test(ref)) return undefined;
        try {
            return fs.readFileSync(path.join(dir, ref), 'utf8');
        } catch {
            return undefined;
        }
    }

    private days(): string[] {
        return safeReaddir(this.opts.directory)
            .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name))
            .map(name => path.join(this.opts.directory, name));
    }

    private totalBytes(): number {
        return this.days().reduce((sum, day) => sum + directoryBytes(day), 0);
    }
}

function dayStamp(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10);
}

function dayTimestamp(dir: string): number {
    const parsed = Date.parse(`${path.basename(dir)}T23:59:59.999Z`);
    return Number.isFinite(parsed) ? parsed : 0;
}

/** A run id reaches this from a webview message, so it must not be able to escape the dir. */
function safeName(id: string): string {
    return String(id).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'run';
}

function safeReaddir(dir: string): string[] {
    try {
        return fs.readdirSync(dir);
    } catch {
        return [];
    }
}

function directoryBytes(dir: string): number {
    let total = 0;
    for (const name of safeReaddir(dir)) {
        const full = path.join(dir, name);
        try {
            const stat = fs.statSync(full);
            total += stat.isDirectory() ? directoryBytes(full) : stat.size;
        } catch { /* raced */ }
    }
    return total;
}

function removeDirectory(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* a locked file on Windows; the next sweep tries again */ }
}
