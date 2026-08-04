import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    MAX_TRANSCRIPT_CHARS, buildExtractionPrompt, parseExtractionResponse, transcriptFrom,
    trimTranscript, worthExtracting,
} from '../src/core/memory-extract';
import { MemoryTurn } from '../src/agent/memory-turn';
import { MemoryStore } from '../src/memory/memory-store';
import { buildMemoryView, describeAge, describeDecay, describeOrigin } from '../src/core/memory-view';
import { createMemory } from '../src/core/memory-model';

/**
 * The memory loop (Phase 8, M41 · P8-1) and its panel (M45 · P8-2).
 *
 * The roadmap recorded P8-1 as "the producer is missing", which was true and understated
 * it: **nothing in the editor imported any of Phase 8.** `sortCandidates` banded
 * candidates nobody produced, `applyDecay` aged entries nobody wrote, and
 * `MemoryStore.forPrompt` rendered a section no prompt included — four correct algorithms
 * and no loop. So this file asserts the loop, not just the new call.
 */

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-memory-'));

const turnFor = (root: string, respond: (prompt: string) => Promise<string> | string) => new MemoryTurn({
    store: new MemoryStore(root),
    complete: async (prompt) => respond(prompt),
});

const conversation = (extra: string[] = []) => [
    { role: 'user', content: 'the CI build is failing again, can you look' },
    { role: 'assistant', content: 'I will check the workflow file.' },
    { role: 'user', content: 'also fyi we deploy with Terraform, not CDK — the CDK app in infra/ is dead code' },
    { role: 'assistant', content: 'Understood. Fixed: the failing step was the Node version.' },
    ...extra.map(content => ({ role: 'user', content })),
];

describe('the extraction prompt is built around what NOT to extract', () => {
    const prompt = buildExtractionPrompt('User: we deploy with Terraform');

    it('shows the exact wrong output rather than stating a principle', () => {
        // "Do not extract narration" is advice a model agrees with and then ignores. A
        // literal example of the wrong sentence is a pattern it can match against what it
        // is about to write.
        expect(prompt).toMatch(/The user asked me to fix the failing test/);
        expect(prompt).toMatch(/I updated the workflow file/);
    });

    it('defines confidence by what the store DOES with it, not as a feeling', () => {
        expect(prompt).toMatch(/written to the project memory file immediately/);
        expect(prompt).toMatch(/queued for the user to confirm/);
        expect(prompt).toMatch(/discarded/);
    });

    it('says an empty answer is correct and common', () => {
        // Without this a model produces something to justify having been asked, and a
        // memory file of session narration is worse than an empty one.
        expect(prompt).toMatch(/An empty array is the correct and common answer/);
    });

    it('lists what is already known so the same fact is not re-proposed every turn', () => {
        expect(buildExtractionPrompt('x', { known: ['we deploy with Terraform'] }))
            .toMatch(/Already known — do not repeat these:[\s\S]*we deploy with Terraform/);
    });
});

describe('transcript handling', () => {
    it('keeps the END when trimming, because corrections come last', () => {
        // A correction is by definition later than the thing it corrects. Keeping the head
        // would preserve the original request — exactly what the filter then discards as a
        // task restatement.
        const long = `${'x'.repeat(MAX_TRANSCRIPT_CHARS)}\nTHE IMPORTANT CORRECTION`;
        const trimmed = trimTranscript(long);
        expect(trimmed).toContain('THE IMPORTANT CORRECTION');
        expect(trimmed).toMatch(/^\[earlier turns omitted\]/);
    });

    it('starts a trimmed transcript on a line boundary', () => {
        // Half a sentence handed to the model reads as a fact about the project.
        const trimmed = trimTranscript(`${'a'.repeat(200)}\nsecond line`, 100);
        expect(trimmed).not.toMatch(/^\[earlier turns omitted\]\na/);
    });

    it('drops tool results, which are output rather than statement', () => {
        const rendered = transcriptFrom([
            { role: 'user', content: 'what does this do' },
            { role: 'tool', content: 'x'.repeat(50_000) },
            { role: 'assistant', content: 'it converts an amount' },
        ]);
        expect(rendered).not.toMatch(/xxxx/);
        expect(rendered).toContain('User: what does this do');
        expect(rendered).toContain('Assistant: it converts an amount');
    });

    it('refuses to spend a call on a turn too small to contain a fact', () => {
        expect(worthExtracting('short', 5)).toBe(false);
        expect(worthExtracting('x'.repeat(500), 1)).toBe(false);
        expect(worthExtracting('x'.repeat(500), 4)).toBe(true);
    });
});

