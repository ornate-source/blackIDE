import { resolveSkills } from '../src/agent/skill-resolver';
import { Skill } from '@blackide/agent-core/agent/skills-manager';
import { ProjectProfile } from '@blackide/agent-core/core/project-profiler';

/**
 * Regression cover for eval finding F1: role affinity alone must not qualify a
 * stack-scoped pack. Before this, a Backend-mode turn on a repo with no detected
 * stack received aspnet-core + django + fastapi + axum + express at once, and a
 * Django task received four wrong-framework packs alongside the right one.
 */

const skill = (over: Partial<Skill> & { name: string }): Skill => ({
    description: '', instructions: 'x', triggerPatterns: [],
    roles: [], stacks: [], priority: 0, directory: '/tmp', origin: 'bundled', ...over,
});

const profile = (over: Partial<ProjectProfile>): ProjectProfile => ({
    languages: [], frameworks: [], testFrameworks: [], packageManagers: [],
    stacks: [], confidence: 1, evidence: [],
    ...over,
    // stacks is languages ∪ frameworks, as the profiler builds it.
    stacks: over.stacks ?? [...(over.languages || []), ...(over.frameworks || [])],
});

const django = skill({ name: 'django', roles: ['backend'], stacks: ['django', 'python'], priority: 10 });
const aspnet = skill({ name: 'aspnet-core', roles: ['backend'], stacks: ['aspnet-core', 'dotnet', 'csharp'], priority: 10 });
const axum = skill({ name: 'axum', roles: ['backend'], stacks: ['axum', 'rust'], priority: 10 });
const restDesign = skill({ name: 'rest-api-design', roles: ['backend'], stacks: [], priority: 5 });
const dockerLegacy = skill({ name: 'legacy-docker', triggerPatterns: ['docker'], priority: 0 });
const all = [django, aspnet, axum, restDesign, dockerLegacy];

describe('F1 — the fail-safe: no detected stack means no stack-scoped packs', () => {
    it('injects no framework packs into a repo with no detected stack', () => {
        const picked = resolveSkills({ skills: all, role: 'backend', profile: profile({}), prompt: 'add a database layer' })
            .map(s => s.name);
        expect(picked).not.toContain('django');
        expect(picked).not.toContain('aspnet-core');
        expect(picked).not.toContain('axum');
    });

    it('still offers genuinely cross-cutting packs, which have only role to go on', () => {
        const picked = resolveSkills({ skills: all, role: 'backend', profile: profile({}), prompt: 'add a database layer' })
            .map(s => s.name);
        expect(picked).toContain('rest-api-design');
    });

    it('injects nothing at all when there is no stack, no role and no prompt hit', () => {
        expect(resolveSkills({ skills: all, profile: profile({}), prompt: 'hello' })).toEqual([]);
    });

    it('keeps the prompt-trigger escape hatch: naming a pack still reaches it', () => {
        const picked = resolveSkills({ skills: all, role: 'backend', profile: profile({}), prompt: 'set up docker' })
            .map(s => s.name);
        expect(picked).toContain('legacy-docker');
    });
});

describe('F1 — precision on a typed repo', () => {
    const rustProfile = profile({ languages: ['rust'], frameworks: ['axum'] });

    it('offers only the matching framework pack, not every backend pack', () => {
        const picked = resolveSkills({ skills: all, role: 'backend', profile: rustProfile, prompt: 'add a health route' })
            .map(s => s.name);
        expect(picked).toContain('axum');
        expect(picked).not.toContain('django');
        expect(picked).not.toContain('aspnet-core');
    });

    it('ranks a framework match above a bare language match', () => {
        // Both packs match a Django repo — django on the framework, a python-language
        // pack only on the language. The framework-specific one must win.
        const pythonLang = skill({ name: 'python-backend', roles: ['backend'], stacks: ['python'], priority: 10 });
        const picked = resolveSkills({
            skills: [pythonLang, django],
            role: 'backend',
            profile: profile({ languages: ['python'], frameworks: ['django'] }),
            prompt: 'add a model',
        }).map(s => s.name);
        expect(picked[0]).toBe('django');
    });

    it('does not let a same-language framework pack outrank the real one', () => {
        // The angular/typescript shape: an unrelated framework pack that also declares
        // the language must not tie with the pack for the framework actually in use.
        const angular = skill({ name: 'angular', roles: ['frontend'], stacks: ['angular', 'typescript'], priority: 10 });
        const react = skill({ name: 'react', roles: ['frontend'], stacks: ['react', 'typescript'], priority: 10 });
        const picked = resolveSkills({
            skills: [angular, react],
            role: 'frontend',
            profile: profile({ languages: ['typescript'], frameworks: ['react', 'nextjs'] }),
            prompt: 'add a component',
        }).map(s => s.name);
        expect(picked[0]).toBe('react');
    });
});

