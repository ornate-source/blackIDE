import { describe, expect, it } from 'vitest';
import {
    MemoryEntry, bandFor, createMemory, injectable, memoryId, normalizeForIdentity,
    renderForPrompt, touch,
} from '@blackide/agent-core/core/memory-model';
import {
    parseMemoryMarkdown, renderEntryLine, renderMemoryMarkdown, roundTrip, withEntries,
} from '@blackide/agent-core/core/memory-markdown';
import {
    applyDecay, consolidate, decideWrite, findContradictions, isNegated,
    isWorthRemembering, sortCandidates, supersede,
} from '@blackide/agent-core/core/memory-lifecycle';

/**
 * Phase 8, M41–M44 — Memory v2.
 *
 * The gate has four clauses and three of them are decidable without a model:
 * **contradiction prompts rather than overwrites**, **consolidation is idempotent**, and
 * **the markdown round-trips byte-stable**. Those three are what this file is about. The
 * fourth — "a fact from session 1 is retrieved in session 3" — is a retrieval-quality
 * measurement and belongs to the eval harness.
 *
 * The byte-stability clause gets the most attention because it is the one protecting a file
 * the user owns. ADR 007 makes the markdown authoritative and the index derived; a
 * projection that churns the file on every pass is one people stop reading, then delete.
 */

const DAY = 24 * 60 * 60_000;

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
    ...createMemory({ text: 'This project uses pnpm', at: 1_000 }),
    ...over,
});

// ─── Gate: the markdown round-trips byte-stable ─────────────────────────────

describe('the markdown projection round-trips byte-for-byte', () => {
    const FILE = [
        '# Project Memory',
        '',
        'Notes I keep by hand. The agent must not eat this paragraph.',
        '',
        '- This project uses pnpm, never npm <!-- mem id=m_abc type=convention tier=project conf=0.90 uses=3 used=1700 created=1000 status=active origin=user -->',
        '- The staging database is read-only <!-- mem id=m_def type=constraint tier=project conf=0.75 uses=0 used=1200 created=1200 status=active origin=extracted -->',
        '',
        '<!-- anything else I wrote -->',
        '',
    ].join('\n');

    it('is stable on the first pass', () => {
        expect(roundTrip(FILE)).toBe(FILE);
    });

    it('is stable on repeated passes', () => {
        // Not implied by one pass: a projection can be stable from its own output while
        // still having mangled the original.
        const once = roundTrip(FILE);
        expect(roundTrip(once)).toBe(once);
        expect(roundTrip(roundTrip(once))).toBe(once);
    });

    it('keeps the user\'s own prose, above and below', () => {
        const document = parseMemoryMarkdown(FILE);
        expect(document.preamble).toContain('must not eat this paragraph');
        expect(document.trailing).toContain('anything else I wrote');
    });

    it('preserves the file\'s entry order rather than sorting', () => {
        // Sorting would be tidier and would produce a diff every time a confidence moved.
        const document = parseMemoryMarkdown(FILE);
        expect(document.entries.map(e => e.text)).toEqual([
            'This project uses pnpm, never npm',
            'The staging database is read-only',
        ]);
    });

    it('survives a file with no trailing newline', () => {
        const noNewline = '# Project Memory\n- a fact worth keeping <!-- mem id=m_1 type=fact tier=project conf=0.60 uses=0 used=1 created=1 status=active origin=user -->';
        expect(roundTrip(noNewline)).toBe(noNewline);
    });

    it('survives an empty file', () => {
        expect(parseMemoryMarkdown('').entries).toEqual([]);
        expect(parseMemoryMarkdown('   ').entries).toEqual([]);
    });

    it('keeps confidence at a fixed width, so arithmetic cannot churn the file', () => {
        // `0.6 * 0.9` is 0.5399999999999999; String() of that is not a diff anyone wants.
        expect(renderEntryLine(entry({ confidence: 0.6 * 0.9 }))).toContain('conf=0.54');
        expect(renderEntryLine(entry({ confidence: 0.8 }))).toContain('conf=0.80');
    });

    it('accepts a hand-written line with no metadata at all', () => {
        // The file is human-editable; a line somebody typed is a memory.
        const document = parseMemoryMarkdown('# Project Memory\n- prefer composition over inheritance\n');
        expect(document.entries).toHaveLength(1);
        expect(document.entries[0].text).toBe('prefer composition over inheritance');
        expect(document.entries[0].provenance.origin).toBe('user');
    });

    it('degrades a malformed metadata comment to defaults instead of dropping the line', () => {
        // Losing a memory because a number failed to parse is the worst available outcome.
        const document = parseMemoryMarkdown('- a real fact <!-- mem conf=banana uses=?? -->\n');
        expect(document.entries).toHaveLength(1);
        expect(document.entries[0].confidence).toBe(0.6);
        expect(document.entries[0].uses).toBe(0);
    });

    it('round-trips a where= containing spaces', () => {
        const line = renderEntryLine(entry({ provenance: { origin: 'extracted', where: 'said in run 12' } }));
        const parsed = parseMemoryMarkdown(`${line}\n`);
        expect(parsed.entries[0].provenance.where).toBe('said in run 12');
    });

    it('renders new entries into an existing document without disturbing the rest', () => {
        const document = parseMemoryMarkdown(FILE);
        const updated = withEntries(document, [...document.entries, entry({ text: 'new fact here', createdAt: 5, lastUsedAt: 5 })]);
        const rendered = renderMemoryMarkdown(updated);

        expect(rendered).toContain('must not eat this paragraph');
        expect(rendered).toContain('anything else I wrote');
        expect(rendered).toContain('new fact here');
        expect(roundTrip(rendered)).toBe(rendered);
    });
});

