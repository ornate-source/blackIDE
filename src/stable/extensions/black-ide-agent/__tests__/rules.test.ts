import { globToRegExp, matchGlobs, parseRuleFile, selectRules, renderRules, renderRequestableRules, Rule } from '../src/core/rules';

/** Phase 2 (M9/M11) — the activation semantics that decide what the model is told. */

const rule = (over: Partial<Rule> & { name: string }): Rule => ({
    description: '', body: 'do the thing', activation: 'always', globs: [],
    priority: 0, scope: 'project', file: `/repo/.blackide/rules/${over.name}.md`, ...over,
});

describe('globToRegExp', () => {
    it('does not let * cross a path separator', () => {
        expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
        expect(globToRegExp('src/*.ts').test('src/nested/a.ts')).toBe(false);
    });

    it('lets ** cross separators, including zero directories', () => {
        const re = globToRegExp('src/**/*.ts');
        expect(re.test('src/a.ts')).toBe(true);
        expect(re.test('src/one/two/a.ts')).toBe(true);
    });

    it('treats a separator-free pattern as depth-agnostic, like editors do', () => {
        const re = globToRegExp('*.py');
        expect(re.test('main.py')).toBe(true);
        expect(re.test('deep/nested/main.py')).toBe(true);
        expect(re.test('main.pyc')).toBe(false);
    });

    it('expands brace alternates', () => {
        const re = globToRegExp('**/*.{ts,tsx}');
        expect(re.test('src/a.ts')).toBe(true);
        expect(re.test('src/a.tsx')).toBe(true);
        expect(re.test('src/a.js')).toBe(false);
    });

    it('supports ? and character classes', () => {
        expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
        expect(globToRegExp('a?.ts').test('abc.ts')).toBe(false);
        expect(globToRegExp('[abc]x.ts').test('bx.ts')).toBe(true);
        expect(globToRegExp('[abc]x.ts').test('dx.ts')).toBe(false);
    });

    it('escapes regex metacharacters in literal segments', () => {
        // A dot must be literal, or `a.ts` would match `axts`.
        expect(globToRegExp('a.ts').test('axts')).toBe(false);
        expect(globToRegExp('a+b.ts').test('a+b.ts')).toBe(true);
    });

    it('is anchored at both ends', () => {
        expect(globToRegExp('src/a.ts').test('other/src/a.ts')).toBe(false);
        expect(globToRegExp('src/a.ts').test('src/a.ts.bak')).toBe(false);
    });
});

describe('matchGlobs', () => {
    it('normalises windows separators and leading ./', () => {
        expect(matchGlobs('src\\core\\a.ts', ['src/**/*.ts'])).toBe('src/**/*.ts');
        expect(matchGlobs('./src/a.ts', ['src/*.ts'])).toBe('src/*.ts');
    });

    it('returns the first matching pattern, or undefined', () => {
        expect(matchGlobs('a.py', ['*.ts', '*.py'])).toBe('*.py');
        expect(matchGlobs('a.rb', ['*.ts', '*.py'])).toBeUndefined();
    });

    it('ignores empty patterns instead of matching everything', () => {
        expect(matchGlobs('a.ts', ['', '  '])).toBeUndefined();
    });
});

describe('parseRuleFile', () => {
    it('treats a plain markdown file with no frontmatter as an always-on rule', () => {
        const { rule: r, problems } = parseRuleFile('/repo/.blackide/rules/style.md', '# Style\nUse tabs.', 'project', 'style');
        expect(problems).toEqual([]);
        expect(r!.name).toBe('style');
        expect(r!.activation).toBe('always');
        expect(r!.body).toBe('# Style\nUse tabs.');
    });

    it('infers glob activation when globs are declared without one', () => {
        // Defaulting to `always` here would silently ignore the globs.
        const { rule: r } = parseRuleFile('/f.md', '---\nglobs: ["**/*.ts"]\n---\nUse strict.', 'project', 'f');
        expect(r!.activation).toBe('glob');
        expect(r!.globs).toEqual(['**/*.ts']);
    });

    it('accepts a comma-separated glob string as well as a list', () => {
        const { rule: r } = parseRuleFile('/f.md', '---\nglobs: "*.ts, *.tsx"\n---\nbody', 'project', 'f');
        expect(r!.globs).toEqual(['*.ts', '*.tsx']);
    });

    it('reports invalid YAML as an error and yields no rule', () => {
        const { rule: r, problems } = parseRuleFile('/f.md', '---\nname: [unclosed\n---\nbody', 'project', 'f');
        expect(r).toBeUndefined();
        expect(problems[0].severity).toBe('error');
        expect(problems[0].message).toMatch(/Invalid YAML/);
    });

    it('warns on an unknown activation and falls back to always', () => {
        const { rule: r, problems } = parseRuleFile('/f.md', '---\nactivation: sometimes\n---\nbody', 'project', 'f');
        expect(r!.activation).toBe('always');
        expect(problems[0].message).toMatch(/Unknown activation/);
    });

    it('warns when glob activation has no globs (it can never fire)', () => {
        const { problems } = parseRuleFile('/f.md', '---\nactivation: glob\n---\nbody', 'project', 'f');
        expect(problems.map(p => p.message).join(' ')).toMatch(/can never fire/);
    });

    it('warns when an agent-requested rule has no description to advertise', () => {
        const { problems } = parseRuleFile('/f.md', '---\nactivation: agent-requested\n---\nbody', 'project', 'f');
        expect(problems.map(p => p.message).join(' ')).toMatch(/never know to ask/);
    });

    it('warns on an empty body', () => {
        const { problems } = parseRuleFile('/f.md', '---\nname: x\n---\n\n', 'project', 'x');
        expect(problems.map(p => p.message).join(' ')).toMatch(/no body/);
    });
});

