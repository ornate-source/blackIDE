import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Rule, RuleProblem, RuleScope, parseRuleFile } from '@blackide/agent-core/core/rules';

// Rules loader — Phase 2 (M9/M11). The I/O half of rules.ts.
//
// Discovery, in ascending precedence for rendering but *descending* authority:
//
//   team    ─ $BLACKIDE_TEAM_RULES, or <repo>/.blackide/team-rules/
//   project ─ <repo>/.blackide/rules/   +  <repo>/.blackide/AGENTS.md (legacy)
//   user    ─ ~/.blackide/rules/        (applies to every project)
//
// `AGENTS.md` is loaded as an ordinary always-on project rule, which is what keeps
// existing projects behaving exactly as before: same content, same section, same
// unconditional injection.

/** Directory names, kept here so the watcher patterns and the loader cannot drift. */
const TEAM_DIR = 'team-rules';
const RULES_DIR = 'rules';
const LEGACY_AGENTS = 'AGENTS.md';

/** Env var pointing at a shared rules directory, e.g. a mounted or vendored path. */
export const TEAM_RULES_ENV = 'BLACKIDE_TEAM_RULES';

/** Per-file read cap. A rule is prompt text; a megabyte of it is a mistake, not a rule. */
const MAX_RULE_BYTES = 256 * 1024;

export class RulesLoader implements vscode.Disposable {
    private rules: Rule[] = [];
    private problems: RuleProblem[] = [];
    private readonly watchers: vscode.FileSystemWatcher[] = [];
    private readonly diagnostics: vscode.DiagnosticCollection;

    constructor() {
        this.diagnostics = vscode.languages.createDiagnosticCollection('blackide-rules');
    }

    getRules(): Rule[] {
        return [...this.rules];
    }

    getProblems(): RuleProblem[] {
        return [...this.problems];
    }

    /** Reload every source. Safe to call repeatedly; state is rebuilt, not appended. */
    async loadAll(rootPath: string): Promise<Rule[]> {
        const rules: Rule[] = [];
        const problems: RuleProblem[] = [];

        for (const { dir, scope } of this.sources(rootPath)) {
            this.loadDir(dir, scope, rules, problems);
        }

        // Legacy `.blackide/AGENTS.md` — an always-on project rule, byte-identical in
        // effect to the previous hard-coded read.
        if (rootPath) {
            const legacy = path.join(rootPath, '.blackide', LEGACY_AGENTS);
            if (fs.existsSync(legacy)) {
                this.loadFile(legacy, 'project', 'AGENTS', rules, problems);
            }
        }

        // A later source may not silently shadow an earlier one: two rules with the
        // same name from different scopes are almost always an accident, and picking a
        // winner quietly is how a team rule ends up disabled without anyone noticing.
        const byName = new Map<string, Rule>();
        for (const rule of rules) {
            const key = rule.name.toLowerCase();
            const clash = byName.get(key);
            if (clash) {
                problems.push({
                    file: rule.file,
                    message: `Rule name "${rule.name}" is already defined by ${clash.scope} rule ${path.basename(clash.file)}. Rename one — both are loaded, which is probably not intended.`,
                    severity: 'warning',
                });
            } else {
                byName.set(key, rule);
            }
        }

        this.rules = rules;
        this.problems = problems;
        this.publishDiagnostics();
        return this.getRules();
    }

    /** Ordered rule sources. Team first so its rules sort first in `selectRules`. */
    private sources(rootPath: string): Array<{ dir: string; scope: RuleScope }> {
        const out: Array<{ dir: string; scope: RuleScope }> = [];

        const envDir = process.env[TEAM_RULES_ENV];
        if (envDir && envDir.trim()) out.push({ dir: envDir.trim(), scope: 'team' });
        if (rootPath) out.push({ dir: path.join(rootPath, '.blackide', TEAM_DIR), scope: 'team' });

        if (rootPath) out.push({ dir: path.join(rootPath, '.blackide', RULES_DIR), scope: 'project' });
        out.push({ dir: path.join(os.homedir(), '.blackide', RULES_DIR), scope: 'user' });

        return out;
    }

    private loadDir(dir: string, scope: RuleScope, rules: Rule[], problems: RuleProblem[]): void {
        let entries: string[];
        try {
            if (!fs.existsSync(dir)) return;
            entries = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md')).sort();
        } catch (e: any) {
            problems.push({ file: dir, message: `Could not read rules directory: ${e?.message || e}`, severity: 'warning' });
            return;
        }
        for (const entry of entries) {
            this.loadFile(path.join(dir, entry), scope, path.basename(entry, path.extname(entry)), rules, problems);
        }
    }

    private loadFile(file: string, scope: RuleScope, fallbackName: string, rules: Rule[], problems: RuleProblem[]): void {
        try {
            const stat = fs.statSync(file);
            if (stat.size > MAX_RULE_BYTES) {
                problems.push({
                    file,
                    message: `Rule file is ${Math.round(stat.size / 1024)} KB, over the ${MAX_RULE_BYTES / 1024} KB limit, and was skipped. Rules are prompt text; split it or narrow its globs.`,
                    severity: 'error',
                });
                return;
            }
            const content = fs.readFileSync(file, 'utf8');
            const { rule, problems: fileProblems } = parseRuleFile(file, content, scope, fallbackName);
            problems.push(...fileProblems);
            if (rule) rules.push(rule);
        } catch (e: any) {
            problems.push({ file, message: `Could not read rule file: ${e?.message || e}`, severity: 'error' });
        }
    }

    /**
     * Hot-reload on save, mirroring `ModeLoader.watchForChanges` so rules and modes
     * behave the same way for the person editing them.
     */
    watchForChanges(rootPath: string, onReload: (rules: Rule[]) => void): void {
        if (!rootPath) return;
        const patterns = [
            new vscode.RelativePattern(rootPath, `.blackide/${RULES_DIR}/**/*.md`),
            new vscode.RelativePattern(rootPath, `.blackide/${TEAM_DIR}/**/*.md`),
            new vscode.RelativePattern(rootPath, `.blackide/${LEGACY_AGENTS}`),
        ];
        for (const pattern of patterns) {
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            const reload = () => void this.loadAll(rootPath).then(onReload);
            watcher.onDidChange(reload);
            watcher.onDidCreate(reload);
            watcher.onDidDelete(reload);
            this.watchers.push(watcher);
        }
    }

    /** Surface malformed rule files in the Problems panel, replacing any previous set. */
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
            d.source = 'Black IDE Rules';
            byFile.set(p.file, [...(byFile.get(p.file) || []), d]);
        }
        for (const [file, diags] of byFile) {
            this.diagnostics.set(vscode.Uri.file(file), diags);
        }
    }

    dispose(): void {
        for (const w of this.watchers) w.dispose();
        this.watchers.length = 0;
        this.diagnostics.dispose();
    }
}
