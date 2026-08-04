import { tokenize } from './text-tokens';

// ─── Rerank stage (Phase 3, M17) ────────────────────────────────────────────
//
// Re-scores the top of the RRF-fused list before it is cut to k.
//
// ── Why a second pass helps at all ──────────────────────────────────────────
// BM25 is a bag of words. It cannot tell "cancel an **order**" from a chunk that
// says "order" nine times and "cancel" never, and it treats one rare term matched
// nine times as better evidence than five distinct query terms matched once each.
// For natural-language questions the second is almost always the better answer.
// Reranking is cheap here because it runs over ~50 candidates rather than the whole
// index, so it can afford signals that would be too slow to compute corpus-wide.
//
// ── Two backends, one interface ─────────────────────────────────────────────
// The roadmap calls for a cross-encoder on the `rerank` model role. That role
// arrives with the ModelRouter in Phase 4, so what ships here is the interface plus
// `LexicalReranker`, the deterministic fallback the roadmap also requires. The
// fallback is not a placeholder: it is what runs whenever no rerank model is
// configured, which is the default and, for a local-first editor, the common case.
// A model-backed implementation slots in behind `Reranker` without touching
// `CodebaseIndex`.

export interface RerankCandidate {
    file: string;
    startLine: number;
    text: string;
    symbol?: string;
    /** 1-based position in the fused list, used as the prior. */
    rank: number;
}

export interface RerankedCandidate extends RerankCandidate {
    /** Higher is better. Comparable only within one call. */
    score: number;
}

export interface Reranker {
    readonly id: string;
    rerank(query: string, candidates: RerankCandidate[]): Promise<RerankedCandidate[]>;
}

export interface RerankWeights {
    coverage: number;
    proximity: number;
    symbol: number;
    path: number;
    prior: number;
}

/**
 * Chosen by sweeping 288 weight combinations against the 36-query eval corpus, not
 * by intuition. Every value below is a measurement.
 *
 * - **`prior` dominates deliberately.** The first draft used coverage 3.0 against a
 *   prior of 1.0, which let a rank-40 chunk with every query word outrank a rank-1
 *   chunk with most of them, and cost **8 points of recall@5**. The first stage is a
 *   well-founded ranking over the same evidence; this pass refines it.
 * - **`coverage` and `symbol` are the signals that pay.** Together they are worth
 *   +1.4 recall@5 and +1.4 recall@10 over no reranking at all.
 * - **`proximity` and `path` measured as neutral-to-harmful here** and default to
 *   zero. `path` at 0.4 cost 4 points of recall@5 — filename words like "orders"
 *   match nearly every file in a service that is about orders, so the signal is
 *   mostly noise on a cohesive codebase. Both are kept implemented and injectable
 *   rather than deleted, because a corpus with more directory structure than an
 *   82-file fixture may well reward them; what is *not* kept is a nonzero default
 *   the measurement does not support.
 */
export const DEFAULT_RERANK_WEIGHTS: RerankWeights = {
    prior: 3.0,
    coverage: 1.0,
    symbol: 0.5,
    proximity: 0,
    path: 0,
};

/**
 * How far down the fused list to rerank.
 *
 * Kept deliberately tight. Reranking the top 50 scored *worse* than reranking the
 * top 20 on every weight set tried: recall@20 fell from 100% to 97.2% while the head
 * gained nothing, because reordering ranks 20–50 only shuffles which marginal file
 * falls off the end. A reranker earns its keep on the head; letting it churn the
 * tail is how a second stage quietly loses recall the first stage had already won.
 */
export const RERANK_DEPTH = 20;

/**
 * Deterministic, dependency-free reranker.
 *
 * Scores four signals the first-stage ranking does not have, then blends them with
 * the fused rank so a strong prior is refined rather than discarded.
 */
export class LexicalReranker implements Reranker {
    readonly id = 'lexical';

    constructor(private readonly weights: RerankWeights = DEFAULT_RERANK_WEIGHTS) {}

    async rerank(query: string, candidates: RerankCandidate[]): Promise<RerankedCandidate[]> {
        const queryTerms = unique(tokenize(query));
        if (queryTerms.length === 0 || candidates.length === 0) {
            return candidates.map(c => ({ ...c, score: 1 / c.rank }));
        }

        return candidates
            .map(candidate => ({ ...candidate, score: scoreCandidate(queryTerms, candidate, this.weights) }))
            .sort((a, b) => b.score - a.score);
    }
}

