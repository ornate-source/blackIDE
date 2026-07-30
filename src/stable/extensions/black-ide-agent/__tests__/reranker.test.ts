import { describe, expect, it } from 'vitest';
import {
    DEFAULT_RERANK_WEIGHTS,
    LexicalReranker,
    RERANK_DEPTH,
    RerankCandidate,
    proximityScore,
} from '../src/core/reranker';

/**
 * Phase 3, M17.
 *
 * The reranker is a *refinement* pass, and the way it fails is by being too
 * confident: given free rein it discards a well-founded first-stage ranking on the
 * strength of one narrow signal, which measured as an 8-point recall@5 loss. Most of
 * these assertions therefore pin how much it is allowed to move things, not just
 * that it moves them in the right direction.
 */

function candidate(over: Partial<RerankCandidate> & { rank: number }): RerankCandidate {
    return { file: 'src/a.ts', startLine: 1, text: '', ...over };
}

describe('LexicalReranker', () => {
    const reranker = new LexicalReranker();

    it('prefers a chunk covering more distinct query terms', async () => {
        const ordered = await reranker.rerank('cancel an order and issue a refund', [
            candidate({ rank: 1, file: 'src/noise.ts', text: 'order order order order order order' }),
            candidate({ rank: 2, file: 'src/right.ts', text: 'cancel the order and issue a refund to the customer' }),
        ]);
        expect(ordered[0].file).toBe('src/right.ts');
    });

    it('breaks a tie in favour of the chunk whose symbol name matches', async () => {
        // Symbol match is a tiebreaker, not an override. Both bodies are equally
        // uninformative here, so the definition wins despite the worse prior.
        const ordered = await reranker.rerank('convert the currency', [
            candidate({ rank: 1, file: 'src/caller.ts', text: 'return amount * rate;' }),
            candidate({ rank: 2, file: 'src/currency.ts', text: 'return amount * rate;', symbol: 'convertCurrency' }),
        ]);
        expect(ordered[0].file).toBe('src/currency.ts');
    });

    it('still prefers a body that actually covers the query over a name-only match', async () => {
        // The inverse, asserted because it is the behaviour the weight sweep chose
        // and it is easy to "fix" into a regression: a chunk discussing both query
        // terms is a real answer, while a matching identifier over an opaque body is
        // weaker evidence.
        const ordered = await reranker.rerank('convert the currency', [
            candidate({ rank: 1, file: 'src/caller.ts', text: 'we convert the currency here, in full' }),
            candidate({ rank: 2, file: 'src/currency.ts', text: 'return amount * rate;', symbol: 'convertCurrency' }),
        ]);
        expect(ordered[0].file).toBe('src/caller.ts');
    });

    it('keeps a strong first-stage result on top when signals are equal', async () => {
        const text = 'cancel the order and issue a refund';
        const ordered = await reranker.rerank('cancel an order and issue a refund', [
            candidate({ rank: 1, file: 'src/first.ts', text }),
            candidate({ rank: 2, file: 'src/second.ts', text }),
        ]);
        expect(ordered[0].file).toBe('src/first.ts');
    });

    it('does not let a deep candidate leapfrog the head on one signal alone', async () => {
        // The regression that cost 8 points of recall@5: a rank-40 chunk with full
        // term coverage overtaking a rank-1 chunk with most of it.
        const ordered = await reranker.rerank('cancel an order and issue a refund', [
            candidate({ rank: 1, file: 'src/head.ts', text: 'cancel the order and issue money back' }),
            candidate({ rank: 40, file: 'src/deep.ts', text: 'cancel an order and issue a refund' }),
        ]);
        expect(ordered[0].file).toBe('src/head.ts');
    });

    it('returns every candidate it was given', async () => {
        const input = [1, 2, 3, 4, 5].map(rank => candidate({ rank, file: `src/f${rank}.ts`, text: 'order' }));
        const ordered = await reranker.rerank('order', input);
        expect(ordered.map(o => o.file).sort()).toEqual(input.map(i => i.file).sort());
    });

    it('is stable for an empty candidate list', async () => {
        expect(await reranker.rerank('anything', [])).toEqual([]);
    });

    it('falls back to first-stage order for a query with no usable terms', async () => {
        const input = [1, 2, 3].map(rank => candidate({ rank, file: `src/f${rank}.ts`, text: 'body' }));
        const ordered = await reranker.rerank('a the of', input);
        expect(ordered.map(o => o.file)).toEqual(['src/f1.ts', 'src/f2.ts', 'src/f3.ts']);
    });

    it('matches an inflected query word against a base-form identifier', async () => {
        const ordered = await reranker.rerank('reserving stock', [
            candidate({ rank: 1, file: 'src/other.ts', text: 'unrelated body text' }),
            candidate({ rank: 2, file: 'src/inv.ts', text: 'holds units', symbol: 'reserveStock' }),
        ]);
        expect(ordered[0].file).toBe('src/inv.ts');
    });

    it('honours injected weights', async () => {
        const symbolBlind = new LexicalReranker({ ...DEFAULT_RERANK_WEIGHTS, symbol: 0, coverage: 0 });
        const ordered = await symbolBlind.rerank('convert the currency', [
            candidate({ rank: 1, file: 'src/caller.ts', text: 'nothing relevant' }),
            candidate({ rank: 2, file: 'src/currency.ts', text: 'x', symbol: 'convertCurrency' }),
        ]);
        // With both discriminating signals off, only the prior remains.
        expect(ordered[0].file).toBe('src/caller.ts');
    });
});

describe('tuned defaults', () => {
    it('keeps the prior dominant over any single new signal', () => {
        const { prior, coverage, proximity, symbol, path } = DEFAULT_RERANK_WEIGHTS;
        expect(prior).toBeGreaterThan(coverage + proximity + symbol + path);
    });

    it('leaves the signals that measured harmful at zero', () => {
        // Documented in the weights' doc comment: `path` at 0.4 cost 4 points of
        // recall@5 on the eval corpus. A future change that switches it back on
        // should have to re-run the sweep and update this test deliberately.
        expect(DEFAULT_RERANK_WEIGHTS.path).toBe(0);
        expect(DEFAULT_RERANK_WEIGHTS.proximity).toBe(0);
    });

    it('reranks only a shallow head of the fused list', () => {
        // Reranking 50 deep measured worse than 20 at every weight set tried:
        // recall@20 fell 100% → 97.2% for no gain at the head.
        expect(RERANK_DEPTH).toBeLessThanOrEqual(20);
    });
});

describe('proximityScore', () => {
    it('is zero when fewer than two distinct terms match', () => {
        expect(proximityScore(['a', 'b', 'c'], new Set(['a']))).toBe(0);
        expect(proximityScore(['a', 'b', 'c'], new Set())).toBe(0);
    });

    it('scores a tight cluster above a scattered one', () => {
        const terms = new Set(['cancel', 'refund']);
        const tight = ['x', 'cancel', 'refund', 'y', 'z'];
        const scattered = ['cancel', ...Array(30).fill('x'), 'refund'];
        expect(proximityScore(tight, terms)).toBeGreaterThan(proximityScore(scattered, terms));
    });

    it('is bounded to [0, 1]', () => {
        const terms = new Set(['a', 'b']);
        for (const tokens of [['a', 'b'], ['a', 'x', 'b'], ['a', ...Array(99).fill('x'), 'b']]) {
            const score = proximityScore(tokens, terms);
            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(1);
        }
    });

    it('handles repeated occurrences without breaking the window scan', () => {
        expect(proximityScore(['a', 'a', 'a', 'b'], new Set(['a', 'b']))).toBeGreaterThan(0);
    });
});
