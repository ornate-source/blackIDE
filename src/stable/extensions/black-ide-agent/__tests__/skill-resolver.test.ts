import { resolveSkills } from '../src/agent/skill-resolver';
import { Skill } from '../src/agent/skills-manager';
import { ProjectProfile } from '../src/core/project-profiler';

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