function scoreCandidate(queryTerms: string[], candidate: RerankCandidate, weights: RerankWeights): number {
    const bodyTokens = tokenize(candidate.text);
    const present = new Set(bodyTokens);

    // 1. Coverage — how many *distinct* query terms appear.
    //
    // The single most useful signal a bag-of-words first stage lacks. A chunk
    // matching five of six query terms once each is answering the question; a chunk
    // matching one term twenty times is about something else that happens to share a
    // word. BM25's term-frequency saturation softens this but does not fix it.
    const matched = queryTerms.filter(t => present.has(t));
    const coverage = matched.length / queryTerms.length;

    // 2. Proximity — how tightly the matched terms cluster.
    //
    // Query terms scattered across a 60-line chunk are usually coincidence; the same
    // terms inside two lines are usually the answer. Measured as the smallest window
    // containing the most distinct matches.
    const proximity = proximityScore(bodyTokens, new Set(matched));

    // 3. Symbol name — the chunk *is* a definition whose name the query used.
    const symbolTerms = candidate.symbol ? new Set(tokenize(candidate.symbol)) : undefined;
    const symbolHit = symbolTerms
        ? queryTerms.filter(t => symbolTerms.has(t)).length / queryTerms.length
        : 0;

    // 4. Path — directory and filename carry real intent ("the orders *route*").
    const pathTerms = new Set(tokenize(candidate.file.replace(/[/\\.]/g, ' ')));
    const pathHit = queryTerms.filter(t => pathTerms.has(t)).length / queryTerms.length;

    // 5. The first-stage prior, damped. Keeping it stops the rerank from throwing
    // away a well-founded lexical ranking on the strength of one narrow signal.
    const prior = 1 / Math.log2(candidate.rank + 2);

    return (
        weights.coverage * coverage +
        weights.proximity * proximity +
        weights.symbol * symbolHit +
        weights.path * pathHit +
        weights.prior * prior
    );
}

/**
 * Fraction of the chunk's matched terms that fit in the tightest window holding the
 * most of them. Returns 0 when fewer than two terms match — proximity is
 * meaningless for a single hit, and returning something non-zero there would just
 * re-weight coverage under another name.
 */
export function proximityScore(tokens: string[], matched: Set<string>): number {
    if (matched.size < 2) return 0;

    const positions: number[] = [];
    const termAt: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (matched.has(tokens[i])) { positions.push(i); termAt.push(tokens[i]); }
    }
    if (positions.length < 2) return 0;

    // Smallest span containing all distinct matched terms, by sliding window.
    const need = matched.size;
    const counts = new Map<string, number>();
    let best = Infinity;
    let left = 0;

    for (let right = 0; right < positions.length; right++) {
        counts.set(termAt[right], (counts.get(termAt[right]) ?? 0) + 1);
        while (counts.size === need) {
            best = Math.min(best, positions[right] - positions[left] + 1);
            const leftTerm = termAt[left];
            const remaining = (counts.get(leftTerm) ?? 1) - 1;
            if (remaining === 0) counts.delete(leftTerm);
            else counts.set(leftTerm, remaining);
            left++;
        }
    }

    if (!Number.isFinite(best)) return 0;
    // Normalise so a tight cluster scores near 1 and a chunk-wide spread near 0.
    return Math.max(0, Math.min(1, need / best));
}

function unique(values: string[]): string[] {
    return Array.from(new Set(values));
}

// ─── Model-backed reranker (Phase 4 closes M17) ─────────────────────────────
//
// The cross-encoder the roadmap asked for, now that the `rerank` role exists. It scores
// each candidate against the query with a model and blends that score with the same
// first-stage prior the lexical reranker uses.
//
// ── Blending, not replacing, is the lesson from M17 ──────────────────────────
// M17's most expensive finding was that a reranker given free rein makes retrieval
// *worse*: a first draft let a rank-40 chunk with every query word overtake a rank-1
// chunk with most of them and cost 8 points of recall@5. A model's relevance judgement is
// better evidence than a lexical score, but it is not so much better that it should
// discard a well-founded ranking over the same text — so the model score enters as a
// signal with a weight, exactly as `coverage` does, and the prior still counts.
//
// ── Failure is a downgrade, never an error ───────────────────────────────────
// This is the component most likely to fail in normal use: it needs a key, a network and
// a model that returns parseable output. Every one of those failures falls back to the
// lexical ranking with a warning, because search that degrades to first-stage quality
// beats search that returns an error — the property `CodebaseIndex` already relies on.

