import * as path from 'path';
import * as fs from 'fs';
import { MemoryEntry, injectable, renderForPrompt, touch } from '@blackide/agent-core/core/memory-model';
import {
    MemoryDocument, EMPTY_DOCUMENT, parseMemoryMarkdown, renderMemoryMarkdown, withEntries,
} from '@blackide/agent-core/core/memory-markdown';
import {
    ExtractionCandidate, WriteDecision, applyDecay, consolidate, decideWrite, sortCandidates,
    supersede,
} from '@blackide/agent-core/core/memory-lifecycle';
import { openDocument, sealDocument } from '@blackide/agent-core/core/at-rest';

// ─── The durable memory store (Phase 8) ─────────────────────────────────────
//
// The file half. Everything interesting is in the three pure modules; this reads and
// writes `.blackIDE/knowledge/memory.md` and does nothing clever, which is deliberate —
// the store is the part that can lose a user's data, so it should be the part with the
// fewest decisions in it.
//
// ── Read-modify-write, every time ────────────────────────────────────────────
// The file is in the user's repo and they may edit it in the editor while an agent is
// running. So every mutation re-reads from disk rather than writing a cached document
// back: a cache would silently overwrite a line the user typed thirty seconds ago, which
// is the single worst thing a tool that writes to somebody's repo can do.

const MEMORY_FILE = path.join('.blackIDE', 'knowledge', 'memory.md');

const SCAFFOLD = [
    '# Project Memory',
    '',
    'Facts, conventions and preferences this project has accumulated. Edit freely — this',
    'file is yours, and the agent preserves anything it did not write.',
    '',
].join('\n');

export class MemoryStore {
    /**
     * At-rest encryption key (M58 · P9-7). Absent means the file is plaintext, which is
     * the default and the shape ADR 007 assumes — see `at-rest.ts` for what encrypting a
     * user-editable file costs and why it is the user's call.
     */
    constructor(private readonly rootPath: string, private readonly key?: Buffer) {}

    get filePath(): string {
        return path.join(this.rootPath, MEMORY_FILE);
    }

    /**
     * Read the document. A missing file is an empty document with the scaffold.
     *
     * "Missing" and "present but unreadable" are deliberately different states, and
     * `unreadable` exists only because collapsing them is a data-loss bug: a file
     * encrypted with a key this process does not have would parse as *empty*, and the
     * next `mutate` would render an empty document over it. `mutate` refuses to write
     * when this flag is set — see there.
     */
    read(): { document: MemoryDocument; unreadable: boolean } {
        let raw: string;
        try {
            raw = fs.readFileSync(this.filePath, 'utf8');
        } catch {
            return { document: { ...EMPTY_DOCUMENT, preamble: SCAFFOLD }, unreadable: false };
        }
        try {
            return { document: parseMemoryMarkdown(openDocument(raw, this.key)), unreadable: false };
        } catch {
            return { document: { ...EMPTY_DOCUMENT, preamble: SCAFFOLD }, unreadable: true };
        }
    }

    entries(): MemoryEntry[] {
        return this.read().document.entries;
    }

    /**
     * Apply a change to the entries and write it back.
     *
     * Re-reads first, so the mutation composes with whatever the user has done to the file
     * since the caller last looked. Writes only when the rendered bytes actually differ —
     * a no-op pass must not touch the file's mtime, or every consolidation run shows up as
     * a modification in the user's editor and their git status.
     */
    private mutate(change: (entries: MemoryEntry[]) => MemoryEntry[]): MemoryDocument {
        const { document, unreadable } = this.read();
        /*
         * Refuse to write over a file we could not read (M58 · P9-7).
         *
         * The case is a memory file encrypted with a key this process does not have —
         * the user changed their passphrase, or opened the repo on a second machine.
         * `read` returns an empty document for it, and without this line the next
         * mutation would render that empty document straight over their memories. It is
         * the same class of mistake as the cache the read-modify-write cycle already
         * exists to avoid, arriving by a different door.
         */
        if (unreadable) return document;

        const updated = withEntries(document, change(document.entries));
        const rendered = renderMemoryMarkdown(updated);
        const onDisk = this.key ? sealDocument(rendered, this.key) : rendered;

        let existing = '';
        try { existing = fs.readFileSync(this.filePath, 'utf8'); } catch { /* new file */ }
        /*
         * Compare the *plaintext*, not the bytes, when encrypting.
         *
         * A fresh IV per seal means the ciphertext differs on every call even when the
         * document has not changed — so a byte comparison would rewrite the file on every
         * idle consolidation pass, defeating the mtime guard this check exists to provide
         * and filling the user's git status with churn.
         */
        const unchanged = this.key
            ? (() => { try { return openDocument(existing, this.key) === rendered; } catch { return false; } })()
            : existing === rendered;
        if (unchanged) return updated;

        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(this.filePath, onDisk, 'utf8');
        } catch { /* a memory write must never break a run */ }
        return updated;
    }

    /**
     * Offer a fact to the store.
     *
     * Returns the decision rather than acting on an `ask`: resolving a contradiction is the
     * user's, and a store that decided for them would be the silent-overwrite behaviour
     * M42 exists to remove.
     */
    offer(text: string): WriteDecision {
        const decision = decideWrite(text, this.entries());
        if (decision.action !== 'write') return decision;
        this.mutate(entries => [...entries, ...sortCandidates([{ text, type: 'fact', confidence: 0.9 }], entries).auto]);
        return decision;
    }

    /** Write the auto-band candidates from an end-of-turn extraction (M41). */
    ingest(candidates: ExtractionCandidate[], at = Date.now()): { written: number; toConfirm: ExtractionCandidate[] } {
        const existing = this.entries();
        const outcome = sortCandidates(candidates, existing, at);
        if (outcome.auto.length) this.mutate(entries => [...entries, ...outcome.auto]);
        return { written: outcome.auto.length, toConfirm: outcome.confirm };
    }

    /** The user resolved a contradiction in favour of the new statement. */
    resolveContradiction(existingId: string, incoming: string, at = Date.now()): void {
        this.mutate(entries => {
            const target = entries.find(e => e.id === existingId);
            if (!target) return entries;
            const [archived, replacement] = supersede(target, incoming, at);
            return [...entries.map(e => (e.id === existingId ? archived : e)), replacement];
        });
    }

    /** Record that entries were used, which is what keeps them out of decay. */
    markUsed(ids: string[], at = Date.now()): void {
        if (!ids.length) return;
        const wanted = new Set(ids);
        this.mutate(entries => entries.map(e => (wanted.has(e.id) ? touch(e, at) : e)));
    }

    /**
     * The idle job (M44): consolidate duplicates, then age what nobody uses.
     *
     * In that order. Consolidating first sums the use counts of duplicates, so a fact
     * recorded three times and read once from each copy is correctly seen as used three
     * times rather than decayed as three barely-used entries.
     */
    consolidateAndDecay(now = Date.now()): { merged: number; entries: MemoryEntry[] } {
        let merged = 0;
        const document = this.mutate(entries => {
            const consolidated = consolidate(entries);
            merged = consolidated.merged;
            return applyDecay(consolidated.entries, { now });
        });
        return { merged, entries: document.entries };
    }

    /** The prompt section, plus the ids that went into it so they can be marked used. */
    forPrompt(maxChars = 2_000): { text: string; ids: string[] } {
        const entries = injectable(this.entries());
        const text = renderForPrompt(entries, maxChars);
        if (!text) return { text: '', ids: [] };
        const included = entries.filter(e => text.includes(e.text)).map(e => e.id);
        return { text, ids: included };
    }
}
