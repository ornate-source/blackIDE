import {
    ConfidenceBand, MemoryEntry, MemoryType, bandFor, clamp01, createMemory, memoryId,
    normalizeForIdentity,
} from './memory-model';

// ─── Memory lifecycle (Phase 8, M41–M44) ────────────────────────────────────
//
// Extraction, contradiction, decay and consolidation. One module because the four are one
// story — a fact arrives, is checked against what is already believed, ages if nobody uses
// it, and is merged with its duplicates — and splitting them would put the four halves of
// "what happens to a memory" in four files that each only make sense together.
//
// All pure. Every one of these decisions is the kind that is easy to get subtly wrong and
// impossible to notice: a decay rule that is slightly too aggressive deletes a fact the
// user stated once and needed in month three, and nothing anywhere reports it.

// ─── M41: extraction ────────────────────────────────────────────────────────

export interface ExtractionCandidate {
    text: string;
    type: MemoryType;
    confidence: number;
    /** Why the extractor believed it, for the confirm prompt. */
    because?: string;
}

export interface ExtractionOutcome {
    /** Written immediately. */
    auto: MemoryEntry[];
    /** Queued for a one-click confirm. */
    confirm: ExtractionCandidate[];
    /** Discarded, with the band that discarded them — for tuning, not for the user. */
    dropped: ExtractionCandidate[];
}

/**
 * Sort candidates into the three bands, and refuse the ones that should never be memories.
 *
 * The band boundaries are in `memory-model.ts`; what lives here is the *content* filter,
 * and it exists because the failure mode of automatic extraction is not missing a fact —
 * it is remembering a hundred worthless ones. A store full of "the user asked me to fix a
 * bug" costs context on every turn, buries the three entries that matter, and teaches the
 * user that the memory feature is noise.
 */
export function sortCandidates(
    candidates: ExtractionCandidate[],
    existing: MemoryEntry[] = [],
    at = Date.now(),
): ExtractionOutcome {
    const outcome: ExtractionOutcome = { auto: [], confirm: [], dropped: [] };
    const known = new Set(existing.map(e => normalizeForIdentity(e.text)));
    const seen = new Set<string>();

    for (const candidate of candidates || []) {
        const text = String(candidate.text || '').trim();
        const normalized = normalizeForIdentity(text);

        if (!isWorthRemembering(text) || known.has(normalized) || seen.has(normalized)) {
            outcome.dropped.push(candidate);
            continue;
        }
        seen.add(normalized);

        const band: ConfidenceBand = bandFor(candidate.confidence);
        if (band === 'auto') {
            outcome.auto.push(createMemory({
                text, type: candidate.type, confidence: candidate.confidence,
                provenance: { origin: 'extracted', where: candidate.because }, at,
            }));
        } else if (band === 'confirm') {
            outcome.confirm.push({ ...candidate, text });
        } else {
            outcome.dropped.push(candidate);
        }
    }
    return outcome;
}

/**
 * Whether a sentence is the kind of thing worth carrying between sessions.
 *
 * Rejects the three shapes an extractor produces most and that are never useful later:
 * transcript narration ("I will now read the file"), restatements of the task, and anything
 * too short to be a claim. Deliberately conservative — a fact wrongly dropped costs one
 * re-derivation, while a hundred wrongly kept cost every future turn.
 */
export function isWorthRemembering(text: string): boolean {
    const trimmed = String(text || '').trim();
    if (trimmed.length < 12 || trimmed.length > 400) return false;

    const lower = trimmed.toLowerCase();
    // First-person process narration: about the run, not about the project.
    if (/^(i|we|let me|let's|i'll|i will|now i|next i)\b/.test(lower)) return false;
    if (/^(ok|okay|sure|done|thanks|got it)\b/.test(lower)) return false;
    // Questions are not facts.
    if (trimmed.endsWith('?')) return false;
    // A restatement of an instruction the agent was given is not something it learned.
    if (/^(the user (asked|wants|requested)|you asked)/.test(lower)) return false;
    return true;
}

// ─── M42: contradiction ─────────────────────────────────────────────────────

export interface Contradiction {
    existing: MemoryEntry;
    incoming: string;
    /** 0..1 — how close the two are in subject matter. */
    similarity: number;
    reason: 'negation' | 'value-conflict';
}

const NEGATORS = ['not', 'never', 'no', "don't", 'dont', "doesn't", 'avoid', 'without', 'stop'];

/**
 * Find entries the incoming text contradicts.
 *
 * Two signals, and both are needed because either alone is useless. **Similarity** finds
 * entries about the same subject; **conflict** decides whether they disagree. Similarity
 * alone flags every restatement of a fact as a contradiction; conflict alone flags "never
 * use tabs" against "never use `any`" because both contain a negator.
 *
 * The similarity here is lexical (token overlap), not embedding-based, and that is a
 * deliberate limitation rather than an oversight: embeddings would need the `embed` role,
 * which makes contradiction detection a network call on every write, and a memory write
 * that can fail on a rate limit is a memory write that silently does not happen. The
 * lexical version catches the case that actually occurs — the same subject asserted two
 * ways — and `E7`'s embedding-near variant remains available when the store is large
 * enough to need it.
 */