describe('behaviour the fix must preserve', () => {
    it('a stack-matched pack still ranks first for its role', () => {
        const picked = resolveSkills({
            skills: all, role: 'backend',
            profile: profile({ languages: ['python'], frameworks: ['django'] }), prompt: '',
        }).map(s => s.name);
        expect(picked[0]).toBe('django');
    });

    it('a wrong-role pack stays out', () => {
        const react = skill({ name: 'react', roles: ['frontend'], stacks: ['react'], priority: 10 });
        const picked = resolveSkills({
            skills: [...all, react], role: 'backend',
            profile: profile({ languages: ['python'], frameworks: ['django'] }), prompt: '',
        }).map(s => s.name);
        expect(picked).not.toContain('react');
    });

    it('works when the caller supplies only `stacks` (no framework/language split)', () => {
        // Back-compat with the pure harness fixtures, which pass a partial profile.
        const picked = resolveSkills({
            skills: all, role: 'backend',
            profile: { stacks: ['django', 'python'] } as ProjectProfile, prompt: '',
        }).map(s => s.name);
        expect(picked[0]).toBe('django');
        expect(picked).toContain('rest-api-design');
    });

    it('respects maxCount', () => {
        const picked = resolveSkills({
            skills: all, role: 'backend',
            profile: profile({ languages: ['python'], frameworks: ['django'] }), prompt: 'docker', maxCount: 1,
        });
        expect(picked).toHaveLength(1);
    });
});

/**
 * Regression cover for eval finding **F3** (2026-08-01): wrong-framework injection.
 *
 * Found by growing the golden-task set from 19 tasks to 74. A NestJS repo asked for a
 * users controller resolved to express + aspnet-core + nextjs + react + angular; a Flask
 * repo got django and fastapi; a React Native screen got Next.js App Router idioms first.
 *
 * F1 established "role affinity alone is not evidence". F3 is the same principle one
 * level down: **the language alone is not evidence either**, when the pack names a
 * framework the repo does not use.
 */
describe('F3 — a pack named after a framework needs that framework detected', () => {
    const express = skill({ name: 'express', roles: ['backend'], stacks: ['express', 'nodejs', 'javascript', 'typescript'], triggerPatterns: ['express', 'app.use', 'middleware', 'router'], priority: 10 });
    const nextjs = skill({ name: 'nextjs', roles: ['frontend'], stacks: ['nextjs', 'react', 'typescript'], triggerPatterns: ['next', 'app router'], priority: 10 });
    const react = skill({ name: 'react', roles: ['frontend'], stacks: ['react', 'typescript', 'javascript'], triggerPatterns: ['react', 'component', 'hook'], priority: 10 });
    const reactNative = skill({ name: 'react-native', roles: ['frontend'], stacks: ['react-native', 'react', 'typescript'], priority: 10 });
    const jest = skill({ name: 'jest', roles: ['testing'], stacks: ['jest', 'react', 'nextjs', 'express', 'typescript'], triggerPatterns: ['jest', 'describe('], priority: 8 });
    const flask = skill({ name: 'flask', roles: ['backend'], stacks: ['flask', 'python'], triggerPatterns: ['flask', 'blueprint'], priority: 10 });
    const fastapi = skill({ name: 'fastapi', roles: ['backend'], stacks: ['fastapi', 'python'], triggerPatterns: ['fastapi'], priority: 10 });

    const nest = profile({ languages: ['javascript', 'typescript'], frameworks: ['nestjs'] });
    const flaskRepo = profile({ languages: ['python'], frameworks: ['flask'] });
    const rnRepo = profile({ languages: ['typescript'], frameworks: ['react-native', 'expo', 'react'] });

    it('keeps Express out of a NestJS repo, though both are TypeScript', () => {
        const picked = resolveSkills({
            skills: [express, nextjs, react, jest], role: 'backend', profile: nest,
            prompt: 'Add a users controller with a service and DTO validation',
        }).map(s => s.name);
        expect(picked).not.toContain('express');
        expect(picked).not.toContain('nextjs');
        expect(picked).not.toContain('react');
    });

    it('keeps Django and FastAPI out of a Flask repo, though all three are Python', () => {
        const picked = resolveSkills({
            skills: [django, flask, fastapi], role: 'backend', profile: flaskRepo,
            prompt: 'Add an orders blueprint with SQLAlchemy models',
        }).map(s => s.name);
        expect(picked).toContain('flask');
        expect(picked).not.toContain('django');
        expect(picked).not.toContain('fastapi');
    });

    it('keeps Next.js out of a React Native app even though react is genuinely detected', () => {
        // The subtle one: React Native *implies* react (finding F2's contract), so the
        // nextjs pack had a real framework match. Identity is what separates them.
        const picked = resolveSkills({
            skills: [nextjs, react, reactNative], role: 'frontend', profile: rnRepo,
            prompt: 'Add an orders screen with a flat list',
        }).map(s => s.name);
        expect(picked).toContain('react-native');
        expect(picked).toContain('react');
        expect(picked).not.toContain('nextjs');
    });

    it('still honours an explicit request for another framework by name', () => {
        // "How would I do this in Flask?" inside a Django repo is a real question.
        const picked = resolveSkills({
            skills: [django, flask], role: 'backend',
            profile: profile({ languages: ['python'], frameworks: ['django'] }),
            prompt: 'How would this look in flask instead?',
        }).map(s => s.name);
        expect(picked).toContain('flask');
    });

    it('does not accept a generic trigger word as an identity claim', () => {
        // `aspnet-core` lists the trigger `controller`, which is not evidence of .NET —
        // Nest, Rails and Django all have controllers. This is the half of F3 that a
        // plain promptHit exemption missed.
        const aspnetGeneric = skill({
            name: 'aspnet-core', roles: ['backend'],
            stacks: ['aspnet-core', 'dotnet', 'csharp'],
            triggerPatterns: ['asp.net', 'controller', '.cs'], priority: 10,
        });
        const picked = resolveSkills({
            skills: [aspnetGeneric], role: 'backend', profile: nest,
            prompt: 'Add a users controller with a service',
        }).map(s => s.name);
        expect(picked).not.toContain('aspnet-core');
    });

    it('accepts a distinctive multi-word or punctuated trigger as one', () => {
        const aspnetGeneric = skill({
            name: 'aspnet-core', roles: ['backend'],
            stacks: ['aspnet-core', 'dotnet', 'csharp'],
            triggerPatterns: ['asp.net', 'controller'], priority: 10,
        });
        const picked = resolveSkills({
            skills: [aspnetGeneric], role: 'backend', profile: nest,
            prompt: 'Port this controller to asp.net conventions',
        }).map(s => s.name);
        expect(picked).toContain('aspnet-core');
    });

    it('leaves test-runner and cross-cutting packs alone — they are not identities', () => {
        // jest names react/nextjs/express and none are detected here, but a runner is not
        // a mutually-exclusive framework choice: Nest scaffolds Jest.
        const picked = resolveSkills({
            skills: [express, jest], role: 'testing', profile: nest,
            prompt: 'Write e2e tests for the users controller',
        }).map(s => s.name);
        expect(picked).toContain('jest');
        expect(picked).not.toContain('express');
    });
});

