import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWN_SKILL_ROLES } from '@blackide/agent-core/agent/skills-manager';

/**
 * Structural guards on the golden-task set (Phase 0, M3 breadth — 2026-08-01).
 *
 * The eval runner measures *resolution quality*; nothing measured whether the task set
 * still covers what it claims to cover. A pack with no task, or a stack with two tasks
 * instead of eight, degrades silently — and a coverage number computed over a shrinking
 * denominator looks like an improvement.
 *
 * These are assertions about the corpus, not about behaviour, which is why they live in
 * the unit tier rather than in the runner: they should fail on the commit that removes a
 * task, not on the next eval run.
 */

const EVAL = path.join(__dirname, '..', 'eval');
const SKILLS_DIR = path.join(__dirname, '..', 'resources', 'skills');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tasks: any[] = require(path.join(EVAL, 'tasks.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fixtures: any[] = require(path.join(EVAL, 'fixtures.js'));

const bundledPacks = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

/** The six stacks Phase 0 named, mapped to the fixtures that stand for them. */
const PLANNED_STACKS: Record<string, string[]> = {
    'Django': ['django'],
    'FastAPI': ['fastapi'],
    'Node/Nest': ['node-express', 'node-nest'],
    '.NET': ['dotnet'],
    'React/Next': ['react-next'],
    'Rust/Go': ['rust', 'go'],
};

describe('golden-task set breadth', () => {
    it('holds 8–10 tasks for each of the six planned stacks', () => {
        // Phase 0 asked for "8–10 tasks × 6 stacks"; the set was 19 tasks total until
        // 2026-08-01. The upper bound is not enforced — more coverage is not a defect —
        // but the lower one is the whole point of the row.
        for (const [label, fixtureIds] of Object.entries(PLANNED_STACKS)) {
            const count = tasks.filter(t => fixtureIds.includes(t.fixture)).length;
            expect(count, `${label} has ${count} tasks`).toBeGreaterThanOrEqual(8);
        }
    });

    it('every task points at a fixture that exists', () => {
        const ids = new Set(fixtures.map(f => f.id));
        for (const task of tasks) expect(ids.has(task.fixture), `${task.id} → ${task.fixture}`).toBe(true);
    });

    it('task ids are unique', () => {
        const ids = tasks.map(t => t.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('every bundled pack is named by at least one task', () => {
        // The completion criterion that a raw task count cannot express: before this,
        // `flask`, `rails`, `angular` and `react-native` shipped with no eval coverage,
        // so a resolver change could have broken any of them silently.
        const named = new Set(tasks.flatMap(t => t.expectSkills || []));
        const unexercised = bundledPacks.filter(p => !named.has(p));
        expect(unexercised, `packs with no golden task: ${unexercised.join(', ')}`).toEqual([]);
    });

    it('every role the resolver understands appears in the set', () => {
        // Including `architect` and `devops`, which is how the library's real shape
        // becomes visible: we bundle nothing for either, so their tasks are all gaps.
        const roles = new Set(tasks.map(t => t.role));
        for (const role of KNOWN_SKILL_ROLES) {
            expect(roles.has(role), `no task exercises the ${role} role`).toBe(true);
        }
    });

    it('a gap task expects nothing, and a covered task expects a real pack', () => {
        const known = new Set(bundledPacks);
        for (const task of tasks) {
            for (const name of task.expectSkills || []) {
                // A typo'd expectation would read as a resolver miss forever.
                expect(known.has(name), `${task.id} expects unknown pack "${name}"`).toBe(true);
            }
        }
    });

    it('forbidSkills name real packs, so a guard cannot silently be a no-op', () => {
        const known = new Set(bundledPacks);
        for (const task of tasks) {
            for (const name of task.forbidSkills || []) {
                expect(known.has(name), `${task.id} forbids unknown pack "${name}"`).toBe(true);
            }
            // A pack cannot be both required and forbidden on one task.
            const overlap = (task.forbidSkills || []).filter((f: string) => (task.expectSkills || []).includes(f));
            expect(overlap, `${task.id} both expects and forbids ${overlap.join(', ')}`).toEqual([]);
        }
    });

    it('the wrong-idiom metric has enough tasks to mean something', () => {
        const guarded = tasks.filter(t => t.forbidSkills?.length || t.forbidAny);
        expect(guarded.length).toBeGreaterThanOrEqual(20);
    });
});
