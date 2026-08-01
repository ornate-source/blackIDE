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

/**
 * Frontmatter list parsing (eval finding F3b, 2026-08-01).
 *
 * The loader split list fields on every comma, so the entries that *needed* quoting were
 * exactly the ones it corrupted: the bundled `express` pack's
 * `triggers: [express, "app.use", middleware, "req, res", router]` became six triggers
 * including the bare token `res`. Combined with substring trigger matching, that pack
 * became a candidate on any prompt containing "Restyle", "resource" or "address".
 *
 * Silent by construction: a corrupted trigger list is still a valid trigger list, so
 * nothing failed and the pack simply resolved too often.
 */
describe('quoted commas in frontmatter lists', () => {
    const load = (frontmatter: string) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-fm-'));
        fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n# Body\n`, 'utf8');
        const skill = SkillsManager.loadSkillDir(dir, path.basename(dir), 'bundled');
        fs.rmSync(dir, { recursive: true, force: true });
        return skill;
    };

    it('keeps a quoted comma inside one entry', () => {
        const skill = load([
            'name: express',
            'description: d',
            'roles: [backend]',
            'stacks: [express]',
            'triggers: [express, "app.use", middleware, "req, res", router]',
        ].join('\n'));
        expect(skill?.triggerPatterns).toEqual(['express', 'app.use', 'middleware', 'req, res', 'router']);
        // The specific token that caused the leak must not exist as a trigger of its own.
        expect(skill?.triggerPatterns).not.toContain('res');
    });

    it('still parses ordinary unquoted lists and bare CSV', () => {
        const bracketed = load('name: a\ndescription: d\nroles: [backend, testing]\nstacks: [django, python]');
        expect(bracketed?.roles).toEqual(['backend', 'testing']);
        expect(bracketed?.stacks).toEqual(['django', 'python']);

        const csv = load('name: b\ndescription: d\nroles: backend, testing\nstacks: django');
        expect(csv?.roles).toEqual(['backend', 'testing']);
        expect(csv?.stacks).toEqual(['django']);
    });

    it('handles single quotes and stray whitespace', () => {
        const skill = load("name: c\ndescription: d\nroles: [ backend ]\ntriggers: ['def test_', ' conftest ']");
        expect(skill?.roles).toEqual(['backend']);
        expect(skill?.triggerPatterns).toEqual(['def test_', 'conftest']);
    });

    it('every very short trigger in a bundled pack is a deliberate one', () => {
        /*
         * The class-level guard, not just the one instance. A 1–3 character bare-word
         * trigger is usually a parsing accident (`res` and `req` from `"req, res"`), but
         * not always: `gin` and `jsx` are the real names of the things they match. So the
         * short ones are allowlisted rather than banned — a new one has to be a decision
         * someone writes here, which is precisely what did not happen for `res`.
         */
        // `gin` and `jsx` are the real names of what they match; `drf` is the standard
        // abbreviation for Django REST Framework.
        const DELIBERATE_SHORT_TRIGGERS = new Set(['gin', 'jsx', 'drf']);
        const dir = path.join(__dirname, '..', 'resources', 'skills');
        const offenders: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const skill = SkillsManager.loadSkillDir(path.join(dir, entry.name), entry.name, 'bundled');
            for (const t of skill?.triggerPatterns || []) {
                if (/^[a-z0-9]{1,3}$/.test(t) && !DELIBERATE_SHORT_TRIGGERS.has(t)) {
                    offenders.push(`${entry.name}: "${t}"`);
                }
            }
        }
        expect(offenders, `unvetted short triggers: ${offenders.join(', ')}`).toEqual([]);
    });
});