// ─── Gate: contradiction prompts, never overwrites ──────────────────────────

describe('contradiction prompts rather than overwriting', () => {
    const known = [
        entry({ text: 'This project uses pnpm', id: 'm_pnpm' }),
        entry({ text: 'Tests live in __tests__', id: 'm_tests' }),
    ];

    it('asks when an incoming fact conflicts with a known one', () => {
        const decision = decideWrite('This project uses npm', known);
        expect(decision.action).toBe('ask');
        expect(decision.contradictions[0].existing.id).toBe('m_pnpm');
    });

    it('detects a negation flip on the same subject', () => {
        const decision = decideWrite('This project does not use pnpm', known);
        expect(decision.action).toBe('ask');
        expect(decision.contradictions[0].reason).toBe('negation');
    });

    it('writes an unrelated fact without asking', () => {
        expect(decideWrite('The staging database is read-only', known).action).toBe('write');
    });

    it('does not flag two unrelated negatives as contradicting each other', () => {
        // Conflict-without-similarity would flag "never use tabs" against "never use any".
        const entries = [entry({ text: 'Never use tabs for indentation' })];
        expect(findContradictions('Never use the any type', entries)).toEqual([]);
    });

    it('does not flag a restatement as a contradiction', () => {
        // Similarity-without-conflict would flag every rephrasing.
        expect(findContradictions('This project uses pnpm', known)).toEqual([]);
    });

    it('skips a fact it already knows rather than asking about it', () => {
        expect(decideWrite('this project uses pnpm.', known).action).toBe('skip');
    });

    it('ignores archived entries when looking for conflicts', () => {
        const archived = [entry({ text: 'This project uses pnpm', status: 'archived' })];
        expect(findContradictions('This project uses npm', archived)).toEqual([]);
    });

    it('archives rather than deletes when the user resolves a conflict', () => {
        const [old, replacement] = supersede(known[0], 'This project uses npm', 9_000);
        expect(old.status).toBe('archived');
        expect(old.text).toBe('This project uses pnpm');   // still there, still readable
        expect(replacement.supersedes).toEqual(['m_pnpm']);
        expect(replacement.provenance.origin).toBe('user');
    });

    it('isNegated recognises the common forms', () => {
        expect(isNegated("don't use npm")).toBe(true);
        expect(isNegated('never commit secrets')).toBe(true);
        expect(isNegated('avoid global state')).toBe(true);
        expect(isNegated('use pnpm')).toBe(false);
    });
});

// ─── Gate: consolidation is idempotent ──────────────────────────────────────

