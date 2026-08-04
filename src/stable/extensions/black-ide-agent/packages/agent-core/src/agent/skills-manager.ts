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

/** Roles the resolver understands. A pack scoped to anything else can never match a real agent. */
export const KNOWN_SKILL_ROLES = ['backend', 'frontend', 'design', 'testing', 'devops', 'architect'] as const;

/** One authoring problem found in a skill pack, surfaced to the user as a diagnostic. */
export interface SkillProblem {
    /** Absolute path to the offending file (the SKILL.md, or the directory when it is missing). */
    file: string;
    message: string;
    severity: 'error' | 'warning';
}

/**
 * Validate a parsed pack, mirroring `validateModeFrontmatter` in mode-loader.
 * Pure and exported so it can be tested without touching disk or `vscode`.
 *
 * The two subtle checks are the valuable ones, because both fail *silently* today:
 * a pack with no stacks, roles or triggers scores 0 in `resolveSkills` and can
 * never be selected; and one with only a positive `priority` scores above 0 for
 * every turn, so it is injected into unrelated work regardless of relevance.
 */
export function validateSkill(skill: {
    description?: string;
    instructions?: string;
    roles?: string[];
    stacks?: string[];
    triggerPatterns?: string[];
    priority?: number;
}): Array<{ message: string; severity: 'error' | 'warning' }> {
    const problems: Array<{ message: string; severity: 'error' | 'warning' }> = [];

    if (!skill.description?.trim()) {
        problems.push({ message: 'Missing "description" — the resolver shows it to the model as the skill summary.', severity: 'warning' });
    }
    if (!skill.instructions?.trim()) {
        problems.push({ message: 'SKILL.md has no body below the frontmatter, so this pack injects no guidance.', severity: 'warning' });
    }

    const roles = skill.roles || [];
    const stacks = skill.stacks || [];
    const triggers = skill.triggerPatterns || [];
    const priority = skill.priority || 0;

    for (const role of roles) {
        if (!(KNOWN_SKILL_ROLES as readonly string[]).includes(role)) {
            problems.push({
                message: `Unknown role "${role}". Valid roles: ${KNOWN_SKILL_ROLES.join(', ')}.`,
                severity: 'warning',
            });
        }
    }

    const hasSignal = stacks.length > 0 || roles.length > 0 || triggers.length > 0;
    if (!hasSignal) {
        // `priority` is only a tie-breaker in resolveSkills, never a signal on its own
        // (see the F1 fix in skill-resolver.ts), so a pack with no stacks, roles or
        // triggers is unreachable no matter what priority it declares.
        problems.push({
            message: 'No "stacks", "roles" or "triggers" — this pack can never be selected. Add at least one to make it resolvable.'
                + (priority > 0 ? ' A "priority" alone does not make it resolvable; it only orders packs that already matched.' : ''),
            severity: 'warning',
        });
    }

    return problems;
}

/**
 * Parse a frontmatter array/CSV field: `roles: [backend, testing]` or `roles: backend, testing`.
 *
 * Quote-aware, and that is not a nicety (eval finding F3b, 2026-08-01). Splitting on
 * every comma broke exactly the entries that needed quoting: the `express` pack's
 * `triggers: [express, "app.use", middleware, "req, res", router]` became six triggers
 * including the bare token **`res`**, which — matched as a substring, as triggers were —
 * fires on "**Res**tyle", "**res**ource", "add**res**s". A backend Express pack was
 * therefore a candidate on almost any English prompt, in any language's repo. Silent,
 * and invisible to every test, because a corrupted trigger list still parses.
 */
