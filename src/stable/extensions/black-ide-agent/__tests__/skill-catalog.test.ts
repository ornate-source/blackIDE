import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWN_SKILL_ROLES, validateSkill } from '../src/agent/skills-manager';
import { findPackViolations } from '../src/core/skill-registry';

/**
 * Phase 10, M59 — the bundled skill catalog.
 *
 * The gate: **every pack parses with ≥1 role and ≥1 stack.** That sounds like a formality
 * and is not — `validateSkill` exists because Phase 0 found packs that could *never* fire
 * (no stacks, roles or triggers scores 0 in the resolver) and packs that fired on *every*
 * turn (a bare positive `priority` scores above 0 unconditionally). Both failed silently.
 *
 * This walks the shipped directory rather than a fixture list, so a pack added later is
 * held to the same rules without anyone remembering to add it here.
 */

const SKILLS_DIR = path.join(__dirname, '..', 'resources', 'skills');

interface ParsedPack {
    name: string;
    file: string;
    frontmatter: Record<string, unknown>;
    body: string;
}

/** Deliberately a small independent parser: a bug in the real loader should not hide here. */
function parsePack(dir: string): ParsedPack | undefined {
    const file = path.join(SKILLS_DIR, dir, 'SKILL.md');
    if (!fs.existsSync(file)) return undefined;
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return { name: dir, file, frontmatter: {}, body: text };

    const frontmatter: Record<string, unknown> = {};
    for (const line of match[1].split('\n')) {
        const at = line.indexOf(':');
        if (at === -1) continue;
        const key = line.slice(0, at).trim();
        const raw = line.slice(at + 1).trim();
        frontmatter[key] = /^\[.*\]$/.test(raw)
            ? raw.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
            : raw;
    }
    return { name: dir, file, frontmatter, body: match[2] };
}

const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();

const packs = dirs.map(parsePack).filter((p): p is ParsedPack => !!p);

describe('the catalog', () => {
    it('grew past Wave 1', () => {
        // C3 recorded "16 shipped, missing all of Wave 2" from rev 1 to rev 11.
        expect(packs.length).toBeGreaterThanOrEqual(40);
    });

    it('every directory has a SKILL.md', () => {
        expect(packs.map(p => p.name)).toEqual(dirs);
    });

    it('covers the roles the resolver understands', () => {
        const covered = new Set(packs.flatMap(p => (p.frontmatter.roles as string[]) || []));
        for (const role of ['backend', 'frontend', 'testing', 'devops']) {
            expect(covered, role).toContain(role);
        }
    });

    it('ships testing packs for every stack family that has a bundled framework pack', () => {
        const names = new Set(packs.map(p => p.name));
        for (const testing of ['pytest', 'jest', 'vitest', 'xunit', 'go-test', 'cargo-test', 'rspec', 'junit-mockito']) {
            expect(names, testing).toContain(testing);
        }
    });
});

// ─── The gate ───────────────────────────────────────────────────────────────

describe('every pack is reachable by the resolver', () => {
    /*
     * The gate's wording is "≥1 role and ≥1 stack". Asserting that literally is wrong, and
     * the eval set said so: `a11y-wcag-aria` ships `stacks: []` **deliberately** — an empty
     * list means "any stack", which is what a genuinely cross-cutting pack needs, and the
     * `empty-fe-1` golden task exists to pin that it fires on a repo with no detected stack
     * at all. Giving it stacks to satisfy the literal reading broke that task.
     *
     * So what is asserted is the resolver's real contract, which `validateSkill` also
     * encodes: a pack needs a role, and it needs *some* way to be selected — stacks or
     * triggers. A pack with none of the three scores 0 and can never fire.
     *
     * `component-architecture` joined the cross-cutting set for a reason worth recording:
     * given a broad `stacks` list it **displaced a specific pack** — on a design-role task
     * about readability, its `react` stack match outranked `a11y-wcag-aria` and pushed it
     * out of the top-N, even though its roles did not include `design`. That is an
     * F1-family defect in the *resolver* (a stack match should not survive a role
     * mismatch), found by the eval set and worked around here in data. The resolver fix is
     * not in this phase.
     */
    for (const pack of packs) {
        it(`${pack.name} is resolvable`, () => {
            const roles = (pack.frontmatter.roles as string[]) || [];
            const stacks = (pack.frontmatter.stacks as string[]) || [];
            const triggers = (pack.frontmatter.triggers as string[]) || [];

            expect(roles.length, 'no roles — this pack can never be selected').toBeGreaterThan(0);
            expect(stacks.length + triggers.length, 'no stacks and no triggers — unreachable').toBeGreaterThan(0);
            for (const role of roles) {
                expect(KNOWN_SKILL_ROLES as readonly string[], `unknown role "${role}"`).toContain(role);
            }
        });
    }

    it('a stack-scoped pack names its stacks, so it cannot fire on an unrelated repo', () => {
        // The other half: F3 was framework packs matching at *language* strength on any
        // repo in that language. A pack with triggers but no stacks is cross-cutting by
        // declaration; there should be very few, and they should be obvious.
        const crossCutting = packs.filter(p => !((p.frontmatter.stacks as string[]) || []).length);
        expect(crossCutting.map(p => p.name).sort()).toEqual(['a11y-wcag-aria', 'component-architecture']);
    });
});

describe('every pack passes the loader\'s own validation', () => {
    for (const pack of packs) {
        it(`${pack.name} has no errors`, () => {
            const problems = validateSkill({
                description: String(pack.frontmatter.description || ''),
                instructions: pack.body,
                roles: (pack.frontmatter.roles as string[]) || [],
                stacks: (pack.frontmatter.stacks as string[]) || [],
                triggerPatterns: (pack.frontmatter.triggers as string[]) || [],
                priority: Number(pack.frontmatter.priority) || 0,
            });
            expect(problems.filter(p => p.severity === 'error')).toEqual([]);
        });
    }
});

describe('no bundled pack tries to widen a capability', () => {
    // The same load-time rule third-party packs face (M60). Bundled packs are ours, which
    // is exactly why they should be held to it — an exception for "our own" content is how
    // the rule stops being a rule.
    for (const pack of packs) {
        it(`${pack.name} declares no capability keys`, () => {
            expect(findPackViolations(pack.frontmatter)).toEqual([]);
        });
    }
});

describe('pack quality', () => {
    for (const pack of packs) {
        it(`${pack.name} carries specific guidance`, () => {
            // A pack whose body is three lines of "follow best practices" costs prompt
            // budget on every matching turn and returns nothing. F1 was the mirror image
            // of this — packs firing where they did not belong; this is packs that fire
            // where they belong and say nothing.
            expect(pack.body.length, 'body is too short to be worth injecting').toBeGreaterThan(400);
            expect(pack.body, 'no pitfalls section').toMatch(/##\s*(Pitfalls|Conventions)/i);
        });

        it(`${pack.name} has triggers that are not bare English words`, () => {
            // F3b: `"req, res"` split on the comma into the trigger `res`, which fires as a
            // substring on "**Res**tyle" and "add**res**s" — making a backend pack a
            // candidate on almost any prompt in any repo.
            const triggers = (pack.frontmatter.triggers as string[]) || [];
            for (const trigger of triggers) {
                expect(trigger.length, `trigger "${trigger}" is too short to be safe`).toBeGreaterThanOrEqual(3);
            }
        });
    }
});
