import * as vscode from 'vscode';
import { SkillProblem } from './skills-manager';

/**
 * Publishes skill-pack authoring problems into the Problems panel — the same UX
 * custom modes already get from `ModeLoader._reportDiagnostic` (Phase 0, M5,
 * closing out plan.md Phase 6).
 *
 * Kept separate from `SkillsManager` on purpose. A `SkillsManager` is constructed
 * per task (see `_runAgentTask` and `runPipelineCore`), so if it owned a
 * `DiagnosticCollection` every run would create and leak another one. Ownership
 * belongs to something long-lived: the collection is created once and the
 * per-task manager just hands over its findings.
 */
export class SkillDiagnostics implements vscode.Disposable {
    private readonly collection: vscode.DiagnosticCollection;

    constructor() {
        this.collection = vscode.languages.createDiagnosticCollection('blackide-skills');
    }

    /**
     * Replace all skill diagnostics with `problems`. A full replace (rather than an
     * append) is what makes a fixed SKILL.md clear its own warning on the next
     * discovery pass.
     */
    publish(problems: SkillProblem[]): void {
        this.collection.clear();
        if (!problems.length) return;

        const byFile = new Map<string, vscode.Diagnostic[]>();
        for (const p of problems) {
            // Frontmatter problems are file-level; anchoring them to line 0 matches
            // how ModeLoader reports the equivalent mode errors.
            const range = new vscode.Range(0, 0, 0, 0);
            const diagnostic = new vscode.Diagnostic(
                range,
                p.message,
                p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
            );
            diagnostic.source = 'Black IDE Skills';
            const list = byFile.get(p.file) || [];
            list.push(diagnostic);
            byFile.set(p.file, list);
        }

        for (const [file, diagnostics] of byFile) {
            this.collection.set(vscode.Uri.file(file), diagnostics);
        }
    }

    dispose(): void {
        this.collection.dispose();
    }
}
