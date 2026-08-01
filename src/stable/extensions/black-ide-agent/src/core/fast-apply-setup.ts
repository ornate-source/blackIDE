import { LLMClient } from './llm-client';
import { ModelRouter } from './model-router';
import { ToolRunner } from '../tools/tool-runner';
import { Verification, buildApplyPrompt, extractBlocks, verifyFastApply } from './fast-apply';

// Assembly for fast-apply (Phase 4, M25). The pure half — prompt, extraction,
// verification — is `fast-apply.ts`; this is the part that calls a model.

/** Fast-apply is a latency optimisation; a slow one is a pessimisation. */
const APPLY_TIMEOUT_MS = 20_000;

export type FastApplyFn = (path: string, content: string, intent: string) => Promise<Verification>;

/**
 * Builds the fast-apply function, or returns undefined when no **`apply`** model is
 * configured.
 *
 * Undefined rather than falling back to the chat model, deliberately. Running fast-apply
 * on the strong model has the cost of the strong model *plus* an extra round trip and none
 * of the benefit — it is strictly worse than the model writing the blocks itself, which is
 * what happens when this returns undefined. So the feature is off until the user names a
 * cheap model for the role, and `ModelRouter.resolve`'s role fallback is bypassed here for
 * exactly the same reason the rerank role bypasses it.
 */
export function buildFastApply(
    router: ModelRouter,
    settings: any,
    log?: (message: string) => void,
): FastApplyFn | undefined {
    if (!settings?.roleModels?.apply) return undefined;

    const resolved = router.resolve('apply');
    if (!resolved || resolved.reason !== 'role') {
        log?.(`[FastApply] the configured apply model ("${settings.roleModels.apply}") is not available; edits will use explicit blocks.`);
        return undefined;
    }
    const config = resolved.config;

    return async (path, content, intent) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), APPLY_TIMEOUT_MS);
        try {
            const response = await LLMClient.streamCompletion(
                config,
                buildApplyPrompt(path, content, intent),
                () => { /* nothing streams: the blocks are not shown, they are applied */ },
                undefined,
                controller.signal,
            );

            const blocks = extractBlocks(response);
            if (!blocks) {
                // Covers both the explicit CANNOT_APPLY refusal and a response with no
                // markers. Either way the strong model is asked for blocks, which is the
                // correct escalation and the reason this path can never be silently wrong.
                return { ok: false, kind: 'malformed', reason: 'the apply model produced no usable SEARCH/REPLACE blocks' };
            }

            // Verified with the *same* applier the normal edit path uses — a second
            // implementation of the matching rules would be a second set of rules.
            return verifyFastApply(content, blocks, (c, b) => ToolRunner.applySearchReplace(c, b));
        } catch (err: any) {
            return { ok: false, kind: 'malformed', reason: `the apply model failed: ${String(err?.message || err).slice(0, 200)}` };
        } finally {
            clearTimeout(timer);
        }
    };
}