describe('consolidation is idempotent', () => {
    const duplicates = [
        entry({ text: 'This project uses pnpm', confidence: 0.6, uses: 1, createdAt: 100, lastUsedAt: 100 }),
        entry({ text: 'this project uses pnpm.', confidence: 0.9, uses: 4, createdAt: 50, lastUsedAt: 900 }),
        entry({ text: 'Tests live in __tests__', confidence: 0.7, uses: 0, createdAt: 10, lastUsedAt: 10 }),
    ];

    it('merges near-duplicates that differ only by case and punctuation', () => {
        const result = consolidate(duplicates);
        expect(result.merged).toBe(1);
        expect(result.entries).toHaveLength(2);
    });

    it('produces the identical array on a second run', () => {
        const once = consolidate(duplicates).entries;
        const twice = consolidate(once).entries;
        expect(twice).toEqual(once);
        expect(consolidate(twice).entries).toEqual(once);
    });

    it('is independent of input order, which is what makes it idempotent', () => {
        // A merge that took "the first one's confidence" would give a different answer per
        // ordering, and the second run would differ from the first.
        const forward = consolidate(duplicates).entries;
        const backward = consolidate([...duplicates].reverse()).entries;
        const key = (e: MemoryEntry) => `${normalizeForIdentity(e.text)}:${e.confidence}:${e.uses}:${e.createdAt}:${e.lastUsedAt}`;
        expect(new Set(forward.map(key))).toEqual(new Set(backward.map(key)));
    });

    it('keeps the strongest evidence from each duplicate', () => {
        const [pnpm] = consolidate(duplicates).entries;
        expect(pnpm.confidence).toBe(0.9);      // max
        expect(pnpm.uses).toBe(5);              // sum — each use validated it
        expect(pnpm.createdAt).toBe(50);        // earliest
        expect(pnpm.lastUsedAt).toBe(900);      // latest
    });

    it('never resurrects something the user archived', () => {
        const merged = consolidate([
            entry({ text: 'a duplicated fact', status: 'archived' }),
            entry({ text: 'a duplicated fact', status: 'active' }),
        ]);
        expect(merged.entries[0].status).toBe('archived');
    });

    it('handles an empty store', () => {
        expect(consolidate([]).entries).toEqual([]);
        expect(consolidate(undefined as any).entries).toEqual([]);
    });
});

// ─── M43: decay ─────────────────────────────────────────────────────────────

describe('decay demotes, then archives, and never deletes', () => {
    const stale = (over: Partial<MemoryEntry> = {}) =>
        entry({ confidence: 0.6, uses: 0, lastUsedAt: 0, ...over });

    it('demotes an unused entry after the idle window', () => {
        const [decayed] = applyDecay([stale()], { now: 31 * DAY });
        expect(decayed.status).toBe('demoted');
        expect(decayed.confidence).toBeLessThan(0.6);
    });

    it('archives a demoted entry that stays unused', () => {
        const [decayed] = applyDecay([stale({ status: 'demoted' })], { now: 91 * DAY });
        expect(decayed.status).toBe('archived');
    });

    it('never removes an entry from the list — the file belongs to the user', () => {
        const store = [stale(), stale({ text: 'another stale fact' })];
        expect(applyDecay(store, { now: 400 * DAY })).toHaveLength(2);
    });

    it('exempts high-confidence entries entirely', () => {
        // A constraint stated once and not needed for three months is still a constraint.
        const [kept] = applyDecay([stale({ confidence: 0.95, type: 'constraint' })], { now: 400 * DAY });
        expect(kept.status).toBe('active');
        expect(kept.confidence).toBe(0.95);
    });

    it('exempts anything that has actually been used', () => {
        const [kept] = applyDecay([stale({ uses: 2 })], { now: 400 * DAY });
        expect(kept.status).toBe('active');
    });

    it('leaves a recently used entry alone', () => {
        const [kept] = applyDecay([stale({ lastUsedAt: 29 * DAY })], { now: 30 * DAY });
        expect(kept.status).toBe('active');
    });

    it('is stable once everything has archived', () => {
        const once = applyDecay([stale()], { now: 400 * DAY });
        expect(applyDecay(once, { now: 500 * DAY })).toEqual(once);
    });
});

// ─── M41: extraction ────────────────────────────────────────────────────────

describe('extraction bands', () => {
    it('auto-writes high confidence, queues medium, drops low', () => {
        const outcome = sortCandidates([
            { text: 'This project uses pnpm as its package manager', type: 'convention', confidence: 0.9 },
            { text: 'The team seems to prefer functional components', type: 'preference', confidence: 0.6 },
            { text: 'Possibly the cache is redis but unclear', type: 'fact', confidence: 0.2 },
        ]);
        expect(outcome.auto.map(e => e.text)).toEqual(['This project uses pnpm as its package manager']);
        expect(outcome.confirm.map(c => c.confidence)).toEqual([0.6]);
        expect(outcome.dropped).toHaveLength(1);
    });

    it('drops a candidate already in the store', () => {
        const outcome = sortCandidates(
            [{ text: 'This project uses pnpm', type: 'convention', confidence: 0.95 }],
            [entry({ text: 'this project uses pnpm.' })],
        );
        expect(outcome.auto).toEqual([]);
        expect(outcome.dropped).toHaveLength(1);
    });

    it('drops duplicates within the same batch', () => {
        const outcome = sortCandidates([
            { text: 'This project uses pnpm always', type: 'convention', confidence: 0.9 },
            { text: 'this project uses pnpm always.', type: 'convention', confidence: 0.9 },
        ]);
        expect(outcome.auto).toHaveLength(1);
    });

    it('records provenance, so "why do you believe this" is answerable', () => {
        const [written] = sortCandidates([
            { text: 'The staging database is read-only', type: 'constraint', confidence: 0.9, because: 'user said so in run 12' },
        ]).auto;
        expect(written.provenance.origin).toBe('extracted');
        expect(written.provenance.where).toBe('user said so in run 12');
    });

    it('bandFor treats a garbled confidence as a drop, not as high', () => {
        expect(bandFor(NaN)).toBe('drop');
        expect(bandFor(undefined as any)).toBe('drop');
        expect(bandFor(0.8)).toBe('auto');
        expect(bandFor(0.5)).toBe('confirm');
    });
});

