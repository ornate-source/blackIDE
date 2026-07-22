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
    /** Agent roles this skill applies to (backend|frontend|design|testing|devops). Empty = any. */
    roles: string[];
    /** Stack tokens this skill applies to (django|react|rust|…), matched against ProjectProfile. */
    stacks: string[];
    /** Tie-breaker in resolution; higher wins. Default 0. */
    priority: number;
    /** Where this skill was loaded from — decides override precedence. */
    origin?: 'bundled' | 'global' | 'workspace';
}

/** Parse a frontmatter array/CSV field: `roles: [backend, testing]` or `roles: backend, testing`. */
function parseListField(fm: string, key: string): string[] {
    const m = fm.match(new RegExp(`${key}:\\s*(.+)`));
    if (!m) return [];
    return m[1]
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(s => s.trim().replace(/["']/g, '').toLowerCase())
        .filter(Boolean);
}

export class SkillsManager {
    private skills: Skill[] = [];

    /**
     * Auto-discover skills. Precedence (later overrides earlier by skill name):
     *   1. bundled built-ins (the extension's resources/skills, if `bundledDir` given)
     *   2. global user skills  (~/.blackide/skills)
     *   3. workspace skills    (<repo>/.blackide/skills) — highest precedence
     * So a workspace `django` pack shadows the built-in one of the same name.
     */
    async discover(bundledDir?: string): Promise<void> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const sources: Array<{ dir: string; origin: Skill['origin'] }> = [];
        if (bundledDir) sources.push({ dir: bundledDir, origin: 'bundled' });
        sources.push({ dir: path.join(require('os').homedir(), '.blackide', 'skills'), origin: 'global' });
        if (rootPath) sources.push({ dir: path.join(rootPath, '.blackide', 'skills'), origin: 'workspace' });

        // Map keyed by name so a later (higher-precedence) source overrides an earlier one.
        const byName = new Map<string, Skill>();
        for (const s of this.skills) byName.set(s.name, s);

        for (const { dir, origin } of sources) {
            if (!fs.existsSync(dir)) continue;
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()); }
            catch { continue; }

            for (const entry of entries) {
                const skill = SkillsManager.loadSkillDir(path.join(dir, entry.name), entry.name, origin);
                if (skill) byName.set(skill.name, skill);
            }
        }
        this.skills = Array.from(byName.values());
    }

    /** Parse one `<dir>/SKILL.md` into a Skill, or undefined if missing/malformed. */
    static loadSkillDir(dir: string, fallbackName: string, origin: Skill['origin']): Skill | undefined {
        const skillFile = path.join(dir, 'SKILL.md');
        if (!fs.existsSync(skillFile)) return undefined;
        try {
            const content = fs.readFileSync(skillFile, 'utf8');
            const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (!frontmatterMatch) return undefined;
            const fm = frontmatterMatch[1];

            const name = fm.match(/name:\s*(.+)/)?.[1]?.trim() || fallbackName;
            const desc = fm.match(/description:\s*(.+)/)?.[1]?.trim() || '';
            const priority = Number(fm.match(/priority:\s*(-?\d+)/)?.[1]) || 0;
            const instructions = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

            return {
                name,
                description: desc,
                instructions,
                triggerPatterns: parseListField(fm, 'triggers'),
                roles: parseListField(fm, 'roles'),
                stacks: parseListField(fm, 'stacks'),
                priority,
                directory: dir,
                origin,
            };
        } catch {
            return undefined;
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
