// ─── Memory v2: the typed entry (Phase 8, M41–M44) ──────────────────────────
//
// C6 has read 🔴 since rev 1: `remember` is model-invoked only, nothing extracts facts
// automatically, nothing ages them out, nothing detects contradictions. The store that
// exists (`memory/knowledge-store.ts`) holds text with a timestamp and a source label, and
// dedupes by SHA-256 — which catches byte-identical repeats and nothing else.
//
// This is the typed index that sits **beside** the markdown, not instead of it. ADR 007
// stands: the markdown is a user file, it is what a human reads and edits, and it is the
// thing that survives this extension being uninstalled. The index is derived, and
// `core/memory-markdown.ts` is required to round-trip it byte-for-byte — the one property
// that keeps "derived" from quietly becoming "authoritative".
//
// ── Two tiers, not three ─────────────────────────────────────────────────────
// OPIDE's Engram has a sensory tier. It buys nothing here: this agent's "sensory" input is
// a transcript that `ContextManager` already bounds, so a third tier would be a second name
// for the conversation. *working* (this session, evicted on compaction) → *project*
// (durable) is the distinction that actually changes behaviour.

export type MemoryTier = 'working' | 'project';

export type MemoryType =
    | 'preference'      // how the user wants things done
    | 'convention'      // how this codebase does things
    | 'fact'            // something true about the project
    | 'decision'        // a choice made, and why
    | 'constraint';     // something that must not change

export type MemoryStatus = 'active' | 'demoted' | 'archived';

export interface MemoryProvenance {
    /** The run or conversation this came from. */
    runId?: string;
    /** Free-text pointer to where it was said, for the "why do you believe this" question. */
    where?: string;
    /** How it entered the store — the difference between a claim and an instruction. */
    origin: 'user' | 'agent' | 'extracted' | 'imported';
}

export interface MemoryEntry {
    id: string;
    text: string;
    type: MemoryType;
    tier: MemoryTier;
    /** 0..1. Drives auto-write vs confirm, and decay. */
    confidence: number;
    provenance: MemoryProvenance;
    createdAt: number;
    lastUsedAt: number;
    uses: number;
    status: MemoryStatus;
    /** Ids this entry replaced, kept so a superseded fact is traceable rather than gone. */
    supersedes?: string[];
}

export const MEMORY_TYPES: readonly MemoryType[] = [
    'preference', 'convention', 'fact', 'decision', 'constraint',
];

/**
 * Confidence bands (M41).
 *
 * `high` auto-writes, `medium` queues for a one-click confirm, `low` is dropped. The
 * boundary that matters is the lower one: an extractor that writes everything it is
 * unsure about produces a store the user stops trusting, and an untrusted memory store is
 * worse than none — it costs context on every turn *and* gets ignored.
 */
export const CONFIDENCE = { auto: 0.8, confirm: 0.5 } as const;

export type ConfidenceBand = 'auto' | 'confirm' | 'drop';

export function bandFor(confidence: number): ConfidenceBand {
    if (!Number.isFinite(confidence)) return 'drop';
    if (confidence >= CONFIDENCE.auto) return 'auto';
    if (confidence >= CONFIDENCE.confirm) return 'confirm';
    return 'drop';
}

/**
 * A stable id derived from the text.
 *
 * Content-addressed on the *normalised* text, so re-extracting the same fact in a later
 * session lands on the same id and updates one entry rather than accumulating five near
 * copies. That is the deduplication the SHA-256 store could not do: it hashed raw content,
 * so "Use pnpm, not npm." and "Use pnpm, not npm" were two different memories.
 */
export function memoryId(text: string): string {
    const normalized = normalizeForIdentity(text);
    let hash = 0x811c9dc5;
    for (let i = 0; i < normalized.length; i++) {
        hash ^= normalized.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `m_${hash.toString(36).padStart(7, '0')}`;
}

/**
 * The comparison form: lowercase, collapsed whitespace, no terminal punctuation.
 *
 * Deliberately *not* stemmed. Stemming would merge "the cache is invalidated on write" with
 * "the cache invalidates writes", which are different claims — and Phase 3 already recorded
 * what happens when a stemmer disagrees with itself (`reserve`/`reserved`). This is used for
 * identity, where a false merge silently destroys a memory.
 */
export function normalizeForIdentity(text: string): string {
    return String(text || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[.!?;,]+$/g, '')
        .trim();
}

export interface NewMemory {
    text: string;
    type?: MemoryType;
    tier?: MemoryTier;
    confidence?: number;
    provenance?: Partial<MemoryProvenance>;
    at?: number;
}

/** Build an entry, with the defaults a caller should not have to think about. */
export function createMemory(input: NewMemory): MemoryEntry {
    const at = input.at ?? Date.now();
    const text = String(input.text || '').trim();
    return {
        id: memoryId(text),
        text,
        type: input.type || 'fact',
        tier: input.tier || 'project',
        confidence: clamp01(input.confidence ?? 0.6),
        provenance: { origin: 'agent', ...input.provenance },
        createdAt: at,
        lastUsedAt: at,
        uses: 0,
        status: 'active',
    };
}

/** Record that an entry was used, which is what keeps it out of decay. */
export function touch(entry: MemoryEntry, at = Date.now()): MemoryEntry {
    return { ...entry, lastUsedAt: at, uses: entry.uses + 1 };
}

export function clamp01(value: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
}

/**
 * Entries eligible to be injected into a prompt.
 *
 * `working` entries are included — they are this session's context — but archived ones
 * never are. A demoted entry is still included at lower priority: demotion means "we are
 * less sure", not "forget it", and dropping it outright would make decay a silent deleter
 * of things the markdown still shows.
 */
export function injectable(entries: MemoryEntry[]): MemoryEntry[] {
    return (entries || [])
        .filter(e => e.status !== 'archived')
        .sort((a, b) => rank(b) - rank(a));
}

/**
 * Injection priority: confidence, weighted by use and recency of use.
 *
 * Uses count more than age because a fact retrieved eleven times has been *validated
 * eleven times*, whereas one written yesterday and never read has only been asserted once.
 */
function rank(entry: MemoryEntry): number {
    const usage = Math.min(1, entry.uses / 5);
    const demoted = entry.status === 'demoted' ? 0.5 : 1;
    return (entry.confidence * 0.6 + usage * 0.4) * demoted;
}

/** A compact rendering for the prompt's memory section. */
export function renderForPrompt(entries: MemoryEntry[], maxChars = 2_000): string {
    const lines: string[] = [];
    let used = 0;
    for (const entry of injectable(entries)) {
        const line = `- (${entry.type}) ${entry.text}`;
        if (used + line.length > maxChars) break;
        lines.push(line);
        used += line.length + 1;
    }
    return lines.join('\n');
}
