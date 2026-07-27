import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSkill, SkillsManager, KNOWN_SKILL_ROLES } from '../src/agent/skills-manager';
import { skillsFiredEvent, resolveSkills } from '../src/agent/skill-resolver';

/**
 * Phase 0, M5 — skill validation diagnostics and the SkillsFired telemetry event.
 * New suites land in vitest per the Phase 0 test-tier decision; `test/harness.js`
 * remains the primary tier for the vscode-free core.
 */

const wellFormed = {
    description: 'Django backend idioms',
    instructions: '# Use the ORM',
    roles: ['backend'],
    stacks: ['django'],
    triggerPatterns: ['django'],
    priority: 10,
};

describe('validateSkill', () => {
    it('accepts a well-formed pack', () => {
        expect(validateSkill(wellFormed)).toEqual([]);
    });

    it('warns when a pack has no stacks, roles or triggers (it can never be selected)', () => {
        const problems = validateSkill({ ...wellFormed, roles: [], stacks: [], triggerPatterns: [], priority: 0 });
        expect(problems).toHaveLength(1);
        expect(problems[0].message).toContain('can never be selected');
        expect(problems[0].severity).toBe('warning');
    });

    it('warns that a priority alone does not make a signal-less pack resolvable', () => {
        const problems = validateSkill({ ...wellFormed, roles: [], stacks: [], triggerPatterns: [], priority: 5 });
        expect(problems).toHaveLength(1);
        expect(problems[0].message).toContain('can never be selected');
        expect(problems[0].message).toContain('only orders packs that already matched');
    });

    it('flags an unknown role and lists the valid ones', () => {
        const problems = validateSkill({ ...wellFormed, roles: ['backnd'] });
        expect(problems).toHaveLength(1);
        expect(problems[0].message).toContain('backnd');
        for (const role of KNOWN_SKILL_ROLES) {
            expect(problems[0].message).toContain(role);
        }
    });

    it('warns on a missing description and an empty body', () => {
        const problems = validateSkill({ ...wellFormed, description: '  ', instructions: '' });
        expect(problems.map(p => p.message).join(' ')).toContain('description');
        expect(problems.map(p => p.message).join(' ')).toContain('no body');
    });
});

describe('the signal-less warning matches resolveSkills behaviour', () => {
    const base = { name: 'x', description: 'd', instructions: 'i', directory: '/tmp/x', origin: 'workspace' as const };

    it('a signal-less zero-priority pack really is unreachable', () => {
        const skill = { ...base, roles: [], stacks: [], triggerPatterns: [], priority: 0 };
        expect(resolveSkills({ skills: [skill], prompt: 'anything at all' })).toEqual([]);
        expect(validateSkill(skill)[0].message).toContain('can never be selected');
    });

    it('a signal-less pack is unreachable even with a positive priority', () => {
        // Priority is a tie-breaker, not evidence — see the F1 fix in skill-resolver.ts.
        const skill = { ...base, roles: [], stacks: [], triggerPatterns: [], priority: 5 };
        expect(resolveSkills({ skills: [skill], prompt: 'totally unrelated request' })).toEqual([]);
        expect(validateSkill(skill)[0].message).toContain('can never be selected');
    });
});

describe('SkillsManager.parseSkillDir', () => {
    let tmpDir: string;
    beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-skills-')); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    const writePack = (name: string, contents: string) => {
        const dir = path.join(tmpDir, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), contents, 'utf8');
        return dir;
    };

    it('reports a missing SKILL.md instead of failing silently', () => {
        const dir = path.join(tmpDir, 'empty-pack');
        fs.mkdirSync(dir, { recursive: true });
        const res = SkillsManager.parseSkillDir(dir, 'empty-pack', 'workspace');
        expect(res.skill).toBeUndefined();
        expect(res.problems).toHaveLength(1);
        expect(res.problems[0].message).toContain('No SKILL.md');
    });

    it('reports missing frontmatter as an error', () => {
        const dir = writePack('no-fm', '# Just a heading, no frontmatter\n');
        const res = SkillsManager.parseSkillDir(dir, 'no-fm', 'workspace');
        expect(res.skill).toBeUndefined();
        expect(res.problems[0].severity).toBe('error');
        expect(res.problems[0].message).toContain('frontmatter');
    });

    it('still loads a pack that only has authoring warnings', () => {
        const dir = writePack('warny', '---\nname: warny\n---\nbody\n');
        const res = SkillsManager.parseSkillDir(dir, 'warny', 'workspace');
        expect(res.skill?.name).toBe('warny');
        expect(res.problems.length).toBeGreaterThan(0);
        expect(res.problems.every(p => p.severity === 'warning')).toBe(true);
    });

    it('loadSkillDir keeps its original signature and return type', () => {
        const dir = writePack('legacy', '---\nname: legacy\nroles: [backend]\nstacks: [django]\ndescription: d\n---\nbody\n');
        const skill = SkillsManager.loadSkillDir(dir, 'legacy', 'workspace');
        expect(skill?.name).toBe('legacy');
        expect(skill?.roles).toEqual(['backend']);
    });

    it('every bundled pack we ship is free of authoring problems', () => {
        const bundledDir = path.resolve(__dirname, '..', 'resources', 'skills');
        const packs = fs.readdirSync(bundledDir, { withFileTypes: true }).filter(d => d.isDirectory());
        expect(packs.length).toBeGreaterThanOrEqual(16);
        const offenders: string[] = [];
        for (const pack of packs) {
            const res = SkillsManager.parseSkillDir(path.join(bundledDir, pack.name), pack.name, 'bundled');
            for (const p of res.problems) offenders.push(`${pack.name}: ${p.message}`);
        }
        expect(offenders).toEqual([]);
    });
});

describe('skillsFiredEvent', () => {
    const mk = (name: string, origin: 'bundled' | 'workspace' | 'global') => ({
        name, description: '', instructions: '', triggerPatterns: [],
        roles: [], stacks: [], priority: 0, directory: '/tmp', origin,
    });

    it('names bundled packs but only counts user packs', () => {
        const e = skillsFiredEvent('Backend', [
            mk('django', 'bundled'),
            mk('acme-internal-billing', 'workspace'),
            mk('my-global-pack', 'global'),
        ]);
        expect(e.type).toBe('SkillsFired');
        expect(e.mode).toBe('Backend');
        expect(e.total).toBe(3);
        expect(e.bundled).toEqual(['django']);
        expect(e.userCount).toBe(2);
    });

    it('never leaks a user pack name into the payload', () => {
        const e = skillsFiredEvent('Agent', [mk('client-project-secret', 'workspace')]);
        expect(JSON.stringify(e)).not.toContain('client-project-secret');
    });

    it('sorts bundled names so the signal is stable across runs', () => {
        const e = skillsFiredEvent('Agent', [mk('react', 'bundled'), mk('django', 'bundled')]);
        expect(e.bundled).toEqual(['django', 'react']);
    });
});