describe('F3b — trigger matching', () => {
    it('does not let a short trigger match inside an unrelated word', () => {
        // The defect: `triggers: [express, "app.use", middleware, "req, res", router]`
        // was split on every comma, producing the bare trigger `res`, which as a
        // substring matched "Restyle", "resource" and "address" — so a backend Express
        // pack was a candidate on almost any prompt, in any language's repo.
        const express = skill({ name: 'express', roles: ['backend'], stacks: ['express'], triggerPatterns: ['res'] });
        const picked = resolveSkills({
            skills: [express], role: 'design', profile: profile({}),
            prompt: 'Restyle the settings page to match the design tokens',
        }).map(s => s.name);
        expect(picked).not.toContain('express');
    });

    it('matches a whole word, and tolerates a plural', () => {
        const hooks = skill({ name: 'hooks-pack', roles: ['frontend'], triggerPatterns: ['hook'] });
        const onSingular = resolveSkills({ skills: [hooks], role: 'frontend', profile: profile({}), prompt: 'extract a hook' });
        const onPlural = resolveSkills({ skills: [hooks], role: 'frontend', profile: profile({}), prompt: 'extract the hooks' });
        expect(onSingular.map(s => s.name)).toContain('hooks-pack');
        expect(onPlural.map(s => s.name)).toContain('hooks-pack');
    });

    it('keeps substring semantics for code fragments', () => {
        const jestPack = skill({ name: 'jest-pack', roles: ['testing'], triggerPatterns: ['describe('] });
        const picked = resolveSkills({
            skills: [jestPack], role: 'testing', profile: profile({}),
            prompt: 'wrap these in describe() blocks',
        }).map(s => s.name);
        expect(picked).toContain('jest-pack');
    });
});

describe('priority is a tie-break, not a signal', () => {
    it('does not float a no-evidence pack over the selection threshold', () => {
        // `score += priority * 0.1` looked like a tie-break and was not one: it survived
        // the `score > 0` filter on its own, so a pack matched only on the repo's
        // language and scoped to another role came back with 0.8 points — which is how a
        // NestJS backend task ended up with the Jest pack as its only skill.
        const jest = skill({ name: 'jest', roles: ['testing'], stacks: ['jest', 'typescript'], priority: 8 });
        const picked = resolveSkills({
            skills: [jest], role: 'backend',
            profile: profile({ languages: ['typescript'], frameworks: ['nestjs'] }),
            prompt: 'Add a users controller',
        }).map(s => s.name);
        expect(picked).toEqual([]);
    });

    it('still orders two equally-evidenced packs by priority', () => {
        const high = skill({ name: 'high', roles: ['backend'], stacks: [], priority: 20 });
        const low = skill({ name: 'low', roles: ['backend'], stacks: [], priority: 1 });
        const picked = resolveSkills({ skills: [low, high], role: 'backend', profile: profile({}), prompt: '' })
            .map(s => s.name);
        expect(picked).toEqual(['high', 'low']);
    });
});
