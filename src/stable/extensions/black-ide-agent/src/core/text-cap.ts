// ─── Bounded append-only documents ───────────────────────────────────────────
// Several of this extension's durable markdown files are append-only and would grow
// without limit: the OpenSpec mindmap's Auto-Sync sections, the knowledge base's ADR
// log. They share one strategy — preserve the head and the NEWEST entries, drop the
// oldest droppable sections, and say so in the file — so that strategy lives here once
// rather than being re-derived per call site. Pure: no I/O, no vscode.

export interface CapSectionsOptions {
    /** Section delimiter. Sections are the segments that begin with this marker. */
    marker?: string;
    /** Notice appended after the head explaining the pruning. Counted inside the budget. */
    notice?: string;
    /**
     * Which sections may be dropped. Defaults to all of them. Callers that must retain
     * hand-authored content (e.g. the mindmap keeps agent-written sections and drops only
     * regenerable Auto-Sync ones) narrow this.
     */
    droppable?: (section: string) => boolean;
    /** Size measure. Defaults to UTF-8 byte length; pass `s => s.length` to budget in chars. */
    measure?: (s: string) => number;
}

/**
 * Trim `content` to fit `maxSize` by dropping its OLDEST droppable sections, preserving
 * the head (everything before the first section) and the newest sections.
 *
 * Returns `content` unchanged when it already fits, or when there is nothing droppable —
 * this never truncates mid-section, and never silently discards a head.
 */
export function capSections(content: string, maxSize: number, opts: CapSectionsOptions = {}): string {
    const marker = opts.marker ?? '\n\n## ';
    const notice = opts.notice ?? '\n\n> _Older entries were pruned to bound file size; full history is in git._\n';
    const droppable = opts.droppable ?? (() => true);
    const measure = opts.measure ?? ((s: string) => Buffer.byteLength(s, 'utf8'));

    if (measure(content) <= maxSize) return content;

    const firstIdx = content.indexOf(marker);
    if (firstIdx < 0) return content; // no sections to trim

    const head = content.slice(0, firstIdx);
    const sections = content.slice(firstIdx).split(marker).filter(Boolean).map(s => marker + s);

    // Measure the FINAL shape (head + notice + survivors) so the notice's own size is
    // inside the budget rather than pushing the result back over it.
    const totalSize = () => measure(head + notice + sections.join(''));
    while (totalSize() > maxSize) {
        const oldest = sections.findIndex(droppable);
        if (oldest < 0) break; // nothing left that is safe to drop
        sections.splice(oldest, 1);
    }
    return head + notice + sections.join('');
}

/**
 * Split a total budget across `n` claimants, then hand back the slack: claimants whose
 * actual size is under their equal share release the remainder to those over it. Without
 * this, a small architecture.md would waste its quarter of the context budget while the
 * decision log gets truncated alongside it.
 *
 * Returns a per-claimant allowance, in the same order as `sizes`.
 */
export function allocateBudget(sizes: number[], total: number): number[] {
    const out = new Array(sizes.length).fill(0);
    let remaining = total;
    let claimants = sizes.map((_, i) => i);

    // Repeatedly give every remaining claimant an equal share; those who need less than
    // their share are satisfied and their slack returns to the pool for the next round.
    while (claimants.length > 0) {
        const share = Math.floor(remaining / claimants.length);
        if (share <= 0) { for (const i of claimants) out[i] = 0; break; }
        const satisfied = claimants.filter(i => sizes[i] <= share);
        if (satisfied.length === 0) { for (const i of claimants) out[i] = share; break; }
        for (const i of satisfied) { out[i] = sizes[i]; remaining -= sizes[i]; }
        claimants = claimants.filter(i => sizes[i] > share);
    }
    return out;
}
