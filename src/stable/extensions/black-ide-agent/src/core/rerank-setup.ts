import { LLMClient } from '@blackide/agent-core/core/llm-client';
import { ModelRouter } from '@blackide/agent-core/core/model-router';
import {
    LexicalReranker, ModelReranker, RerankCandidate, RerankScorer, Reranker,
    buildRerankPrompt, parseRerankScores,
} from '@blackide/agent-core/core/reranker';

// Assembly for the rerank stage (Phase 4 closing Phase 3's M17).
//
// Separate from `reranker.ts` so that file stays free of the LLM client and the router:
// the ranking logic is pure and heavily unit-tested, and the thing that talks to a
// provider is not.

/** Scores candidates with one model call. */
export class LLMRerankScorer implements RerankScorer {
    constructor(
        private readonly config: import('@blackide/agent-core/core/types').LLMConfigEntry,
        private readonly timeoutMs = 8_000,
    ) {}

    async score(query: string, candidates: RerankCandidate[]): Promise<number[]> {
        /*
         * A hard timeout, because this sits in the middle of a search.
         *
         * `codebase_search` is a tool call the agent is blocked on; a rerank model having
         * a slow minute must not turn a 200 ms search into a 60 s one. On timeout the
         * abort propagates as a throw, and `ModelReranker` falls back to the lexical
         * ranking — the user gets a slightly worse result quickly instead of a better one
         * far too late.
         */
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await LLMClient.streamCompletion(
                this.config,
                buildRerankPrompt(query, candidates),
                () => { /* nothing streams from a scoring call */ },
                undefined,
                controller.signal,
            );
            return parseRerankScores(response, candidates.length);
        } finally {
            clearTimeout(timer);
        }
    }
}

/**
 * The reranker for the current configuration.
 *
 * Returns the deterministic `LexicalReranker` unless the user has explicitly pointed the
 * **`rerank` role** at a model. That "explicitly" is the whole rule: `ModelRouter.resolve`
 * falls back to the chat model for any unconfigured role, which is right for `plan` or
 * `edit` and wrong here — it would silently spend a request against the user's strongest
 * (most expensive) model on every `codebase_search`, having never been asked to. So this
 * checks for a configured role mapping rather than accepting the fallback.
 */
export function buildReranker(
    router: ModelRouter,
    settings: any,
    onDegrade?: (reason: string) => void,
): Reranker {
    const configuredId = settings?.roleModels?.rerank;
    if (!configuredId) return new LexicalReranker();

    const resolved = router.resolve('rerank');
    if (!resolved || resolved.reason !== 'role') {
        // Configured, but pointing at a model that no longer exists. Saying so beats
        // silently running the lexical fallback and leaving the user believing their
        // rerank model is in use.
        onDegrade?.(`the configured rerank model ("${configuredId}") is not available; using the lexical reranker`);
        return new LexicalReranker();
    }

    return new ModelReranker(new LLMRerankScorer(resolved.config), new LexicalReranker(), undefined, onDegrade);
}
