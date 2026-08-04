import { ExtractionCandidate } from '../core/memory-lifecycle';
import { MemoryEntry } from '../core/memory-model';
import {
    buildExtractionPrompt, parseExtractionResponse, transcriptFrom, worthExtracting,
} from '../core/memory-extract';
import { MemoryStore } from '../memory/memory-store';

// ─── Memory across a turn (Phase 8, M41 · P8-1) ────────────────────────────
//
// Phase 8 shipped four pure modules and a store, and **nothing in the editor imported
// any of them.** `sortCandidates` banded candidates nobody produced, `applyDecay` aged
// entries nobody wrote, and `MemoryStore.forPrompt` rendered a section no prompt
// included. The roadmap recorded P8-1 as "the producer is missing", which was true and
// understated it: the consumer was missing too, so the feature was four correct
// algorithms and no loop.
//
// This is the loop. Two calls, one at each end of a turn:
//
//   `inject`  — before the model runs. Puts what is known into the prompt and records
//               which entries were used, which is what keeps them out of decay.
//   `extract` — after the turn ends. One model call over the finished transcript,
//               producing candidates that `sortCandidates` then bands.
//
// ── Why extraction is fire-and-forget, and why that is not laziness ─────────
// `extract` is not awaited by the lane that calls it. A memory pass is a background
// nicety; a user watching a finished answer must not wait on a second model call to see
// their turn marked complete, and a failure in it must never surface as the task having
// failed. Every path swallows its error into a log line for that reason. The cost of
// getting this wrong is high and asymmetric: a lost memory candidate costs one
// re-derivation, and a turn that appears to hang costs trust in the whole feature.
//
// ── The confirm band goes somewhere a person can act on it ─────────────────
// `sortCandidates` returns three bands and the middle one — "queued for a one-click
// confirm" — needs a surface. Confirmations are held here and read by the memory panel
// (M45). Deliberately not a modal per candidate: a background feature that interrupts
// the user to ask about three facts is a background feature they switch off.

export interface MemoryTurnDeps {
    store: MemoryStore;
    /** Makes the extraction model call. Injected so a lane picks its own role/budget. */
    complete: (prompt: string) => Promise<string>;
    log?: (message: string) => void;
    /** Conversation or run id, recorded as provenance. */
    runId?: string;
}

export interface InjectedMemory {
    /** The prompt section, or '' when there is nothing worth injecting. */
    text: string;
    /** Ids that went in, already marked used. */
    ids: string[];
}

export interface ExtractionResult {
    written: number;
    toConfirm: ExtractionCandidate[];
    /** Why nothing happened, when nothing did. */
    skipped?: string;
}

export class MemoryTurn {
    /** Candidates awaiting a one-click confirm, newest first. */
    private confirmations: ExtractionCandidate[] = [];

    constructor(private readonly deps: MemoryTurnDeps) {}

    /**
     * The memory section for this turn's system prompt.
     *
     * Marks the injected entries used in the same breath as injecting them, because the
     * two must not drift: `applyDecay` exempts anything with `uses > 0`, so an entry that
     * is injected on every turn and never marked would be archived after ninety days for
     * being unused — deleting exactly the facts the feature is working hardest to supply.
     */
    inject(maxChars = 2_000): InjectedMemory {
        try {
            const { text, ids } = this.deps.store.forPrompt(maxChars);
            if (ids.length) this.deps.store.markUsed(ids);
            return { text, ids };
        } catch (error: any) {
            // A memory read must never break a turn. The turn is simply less informed.
            this.deps.log?.(`[Memory] Could not read the store: ${error?.message || error}`);
            return { text: '', ids: [] };
        }
    }