describe('parsing an extraction response', () => {
    const candidate = (over = {}) => JSON.stringify([{
        text: 'The team deploys with Terraform, not CDK', type: 'convention', confidence: 0.9, ...over,
    }]);

    it('reads a clean array', () => {
        expect(parseExtractionResponse(candidate())).toMatchObject([{ type: 'convention', confidence: 0.9 }]);
    });

    it('survives a fence and surrounding prose', () => {
        expect(parseExtractionResponse(`Here is what I found:\n\`\`\`json\n${candidate()}\n\`\`\`\nHope that helps.`))
            .toHaveLength(1);
    });

    it('survives a {"memories": [...]} wrapper', () => {
        expect(parseExtractionResponse(JSON.stringify({ memories: JSON.parse(candidate()) }))).toHaveLength(1);
    });

    it('finds a balanced array even when prose contains a bracket', () => {
        // The greedy first-`[`-to-last-`]` version splices unrelated text into JSON.parse.
        expect(parseExtractionResponse(`I looked at [the config] and found:\n${candidate()}`)).toHaveLength(1);
    });

    it('returns nothing for an unparseable response rather than guessing', () => {
        // This writes to a file in the user's repo. A partial guess is a wrong fact
        // asserted with a confidence the model never gave it.
        expect(parseExtractionResponse('I could not find anything.')).toEqual([]);
        expect(parseExtractionResponse('')).toEqual([]);
    });

    it('applies the content filter here too, so a prompt regression shows up as a score', () => {
        const narration = JSON.stringify([
            { text: 'The user asked me to fix the failing test', confidence: 0.9 },
            { text: 'I will now read the workflow file', confidence: 0.9 },
            { text: 'Should we use Terraform?', confidence: 0.9 },
        ]);
        expect(parseExtractionResponse(narration)).toEqual([]);
    });

    it('defaults a missing confidence to the bottom of the confirm band', () => {
        // Defaulting high auto-writes a fact the model never vouched for; defaulting to a
        // drop silently loses every candidate from a provider that omits the field.
        expect(parseExtractionResponse(candidate({ confidence: undefined }))[0].confidence).toBe(0.5);
    });

    it('falls back to `fact` for an unknown type rather than dropping the candidate', () => {
        expect(parseExtractionResponse(candidate({ type: 'nonsense' }))[0].type).toBe('fact');
    });
});