describe('selectRules — activation', () => {
    const always = rule({ name: 'house-style' });
    const tsRule = rule({ name: 'ts-strict', activation: 'glob', globs: ['**/*.ts', '**/*.tsx'] });
    const pyRule = rule({ name: 'py-typing', activation: 'glob', globs: ['**/*.py'] });
    const manual = rule({ name: 'perf-audit', activation: 'manual' });
    const requested = rule({ name: 'security-deep', activation: 'agent-requested', description: 'deep security checklist' });
    const all = [always, tsRule, pyRule, manual, requested];

    it('always-rules fire with no other input', () => {
        expect(selectRules({ rules: all }).map(r => r.rule.name)).toEqual(['house-style']);
    });

    it('editing a .ts file activates only the TS glob rule — the Phase 2 gate', () => {
        const names = selectRules({ rules: all, activePaths: ['src/core/a.ts'] }).map(r => r.rule.name);
        expect(names).toContain('ts-strict');
        expect(names).not.toContain('py-typing');
        expect(names).toContain('house-style');
        expect(names).not.toContain('perf-audit');
        expect(names).not.toContain('security-deep');
    });

    it('records why a glob rule fired, and against which path and pattern', () => {
        const hit = selectRules({ rules: all, activePaths: ['a/b/c.tsx'] }).find(r => r.rule.name === 'ts-strict')!;
        expect(hit.reason).toBe('glob-match');
        expect(hit.matchedPath).toBe('a/b/c.tsx');
        expect(hit.matchedGlob).toBe('**/*.tsx');
    });

    it('manual rules fire only when enabled for the session', () => {
        expect(selectRules({ rules: all }).map(r => r.rule.name)).not.toContain('perf-audit');
        expect(selectRules({ rules: all, enabled: ['perf-audit'] }).map(r => r.rule.name)).toContain('perf-audit');
    });

    it('agent-requested rules fire only when the model asked by name', () => {
        expect(selectRules({ rules: all, requested: ['security-deep'] }).map(r => r.rule.name)).toContain('security-deep');
    });

    it('matches enable/disable/request names case-insensitively', () => {
        expect(selectRules({ rules: all, enabled: ['PERF-Audit'] }).map(r => r.rule.name)).toContain('perf-audit');
    });
});

describe('selectRules — scope authority', () => {
    it('a user may disable a project rule but not a team rule', () => {
        const team = rule({ name: 'team-secrets', scope: 'team' });
        const project = rule({ name: 'proj-style', scope: 'project' });
        const names = selectRules({ rules: [team, project], disabled: ['team-secrets', 'proj-style'] }).map(r => r.rule.name);
        expect(names).toEqual(['team-secrets']);
    });

    it('orders team before project before user, so team survives truncation', () => {
        const rules = [
            rule({ name: 'u', scope: 'user' }),
            rule({ name: 'p', scope: 'project' }),
            rule({ name: 't', scope: 'team' }),
        ];
        expect(selectRules({ rules }).map(r => r.rule.name)).toEqual(['t', 'p', 'u']);
    });

    it('orders by descending priority within a scope, then by name', () => {
        const rules = [
            rule({ name: 'b', priority: 5 }),
            rule({ name: 'a', priority: 5 }),
            rule({ name: 'c', priority: 9 }),
        ];
        expect(selectRules({ rules }).map(r => r.rule.name)).toEqual(['c', 'a', 'b']);
    });
});

describe('rendering', () => {
    it('renders nothing for an empty selection', () => {
        expect(renderRules([])).toBe('');
    });

    it('marks team rules as taking precedence', () => {
        const out = renderRules(selectRules({ rules: [rule({ name: 'sec', scope: 'team' })] }));
        expect(out).toContain('team rule — takes precedence');
    });

    it('includes every selected rule body exactly once', () => {
        const rules = [rule({ name: 'a', body: 'AAA' }), rule({ name: 'b', body: 'BBB' })];
        const out = renderRules(selectRules({ rules }));
        expect(out.match(/AAA/g)).toHaveLength(1);
        expect(out.match(/BBB/g)).toHaveLength(1);
    });

    it('advertises requestable rules by name and description only, never the body', () => {
        const r = rule({ name: 'security-deep', activation: 'agent-requested', description: 'deep checklist', body: 'SECRET_BODY' });
        const out = renderRequestableRules([r]);
        expect(out).toContain('security-deep');
        expect(out).toContain('deep checklist');
        expect(out).not.toContain('SECRET_BODY');
    });

    it('advertises nothing when no rule is requestable', () => {
        expect(renderRequestableRules([rule({ name: 'a' })])).toBe('');
    });
});