export function findContradictions(
    incoming: string,
    entries: MemoryEntry[],
    options: { threshold?: number } = {},
): Contradiction[] {
    const threshold = options.threshold ?? 0.4;
    const incomingTokens = contentTokens(incoming);
    if (!incomingTokens.length) return [];

    const out: Contradiction[] = [];
    for (const entry of entries || []) {
        if (entry.status === 'archived') continue;
        if (normalizeForIdentity(entry.text) === normalizeForIdentity(incoming)) continue;

        const similarity = jaccard(incomingTokens, contentTokens(entry.text));
        if (similarity < threshold) continue;

        const reason = conflictReason(incoming, entry.text);
        if (reason) out.push({ existing: entry, incoming, similarity, reason });
    }
    return out.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Why two similar statements disagree, or undefined.
 *
 * `negation` — exactly one of them is negated, so they assert opposite things about the
 * same subject. `value-conflict` — both name a value in the same slot and the values
 * differ ("use pnpm" vs "use npm"), which is the commonest real contradiction and the one a
 * negation check alone misses entirely.
 */
function conflictReason(a: string, b: string): Contradiction['reason'] | undefined {
    if (isNegated(a) !== isNegated(b)) return 'negation';

    const aTokens = contentTokens(a);
    const bTokens = contentTokens(b);
    const onlyA = aTokens.filter(t => !bTokens.includes(t));
    const onlyB = bTokens.filter(t => !aTokens.includes(t));
    // Same subject, and each names something the other does not: a differing value in the
    // same slot. Bounded to a small difference, or two long unrelated sentences that happen
    // to share a noun would qualify.
    if (onlyA.length && onlyB.length && onlyA.length <= 2 && onlyB.length <= 2) return 'value-conflict';
    return undefined;
}

export function isNegated(text: string): boolean {
    const tokens = String(text || '').toLowerCase().match(/[a-z']+/g) || [];
    return tokens.some(t => NEGATORS.includes(t));
}

/** Tokens that carry meaning: no stopwords, no negators (those are handled separately). */
function contentTokens(text: string): string[] {
    const stop = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'for',
        'and', 'or', 'this', 'that', 'it', 'we', 'you', 'should', 'must', 'always', 'use',
        'using', 'with', 'as', 'at', 'by', 'from', ...NEGATORS,
    ]);
    return [...new Set(
        (String(text || '').toLowerCase().match(/[a-z0-9_.-]+/g) || [])
            .filter(t => t.length > 1 && !stop.has(t)),
    )];
}

function jaccard(a: string[], b: string[]): number {
    if (!a.length || !b.length) return 0;
    const setB = new Set(b);
    const intersection = a.filter(t => setB.has(t)).length;
    return intersection / (a.length + b.length - intersection);
}

export interface WriteDecision {
    /** What to do. `ask` is the point of this milestone. */
    action: 'write' | 'ask' | 'skip';
    contradictions: Contradiction[];
    reason?: string;
}

/**
 * Decide whether an incoming fact may be written.
 *
 * **Never silently overwrites.** A contradiction returns `ask`, with both statements, so
 * the user resolves it. That is the milestone's whole requirement, and the reason it is a
 * requirement is that the alternative is invisible: an agent that overwrites "we use pnpm"
 * with "we use npm" because a stale README said so produces a store that is confidently
 * wrong, and nothing about the store's appearance distinguishes it from one that is right.
 */
export function decideWrite(incoming: string, entries: MemoryEntry[]): WriteDecision {
    const text = String(incoming || '').trim();
    if (!isWorthRemembering(text)) return { action: 'skip', contradictions: [], reason: 'not worth remembering' };

    const identical = (entries || []).find(e => normalizeForIdentity(e.text) === normalizeForIdentity(text));
    if (identical) return { action: 'skip', contradictions: [], reason: 'already known' };

    const contradictions = findContradictions(text, entries);
    if (contradictions.length) {
        return {
            action: 'ask',
            contradictions,
            reason: `This contradicts ${contradictions.length} existing ${contradictions.length === 1 ? 'memory' : 'memories'}.`,
        };
    }
    return { action: 'write', contradictions: [] };
}

/** Resolve a contradiction by superseding the old entry. Never deletes it. */
export function supersede(existing: MemoryEntry, incoming: string, at = Date.now()): MemoryEntry[] {
    const replacement = createMemory({
        text: incoming,
        type: existing.type,
        tier: existing.tier,
        confidence: Math.max(existing.confidence, 0.7),
        provenance: { origin: 'user', where: `supersedes ${existing.id}` },
        at,
    });
    return [
        { ...existing, status: 'archived', lastUsedAt: at },
        { ...replacement, supersedes: [existing.id] },
    ];
}

// ─── M43: decay ─────────────────────────────────────────────────────────────

export interface DecayOptions {
    now?: number;
    /** Unused for this long → demote. */
    demoteAfterMs?: number;
    /** Demoted and still unused for this long → archive. */
    archiveAfterMs?: number;
    /** Entries above this confidence never decay. */
    protectAbove?: number;
}

const DAY = 24 * 60 * 60_000;

/**
 * Age unused, low-confidence entries.
 *
 * **Never hard-deletes.** The markdown is a user file (ADR 007), so removing a line from it
 * is editing somebody's document; archiving keeps the line and marks it, which a human can
 * see, reverse, and diff. Two stages rather than one because a single stage makes the
 * threshold do two jobs — "stop injecting this" and "stop believing this" — and those
 * deserve different timescales.
 *
 * High-confidence entries are exempt entirely. A constraint the user stated once and has
 * not needed for three months is still a constraint; decaying it would delete exactly the
 * kind of fact this feature exists to preserve.
 */
export function applyDecay(entries: MemoryEntry[], options: DecayOptions = {}): MemoryEntry[] {
    const now = options.now ?? Date.now();
    const demoteAfter = options.demoteAfterMs ?? 30 * DAY;
    const archiveAfter = options.archiveAfterMs ?? 90 * DAY;
    const protectAbove = options.protectAbove ?? 0.8;

    return (entries || []).map(entry => {
        if (entry.status === 'archived') return entry;
        if (entry.confidence >= protectAbove) return entry;
        // Anything that has been used is evidence of its own value.
        if (entry.uses > 0 && entry.status === 'active') return entry;

        /*
         * The stage is a function of *elapsed time*, not of how many times this job ran.
         *
         * The first version advanced one stage per call, which made an entry idle for a
         * year "demoted" if the consolidation job had run once and "archived" if it had run
         * twice — so the store's contents depended on scheduling, and reopening a project
         * after a long gap gave a different answer from having left the editor open. Found
         * by the idempotency assertion, which is the same property that catches it.
         */
        const idle = now - entry.lastUsedAt;
        if (idle >= archiveAfter) return { ...entry, status: 'archived' as const };
        if (entry.status === 'active' && idle >= demoteAfter) {
            return { ...entry, status: 'demoted' as const, confidence: clamp01(entry.confidence * 0.8) };
        }
        return entry;
    });
}

// ─── M44: consolidation ─────────────────────────────────────────────────────

export interface ConsolidationResult {
    entries: MemoryEntry[];
    merged: number;
}

/**
 * Merge duplicate entries.
 *
 * **Idempotent**, which the gate asks for explicitly and which is not free: running this
 * twice must produce the identical array, so the merge cannot depend on iteration order and
 * the merged entry's fields must be chosen by rules that are stable under re-application
 * (max of confidences, sum of uses, earliest creation, latest use). A merge that took "the
 * first one's confidence" would produce a different answer depending on input order, and
 * the second run would differ from the first.
 *
 * Identity is `normalizeForIdentity`, not the id: entries written by a human by hand have
 * no id until they are parsed, and two hand-written lines differing only in a full stop are
 * exactly the duplicates this is for.
 */
export function consolidate(entries: MemoryEntry[]): ConsolidationResult {
    const byIdentity = new Map<string, MemoryEntry>();
    let merged = 0;

    for (const entry of entries || []) {
        const key = normalizeForIdentity(entry.text);
        const existing = byIdentity.get(key);
        if (!existing) {
            byIdentity.set(key, entry);
            continue;
        }
        merged++;
        byIdentity.set(key, mergeEntries(existing, entry));
    }

    return { entries: [...byIdentity.values()], merged };
}

/** Commutative and associative in every field, which is what makes consolidation stable. */
function mergeEntries(a: MemoryEntry, b: MemoryEntry): MemoryEntry {
    const keep = a.createdAt <= b.createdAt ? a : b;
    return {
        ...keep,
        id: memoryId(keep.text),
        confidence: Math.max(a.confidence, b.confidence),
        uses: a.uses + b.uses,
        createdAt: Math.min(a.createdAt, b.createdAt),
        lastUsedAt: Math.max(a.lastUsedAt, b.lastUsedAt),
        // The more definite status wins: an entry re-asserted after being demoted is active
        // again, and a merge must not resurrect something the user archived.
        status: a.status === 'archived' || b.status === 'archived'
            ? 'archived'
            : (a.status === 'active' || b.status === 'active' ? 'active' : 'demoted'),
        supersedes: dedupe([...(a.supersedes || []), ...(b.supersedes || [])]),
    };
}

function dedupe(values: string[]): string[] | undefined {
    const out = [...new Set(values)];
    return out.length ? out : undefined;
}

/** Entries no longer worth carrying in the prompt but still present in the file. */
export function archivedCount(entries: MemoryEntry[]): number {
    return (entries || []).filter(e => e.status === 'archived').length;
}