describe('the loop: inject before, extract after', () => {
    it('injects nothing from an empty store, and does not fail doing it', () => {
        const turn = turnFor(scratch(), () => '[]');
        expect(turn.inject()).toEqual({ text: '', ids: [] });
    });

    it('marks injected entries used, or decay would delete the facts it supplies', () => {
        /*
         * The subtle one. `applyDecay` exempts anything with `uses > 0`, so an entry
         * injected on every turn and never marked would be archived after ninety days for
         * being unused — deleting exactly the facts the feature works hardest to provide.
         */
        const root = scratch();
        const store = new MemoryStore(root);
        store.offer('The staging database is read-only for this team');

        const turn = new MemoryTurn({ store, complete: async () => '[]' });
        expect(turn.inject().ids.length).toBe(1);
        expect(store.entries()[0].uses).toBeGreaterThan(0);
    });

    it('writes a high-confidence fact and queues a middling one', async () => {
        const turn = turnFor(scratch(), () => JSON.stringify([
            { text: 'The team deploys with Terraform, not CDK', type: 'convention', confidence: 0.95 },
            { text: 'The orders service probably owns invoicing', type: 'fact', confidence: 0.6 },
        ]));

        const result = await turn.extract(conversation());
        expect(result.written).toBe(1);
        expect(result.toConfirm).toHaveLength(1);
        expect(turn.pending[0].text).toMatch(/probably owns invoicing/);
    });

    it('a confirmed candidate is written above the auto band, so decay cannot demote it', async () => {
        // A human saying yes is stronger evidence than the model's own score.
        const turn = turnFor(scratch(), () => JSON.stringify([
            { text: 'The orders service owns invoicing', type: 'fact', confidence: 0.6 },
        ]));
        await turn.extract(conversation());
        const entries = turn.confirm('The orders service owns invoicing');
        expect(entries.some(e => e.confidence >= 0.8)).toBe(true);
        expect(turn.pending).toHaveLength(0);
    });

    it('a rejected candidate is dropped and not re-queued', async () => {
        const turn = turnFor(scratch(), () => JSON.stringify([
            { text: 'The orders service owns invoicing', type: 'fact', confidence: 0.6 },
        ]));
        await turn.extract(conversation());
        turn.reject('The orders service owns invoicing');
        expect(turn.pending).toHaveLength(0);
        expect(turn.entries()).toHaveLength(0);
    });

    it('de-duplicates the confirm queue — one question, not three', async () => {
        const turn = turnFor(scratch(), () => JSON.stringify([
            { text: 'The orders service owns invoicing', type: 'fact', confidence: 0.6 },
        ]));
        await turn.extract(conversation());
        await turn.extract(conversation(['and again']));
        expect(turn.pending).toHaveLength(1);
    });

    it('does not spend a call on a turn with nothing in it', async () => {
        const complete = vi.fn(async () => '[]');
        const turn = new MemoryTurn({ store: new MemoryStore(scratch()), complete });
        const result = await turn.extract([{ role: 'user', content: 'thanks' }]);
        expect(complete).not.toHaveBeenCalled();
        expect(result.skipped).toMatch(/too short/);
    });

    it('a failed extraction call is reported, not thrown', async () => {
        const turn = turnFor(scratch(), () => { throw new Error('429 rate limited'); });
        const result = await turn.extract(conversation());
        expect(result.written).toBe(0);
        expect(result.skipped).toMatch(/429/);
    });

    it('extractInBackground returns nothing and cannot reject', async () => {
        /*
         * The signature is the guarantee. A lane cannot accidentally `await` a background
         * memory pass (which would make the user wait on a second model call to see their
         * answer marked complete), and cannot accidentally fail because of one.
         */
        const turn = turnFor(scratch(), () => { throw new Error('boom'); });
        expect(turn.extractInBackground(conversation())).toBeUndefined();
        await new Promise(resolve => setTimeout(resolve, 10));
    });

    it('a broken store never breaks a turn', () => {
        const turn = new MemoryTurn({
            store: { forPrompt: () => { throw new Error('disk on fire'); } } as any,
            complete: async () => '[]',
        });
        expect(turn.inject()).toEqual({ text: '', ids: [] });
    });

    it('round-trips through the file, so a later session sees what an earlier one learned', async () => {
        const root = scratch();
        const first = turnFor(root, () => JSON.stringify([
            { text: 'The staging database is read-only for this team', type: 'constraint', confidence: 0.95 },
        ]));
        await first.extract(conversation());

        // A different MemoryTurn over the same root — the point of a durable store.
        const second = turnFor(root, () => '[]');
        expect(second.inject().text).toMatch(/staging database is read-only/);
    });
});

// ─── The panel (M45 · P8-2) ─────────────────────────────────────────────────

const entry = (over: Parameters<typeof createMemory>[0] & { status?: any; uses?: number } = {} as any) => ({
    ...createMemory({
        text: 'The team deploys with Terraform', type: 'convention', confidence: 0.9,
        provenance: { origin: 'extracted', where: 'conversation 4' }, ...over,
    }),
    ...(over.status ? { status: over.status } : {}),
    ...(over.uses !== undefined ? { uses: over.uses } : {}),
});

