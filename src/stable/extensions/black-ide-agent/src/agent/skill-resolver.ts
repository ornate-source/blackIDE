// Skill Resolver — Phase 2 of the Project-Aware Agent Skills initiative.
//
// Pure ranking of skills for a given (agent role, project profile, prompt). Replaces the old
// prompt-keyword-only `findRelevant` so that a Backend agent on a Django repo gets the django pack
// even when the word "django" never appears in the prompt. Backward compatible: legacy skills with
// no roles/stacks still resolve on their trigger keywords.

import { Skill } from './skills-manager';
import { ProjectProfile, Role } from '../core/project-profiler';

// Weights: the detected stack is the strongest signal, then role affinity, then prompt keywords.
const W_STACK = 10;
const W_ROLE = 4;
const W_PROMPT = 3;

export interface ResolveOpts {
    skills: Skill[];
    /** The acting agent's role, if it maps to one (see roleForMode). Undefined = generalist. */
    role?: Role;
    /** Detected project stack (Phase 1). Undefined/empty = no stack signal. */
    profile?: ProjectProfile;
    /** The user/task prompt, for keyword triggers. */
    prompt?: string;
    /** Max skills to return (budget guard). */
    maxCount?: number;
}

/**
 * Rank and select the skills most relevant to this agent turn. A skill is a candidate only if it
 * has a positive signal — a matching stack, a matching role, or a prompt-keyword hit — so an
 * unrelated pack is never injected. Wrong-role skills are demoted below role-appropriate ones.
 */
export function resolveSkills(opts: ResolveOpts): Skill[] {
    const { skills, role, profile, prompt = '', maxCount = 5 } = opts;
    const stacks = new Set((profile?.stacks || []).map(s => s.toLowerCase()));
    const lowerPrompt = prompt.toLowerCase();

    const scored = skills.map(skill => {
        let score = 0;

        const stackHit = skill.stacks.some(s => stacks.has(s));
        if (stackHit) score += W_STACK;

        if (role && skill.roles.length) {
            if (skill.roles.includes(role)) score += W_ROLE;   // cross-cutting skills for this role
            else score -= W_ROLE;                               // scoped to a different role → demote
        }

        const promptHit = skill.triggerPatterns.some(p => p && lowerPrompt.includes(p.toLowerCase()));
        if (promptHit) score += W_PROMPT;

        score += (skill.priority || 0) * 0.1;
        return { skill, score };
    });

    return scored
        .filter(s => s.score > 0)
        .sort((a, b) =>
            b.score - a.score ||
            (b.skill.priority || 0) - (a.skill.priority || 0) ||
            a.skill.name.localeCompare(b.skill.name))
        .slice(0, maxCount)
        .map(s => s.skill);
}

/** Render selected skills into a system-prompt section (budgeted downstream by PromptBuilder). */
export function renderSkills(skills: Skill[]): string {
    if (!skills.length) return '';
    return 'Project-specific skills (apply these idioms and conventions):\n' + skills.map(s =>
        `### ${s.name}${s.stacks.length ? ` [${s.stacks.join(', ')}]` : ''}\n${s.description}\n\n${s.instructions.slice(0, 1800)}`
    ).join('\n\n');
}

/**
 * Map an agent/mode name to the skill role it acts as. Generalist and analysis modes (Ask, Plan,
 * Agent, Manager, Sr Architect/HLD/LLD, Planner) return undefined — stack skills still apply to
 * them, but no role scoping is imposed.
 */
export function roleForMode(modeName: string): Role | undefined {
    const n = (modeName || '').toLowerCase();
    if (n.includes('backend')) return 'backend';
    if (n.includes('frontend')) return 'frontend';
    if (n.includes('design')) return 'design';
    if (n.includes('testing') || n === 'test' || n.includes('tester')) return 'testing';
    if (n.includes('devops')) return 'devops';
    return undefined;
}
