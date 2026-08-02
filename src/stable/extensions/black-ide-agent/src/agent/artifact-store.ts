import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    ArtifactRecord, ArtifactType, addComment, artifactFilename, artifactId, extensionFor,
    groupForReview, isBinaryArtifact, markDelivered, undeliveredComments,
} from '../core/artifacts';

// ─── The typed artifact store (Phase 7, M38) ────────────────────────────────
//
// The durable half of `core/artifacts.ts`: a directory plus a JSON index. It sits beside
// the existing `ArtifactManager` rather than replacing it, because that class is wired
// into every executor's `create_artifact` tool and swapping it out mid-phase would be a
// behaviour change disguised as a refactor. What it does *not* do is repeat that class's
// defect — the type is written to the index and to the filename, and read back from both.
//
// The index is a cache, not the truth. If it is deleted, `rebuildFromDisk` reconstructs
// every record from the filenames, which is why the naming scheme carries run and type.
// An index that cannot be rebuilt is a single file whose loss silently empties a review
// surface, and nobody backs up a cache.

const INDEX_FILE = 'index.json';

export class ArtifactStore {
    private readonly dir: string;
    private records: ArtifactRecord[] = [];
    private sequence = 0;

    constructor(context: vscode.ExtensionContext) {
        this.dir = path.join(context.globalStorageUri.fsPath, 'artifacts-v2');
        try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* surfaced on first write */ }
        this.records = this.loadIndex();
    }

    get directory(): string { return this.dir; }

    /** Save a text artifact. */
    save(runId: string, type: ArtifactType, title: string, content: string): ArtifactRecord {
        return this.write(runId, type, title, extensionFor(type), (target) => fs.writeFileSync(target, content, 'utf8'));
    }

    /**
     * Save a binary artifact (a screenshot, a recording).
     *
     * Takes bytes rather than a source path because the producer — `BrowserTool` — already
     * holds a buffer, and a copy-from-temp step is one more place for a screenshot to go
     * missing between being taken and being attached.
     */
    saveBinary(runId: string, type: ArtifactType, title: string, data: Buffer, extension?: string): ArtifactRecord {
        return this.write(runId, type, title, extension || extensionFor(type), (target) => fs.writeFileSync(target, data));
    }

    private write(
        runId: string, type: ArtifactType, title: string, extension: string,
        writer: (target: string) => void,
    ): ArtifactRecord {
        const now = Date.now();
        const filename = artifactFilename({ runId, type, title }, extension);
        const target = path.join(this.dir, filename);
        writer(target);

        let size: number | undefined;
        try { size = fs.statSync(target).size; } catch { /* best effort */ }

        const record: ArtifactRecord = {
            id: artifactId(runId, type, now, ++this.sequence),
            runId, type, title, path: target, createdAt: now, size,
        };
        this.records.push(record);
        this.persist();
        return record;
    }

    list(): ArtifactRecord[] {
        return [...this.records];
    }

    forRun(runId: string): ArtifactRecord[] {
        return this.records.filter(r => r.runId === runId);
    }

    grouped() {
        return groupForReview(this.records);
    }

    /** Attach a review comment (M39's input side). */
    comment(artifactId: string, text: string, region?: string): ArtifactRecord | undefined {
        const index = this.records.findIndex(r => r.id === artifactId);
        if (index === -1) return undefined;
        this.records[index] = addComment(this.records[index], text, { region });
        this.persist();
        return this.records[index];
    }

    /** Comments that have not yet been handed to a running agent. */
    pendingComments() {
        return undeliveredComments(this.records);
    }

    markCommentsDelivered(artifactId: string, commentIds: string[]): void {
        const index = this.records.findIndex(r => r.id === artifactId);
        if (index === -1) return;
        this.records[index] = markDelivered(this.records[index], commentIds);
        this.persist();
    }

    async open(record: ArtifactRecord): Promise<void> {
        const uri = vscode.Uri.file(record.path);
        if (isBinaryArtifact(record.type)) {
            // A .png in a text editor is a screen of mojibake. `vscode.open` routes to the
            // image preview or the OS handler, which is what the user meant by "open".
            await vscode.commands.executeCommand('vscode.open', uri);
            return;
        }
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    }

    /** Drop an artifact and its file. */
    remove(artifactId: string): void {
        const record = this.records.find(r => r.id === artifactId);
        if (!record) return;
        try { fs.unlinkSync(record.path); } catch { /* already gone */ }
        this.records = this.records.filter(r => r.id !== artifactId);
        this.persist();
    }

    /**
     * Reconstruct the index from filenames.
     *
     * Runs when the index is missing or unparseable. Titles come back with their
     * sanitisation intact rather than their original punctuation, and comments are lost —
     * both are honest consequences of the index being a cache, and both are better than a
     * review surface that silently shows nothing because one JSON file was corrupted.
     */
    rebuildFromDisk(): ArtifactRecord[] {
        const rebuilt: ArtifactRecord[] = [];
        let entries: string[] = [];
        try { entries = fs.readdirSync(this.dir); } catch { return rebuilt; }

        for (const entry of entries) {
            if (entry === INDEX_FILE) continue;
            const parts = entry.split('__');
            if (parts.length < 3) continue;
            const [runId, type] = parts;
            const rest = parts.slice(2).join('__');
            const extension = path.extname(rest);
            const full = path.join(this.dir, entry);
            let createdAt = Date.now();
            let size: number | undefined;
            try {
                const stat = fs.statSync(full);
                createdAt = stat.birthtimeMs || stat.mtimeMs;
                size = stat.size;
            } catch { /* best effort */ }

            rebuilt.push({
                id: artifactId(runId, type as ArtifactType, createdAt, rebuilt.length),
                runId,
                type: type as ArtifactType,
                title: path.basename(rest, extension),
                path: full,
                createdAt,
                size,
            });
        }

        this.records = rebuilt.sort((a, b) => a.createdAt - b.createdAt);
        this.persist();
        return this.records;
    }

    private loadIndex(): ArtifactRecord[] {
        try {
            const raw = fs.readFileSync(path.join(this.dir, INDEX_FILE), 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
        } catch { /* falls through to a rebuild */ }
        return this.rebuildFromDisk();
    }

    private persist(): void {
        try {
            fs.writeFileSync(path.join(this.dir, INDEX_FILE), JSON.stringify(this.records, null, 2), 'utf8');
        } catch { /* the files are the truth; the index rebuilds */ }
    }
}