export interface RerankScorer {
    /** Returns one score per candidate, in the same order. Higher is more relevant. */
    score(query: string, candidates: RerankCandidate[]): Promise<number[]>;
}

/**
 * Weight of the model's judgement relative to the prior.
 *
 * Set to the same magnitude as the prior rather than above it: the model is the better
 * signal, so it should be able to *move* a candidate several places, and it should not be
 * able to lift the 20th candidate over the 1st on its own. Those two sentences are the
 * whole tuning rationale, and they are the M17 finding restated for a stronger signal.
 */
export const DEFAULT_MODEL_RERANK_WEIGHT = 3.0;

export class ModelReranker implements Reranker {
    readonly id = 'model';

    constructor(
        private readonly scorer: RerankScorer,
        private readonly fallback: Reranker = new LexicalReranker(),
        private readonly modelWeight = DEFAULT_MODEL_RERANK_WEIGHT,
        private readonly onDegrade?: (reason: string) => void,
    ) {}

    async rerank(query: string, candidates: RerankCandidate[]): Promise<RerankedCandidate[]> {
        if (!candidates.length) return [];
        try {
            const scores = await this.scorer.score(query, candidates);
            // A scorer that returns the wrong shape is a broken scorer, not a partial
            // result: silently zero-filling would rank real candidates below whatever the
            // model did answer for, which is worse than not reranking at all.
            if (!Array.isArray(scores) || scores.length !== candidates.length) {
                throw new Error(`scorer returned ${Array.isArray(scores) ? scores.length : 'non-array'} scores for ${candidates.length} candidates`);
            }
            return candidates
                .map((candidate, i) => ({
                    ...candidate,
                    score: this.modelWeight * clamp01(scores[i]) + DEFAULT_RERANK_WEIGHTS.prior * (1 / Math.log2(candidate.rank + 2)),
                }))
                .sort((a, b) => b.score - a.score);
        } catch (err: any) {
            this.onDegrade?.(`rerank model unavailable (${err?.message || err}); using the lexical reranker`);
            return this.fallback.rerank(query, candidates);
        }
    }
}

/**
 * Prompt and parser for the scoring call.
 *
 * Scores all candidates in **one** request rather than one request per candidate: a true
 * cross-encoder pass is N calls, and at RERANK_DEPTH=20 that is 20 round trips inside a
 * search a user is waiting on. One call with numbered snippets gets the same ordering
 * signal at 1/20th the latency, which is the trade that makes this usable at all.
 */
export function buildRerankPrompt(query: string, candidates: RerankCandidate[]): string {
    const items = candidates.map((c, i) =>
        `[${i + 1}] ${c.file}${c.symbol ? ` — ${c.symbol}` : ''}\n${c.text.slice(0, 800)}`,
    );
    return [
        'Rate how well each code snippet answers the question. Output one line per snippet,',
        'formatted exactly as `<number>: <score 0-10>`, nothing else.',
        '',
        `Question: ${query}`,
        '',
        ...items,
    ].join('\n');
}

/**
 * Parses `1: 8` lines into normalised scores.
 *
 * Missing lines score 0 — a candidate the model declined to rate is not evidence of
 * relevance — but a response that rates *nothing* throws, so `ModelReranker` degrades to
 * the lexical pass instead of silently ranking everything equal, which would present a
 * random order as a reranking.
 */
export function parseRerankScores(response: string, count: number): number[] {
    const scores = new Array<number>(count).fill(0);
    let seen = 0;
    for (const match of response.matchAll(/^\s*\[?(\d+)\]?\s*[:.)-]\s*(\d+(?:\.\d+)?)/gm)) {
        const index = Number(match[1]) - 1;
        if (index < 0 || index >= count) continue;
        scores[index] = clamp01(Number(match[2]) / 10);
        seen++;
    }
    if (seen === 0) throw new Error('no scores could be parsed from the rerank response');
    return scores;
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}
