import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { UserPrompt, PromptProblem, parsePromptFile } from './prompt-library';

// Loader for `.blackide/prompts/*.md` — Phase 2 (M12). Mirrors RulesLoader: same
// discovery shape, same hot-reload, same Problems-panel reporting, so the three
// authorable things (modes, rules, prompts) behave identically for whoever edits them.
//
//   workspace ─ <repo>/.blackide/prompts/    (wins on a name clash)
//   user      ─ ~/.blackide/prompts/         (applies to every project)

const PROMPTS_DIR = 'prompts';
const MAX_PROMPT_BYTES = 64 * 1024;

export class PromptLibrary implements vscode.Disposable {
    private prompts = new Map<string, UserPrompt>();
    private problems: PromptProblem[] = [];
    private readonly watchers: vscode.FileSystemWatcher[] = [];
    private readonly diagnostics: vscode.DiagnosticCollection;

    constructor() {
        this.diagnostics = vscode.languages.createDiagnosticCollection('blackide-prompts');
    }

    getAll(): UserPrompt[] {
        return [...this.prompts.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    get(name: string): UserPrompt | undefined {
        return this.prompts.get(name.toLowerCase());
    }

    getProblems(): PromptProblem[] {
        return [...this.problems];
    }

    async loadAll(rootPath: string): Promise<UserPrompt[]> {
        const prompts = new Map<string, UserPrompt>();
        const problems: PromptProblem[] = [];

        // User first, workspace second: a project prompt intentionally overrides a
        // personal one of the same name, matching how skills already resolve.
        const dirs = [
            path.join(os.homedir(), '.blackide', PROMPTS_DIR),
            ...(rootPath ? [path.join(rootPath, '.blackide', PROMPTS_DIR)] : []),
        ];

        for (const dir of dirs) {
            let entries: string[];
            try {
                if (!fs.existsSync(dir)) continue;
                entries = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md')).sort();
            } catch (e: any) {
                problems.push({ file: dir, message: `Could not read prompts directory: ${e?.message || e}`, severity: 'warning' });
                continue;
            }

            for (const entry of entries) {
                const file = path.join(dir, entry);
                try {
                    if (fs.statSync(file).size > MAX_PROMPT_BYTES) {
                        problems.push({
                            file,
                            message: `Prompt file exceeds ${MAX_PROMPT_BYTES / 1024} KB and was skipped.`,
                            severity: 'error',
                        });
                        continue;
                    }
                    const content = fs.readFileSync(file, 'utf8');
                    const { prompt, problems: fileProblems } = parsePromptFile(file, content, path.basename(entry, path.extname(entry)));
                    problems.push(...fileProblems);
                    if (prompt) prompts.set(prompt.name, prompt);
                } catch (e: any) {
                    problems.push({ file, message: `Could not read prompt file: ${e?.message || e}`, severity: 'error' });
                }
            }
        }

        // A step naming a prompt that does not exist is reported, not ignored: the
        // workflow would otherwise quietly skip it and look like it ran in full.
        for (const prompt of prompts.values()) {
            for (const step of prompt.steps) {
                if (!prompts.has(step)) {
                    problems.push({
                        file: prompt.file,
                        message: `Step "${step}" does not match any prompt, so it will be skipped. Check the name.`,
                        severity: 'warning',
                    });
                }
            }
        }

        this.prompts = prompts;
        this.problems = problems;
        this.publishDiagnostics();
        return this.getAll();
    }

    watchForChanges(rootPath: string, onReload: (prompts: UserPrompt[]) => void): void {
        if (!rootPath) return;
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(rootPath, `.blackide/${PROMPTS_DIR}/**/*.md`),
        );
        const reload = () => void this.loadAll(rootPath).then(onReload);
        watcher.onDidChange(reload);
        watcher.onDidCreate(reload);
        watcher.onDidDelete(reload);
        this.watchers.push(watcher);
    }

    private publishDiagnostics(): void {
        this.diagnostics.clear();
        if (!this.problems.length) return;
        const byFile = new Map<string, vscode.Diagnostic[]>();
        for (const p of this.problems) {
            const d = new vscode.Diagnostic(
                new vscode.Range(0, 0, 0, 0),
                p.message,
                p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
            );
            d.source = 'Black IDE Prompts';
            byFile.set(p.file, [...(byFile.get(p.file) || []), d]);
        }
        for (const [file, diags] of byFile) this.diagnostics.set(vscode.Uri.file(file), diags);
    }

    dispose(): void {
        for (const w of this.watchers) w.dispose();
        this.watchers.length = 0;
        this.diagnostics.dispose();
    }
}
