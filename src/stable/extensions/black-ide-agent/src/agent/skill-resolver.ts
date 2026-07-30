// Skill Resolver — Phase 2 of the Project-Aware Agent Skills initiative.
//
// Pure ranking of skills for a given (agent role, project profile, prompt). Replaces the old
// prompt-keyword-only `findRelevant` so that a Backend agent on a Django repo gets the django pack
// even when the word "django" never appears in the prompt. Backward compatible: legacy skills with
// no roles/stacks still resolve on their trigger keywords.

import { Skill } from './skills-manager';
import { ProjectProfile, Role } from '../core/project-profiler';

// Weights: the detected stack is the strongest signal, then role affinity, then prompt keywords.
//
// A framework match outranks a bare language match (eval finding F1). Several bundled
// packs list the language alongside the framework — `angular` declares
// `[angular, typescript]` — so on any TypeScript repo an Angular pack matched as
// strongly as the React pack did on a React repo. Framework tokens are the specific
// evidence; language tokens are weak evidence that many packs share.
const W_FRAMEWORK = 10;
const W_LANGUAGE = 5;
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
    const lower = (s: string) => s.toLowerCase();
    const stacks = new Set((profile?.stacks || []).map(lower));
    // Callers pass a full ProjectProfile; the pure tests pass `{ stacks }` only. When
    // the finer breakdown is absent, every match is treated as language-strength.
    const frameworks = new Set((profile?.frameworks || []).map(lower));
    const languages = new Set((profile?.languages || []).map(lower));
    const lowerPrompt = prompt.toLowerCase();

    const scored = skills.map(skill => {
        const frameworkHit = skill.stacks.some(s => frameworks.has(s));
        const languageHit = skill.stacks.some(s => languages.has(s));
        const stackHit = skill.stacks.some(s => stacks.has(s));
        const promptHit = skill.triggerPatterns.some(p => p && lowerPrompt.includes(p.toLowerCase()));
        /** No `stacks` declared → the pack is stack-agnostic (REST design, a11y, TDD…). */
        const crossCutting = skill.stacks.length === 0;

        /*
         * Eval finding F1 — the fail-safe. A pack that names the stacks it applies to
         * must actually match one of them (or be asked for by name in the prompt) to be
         * a candidate. Role affinity alone is not evidence that a pack applies to *this*
         * repo: it is what caused a Backend-mode turn on a repo with no detected stack
         * to receive aspnet-core + django + fastapi + axum + express simultaneously, and
         * a Django task to receive four wrong-framework packs alongside the right one.
         *
         * Cross-cutting packs are deliberately exempt — role is the only signal they
         * have, and it is the correct one for them.
         */
        if (!crossCutting && !stackHit && !promptHit) return { skill, score: 0 };

        const roleHit = !!role && skill.roles.includes(role);

        /*
         * Priority is a tie-breaker, not a signal. Adding it unconditionally meant a
         * pack with a positive `priority` and no matching signal at all still scored
         * above the `score > 0` filter, so it was injected into every turn — the exact
         * failure `validateSkill` warns authors about in skills-manager.ts. Requiring a
         * real signal here keeps the warning and the runtime consistent.
         */
        if (!stackHit && !roleHit && !promptHit) return { skill, score: 0 };

        let score = 0;
        if (frameworkHit) score += W_FRAMEWORK;
        else if (languageHit || stackHit) score += W_LANGUAGE;

        if (role && skill.roles.length) {
            if (roleHit) score += W_ROLE;                        // cross-cutting skills for this role
            else score -= W_ROLE;                               // scoped to a different role → demote
        }

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

/**
 * Build the `SkillsFired` bus envelope for a resolved set (Phase 0, M5).
 *
 * Both call sites (chat and the pipeline executors) go through this so the split
 * between named bundled packs and merely-counted user packs is applied in exactly
 * one place — see the privacy note on the `SkillsFired` case in telemetry-sink.ts.
 */
export function skillsFiredEvent(mode: string, skills: Skill[]): {
    type: 'SkillsFired';
    mode: string;
    total: number;
    bundled: string[];
    userCount: number;
    ts: number;
} {
    const bundled = skills.filter(s => s.origin === 'bundled').map(s => s.name).sort();
    return {
        type: 'SkillsFired',
        mode,
        total: skills.length,
        bundled,
        userCount: skills.length - bundled.length,
        ts: Date.now(),
    };
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
