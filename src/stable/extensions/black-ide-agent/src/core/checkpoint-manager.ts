import * as fs from 'fs';
import * as path from 'path';
import { Hunk, diffLines, applyHunks } from './diff';

// ─── Transactional Checkpoints ──────────────────────────────────────────────
// A task's file changes form one transaction. We store the forward patch and the
// reverse patch — not copies of the files — so undo can be applied against the
// file's CURRENT content. That is the whole point: restoring a whole-file snapshot
// would wipe out any later edit to the same file, whether the agent's or the user's.
//
// Checkpoints outlive the window: they persist to disk, so "undo that last task"
// still works after a reload.

export type ReviewState = 'pending' | 'kept' | 'restored';

export interface FileTransaction {
    path: string;      // absolute
    relPath: string;
    kind: 'created' | 'modified' | 'deleted';
    forward: Hunk[];   // before -> after
    reverse: Hunk[];   // after -> before
    before: string;    // needed to recreate a deleted file
    reviewState: ReviewState;
    linesAdded: number;
    linesRemoved: number;
}

export interface Checkpoint {
    id: string;
    taskId: string;
    /** The chat message this checkpoint belongs to, for per-message undo. */
    messageId?: string;
    label: string;
    createdAt: number;
    files: FileTransaction[];
}

export interface UndoResult {
    restored: string[];
    conflicted: string[];
}

interface Pending {
    path: string;
    existed: boolean;
    before: string;
}