describe('isWorthRemembering', () => {
    it('rejects transcript narration', () => {
        // The failure mode of automatic extraction is not missing a fact, it is
        // remembering a hundred worthless ones.
        for (const text of [
            'I will now read the file and check the imports',
            "Let's start by looking at the configuration",
            'Okay, that is done and the tests pass now',
        ]) {
            expect(isWorthRemembering(text), text).toBe(false);
        }
    });

    it('rejects restatements of the instruction', () => {
        expect(isWorthRemembering('The user asked me to add retry logic to the client')).toBe(false);
    });

    it('rejects questions', () => {
        expect(isWorthRemembering('Should this use the existing retry helper?')).toBe(false);
    });

    it('rejects fragments and essays', () => {
        expect(isWorthRemembering('pnpm')).toBe(false);
        expect(isWorthRemembering('x'.repeat(500))).toBe(false);
    });

    it('keeps a real project fact', () => {
        expect(isWorthRemembering('The staging database is read-only for all services')).toBe(true);
        expect(isWorthRemembering('Tests live in __tests__ and run with vitest')).toBe(true);
    });
});

// ─── The model ──────────────────────────────────────────────────────────────

describe('identity and injection', () => {
    it('gives the same id to the same fact stated with different punctuation', () => {
        // The SHA-256 store hashed raw content, so these were two memories.
        expect(memoryId('Use pnpm, not npm.')).toBe(memoryId('use pnpm, not npm'));
    });

    it('does not merge two different claims that share words', () => {
        expect(memoryId('the cache is invalidated on write'))
            .not.toBe(memoryId('the cache invalidates writes'));
    });

    it('excludes archived entries from injection but keeps demoted ones', () => {
        const store = [
            entry({ text: 'archived fact', status: 'archived' }),
            entry({ text: 'demoted fact', status: 'demoted' }),
            entry({ text: 'active fact', status: 'active' }),
        ];
        const texts = injectable(store).map(e => e.text);
        expect(texts).toContain('demoted fact');
        expect(texts).not.toContain('archived fact');
    });

    it('ranks a frequently used memory above a freshly written one', () => {
        const store = [
            entry({ text: 'never used', confidence: 0.7, uses: 0 }),
            entry({ text: 'used eleven times', confidence: 0.7, uses: 11 }),
        ];
        expect(injectable(store)[0].text).toBe('used eleven times');
    });

    it('touch records the use that keeps an entry out of decay', () => {
        const used = touch(entry({ uses: 2 }), 5_000);
        expect(used.uses).toBe(3);
        expect(used.lastUsedAt).toBe(5_000);
    });

    it('renderForPrompt stays inside its budget', () => {
        const store = Array.from({ length: 100 }, (_, i) => entry({ text: `fact number ${i} about this project` }));
        expect(renderForPrompt(store, 200).length).toBeLessThanOrEqual(200);
    });

    it('renderForPrompt names the type, so the model can weigh a constraint differently', () => {
        expect(renderForPrompt([entry({ text: 'staging is read-only', type: 'constraint' })]))
            .toContain('(constraint)');
    });
});

describe('decay is a function of elapsed time, not of job scheduling', () => {
    it('archives a long-idle active entry in one pass', () => {
        // The first version advanced one stage per call, so an entry idle for a year was
        // "demoted" if the job had run once and "archived" if it had run twice — the
        // store's contents depended on scheduling.
        const [decayed] = applyDecay([entry({ confidence: 0.6, uses: 0, lastUsedAt: 0 })], { now: 400 * DAY });
        expect(decayed.status).toBe('archived');
    });

    it('reaches the same state whether the job ran once or five times', () => {
        const start = [entry({ confidence: 0.6, uses: 0, lastUsedAt: 0 })];
        const once = applyDecay(start, { now: 400 * DAY });
        let many = start;
        for (let i = 0; i < 5; i++) many = applyDecay(many, { now: 400 * DAY });
        expect(many).toEqual(once);
    });
});
