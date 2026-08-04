// Skill Resolver — Phase 2 of the Project-Aware Agent Skills initiative.
//
// Pure ranking of skills for a given (agent role, project profile, prompt). Replaces the old
// prompt-keyword-only `findRelevant` so that a Backend agent on a Django repo gets the django pack
// even when the word "django" never appears in the prompt. Backward compatible: legacy skills with
// no roles/stacks still resolve on their trigger keywords.

import { Skill } from '@blackide/agent-core/agent/skills-manager';
import { FRAMEWORK_IDENTITY_TOKENS, ProjectProfile, Role } from '@blackide/agent-core/core/project-profiler';

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
/*
 * The penalty for a pack scoped to a *different* role, set to exactly W_LANGUAGE.
 *
 * That equality is the whole point (2026-08-01): a pack whose only evidence is the
 * repo's *language*, and which is scoped to another role, has nothing to say about this
 * turn — it scored 1 and filled a slot, so a NestJS backend task ended up with the Jest
 * pack as its only skill. Netting it to zero drops those, while a pack matched on the
 * detected *framework* still survives a role mismatch (10 − 5), which is intended:
 * Django idioms genuinely help a Testing agent writing Django tests.
 */
const W_ROLE_MISMATCH = W_LANGUAGE;

/**
 * Does one trigger fire on this prompt? (eval finding F3b, 2026-08-01.)
 *
 * Triggers used to be plain substring tests, which is right for the code fragments
 * packs list (`app.use`, `def test_`, `@component`, `describe(`) and badly wrong for
 * bare words: `res` matched "Restyle", so the Express pack was a candidate on nearly
 * any prompt. Both kinds live in the same list, so the rule keys off the trigger's own
 * shape rather than asking authors to mark them.
 *
 * A bare word matches on word boundaries, tolerating only a plural suffix — `hook`
 * should fire on "hooks", and `react` should *not* fire on "reactive".
 */
export function triggerMatches(trigger: string, lowerPrompt: string): boolean {
    const t = (trigger || '').toLowerCase().trim();
    if (!t) return false;
    // Anything with punctuation is a code fragment: substring is the intended semantic.
    if (/[^a-z0-9]/.test(t)) return lowerPrompt.includes(t);
    return new RegExp(`\\b${t}(?:s|es)?\\b`).test(lowerPrompt);
}

/**
 * Did the prompt actually *name* this framework? (eval finding F3, second half.)
 *
 * The F3 rule below lets a prompt mention override an absent detection, because "how
 * would I do this in Flask?" inside a Django repo is a real request. But a plain
 * `promptHit` is far too weak to carry that: `aspnet-core` lists the trigger
 * `controller`, so a NestJS *or* Rails prompt saying "users controller" claimed an
 * ASP.NET identity; `react` lists `component`, so an Angular component task pulled in
 * React; `rails` lists `migration`, which Django and EF Core also call a migration.
 *
 * An identity claim needs an identifying mention. That is the pack's own name, or a
 * trigger that is a code fragment or multi-word phrase (`asp.net`, `app router`,
 * `@component`) — a shape a generic English noun never has. Generic triggers keep their
 * normal scoring role for packs whose framework *is* detected, where "controller" on a
 * real .NET repo is a perfectly good relevance signal.
 */
function identifiesItself(skill: Skill, lowerPrompt: string): boolean {
    if (triggerMatches(skill.name, lowerPrompt)) return true;
    return skill.triggerPatterns.some(p => {
        const t = (p || '').toLowerCase().trim();
        if (!t || !triggerMatches(t, lowerPrompt)) return false;
        return t === skill.name.toLowerCase() || /[^a-z0-9]/.test(t);
    });
}

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
    /*
     * What counts as "this repo uses X" for the F3 rule below. `frameworks` is the
     * precise answer, but the pure tests (and any caller with only a coarse profile)
     * pass `{ stacks }` alone, where the framework and language tokens are already
     * mixed together. Falling back to `stacks` keeps those callers working; falling
     * back to *nothing* would silently disable the rule for them, which is worse than
     * being slightly coarse.
     */
    const detected = frameworks.size ? frameworks : stacks;

    const scored = skills.map(skill => {
        const frameworkHit = skill.stacks.some(s => frameworks.has(s));
        const languageHit = skill.stacks.some(s => languages.has(s));
        const stackHit = skill.stacks.some(s => stacks.has(s));
        const promptHit = skill.triggerPatterns.some(p => triggerMatches(p, lowerPrompt));
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

        /*
         * Eval finding F3 (2026-08-01) — wrong-framework injection.
         *
         * Found by growing the golden-task set from 19 tasks to 74 with five new
         * fixtures. A NestJS repo asked for a users controller resolved to
         * **express, aspnet-core, nextjs, react, angular** — five packs, all wrong. A
         * Flask repo got django and fastapi. A React Native screen got Next.js App
         * Router idioms ranked first.
         *
         * The mechanism: several packs list the *language* alongside the framework
         * (`express` declares `[express, nodejs, javascript, typescript]`), so on any
         * TypeScript repo they matched at language strength, and role affinity then
         * carried them over the selection threshold. F1 closed "role alone is not
         * evidence"; this closes "the language alone is not evidence *when the pack
         * names a framework the repo does not use*".
         *
         * A pack named after a mutually-exclusive framework token must have that
         * framework detected. Prompt mention still qualifies it — asking "how would I do
         * this in Flask?" inside a Django repo is a real request, not a mistake — which
         * is the same exemption F1 uses and the reason this is a candidacy rule rather
         * than a score penalty.
         *
         * Test runners, additive libraries and infrastructure are deliberately not
         * identities; see FRAMEWORK_IDENTITY_TOKENS for why that distinction is the one
         * that matters.
         */
        if (FRAMEWORK_IDENTITY_TOKENS.includes(lower(skill.name))
            && !detected.has(lower(skill.name))
            && !identifiesItself(skill, lowerPrompt)) {
            return { skill, score: 0 };
        }

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
            else score -= W_ROLE_MISMATCH;                       // scoped to a different role → demote
        }

        if (promptHit) score += W_PROMPT;

        /*
         * `priority` is deliberately *not* added to the score (2026-08-01).
         *
         * It used to contribute `priority * 0.1`, which is small enough to look like a
         * tie-break and is not one: it survives the `score > 0` filter on its own. A
         * pack matched only on the repo's language and scoped to another role nets to
         * zero evidence, and a priority of 8 then floated it back to 0.8 — which is how
         * a NestJS *backend* task came back with the Jest pack as its only skill. This
         * is the same defect F1 fixed for a positive priority with no signal at all;
         * it survived because the arithmetic changed rather than the rule.
         *
         * Priority still orders equal-evidence packs — as the second sort key below,
         * where a tie-break belongs.
         */
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
