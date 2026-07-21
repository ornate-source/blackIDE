// ─── Line Diff & Patch ──────────────────────────────────────────────────────
// Checkpoints store patches, not file copies. A patch can be reversed against the
// file's CURRENT content, so a task's edit can be undone even after a later task
// touched the same file — a whole-file snapshot would silently clobber that later
// work. When the surrounding lines have moved too far to match, we report a
// conflict rather than guess.

export interface Hunk {
    /** 0-based line index in the content the hunk applies to. */
    start: number;
    remove: string[];
    add: string[];
}

export interface PatchResult {
    ok: boolean;
    content: string;
    conflicts: number;
}

/** LCS is O(n·m); past this we stop trying to be clever and rewrite the region wholesale. */
const LCS_CELL_LIMIT = 4_000_000;
/** How far a hunk may drift before we call it a conflict instead of a match. */
const SEARCH_RADIUS = 200;

function splitLines(s: string): string[] {
    return s.length === 0 ? [] : s.split('\n');
}

function joinLines(lines: string[]): string {
    return lines.join('\n');
}

/** Line-level diff from `before` to `after`. */
export function diffLines(before: string, after: string): Hunk[] {
    const a = splitLines(before);
    const b = splitLines(after);

    // Shave the identical head and tail; real edits are almost always local.
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (
        tail < a.length - head &&
        tail < b.length - head &&
        a[a.length - 1 - tail] === b[b.length - 1 - tail]
    ) tail++;

    const aMid = a.slice(head, a.length - tail);
    const bMid = b.slice(head, b.length - tail);

    if (aMid.length === 0 && bMid.length === 0) return [];

    if (aMid.length * bMid.length > LCS_CELL_LIMIT) {
        return [{ start: head, remove: aMid, add: bMid }];
    }

    return lcsHunks(aMid, bMid, head);
}

/** Classic LCS table walked back into remove/add runs. */
function lcsHunks(a: string[], b: string[], offset: number): Hunk[] {
    const n = a.length, m = b.length;
    const table: Uint32Array = new Uint32Array((n + 1) * (m + 1));
    const at = (i: number, j: number) => i * (m + 1) + j;

    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[at(i, j)] = a[i] === b[j]
                ? table[at(i + 1, j + 1)] + 1
                : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
        }
    }

    const hunks: Hunk[] = [];
    let i = 0, j = 0;
    let remove: string[] = [], add: string[] = [], start = offset;

    const flush = () => {
        if (remove.length || add.length) hunks.push({ start, remove, add });
        remove = []; add = [];
    };

    while (i < n && j < m) {
        if (a[i] === b[j]) {
            flush();
            i++; j++;
            start = offset + i;
        } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
            if (!remove.length && !add.length) start = offset + i;
            remove.push(a[i++]);
        } else {
            if (!remove.length && !add.length) start = offset + i;
            add.push(b[j++]);
        }
    }
    if (i < n || j < m) {
        if (!remove.length && !add.length) start = offset + i;
        while (i < n) remove.push(a[i++]);
        while (j < m) add.push(b[j++]);
    }
    flush();

    return hunks;
}

/**
 * Apply hunks to content. Each hunk is located by matching its `remove` lines —
 * first at its recorded position, then within SEARCH_RADIUS lines either side, so a
 * patch still lands after unrelated edits shifted the file. Unmatched hunks are
 * skipped and counted; the caller decides what a partial apply means.
 */
export function applyHunks(content: string, hunks: Hunk[]): PatchResult {
    const lines = splitLines(content);
    let conflicts = 0;
    let drift = 0; // net lines added/removed by hunks applied so far

    for (const hunk of hunks) {
        const at = locate(lines, hunk, hunk.start + drift);
        if (at < 0) { conflicts++; continue; }
        lines.splice(at, hunk.remove.length, ...hunk.add);
        drift += hunk.add.length - hunk.remove.length;
    }

    return { ok: conflicts === 0, content: joinLines(lines), conflicts };
}

/** Find where a hunk's `remove` block actually sits, searching outward from `expected`. */
function locate(lines: string[], hunk: Hunk, expected: number): number {
    const matches = (at: number) => {
        if (at < 0 || at + hunk.remove.length > lines.length) return false;
        for (let k = 0; k < hunk.remove.length; k++) {
            if (lines[at + k] !== hunk.remove[k]) return false;
        }
        return true;
    };

    // A pure insertion has nothing to match on, so trust the recorded position.
    if (hunk.remove.length === 0) {
        return expected >= 0 && expected <= lines.length ? expected : -1;
    }

    if (matches(expected)) return expected;
    for (let d = 1; d <= SEARCH_RADIUS; d++) {
        if (matches(expected - d)) return expected - d;
        if (matches(expected + d)) return expected + d;
    }
    return -1;
}
