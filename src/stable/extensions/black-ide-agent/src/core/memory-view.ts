import { ExtractionCandidate } from './memory-lifecycle';
import { MemoryEntry, MemoryStatus, MemoryType, bandFor } from './memory-model';

// ─── The memory panel's decision layer (Phase 8, M45 · P8-2) ───────────────
//
// "Entries, confidence, provenance and status are browsable; the data all exists
// already." The data does — and until now nothing read it, which is why the panel is
// worth more than the sentence suggests: this is the first surface on which a user can
// see what the agent believes about their project.
//
// Pure, for the reason every panel's decision layer in this codebase is pure: the
// interesting parts are ordering and what a row is allowed to claim, and neither needs a
// webview to test.
//
// ── The ordering question, and why "newest first" is the wrong answer ───────
// A memory store is not a feed. The question a user opens this panel with is almost
// never "what was learned most recently" — it is "what does it think it knows", and
// second "is any of that wrong". So rows are grouped by **status** and ordered within a
// group by confidence: what is actively shaping answers comes first, what has decayed
// comes last, and the entry most likely to be doing damage if it is wrong is at the top
// where somebody will read it.

export interface MemoryRow {
    id: string;
    text: string;
    type: MemoryType;
    status: MemoryStatus;
    /** 0–100, for a bar the user can read at a glance. */
    confidencePct: number;
    /** Which band this confidence falls in — the same one that decided its fate. */
    band: 'auto' | 'confirm' | 'drop';
    /** Where it came from, in one phrase. */
    origin: string;
    provenance?: string;
    createdAt: number;
    lastUsedAt: number;
    uses: number;
    /** True when this entry is currently eligible for injection into a prompt. */
    injected: boolean;
    /** Ids this entry replaced. Rendered as "supersedes 2 earlier facts". */
    supersedes: number;
}

export interface PendingRow {
    text: string;
    type: MemoryType;
    confidencePct: number;
    because?: string;
}

export interface MemoryView {
    /** Everything, ordered for reading. */
    rows: MemoryRow[];
    /** Candidates awaiting a one-click confirm. */
    pending: PendingRow[];
    counts: {
        total: number;
        active: number;
        demoted: number;
        archived: number;
        pending: number;
        byType: Record<string, number>;
    };
    /** Absolute path of the markdown file, so the panel can offer to open it. */
    filePath?: string;
    /** Set when there is nothing to show, explaining which nothing it is. */
    empty?: string;
}

const STATUS_ORDER: Record<MemoryStatus, number> = { active: 0, demoted: 1, archived: 2 };

export interface MemoryViewOptions {
    status?: MemoryStatus;
    type?: MemoryType;
    /** Free-text filter over the entry text. */
    query?: string;
    filePath?: string;
}

