// ─── Edit history ring buffer (Phase 5, M28) ────────────────────────────────
//
// What the model needs to predict the *next* edit is not the file — it is the last
// few things the developer did. `inline-completion.ts` sees one document and one
// cursor, which is why it can only ever finish the current line. A rename that has
// been applied in three of five call sites is invisible to it and obvious here.
//
// Deliberately vscode-free: this is the half that can be tested without an extension
// host, and it is the half Phase 11's `agent-core` extraction needs to carry.

/** One coalesced change to one file. Line numbers are 0-based and post-edit. */
export interface EditRecord {
    /** Workspace-relative, so a record can be matched against the code graph. */
    file: string;
    startLine: number;
    endLine: number;
    /** Text that was there before. Empty for a pure insertion. */
    removed: string;
    /** Text that is there now. Empty for a pure deletion. */
    added: string;
    at: number;
    /** True when the text was clipped by `MAX_RECORD_CHARS` (see below). */
    truncated?: boolean;
}

/** A raw change as the host reports it, before coalescing. */
export interface RawEdit {
    file: string;
    startLine: number;
    endLine: number;
    removed: string;
    added: string;
    at: number;
}

/**
 * How long two edits to the same region may be apart and still be one edit.
 *
 * Typing `handler` is seven change events. Without coalescing the buffer holds seven
 * one-character records, the ten-slot window covers 1.4 words of history, and the
 * prompt describes keystrokes instead of intent — the feature would be measuring the
 * keyboard rather than the developer.
 */
const COALESCE_WINDOW_MS = 2_000;

/** Two edits merge only if they are also within this many lines of each other. */
const COALESCE_LINE_DISTANCE = 2;

/**
 * Per-record text cap.
 *
 * A record is prompt material and lives in memory for the session, so pasting a 4 MB
 * vendored file must not become a 4 MB buffer entry. Oversized edits are *kept and
 * clipped* rather than dropped: "a large edit happened in `schema.sql`" is real signal
 * about where attention moved, and dropping it would make the history claim nothing
 * happened. Clipping is marked so the prompt can say so rather than presenting a
 * truncated fragment as the whole change.
 */
const MAX_RECORD_CHARS = 2_000;

const DEFAULT_CAPACITY = 24;

export class EditHistory {
    private readonly records: EditRecord[] = [];

    constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

    get size(): number { return this.records.length; }

    /**
     * Record a change, merging it into the previous one when they are plainly the
     * same edit still in progress.
     */
    record(edit: RawEdit): void {
        if (!edit.file) return;
        // A change that neither adds nor removes anything is a no-op the host still
        // reports (a formatter rewriting a line to itself, a save with no diff).
        if (!edit.added && !edit.removed) return;

        const previous = this.records[this.records.length - 1];
        if (previous && this.mergeable(previous, edit)) {
            this.records[this.records.length - 1] = this.merge(previous, edit);
            return;
        }

        this.records.push(clip({
            file: edit.file,
            startLine: edit.startLine,
            endLine: edit.endLine,
            removed: edit.removed,
            added: edit.added,
            at: edit.at,
        }));

        while (this.records.length > this.capacity) this.records.shift();
    }

    private mergeable(previous: EditRecord, edit: RawEdit): boolean {
        if (previous.file !== edit.file) return false;
        if (edit.at - previous.at > COALESCE_WINDOW_MS) return false;
        // Distance is measured against the whole previous span, not just its start:
        // an edit that extends a multi-line insertion downwards is the same edit.
        const distance = Math.min(
            Math.abs(edit.startLine - previous.endLine),
            Math.abs(edit.startLine - previous.startLine),
        );
        return distance <= COALESCE_LINE_DISTANCE;
    }

    /**
     * Merged span covers both edits; `removed` keeps the *earliest* prior text and
     * `added` the *latest* current text, which is what "what did this edit do" means
     * once the intermediate keystrokes are gone.
     */
    private merge(previous: EditRecord, edit: RawEdit): EditRecord {
        return clip({
            file: previous.file,
            startLine: Math.min(previous.startLine, edit.startLine),
            endLine: Math.max(previous.endLine, edit.endLine),
            removed: previous.removed || edit.removed,
            added: edit.added || previous.added,
            at: edit.at,
            truncated: previous.truncated,
        });
    }

    /** Most recent last — the order the prompt reads in. */
    recent(limit = this.capacity): EditRecord[] {
        return this.records.slice(-limit);
    }

    /** Distinct files touched, most recently touched first. */
    filesTouched(limit = 8): string[] {
        const seen: string[] = [];
        for (let i = this.records.length - 1; i >= 0 && seen.length < limit; i--) {
            const file = this.records[i].file;
            if (!seen.includes(file)) seen.push(file);
        }
        return seen;
    }

    clear(): void {
        this.records.length = 0;
    }
}

function clip(record: EditRecord): EditRecord {
    const over = record.removed.length > MAX_RECORD_CHARS || record.added.length > MAX_RECORD_CHARS;
    if (!over) return record;
    return {
        ...record,
        removed: record.removed.slice(0, MAX_RECORD_CHARS),
        added: record.added.slice(0, MAX_RECORD_CHARS),
        truncated: true,
    };
}

/**
 * Render the history for a prompt.
 *
 * Diff-shaped rather than prose because the model reads diffs natively, and because a
 * prose rendering ("the user changed line 12") loses the one thing that carries the
 * pattern: the before and after text.
 */
export function renderEditHistory(records: EditRecord[], maxChars = 4_000): string {
    if (!records.length) return '';
    const blocks: string[] = [];
    let used = 0;

    // Newest first while filling, so a tight budget keeps the *recent* edits — the
    // older ones are the ones whose pattern has already been established.
    for (let i = records.length - 1; i >= 0; i--) {
        const block = renderRecord(records[i]);
        if (used + block.length > maxChars) break;
        blocks.unshift(block);
        used += block.length;
    }
    return blocks.join('\n');
}

function renderRecord(record: EditRecord): string {
    const lines: string[] = [`--- ${record.file}:${record.startLine + 1}${record.truncated ? ' (large edit, clipped)' : ''}`];
    for (const line of record.removed.split('\n')) if (line.length) lines.push(`- ${line}`);
    for (const line of record.added.split('\n')) if (line.length) lines.push(`+ ${line}`);
    return lines.join('\n');
}
