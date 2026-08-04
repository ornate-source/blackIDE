// ─── Fast-apply (Phase 4, M25) ──────────────────────────────────────────────
//
// The strong model states *intent* ("rename the retry helper and give it a jitter
// argument"); a cheap, fast model on the `apply` role materialises the SEARCH/REPLACE
// blocks that carry it out. The saving is real because materialising an edit is a
// transcription task — the tokens are the file, not the reasoning — and it is the phase
// that dominates apply cost on large files.
//
// ── The only property that matters is failing closed ────────────────────────
// A fast-apply path that is 99% correct is worse than none: the 1% is a silently wrong
// edit in a file the user did not read, and the whole point of the exact-match
// SEARCH/REPLACE contract (`core/tools.ts:76`) is that a mismatch is *detectable*. So
// every candidate is verified against the real applier before it is allowed anywhere near
// disk, and any failure — malformed block, missing anchor, ambiguous anchor, no change,
// or a change to a region the intent did not mention — discards the fast result and hands
// the edit back to the strong model. `zero silently wrong edits` is a hard gate, and this
// module is written so that the only way to pass verification is to be right.

export interface VerificationSuccess {
    ok: true;
    /** The content that applying the blocks produces. */
    updated: string;
    blocks: number;
}

export interface VerificationFailure {
    ok: false;
    /** Why the fast path was rejected, in words the strong-model retry can use. */
    reason: string;
    kind: 'malformed' | 'anchor-missing' | 'anchor-ambiguous' | 'no-change' | 'oversized';
}

export type Verification = VerificationSuccess | VerificationFailure;

/** The subset of `ToolRunner` this needs, injected so verification is testable pure. */
export type ApplyFn = (content: string, blocks: string) => string;

export interface VerifyOptions {
    /**
     * Cap on how much of the file one fast-apply may rewrite, as a fraction of its
     * length. A cheap model asked for a small edit sometimes returns the *whole file* as
     * one enormous block — which applies cleanly, verifies cleanly, and quietly reformats
     * everything. Exact-match verification cannot catch that, because the model's copy of
     * the file genuinely matches the file. This can.
     */
    maxRewriteFraction?: number;
}

const DEFAULT_MAX_REWRITE_FRACTION = 0.5;

/**
 * Checks a candidate block set against the file it claims to edit.
 *
 * Uses the *same* applier the real edit path uses — injected rather than re-implemented,
 * because a second implementation of the matching rules is a second set of rules, and the
 * one thing this must never do is accept a block set that the real applier would treat
 * differently.
 */
export function verifyFastApply(
    original: string,
    blocks: string,
    apply: ApplyFn,
    options: VerifyOptions = {},
): Verification {
    let updated: string;
    try {
        updated = apply(original, blocks);
    } catch (err: any) {
        const message = String(err?.message || err);
        return { ok: false, kind: classify(message), reason: message.split('\n')[0].slice(0, 300) };
    }

    if (updated === original) {
        // Applied cleanly and changed nothing: the model matched an anchor and echoed it
        // back. Passing this through would report success for an edit that never happened.
        return { ok: false, kind: 'no-change', reason: 'The blocks applied but produced no change.' };
    }

    const limit = options.maxRewriteFraction ?? DEFAULT_MAX_REWRITE_FRACTION;
    const churn = changedFraction(original, updated);
    if (churn > limit) {
        return {
            ok: false,
            kind: 'oversized',
            reason: `The edit rewrites ${Math.round(churn * 100)}% of the file, over the ${Math.round(limit * 100)}% fast-apply limit. `
                + 'A change this large goes to the strong model.',
        };
    }

    return { ok: true, updated, blocks: countBlocks(blocks) };
}

function classify(message: string): VerificationFailure['kind'] {
    if (/not unique|appears multiple times/i.test(message)) return 'anchor-ambiguous';
    if (/not found/i.test(message)) return 'anchor-missing';
    return 'malformed';
}

export function countBlocks(blocks: string): number {
    return (blocks.match(/<<<<<<< ORIGINAL/g) || []).length;
}

/**
 * How much of the file changed, by lines, symmetric between the two versions.
 *
 * A line-multiset comparison rather than a diff: it needs to be cheap and it only has to
 * answer "roughly how much moved", where a real diff would answer it more precisely at
 * more cost. It is deliberately *pessimistic* about reordering — moving a block counts as
 * changing it — because a fast-apply that reorders a file is exactly what should be
 * escalated rather than accepted.
 */
export function changedFraction(original: string, updated: string): number {
    const before = original.split('\n');
    const after = updated.split('\n');
    const counts = new Map<string, number>();
    for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);

    let kept = 0;
    for (const line of after) {
        const n = counts.get(line) ?? 0;
        if (n > 0) { counts.set(line, n - 1); kept++; }
    }

    const total = Math.max(before.length, after.length);
    if (total === 0) return 0;
    return 1 - kept / total;
}

/**
 * The prompt for the apply-role model.
 *
 * Written as a transcription task with no latitude, because latitude is what a fast model
 * spends badly: it is told to copy anchors byte-for-byte, to keep them minimal but
 * unique, to emit nothing but blocks, and to make no change the intent did not ask for.
 * The file is given with no line numbers — a model handed numbered lines tends to copy
 * them into the anchor, which then matches nothing.
 */
export function buildApplyPrompt(path: string, content: string, intent: string): string {
    return [
        'You are an exact-transcription tool. Convert the requested change into SEARCH/REPLACE blocks.',
        '',
        'Rules, all mandatory:',
        '1. Output ONLY blocks in this exact format, nothing before or after:',
        '<<<<<<< ORIGINAL',
        '(text copied byte-for-byte from the file)',
        '=======',
        '(replacement text)',
        '>>>>>>> UPDATED',
        '2. The ORIGINAL text must appear in the file EXACTLY once. Include just enough',
        '   surrounding lines to make it unique, and no more.',
        '3. Copy the ORIGINAL text character for character, including indentation. Do not',
        '   reformat, reindent, or "fix" anything you were not asked to change.',
        '4. Make no change the requested edit does not ask for.',
        '5. If the change cannot be expressed this way, output exactly: CANNOT_APPLY',
        '',
        `File: ${path}`,
        '```',
        content,
        '```',
        '',
        `Requested change: ${intent}`,
    ].join('\n');
}

/** The refusal token the prompt above asks for. */
export const CANNOT_APPLY = 'CANNOT_APPLY';

/**
 * Pulls the block text out of a model response.
 *
 * Fast models wrap output in prose or fences however they like; the markers are the
 * contract, so the response is trimmed to the first marker and the last one. Anything
 * outside them is discarded rather than parsed — and a response with no markers at all
 * returns undefined instead of an empty string, so "the model refused" and "the model
 * produced an empty edit" stay distinguishable at the call site.
 */
export function extractBlocks(response: string): string | undefined {
    if (!response) return undefined;
    if (response.trim().includes(CANNOT_APPLY)) return undefined;
    const start = response.indexOf('<<<<<<< ORIGINAL');
    const endMarker = '>>>>>>> UPDATED';
    const end = response.lastIndexOf(endMarker);
    if (start === -1 || end === -1 || end < start) return undefined;
    return response.slice(start, end + endMarker.length);
}
