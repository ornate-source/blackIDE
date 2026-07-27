import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RulesLoader, TEAM_RULES_ENV } from '../src/core/rules-loader';
import { selectRules, renderRules } from '../src/core/rules';

/**
 * Phase 2 (M9/M11) loader behaviour: discovery, precedence, `AGENTS.md` back-compat
 * and team-rule authority.
 */

let repo: string;
let teamDir: string;
const originalEnv = process.env[TEAM_RULES_ENV];

const write = (p: string, content: string) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
};

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-rules-'));
    teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-team-'));
    delete process.env[TEAM_RULES_ENV];
});

afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(teamDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env[TEAM_RULES_ENV];
    else process.env[TEAM_RULES_ENV] = originalEnv;
});

describe('AGENTS.md back-compat', () => {
    const legacyBody = '# House rules\nAlways use tabs.\nNever commit secrets.';

    it('loads a legacy AGENTS.md as an always-on project rule', async () => {
        write(path.join(repo, '.blackide', 'AGENTS.md'), legacyBody);
        const rules = await new RulesLoader().loadAll(repo);

        expect(rules).toHaveLength(1);
        expect(rules[0].name).toBe('AGENTS');
        expect(rules[0].activation).toBe('always');
        expect(rules[0].scope).toBe('project');
    });

    it('injects the legacy content in full, with no globs required', async () => {
        write(path.join(repo, '.blackide', 'AGENTS.md'), legacyBody);
        const rules = await new RulesLoader().loadAll(repo);

        // No activePaths at all — the legacy file must still fire, as it always did.
        const out = renderRules(selectRules({ rules }));
        expect(out).toContain('Always use tabs.');
        expect(out).toContain('Never commit secrets.');
    });

    it('a project with no rule files at all injects nothing', async () => {
        const rules = await new RulesLoader().loadAll(repo);
        expect(rules).toEqual([]);
        expect(renderRules(selectRules({ rules }))).toBe('');
    });

    it('is user-disableable, unlike a team rule', async () => {
        write(path.join(repo, '.blackide', 'AGENTS.md'), legacyBody);
        const rules = await new RulesLoader().loadAll(repo);
        expect(selectRules({ rules, disabled: ['AGENTS'] })).toEqual([]);
    });
});

describe('discovery and scope', () => {
    it('loads project rules from .blackide/rules', async () => {
        write(path.join(repo, '.blackide', 'rules', 'style.md'), '---\nname: style\n---\nUse tabs.');
        write(path.join(repo, '.blackide', 'rules', 'ts.md'), '---\nglobs: ["**/*.ts"]\n---\nStrict mode.');
        const rules = await new RulesLoader().loadAll(repo);
        expect(rules.map(r => r.name).sort()).toEqual(['style', 'ts']);
        expect(rules.every(r => r.scope === 'project')).toBe(true);
    });

    it('loads team rules from .blackide/team-rules with team scope', async () => {
        write(path.join(repo, '.blackide', 'team-rules', 'sec.md'), '---\nname: sec\n---\nNo secrets in logs.');
        const rules = await new RulesLoader().loadAll(repo);
        expect(rules[0].scope).toBe('team');
    });

    it('loads team rules from the BLACKIDE_TEAM_RULES path', async () => {
        write(path.join(teamDir, 'org.md'), '---\nname: org-policy\n---\nOrg policy text.');
        process.env[TEAM_RULES_ENV] = teamDir;
        const rules = await new RulesLoader().loadAll(repo);
        expect(rules.map(r => r.name)).toContain('org-policy');
        expect(rules.find(r => r.name === 'org-policy')!.scope).toBe('team');
    });

    it('ignores a BLACKIDE_TEAM_RULES path that does not exist, without erroring', async () => {
        process.env[TEAM_RULES_ENV] = path.join(teamDir, 'nope');
        await expect(new RulesLoader().loadAll(repo)).resolves.toEqual([]);
    });

    it('ignores non-markdown files', async () => {
        write(path.join(repo, '.blackide', 'rules', 'notes.txt'), 'not a rule');
        write(path.join(repo, '.blackide', 'rules', 'real.md'), 'a rule');
        const rules = await new RulesLoader().loadAll(repo);
        expect(rules.map(r => r.name)).toEqual(['real']);
    });

    it('rebuilds state on reload rather than accumulating', async () => {
        const file = path.join(repo, '.blackide', 'rules', 'a.md');
        write(file, 'first');
        const loader = new RulesLoader();
        await loader.loadAll(repo);
        fs.rmSync(file);
        expect(await loader.loadAll(repo)).toEqual([]);
        expect(loader.getProblems()).toEqual([]);
    });
});

describe('team-rule authority (tighten-only)', () => {
    it('a team rule cannot be disabled by the user, a project rule can', async () => {
        write(path.join(repo, '.blackide', 'team-rules', 'must.md'), '---\nname: must\n---\nMandatory.');
        write(path.join(repo, '.blackide', 'rules', 'pref.md'), '---\nname: pref\n---\nPreference.');
        const rules = await new RulesLoader().loadAll(repo);

        const names = selectRules({ rules, disabled: ['must', 'pref'] }).map(r => r.rule.name);
        expect(names).toEqual(['must']);
    });

    it('renders team rules first so they survive budget truncation', async () => {
        write(path.join(repo, '.blackide', 'team-rules', 'must.md'), '---\nname: must\n---\nTEAM_BODY');
        write(path.join(repo, '.blackide', 'rules', 'pref.md'), '---\nname: pref\n---\nPROJECT_BODY');
        const rules = await new RulesLoader().loadAll(repo);

        const out = renderRules(selectRules({ rules }));
        expect(out.indexOf('TEAM_BODY')).toBeLessThan(out.indexOf('PROJECT_BODY'));
        expect(out).toContain('takes precedence');
    });
});

describe('diagnostics', () => {
    it('reports a malformed rule file without dropping the valid ones', async () => {
        write(path.join(repo, '.blackide', 'rules', 'bad.md'), '---\nname: [unclosed\n---\nbody');
        write(path.join(repo, '.blackide', 'rules', 'good.md'), '---\nname: good\n---\nbody');
        const loader = new RulesLoader();
        const rules = await loader.loadAll(repo);

        expect(rules.map(r => r.name)).toEqual(['good']);
        expect(loader.getProblems().some(p => p.severity === 'error')).toBe(true);
    });

    it('warns on a duplicate rule name across scopes instead of silently shadowing', async () => {
        write(path.join(repo, '.blackide', 'team-rules', 'dup.md'), '---\nname: dup\n---\nteam');
        write(path.join(repo, '.blackide', 'rules', 'dup.md'), '---\nname: dup\n---\nproject');
        const loader = new RulesLoader();
        await loader.loadAll(repo);
        expect(loader.getProblems().some(p => /already defined/.test(p.message))).toBe(true);
    });

    it('skips an oversized rule file with an error rather than blowing the budget', async () => {
        write(path.join(repo, '.blackide', 'rules', 'huge.md'), 'x'.repeat(300 * 1024));
        const loader = new RulesLoader();
        const rules = await loader.loadAll(repo);
        expect(rules).toEqual([]);
        expect(loader.getProblems()[0].message).toMatch(/over the .* limit/);
    });
});
