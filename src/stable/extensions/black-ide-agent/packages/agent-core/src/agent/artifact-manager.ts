import * as path from 'path';
import * as fs from 'fs';

// Artifact Manager — Feature 18
// Manages structured output artifacts (plans, reports, analyses, walkthroughs).
//
// ── Crossed the agent-core boundary in Phase 11 (M62 · P11-1) ──────────────
// This module took a `vscode.ExtensionContext` for one field — a directory — and called
// `vscode.window.showTextDocument` in one method. Two lines of editor dependency made the
// whole module unreachable from a package that must run in a terminal.
//
// Both are parameters now. The directory is a string, because that is what it always
// was; opening a file is an injected callback, because opening a file *is* an editor
// capability and pretending otherwise would be the mistake `host.ts` warns about — an
// interface that assumes an editor's semantics through a differently-named door.

export interface Artifact {
    name: string;
    path: string;
    type: 'plan' | 'report' | 'task' | 'walkthrough' | 'analysis';
    created: number;
    modified: number;
}

export interface ArtifactManagerOptions {
    /**
     * Show a file to the user. Absent headlessly, where there is nobody to show it to.
     *
     * `HostEditorCapabilities.openFile` has exactly this shape, so an `AgentHost` can be
     * handed straight in without an adapter.
     */
    openFile?: (path: string) => void | Promise<void>;
}

export class ArtifactManager {
    private artifactDir: string;

    /**
     * @param storageDir Where artifacts live. The editor passes
     *                   `context.globalStorageUri.fsPath`; a CLI passes its own directory.
     */
    constructor(storageDir: string, private readonly options: ArtifactManagerOptions = {}) {
        this.artifactDir = path.join(storageDir, 'artifacts');
        if (!fs.existsSync(this.artifactDir)) {
            fs.mkdirSync(this.artifactDir, { recursive: true });
        }
    }

    /** Save a structured artifact */
    save(name: string, content: string, type: Artifact['type'] = 'report'): string {
        const filename = `${name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64)}.md`;
        const filepath = path.join(this.artifactDir, filename);
        fs.writeFileSync(filepath, content, 'utf8');
        return filepath;
    }

    /**
     * Show an artifact to the user.
     *
     * Returns whether anything happened. A headless run has nobody to show a file to, and
     * `false` says so — a method that silently succeeds at doing nothing is how a caller
     * comes to believe the user has seen something they have not.
     */
    async open(filepath: string): Promise<boolean> {
        if (!this.options.openFile) return false;
        await this.options.openFile(filepath);
        return true;
    }

    /** List all artifacts, sorted by most recently modified */
    list(): Artifact[] {
        if (!fs.existsSync(this.artifactDir)) return [];

        return fs.readdirSync(this.artifactDir)
            .filter(f => f.endsWith('.md'))
            .map(f => {
                const fp = path.join(this.artifactDir, f);
                const stat = fs.statSync(fp);
                return {
                    name: f.replace('.md', '').replace(/_/g, ' '),
                    path: fp,
                    type: 'report' as Artifact['type'],
                    created: stat.birthtimeMs,
                    modified: stat.mtimeMs,
                };
            })
            .sort((a, b) => b.modified - a.modified);
    }

    /** Delete an artifact */
    delete(filepath: string): void {
        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
        }
    }

    /** Get the artifact directory path */
    get directory(): string {
        return this.artifactDir;
    }
}
