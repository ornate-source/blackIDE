import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Skills / Plugin Extensibility Framework — Feature 15
// Auto-discovers and loads skill definitions from .blackide/skills/ directories.

export interface Skill {
    name: string;
    description: string;
    instructions: string;
    triggerPatterns: string[];
    directory: string;
}

export class SkillsManager {
    private skills: Skill[] = [];

    /** Auto-discover skills from workspace .blackide/skills/ directory */
    async discover(): Promise<void> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) return;

        const skillsDirs = [
            path.join(rootPath, '.blackide', 'skills'),
            path.join(require('os').homedir(), '.blackide', 'skills'),
        ];

        for (const skillsDir of skillsDirs) {
            if (!fs.existsSync(skillsDir)) continue;

            const dirs = fs.readdirSync(skillsDir, { withFileTypes: true })
                .filter(d => d.isDirectory());

            for (const dir of dirs) {
                const skillFile = path.join(skillsDir, dir.name, 'SKILL.md');
                if (!fs.existsSync(skillFile)) continue;

                try {
                    const content = fs.readFileSync(skillFile, 'utf8');

                    // Parse YAML frontmatter
                    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
                    if (!frontmatterMatch) continue;

                    const fm = frontmatterMatch[1];
                    const name = fm.match(/name:\s*(.+)/)?.[1]?.trim() || dir.name;
                    const desc = fm.match(/description:\s*(.+)/)?.[1]?.trim() || '';

                    // Parse triggers — support both array and comma-separated formats
                    let triggers: string[] = [];
                    const triggersMatch = fm.match(/triggers:\s*\[(.+)\]/);
                    if (triggersMatch) {
                        triggers = triggersMatch[1]
                            .split(',')
                            .map(s => s.trim().replace(/["']/g, ''))
                            .filter(s => s.length > 0);
                    }

                    // Body is everything after frontmatter
                    const instructions = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

                    // Skip if already loaded (prevent duplicates across dirs)
                    if (this.skills.some(s => s.name === name)) continue;

                    this.skills.push({
                        name,
                        description: desc,
                        instructions,
                        triggerPatterns: triggers,
                        directory: path.join(skillsDir, dir.name),
                    });
                } catch {
                    // skip malformed skill files
                }
            }
        }
    }

    /** Find skills relevant to a prompt */
    findRelevant(prompt: string): Skill[] {
        const lower = prompt.toLowerCase();
        return this.skills.filter(s =>
            s.triggerPatterns.some(p => lower.includes(p.toLowerCase()))
        );
    }

    /** Get skill instructions to inject into system prompt */
    getInstructions(skills: Skill[]): string {
        if (skills.length === 0) return '';
        return '\n\nActive Skills:\n' + skills.map(s =>
            `### Skill: ${s.name}\n${s.description}\n\n${s.instructions.slice(0, 2000)}`
        ).join('\n\n');
    }

    /** Get all loaded skills */
    getAll(): Skill[] {
        return [...this.skills];
    }

    /** Get count of loaded skills */
    get count(): number {
        return this.skills.length;
    }
}