let seq = 0;
const newId = () => `ckpt_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export class CheckpointManager {
    private pending = new Map<string, Pending>();
    private checkpoints: Checkpoint[] = [];

    /** `storageDir` omitted → in-memory only (tests). */
    constructor(private readonly storageDir?: string) {
        this.load();
    }

    // ─── Recording ──────────────────────────────────────────────────────────

    /** Capture a file's state before the agent first touches it (once per file). */
    snapshot(absPath: string): void {
        if (this.pending.has(absPath)) return;
        let existed = false;
        let before = '';
        try {
            if (fs.existsSync(absPath)) {
                existed = true;
                before = fs.readFileSync(absPath, 'utf8');
            }
        } catch { /* unreadable — treat as absent */ }
        this.pending.set(absPath, { path: absPath, existed, before });
    }

    /**
     * Close the transaction: diff each touched file against what is now on disk and
     * store the patch pair. Files that ended up byte-identical are dropped — an
     * agent that read a file and rewrote it unchanged should not appear in review.
     */
    commit(taskId: string, label: string, rootPath = '', messageId?: string): Checkpoint | undefined {
        const files: FileTransaction[] = [];

        for (const p of this.pending.values()) {
            let after = '';
            let exists = false;
            try {
                if (fs.existsSync(p.path)) { exists = true; after = fs.readFileSync(p.path, 'utf8'); }
            } catch { /* treat as gone */ }

            if (p.existed === exists && p.before === after) continue;

            const kind: FileTransaction['kind'] =
                !p.existed && exists ? 'created'
                : p.existed && !exists ? 'deleted'
                : 'modified';

            const forward = diffLines(p.before, after);
            const reverse = diffLines(after, p.before);
            files.push({
                path: p.path,
                relPath: rootPath ? path.relative(rootPath, p.path) : p.path,
                kind,
                forward,
                reverse,
                before: p.before,
                reviewState: 'pending',
                linesAdded: forward.reduce((n, h) => n + h.add.length, 0),
                linesRemoved: forward.reduce((n, h) => n + h.remove.length, 0),
            });
        }

        this.pending.clear();
        if (files.length === 0) return undefined;

        const checkpoint: Checkpoint = {
            id: newId(),
            taskId, messageId, label,
            createdAt: Date.now(),
            files,
        };
        this.checkpoints.push(checkpoint);
        this.persist();
        return checkpoint;
    }

    // ─── Review & undo ──────────────────────────────────────────────────────

    /** Accept a file's changes. Nothing on disk moves; it just leaves the review queue. */
    keepFile(checkpointId: string, absPath: string): boolean {
        const file = this.findFile(checkpointId, absPath);
        if (!file) return false;
        file.reviewState = 'kept';
        this.persist();
        return true;
    }

    /** Roll one file back by applying its reverse patch to the file as it stands now. */
    restoreFile(checkpointId: string, absPath: string): UndoResult {
        const file = this.findFile(checkpointId, absPath);
        if (!file) return { restored: [], conflicted: [] };
        return this.applyReverse([file]);
    }

    /** Undo the whole transaction, skipping files already restored. */
    undo(checkpointId: string): UndoResult {
        const cp = this.checkpoints.find(c => c.id === checkpointId);
        if (!cp) return { restored: [], conflicted: [] };
        return this.applyReverse(cp.files.filter(f => f.reviewState !== 'restored'));
    }

    /** Re-apply a transaction that was undone. */
    redo(checkpointId: string): UndoResult {
        const cp = this.checkpoints.find(c => c.id === checkpointId);
        if (!cp) return { restored: [], conflicted: [] };

        const restored: string[] = [];
        const conflicted: string[] = [];

        for (const file of cp.files.filter(f => f.reviewState === 'restored')) {
            try {
                if (file.kind === 'deleted') {
                    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
                } else {
                    const current = fs.existsSync(file.path) ? fs.readFileSync(file.path, 'utf8') : '';
                    const result = applyHunks(current, file.forward);
                    if (!result.ok) { conflicted.push(file.path); continue; }
                    fs.mkdirSync(path.dirname(file.path), { recursive: true });
                    fs.writeFileSync(file.path, result.content, 'utf8');
                }
                file.reviewState = 'pending';
                restored.push(file.path);
            } catch { conflicted.push(file.path); }
        }

        this.persist();
        return { restored, conflicted };
    }

    private applyReverse(files: FileTransaction[]): UndoResult {
        const restored: string[] = [];
        const conflicted: string[] = [];

        for (const file of files) {
            try {
                if (file.kind === 'created') {
                    // Reversing a creation means removing the file, not emptying it.
                    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
                } else if (file.kind === 'deleted') {
                    fs.mkdirSync(path.dirname(file.path), { recursive: true });
                    fs.writeFileSync(file.path, file.before, 'utf8');
                } else {
                    const current = fs.existsSync(file.path) ? fs.readFileSync(file.path, 'utf8') : '';
                    const result = applyHunks(current, file.reverse);
                    // A conflict means the file moved on beyond what the patch can locate.
                    // Refuse rather than overwrite work we cannot account for.
                    if (!result.ok) { conflicted.push(file.path); continue; }
                    fs.writeFileSync(file.path, result.content, 'utf8');
                }
                file.reviewState = 'restored';
                restored.push(file.path);
            } catch { conflicted.push(file.path); }
        }

        this.persist();
        return { restored, conflicted };
    }

    private findFile(checkpointId: string, absPath: string): FileTransaction | undefined {
        return this.checkpoints.find(c => c.id === checkpointId)?.files.find(f => f.path === absPath);
    }

    // ─── Queries ────────────────────────────────────────────────────────────

    /** Newest first. */
    list(): Checkpoint[] {
        return [...this.checkpoints].sort((a, b) => b.createdAt - a.createdAt);
    }

    get latest(): Checkpoint | undefined {
        return this.list()[0];
    }

    forMessage(messageId: string): Checkpoint | undefined {
        return this.checkpoints.find(c => c.messageId === messageId);
    }

    /** Uncommitted files touched during the current task. */
    get count(): number { return this.pending.size; }
    get touchedFiles(): string[] { return Array.from(this.pending.keys()); }

    /**
     * Commit whatever is pending and immediately undo it. This is the "revert the run
     * I just watched" button, and it goes through the same patch machinery as every
     * other undo rather than blind-writing the old bytes back.
     */
    restoreAll(taskId = 'adhoc', rootPath = ''): string[] {
        const cp = this.commit(taskId, 'Session checkpoint', rootPath);
        if (!cp) return [];
        return this.undo(cp.id).restored;
    }

    /** Prune checkpoints beyond the cap, keeping newest */
    pruneOldest(maxCount: number): void {
        if (this.checkpoints.length <= maxCount) return;

        // checkpoints are usually stored chronologically, but we sort to be safe
        this.checkpoints.sort((a, b) => a.createdAt - b.createdAt);
        
        while (this.checkpoints.length > maxCount) {
            this.checkpoints.shift();
        }

        this.persist();
    }

    /** Generate inline diff hunks for UI preview in O(1) time without file reconstruction */
    getInlineDiffPreview(checkpointId: string, filePath: string): string[] {
        const cp = this.findFile(checkpointId, filePath);
        if (!cp) return [];
        
        const lines: string[] = [];
        for (const hunk of cp.forward) {
            if (lines.length > 20) {
                lines.push(`... remaining changes truncated`);
                break;
            }
            for (const line of hunk.remove) {
                if (lines.length > 20) break;
                lines.push(`- ${line}`);
            }
            for (const line of hunk.add) {
                if (lines.length > 20) break;
                lines.push(`+ ${line}`);
            }
        }
        return lines;
    }

    // ─── Persistence ────────────────────────────────────────────────────────

    private get file(): string | undefined {
        return this.storageDir ? path.join(this.storageDir, 'checkpoints.json') : undefined;
    }

    private load(): void {
        const f = this.file;
        if (!f || !fs.existsSync(f)) return;
        try {
            const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (Array.isArray(parsed)) {
                // v1 -> v2 schema migration (add createdAt)
                this.checkpoints = parsed.map(cp => {
                    if (typeof cp.createdAt !== 'number') {
                        cp.createdAt = Date.now();
                    }
                    return cp;
                });
            }
        } catch { /* a corrupt history must not block the agent from starting */ }
    }

    private persist(): void {
        const f = this.file;
        if (!f) return;
        try {
            fs.mkdirSync(this.storageDir!, { recursive: true });
            // Keep the tail bounded; patches are small but not free.
            const recent = this.list().slice(0, 50);
            fs.writeFileSync(f, JSON.stringify(recent), 'utf8');
        } catch { /* best-effort: never fail a task because history could not be saved */ }
    }
}

/** Unified-diff-ish stat line for review cards. */
export function diffStat(file: FileTransaction): string {
    return `+${file.linesAdded} -${file.linesRemoved}`;
}

