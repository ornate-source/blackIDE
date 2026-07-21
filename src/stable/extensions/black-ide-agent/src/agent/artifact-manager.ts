import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Artifact Manager — Feature 18
// Manages structured output artifacts (plans, reports, analyses, walkthroughs).

export interface Artifact {
    name: string;
    path: string;
    type: 'plan' | 'report' | 'task' | 'walkthrough' | 'analysis';
    created: number;
    modified: number;
}

export class ArtifactManager {
    private artifactDir: string;

    constructor(context: vscode.ExtensionContext) {
        this.artifactDir = path.join(context.globalStorageUri.fsPath, 'artifacts');
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

    /** Open artifact in VS Code editor */
    async open(filepath: string): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(filepath);
        await vscode.window.showTextDocument(doc, { preview: false });
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