describe('the memory view', () => {
    it('orders by status first, then confidence — not newest first', () => {
        /*
         * A memory store is not a feed. The question is "what does it think it knows",
         * and second "is any of that wrong" — so what is actively shaping answers comes
         * first, and the entry most likely to be doing damage if it is wrong is at the top.
         */
        const view = buildMemoryView([
            entry({ text: 'An archived low-confidence belief', confidence: 0.3, status: 'archived' } as any),
            entry({ text: 'An active but uncertain belief', confidence: 0.55 } as any),
            entry({ text: 'An active and certain belief', confidence: 0.95 } as any),
        ]);
        expect(view.rows.map(r => r.text)).toEqual([
            'An active and certain belief',
            'An active but uncertain belief',
            'An archived low-confidence belief',
        ]);
    });

    it('counts by status and type', () => {
        const view = buildMemoryView([
            entry({ text: 'a convention about imports here' } as any),
            entry({ text: 'a fact about the database here', type: 'fact' } as any),
        ]);
        expect(view.counts).toMatchObject({ total: 2, active: 2, byType: { convention: 1, fact: 1 } });
    });

    it('filters by status, type and free text', () => {
        const entries = [
            entry({ text: 'we deploy with Terraform not CDK' } as any),
            entry({ text: 'the staging database is read-only', type: 'constraint' } as any),
        ];
        expect(buildMemoryView(entries, [], { type: 'constraint' }).rows).toHaveLength(1);
        expect(buildMemoryView(entries, [], { query: 'terraform' }).rows).toHaveLength(1);
        expect(buildMemoryView(entries, [], { status: 'archived' }).rows).toHaveLength(0);
    });

    it('distinguishes "nothing yet" from "nothing matches", which lead opposite ways', () => {
        expect(buildMemoryView([]).empty).toMatch(/Nothing is remembered about this project yet/);
        expect(buildMemoryView([entry()], [], { query: 'zzz' }).empty).toMatch(/No memories match this filter/);
        expect(buildMemoryView([entry()]).empty).toBeUndefined();
    });

    it('surfaces pending candidates even when the entry filter excludes everything', () => {
        // The confirm queue is the only decision waiting on the user; a filter must not
        // be able to hide it.
        const view = buildMemoryView([], [{ text: 'a candidate fact here', type: 'fact', confidence: 0.6 }], { query: 'zzz' });
        expect(view.pending).toHaveLength(1);
        expect(view.empty).toBeUndefined();
    });

    it('answers "why do you believe this" rather than printing an enum', () => {
        expect(describeOrigin(entry({ provenance: { origin: 'user' } } as any))).toBe('you stated this');
        expect(describeOrigin(entry({ provenance: { origin: 'extracted' } } as any)))
            .toBe('extracted from a conversation');
    });

    it('states decay as what will happen and when, not as a status word', () => {
        // "Demoted" is a word this codebase invented and the user has no reason to know.
        const now = Date.now();
        const idle = { ...entry({ confidence: 0.5 } as any), uses: 0, lastUsedAt: now - 40 * 86_400_000 };
        expect(describeDecay(idle as any, { now })).toMatch(/Unused for 40 days — will be demoted/);
        expect(describeDecay({ ...idle, status: 'demoted' } as any, { now })).toMatch(/will be archived in 50/);
        expect(describeDecay(entry({ confidence: 0.9 } as any), { now })).toMatch(/never decays/);
    });

    it('describes age in units a reader parses at a glance', () => {
        const now = 1_000_000_000_000;
        expect(describeAge(now - 30_000, now)).toBe('just now');
        expect(describeAge(now - 5 * 3_600_000, now)).toBe('5h ago');
        expect(describeAge(now - 3 * 86_400_000, now)).toBe('3d ago');
        expect(describeAge(now - 400 * 86_400_000, now)).toBe('1y ago');
    });
});

// ─── Wiring ─────────────────────────────────────────────────────────────────

describe('the loop is actually reachable from the editor', () => {
    const src = (...parts: string[]) => fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8');

    it('the chat lane injects memory into the prompt', () => {
        // Structural, and the assertion that would have caught the original state: every
        // pure module below this line was correct and none of them were called.
        const chat = src('agent', 'chat-task.ts');
        expect(chat).toMatch(/memoryTurn\.inject\(\)/);
        expect(chat).toMatch(/name: 'memory'/);
    });

    it('the chat lane extracts at the end of a completed turn, in the background', () => {
        expect(src('agent', 'chat-task.ts')).toMatch(/memoryTurn\.extractInBackground\(/);
    });

    it('the provider owns the loop, so the confirm queue survives between turns', () => {
        // A per-turn instance would produce candidates, band them, queue them, and throw
        // them away before anything could show them.
        expect(src('extension.ts')).toMatch(/private readonly _memory: MemoryTurn \| undefined/);
        expect(src('extension.ts')).toMatch(/memoryTurn: this\._memory/);
    });

    it('the manager panel exposes memory, and offers to open the file', () => {
        const panel = src('core', 'manager-panel.ts');
        expect(panel).toMatch(/case 'listMemory'/);
        expect(panel).toMatch(/case 'confirmMemory'/);
        // ADR 007: the markdown is a user file, and editing it is the supported way to
        // correct a memory.
        expect(panel).toMatch(/case 'openMemoryFile'/);
    });
});