    /**
     * Extract durable facts from a finished turn.
     *
     * Cheap checks first, before the model: a two-message exchange has nowhere to hide a
     * durable fact, and running an extraction call on every trivial turn is how a
     * background feature becomes the thing that doubled everyone's bill.
     */
    async extract(messages: { role: string; content?: string }[]): Promise<ExtractionResult> {
        const transcript = transcriptFrom(messages);
        if (!worthExtracting(transcript, messages.length)) {
            return { written: 0, toConfirm: [], skipped: 'the turn was too short to contain a durable fact' };
        }

        let known: string[] = [];
        try { known = this.deps.store.entries().map(e => e.text); } catch { /* an empty store is fine */ }

        let candidates: ExtractionCandidate[];
        try {
            const response = await this.deps.complete(buildExtractionPrompt(transcript, { known, runId: this.deps.runId }));
            candidates = parseExtractionResponse(response);
        } catch (error: any) {
            this.deps.log?.(`[Memory] Extraction call failed: ${error?.message || error}`);
            return { written: 0, toConfirm: [], skipped: `the extraction call failed: ${error?.message || error}` };
        }

        if (!candidates.length) {
            // The common and correct answer. Logged at all only because a *silent* no-op
            // is indistinguishable from the feature being switched off.
            return { written: 0, toConfirm: [], skipped: 'nothing durable in this turn' };
        }

        const outcome = this.deps.store.ingest(candidates);
        this.queueConfirmations(outcome.toConfirm);

        if (outcome.written) this.deps.log?.(`[Memory] Wrote ${outcome.written} fact(s) to project memory.`);
        if (outcome.toConfirm.length) this.deps.log?.(`[Memory] ${outcome.toConfirm.length} candidate(s) await confirmation.`);
        return { written: outcome.written, toConfirm: outcome.toConfirm };
    }

    /**
     * Run extraction without making the caller wait or handle its failure.
     *
     * The signature is the point: it returns nothing, so no lane can accidentally await
     * it, and it cannot reject, so no lane can accidentally fail because of it.
     */
    extractInBackground(messages: { role: string; content?: string }[]): void {
        void this.extract(messages).catch(error => {
            this.deps.log?.(`[Memory] Extraction failed: ${error?.message || error}`);
        });
    }

    private queueConfirmations(candidates: ExtractionCandidate[]): void {
        for (const candidate of candidates) {
            // De-duplicated on text: the same fact restated across three turns should be
            // one question, not three.
            const key = normalise(candidate.text);
            if (this.confirmations.some(c => normalise(c.text) === key)) continue;
            this.confirmations.unshift(candidate);
        }
        // Bounded. A queue that grows without limit becomes a list nobody opens, and the
        // oldest unconfirmed candidate is the one least likely to still matter.
        this.confirmations = this.confirmations.slice(0, 20);
    }

    get pending(): ExtractionCandidate[] { return [...this.confirmations]; }

    /** Everything currently believed, for the panel (M45). */
    entries(): MemoryEntry[] {
        try { return this.deps.store.entries(); } catch { return []; }
    }

    /** Where the markdown lives, so the panel can offer to open it. See ADR 007. */
    get filePath(): string { return this.deps.store.filePath; }

    /**
     * The user accepted a candidate.
     *
     * Written with `origin: 'user'` and a confidence above the auto band, because a human
     * saying yes is stronger evidence than the model's own score — and because leaving it
     * at the extracted confidence would let `applyDecay` demote a fact somebody
     * explicitly confirmed.
     */
    confirm(text: string): MemoryEntry[] {
        const key = normalise(text);
        const candidate = this.confirmations.find(c => normalise(c.text) === key);
        this.confirmations = this.confirmations.filter(c => normalise(c.text) !== key);
        if (!candidate) return this.deps.store.entries();

        this.deps.store.ingest([{ ...candidate, confidence: Math.max(candidate.confidence, 0.85) }]);
        return this.deps.store.entries();
    }

    /** The user rejected a candidate. Dropped, not remembered as rejected. */
    reject(text: string): void {
        const key = normalise(text);
        this.confirmations = this.confirmations.filter(c => normalise(c.text) !== key);
    }
}

function normalise(text: string): string {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