export function buildMemoryView(
    entries: MemoryEntry[],
    pending: ExtractionCandidate[] = [],
    options: MemoryViewOptions = {},
): MemoryView {
    const all = entries || [];
    const query = (options.query || '').trim().toLowerCase();

    const filtered = all.filter(entry => {
        if (options.status && entry.status !== options.status) return false;
        if (options.type && entry.type !== options.type) return false;
        if (query && !entry.text.toLowerCase().includes(query)) return false;
        return true;
    });

    const rows = filtered.map(toRow).sort((a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
        || b.confidencePct - a.confidencePct
        // Deterministic tail-break, so re-rendering does not reshuffle equal rows under
        // the reader's cursor.
        || a.text.localeCompare(b.text));

    const byType: Record<string, number> = {};
    for (const entry of all) byType[entry.type] = (byType[entry.type] || 0) + 1;

    const view: MemoryView = {
        rows,
        pending: pending.map(candidate => ({
            text: candidate.text,
            type: candidate.type,
            confidencePct: Math.round(candidate.confidence * 100),
            because: candidate.because,
        })),
        counts: {
            total: all.length,
            active: all.filter(e => e.status === 'active').length,
            demoted: all.filter(e => e.status === 'demoted').length,
            archived: all.filter(e => e.status === 'archived').length,
            pending: pending.length,
            byType,
        },
        filePath: options.filePath,
    };

    // Two different nothings, said differently. "No memories yet" and "nothing matches
    // your filter" lead to opposite next actions, and a panel that renders the same
    // empty state for both sends half its readers the wrong way.
    if (!all.length && !pending.length) {
        view.empty = 'Nothing is remembered about this project yet. Facts are extracted at the '
            + 'end of a turn, and anything you state plainly is the most likely thing to be kept.';
    } else if (!rows.length && !pending.length) {
        view.empty = 'No memories match this filter.';
    }
    return view;
}

function toRow(entry: MemoryEntry): MemoryRow {
    return {
        id: entry.id,
        text: entry.text,
        type: entry.type,
        status: entry.status,
        confidencePct: Math.round(entry.confidence * 100),
        band: bandFor(entry.confidence),
        origin: describeOrigin(entry),
        provenance: entry.provenance?.where,
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt,
        uses: entry.uses,
        // The same predicate `MemoryStore.forPrompt` uses, restated here rather than
        // imported from the store: a panel that says "this is in your prompts" while the
        // store disagrees is worse than one that says nothing.
        injected: entry.status === 'active',
        supersedes: entry.supersedes?.length || 0,
    };
}

/**
 * Where an entry came from, phrased for the question the panel is really answering.
 *
 * "Why do you believe this?" is the second thing a user asks after reading a wrong
 * memory, and `origin` alone does not answer it — `extracted` and `user` are the
 * difference between the agent inferring something and the user having said it, which
 * decides whether the fix is to correct the memory or to correct the extractor.
 */
export function describeOrigin(entry: MemoryEntry): string {
    switch (entry.provenance?.origin) {
        case 'user': return 'you stated this';
        case 'agent': return 'the agent recorded this';
        case 'extracted': return 'extracted from a conversation';
        case 'imported': return 'imported';
        default: return 'unknown';
    }
}

/** Human-readable age, for a column where an exact timestamp is noise. */
export function describeAge(at: number, now = Date.now()): string {
    const ms = Math.max(0, now - at);
    const days = Math.floor(ms / 86_400_000);
    if (days >= 365) return `${Math.floor(days / 365)}y ago`;
    if (days >= 30) return `${Math.floor(days / 30)}mo ago`;
    if (days >= 1) return `${days}d ago`;
    const hours = Math.floor(ms / 3_600_000);
    if (hours >= 1) return `${hours}h ago`;
    const minutes = Math.floor(ms / 60_000);
    return minutes >= 1 ? `${minutes}m ago` : 'just now';
}

/**
 * What the panel says about an entry's decay position.
 *
 * Stated as *what will happen and when* rather than as a status word, because "demoted"
 * is a word this codebase invented and the user has no reason to know it. A row that
 * says "unused for 34 days — will be archived in 56" is one somebody can act on.
 */
export function describeDecay(
    entry: MemoryEntry,
    options: { now?: number; demoteAfterMs?: number; archiveAfterMs?: number; protectAbove?: number } = {},
): string {
    const now = options.now ?? Date.now();
    const demoteAfter = options.demoteAfterMs ?? 30 * 86_400_000;
    const archiveAfter = options.archiveAfterMs ?? 90 * 86_400_000;
    const protectAbove = options.protectAbove ?? 0.8;

    if (entry.status === 'archived') return 'Archived. Still in the file, not injected into prompts.';
    if (entry.confidence >= protectAbove) return 'High confidence — never decays.';
    if (entry.uses > 0 && entry.status === 'active') return `Used ${entry.uses} time(s) — will not decay while it is being used.`;

    const idleDays = Math.floor((now - entry.lastUsedAt) / 86_400_000);
    const untilArchive = Math.ceil((archiveAfter - (now - entry.lastUsedAt)) / 86_400_000);
    if (entry.status === 'demoted') {
        return `Unused for ${idleDays} days — will be archived in ${Math.max(0, untilArchive)}.`;
    }
    const untilDemote = Math.ceil((demoteAfter - (now - entry.lastUsedAt)) / 86_400_000);
    return `Unused for ${idleDays} days — will be demoted in ${Math.max(0, untilDemote)}.`;
}