function parseListField(fm: string, key: string): string[] {
    const m = fm.match(new RegExp(`${key}:\\s*(.+)`));
    if (!m) return [];
    return splitTopLevel(m[1].trim().replace(/^\[|\]$/g, ''))
        .map(s => s.trim().replace(/^["']|["']$/g, '').toLowerCase())
        .filter(Boolean);
}

/** Splits on commas that are not inside single or double quotes. */
function splitTopLevel(value: string): string[] {
    const out: string[] = [];
    let current = '';
    let quote: string | undefined;
    for (const ch of value) {
        if (quote) {
            if (ch === quote) quote = undefined;
            else current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === ',') { out.push(current); current = ''; continue; }
        current += ch;
    }
    out.push(current);
    return out;
}

export class SkillsManager {
    private skills: Skill[] = [];
    private problems: SkillProblem[] = [];

    /**
     * Auto-discover skills. Precedence (later overrides earlier by skill name):
     *   1. bundled built-ins (the extension's resources/skills, if `bundledDir` given)
     *   2. global user skills  (~/.blackide/skills)
     *   3. workspace skills    (<repo>/.blackide/skills) — highest precedence
     * So a workspace `django` pack shadows the built-in one of the same name.
     */
    async discover(bundledDir?: string, workspaceRoot?: string): Promise<void> {
        /*
         * The root is a parameter, not a lookup (Phase 11, M62).
         *
         * One `workspaceFolders[0]` read was the whole reason the skills manager — and
         * therefore skill resolution, which every prompt goes through — could not exist
         * outside an editor. It was also the M36 bug in miniature: in a two-root workspace
         * it read folder zero's packs whatever the agent was working on. Callers pass the
         * root they mean; the extension passes the one the user is in, the CLI passes its
         * cwd.
         */
        const rootPath = workspaceRoot;
        const sources: Array<{ dir: string; origin: Skill['origin'] }> = [];
        if (bundledDir) sources.push({ dir: bundledDir, origin: 'bundled' });
        sources.push({ dir: path.join(require('os').homedir(), '.blackide', 'skills'), origin: 'global' });
        if (rootPath) sources.push({ dir: path.join(rootPath, '.blackide', 'skills'), origin: 'workspace' });

        // Map keyed by name so a later (higher-precedence) source overrides an earlier one.
        const byName = new Map<string, Skill>();
        for (const s of this.skills) byName.set(s.name, s);

        // Rebuilt from scratch each discovery so fixing a SKILL.md clears its diagnostic
        // instead of leaving a stale one behind.
        const problems: SkillProblem[] = [];

        for (const { dir, origin } of sources) {
            if (!fs.existsSync(dir)) continue;
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()); }
            catch { continue; }

            for (const entry of entries) {
                const parsed = SkillsManager.parseSkillDir(path.join(dir, entry.name), entry.name, origin);
                // Bundled packs are ours and reviewed; a diagnostic on them would be noise
                // in the user's Problems panel that they cannot act on. Report only the
                // packs the user actually authors.
                if (origin !== 'bundled') problems.push(...parsed.problems);
                if (parsed.skill) byName.set(parsed.skill.name, parsed.skill);
            }
        }
        this.skills = Array.from(byName.values());
        this.problems = problems;
    }

    /** Authoring problems found by the last `discover()`, for surfacing as diagnostics. */
    getProblems(): SkillProblem[] {
        return [...this.problems];
    }

    /** Parse one `<dir>/SKILL.md` into a Skill, or undefined if missing/malformed. */
    static loadSkillDir(dir: string, fallbackName: string, origin: Skill['origin']): Skill | undefined {
        return SkillsManager.parseSkillDir(dir, fallbackName, origin).skill;
    }

    /**
     * Same parse as `loadSkillDir`, but also reports *why* a pack failed to load.
     * Previously every failure — a missing SKILL.md, absent frontmatter, an unreadable
     * file — collapsed into a silent `undefined`, so a user with a typo got no feedback
     * at all and simply saw their skill never fire.
     */
    static parseSkillDir(
        dir: string,
        fallbackName: string,
        origin: Skill['origin'],
    ): { skill?: Skill; problems: SkillProblem[] } {
        const skillFile = path.join(dir, 'SKILL.md');
        if (!fs.existsSync(skillFile)) {
            return {
                problems: [{
                    file: dir,
                    message: `No SKILL.md in this skill directory — the pack "${fallbackName}" will be ignored.`,
                    severity: 'warning',
                }],
            };
        }
        try {
            const content = fs.readFileSync(skillFile, 'utf8');
            const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (!frontmatterMatch) {
                return {
                    problems: [{
                        file: skillFile,
                        message: 'Missing YAML frontmatter. A SKILL.md must open with a "---" delimited block declaring at least a name.',
                        severity: 'error',
                    }],
                };
            }
            const fm = frontmatterMatch[1];

            const name = fm.match(/name:\s*(.+)/)?.[1]?.trim() || fallbackName;
            const desc = fm.match(/description:\s*(.+)/)?.[1]?.trim() || '';
            const priority = Number(fm.match(/priority:\s*(-?\d+)/)?.[1]) || 0;
            const instructions = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

            const skill: Skill = {
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

            // The pack still loads when validation complains — these are authoring hints,
            // not load failures. Refusing to load would be a harsher change in behaviour
            // than the diagnostics are worth.
            const problems = validateSkill(skill).map(p => ({ file: skillFile, ...p }));
            return { skill, problems };
        } catch (e: any) {
            return {
                problems: [{
                    file: skillFile,
                    message: `Could not read SKILL.md: ${e?.message || e}`,
                    severity: 'error',
                }],
            };
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
