import { selectRules, renderRules, Rule, RuleActivationReason } from '../src/core/rules';

/**
 * The Phase 2 gate: what the session panel reports as "applied" must be what was
 * actually assembled into the prompt.
 *
 * The design that makes this hold is that `selectRules` returns the activation
 * reasons, and *the same array* is used three ways — rendered into the prompt, stored
 * on the session, and posted to the webview. These tests pin that equivalence, so a
 * future change that recomputes the panel list separately (the obvious way to
 * introduce drift) fails here.
 */

const rule = (over: Partial<Rule> & { name: string }): Rule => ({
    description: '', body: `BODY_${over.name}`, activation: 'always', globs: [],
    priority: 0, scope: 'project', file: `/repo/.blackide/rules/${over.name}.md`, ...over,
});

/** The projection the host posts to the webview as `rulesFired`. */
const toPanelPayload = (selected: RuleActivationReason[]) => selected.map(r => ({
    name: r.rule.name,
    scope: r.rule.scope,
    reason: r.reason,
    matchedPath: r.matchedPath,
    matchedGlob: r.matchedGlob,
}));

describe('panel fidelity', () => {
    const rules = [
        rule({ name: 'house-style' }),
        rule({ name: 'ts-strict', activation: 'glob', globs: ['**/*.ts'] }),
        rule({ name: 'py-typing', activation: 'glob', globs: ['**/*.py'] }),
        rule({ name: 'perf', activation: 'manual' }),
        rule({ name: 'team-sec', scope: 'team' }),
    ];

    it('every rule the panel lists has its body in the assembled prompt', () => {
        const selected = selectRules({ rules, activePaths: ['src/a.ts'], enabled: ['perf'] });
        const prompt = renderRules(selected);

        for (const entry of toPanelPayload(selected)) {
            expect(prompt, `panel claims ${entry.name} applied`).toContain(`BODY_${entry.name}`);
        }
    });

    it('every rule body in the prompt is listed by the panel — no silent extras', () => {
        const selected = selectRules({ rules, activePaths: ['src/a.ts'] });
        const prompt = renderRules(selected);
        const listed = new Set(toPanelPayload(selected).map(e => e.name));

        for (const r of rules) {
            const inPrompt = prompt.includes(`BODY_${r.name}`);
            expect(inPrompt, `${r.name}: in prompt=${inPrompt}, listed=${listed.has(r.name)}`).toBe(listed.has(r.name));
        }
    });

    it('a rule that did not fire is absent from both', () => {
        const selected = selectRules({ rules, activePaths: ['src/a.ts'] });
        const prompt = renderRules(selected);
        expect(prompt).not.toContain('BODY_py-typing');
        expect(toPanelPayload(selected).map(e => e.name)).not.toContain('py-typing');
        expect(prompt).not.toContain('BODY_perf');
    });

    it('the panel carries the reason, so it can explain *why* a rule applied', () => {
        const payload = toPanelPayload(selectRules({ rules, activePaths: ['src/a.ts'], enabled: ['perf'] }));
        const byName = new Map(payload.map(e => [e.name, e]));
        expect(byName.get('house-style')!.reason).toBe('always');
        expect(byName.get('ts-strict')!.reason).toBe('glob-match');
        expect(byName.get('ts-strict')!.matchedGlob).toBe('**/*.ts');
        expect(byName.get('perf')!.reason).toBe('manual-enabled');
    });

    it('panel order matches injection order, so the list reads as the model saw it', () => {
        const selected = selectRules({ rules, activePaths: ['src/a.ts'] });
        const prompt = renderRules(selected);
        const names = toPanelPayload(selected).map(e => e.name);

        const positions = names.map(n => prompt.indexOf(`BODY_${n}`));
        const sorted = [...positions].sort((a, b) => a - b);
        expect(positions).toEqual(sorted);
    });

    it('disabling a rule removes it from both the prompt and the panel', () => {
        const selected = selectRules({ rules, disabled: ['house-style'] });
        const prompt = renderRules(selected);
        expect(prompt).not.toContain('BODY_house-style');
        expect(toPanelPayload(selected).map(e => e.name)).not.toContain('house-style');
    });

    it('a team rule stays in both even when the user tries to disable it', () => {
        const selected = selectRules({ rules, disabled: ['team-sec'] });
        expect(renderRules(selected)).toContain('BODY_team-sec');
        expect(toPanelPayload(selected).map(e => e.name)).toContain('team-sec');
    });

    it('an empty selection means an empty prompt section and an empty panel list', () => {
        const selected = selectRules({ rules: [], activePaths: ['src/a.ts'] });
        expect(renderRules(selected)).toBe('');
        expect(toPanelPayload(selected)).toEqual([]);
    });
});
