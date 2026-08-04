import { describe, expect, it, vi } from 'vitest';
import {
    MODEL_ROLES, ModelRouter, ProviderHealth, runWithFailover,
} from '@blackide/agent-core/core/model-router';
import { LLMConfigEntry } from '@blackide/agent-core/core/types';

/**
 * Phase 4, M23 + M24 — per-role models and cross-provider failover.
 *
 * The two properties that carry the risk:
 *   1. **Precedence.** An explicit choice (the chat dropdown, a Manager run's model) must
 *      beat a standing role mapping, and a legacy `autocompleteModelId` must keep working
 *      — a config that quietly stops being applied is worse than one that errors.
 *   2. **Failover must not duplicate output.** If the primary streamed half an answer and
 *      then died, retrying elsewhere appends a second answer to the first half of one.
 */

const model = (id: string, type: LLMConfigEntry['type'], over: Partial<LLMConfigEntry> = {}): LLMConfigEntry =>
    ({ id, name: id, type, model: id, enabled: true, ...over });

const claude = model('claude-1', 'claude');
const gpt = model('gpt-1', 'openai');
const gpt2 = model('gpt-2', 'openai');
const groq = model('groq-1', 'groq');
const local = model('local-1', 'local');
const all = [claude, gpt, gpt2, groq, local];

describe('role resolution', () => {
    it('names every role the roadmap asked for', () => {
        // `review` joined in Phase 9 (M47). Unlike the other roles it exists so a
        // reviewer can be pointed at a *better* model, not a cheaper one.
        expect([...MODEL_ROLES]).toEqual(['chat', 'plan', 'edit', 'apply', 'autocomplete', 'embed', 'rerank', 'review']);
    });

    it('prefers an explicit override over everything', () => {
        const router = new ModelRouter(all, { selectedModelId: claude.id, roleModels: { chat: gpt.id } });
        const resolved = router.resolve('chat', groq.id);
        expect(resolved?.config.id).toBe(groq.id);
        expect(resolved?.reason).toBe('override');
    });

    it('falls to the role mapping, then the selected model, then the first enabled', () => {
        expect(new ModelRouter(all, { selectedModelId: claude.id, roleModels: { apply: groq.id } }).resolve('apply'))
            .toMatchObject({ config: { id: groq.id }, reason: 'role' });
        expect(new ModelRouter(all, { selectedModelId: claude.id }).resolve('apply'))
            .toMatchObject({ config: { id: claude.id }, reason: 'selected' });
        expect(new ModelRouter(all, {}).resolve('apply'))
            .toMatchObject({ config: { id: claude.id }, reason: 'first-enabled' });
    });

    it('keeps honouring the pre-roles autocompleteModelId', () => {
        // This call site is where per-role models started (`inline-completion.ts` already
        // preferred it). Dropping the setting would silently move existing users'
        // completions onto their chat model.
        const router = new ModelRouter(all, { selectedModelId: claude.id, autocompleteModelId: groq.id });
        expect(router.resolve('autocomplete')).toMatchObject({ config: { id: groq.id }, reason: 'legacy-autocomplete' });
        // …but a role mapping is the newer, more specific statement and wins.
        const withRole = new ModelRouter(all, { autocompleteModelId: groq.id, roleModels: { autocomplete: local.id } });
        expect(withRole.resolve('autocomplete')?.config.id).toBe(local.id);
    });

    it('ignores disabled models and unresolvable ids', () => {
        const configs = [model('off', 'openai', { enabled: false }), claude];
        const router = new ModelRouter(configs, { selectedModelId: 'off', roleModels: { chat: 'ghost' } });
        expect(router.resolve('chat')?.config.id).toBe(claude.id);
    });

    it('returns undefined when nothing is configured, rather than inventing a default', () => {
        // The zero-config path (M27) depends on this: an empty config list is a legitimate
        // first-run state, not an error, and the caller turns it into the local-model offer.
        expect(new ModelRouter([], {}).resolve('chat')).toBeUndefined();
    });

    it('describes every role for the settings UI', () => {
        const described = new ModelRouter(all, { selectedModelId: claude.id, roleModels: { rerank: groq.id } }).describe();
        expect(described).toHaveLength(MODEL_ROLES.length);
        expect(described.find(d => d.role === 'rerank')).toMatchObject({ modelId: groq.id, reason: 'role' });
        expect(described.find(d => d.role === 'chat')).toMatchObject({ modelId: claude.id, reason: 'selected' });
    });
});

describe('failover chain', () => {
    it('puts a different provider ahead of another model from the same one', () => {
        // The point of health-aware routing: when Anthropic returns 529, a second Anthropic
        // model is behind the same outage. An OpenAI model is not.
        const router = new ModelRouter([gpt, gpt2, claude, groq], { selectedModelId: gpt.id });
        const chain = router.chainFor('chat').map(c => c.id);
        expect(chain[0]).toBe(gpt.id);
        expect(chain.indexOf(claude.id)).toBeLessThan(chain.indexOf(gpt2.id));
    });

    it('is a single entry when the user opts out', () => {
        const router = new ModelRouter(all, { selectedModelId: gpt.id, disableFailover: true });
        expect(router.chainFor('chat')).toHaveLength(1);
    });

    it('keeps the primary at the head even when its breaker is open', () => {
        // A chain that silently reordered the user's choice would make "which model am I
        // on?" unanswerable from the settings alone; skipping happens at attempt time.
        const health = new ProviderHealth(1);
        health.recordFailure(gpt.id);
        const router = new ModelRouter([gpt, claude], { selectedModelId: gpt.id }, health);
        expect(router.chainFor('chat')[0].id).toBe(gpt.id);
    });

    it('is empty when nothing resolves', () => {
        expect(new ModelRouter([], {}).chainFor('chat')).toEqual([]);
    });
});

describe('ProviderHealth', () => {
    it('trips after consecutive failures and recovers after the cooldown', () => {
        let now = 1_000;
        const health = new ProviderHealth(3, 60_000, () => now);
        health.recordFailure('a');
        health.recordFailure('a');
        expect(health.isUsable('a')).toBe(true);
        health.recordFailure('a');
        expect(health.isUsable('a')).toBe(false);
        expect(health.openBreakers()).toEqual([{ id: 'a', msRemaining: 60_000 }]);

        now += 60_001;
        expect(health.isUsable('a')).toBe(true);      // half-open: the next attempt is real
        expect(health.openBreakers()).toEqual([]);
    });

    it('counts consecutive failures, so an occasional error never trips it', () => {
        // A provider failing one request in ten is having a bad day, not an outage; a
        // cumulative count would eventually disable every provider a long session touched.
        const health = new ProviderHealth(3);
        health.recordFailure('a');
        health.recordFailure('a');
        health.recordSuccess('a');
        health.recordFailure('a');
        expect(health.isUsable('a')).toBe(true);
    });
});

describe('runWithFailover', () => {
    const boom = (message = 'HTTP 529') => { throw new Error(message); };

    it('completes on the secondary and reports the substitution', async () => {
        const health = new ProviderHealth();
        const seen: string[] = [];
        const onSubstitution = vi.fn();
        const outcome = await runWithFailover([gpt, claude], health, async (config) => {
            seen.push(config.id);
            if (config.id === gpt.id) boom();
            return 'answer';
        }, { onSubstitution });

        expect(outcome.result).toBe('answer');
        expect(outcome.used.id).toBe(claude.id);
        expect(outcome.substitution).toMatchObject({ from: { id: gpt.id }, to: { id: claude.id } });
        expect(outcome.substitution?.because).toContain('529');
        expect(onSubstitution).toHaveBeenCalledOnce();
        expect(seen).toEqual([gpt.id, claude.id]);
    });

    it('never retries elsewhere once output has reached the user', async () => {
        // The correctness rule of streaming failover: the user would otherwise see two
        // overlapping replies, and the transcript would be unusable.
        const health = new ProviderHealth();
        let attempts = 0;
        await expect(runWithFailover([gpt, claude], health, async () => {
            attempts++;
            boom();
        }, { hasEmitted: () => true })).rejects.toThrow('529');
        expect(attempts).toBe(1);
    });

    it('never retries an abort — that is the user\'s decision', async () => {
        const health = new ProviderHealth();
        let attempts = 0;
        const abort = Object.assign(new Error('Aborted'), { name: 'AbortError' });
        await expect(runWithFailover([gpt, claude], health, async () => {
            attempts++;
            throw abort;
        }, { isAbort: (e: any) => e?.name === 'AbortError' })).rejects.toThrow('Aborted');
        expect(attempts).toBe(1);
        // An abort is not a provider fault and must not count towards its breaker.
        expect(health.isUsable(gpt.id)).toBe(true);
    });

    it('records health on both outcomes', async () => {
        const health = new ProviderHealth(1);
        await runWithFailover([gpt, claude], health, async (config) => {
            if (config.id === gpt.id) boom();
            return 'ok';
        });
        expect(health.isUsable(gpt.id)).toBe(false);
        expect(health.isUsable(claude.id)).toBe(true);
    });

    it('skips a tripped provider without attempting it', async () => {
        const health = new ProviderHealth(1);
        health.recordFailure(gpt.id);
        const seen: string[] = [];
        const outcome = await runWithFailover([gpt, claude], health, async (config) => {
            seen.push(config.id);
            return 'ok';
        });
        expect(seen).toEqual([claude.id]);
        expect(outcome.used.id).toBe(claude.id);
    });

    it('tries the chain anyway when every breaker is open', async () => {
        // Refusing to call because everything failed recently turns a transient outage into
        // a hard stop only time can clear. The breaker exists to stop wasting attempts, not
        // to forbid the last one.
        const health = new ProviderHealth(1);
        health.recordFailure(gpt.id);
        health.recordFailure(claude.id);
        const outcome = await runWithFailover([gpt, claude], health, async () => 'ok');
        expect(outcome.result).toBe('ok');
    });

    it('throws the last error when every provider fails', async () => {
        const health = new ProviderHealth();
        await expect(runWithFailover([gpt, claude], health, async (c) => boom(`down: ${c.id}`)))
            .rejects.toThrow('down: claude-1');
    });

    it('refuses an empty chain with an actionable message', async () => {
        await expect(runWithFailover([], new ProviderHealth(), async () => 'x'))
            .rejects.toThrow(/No model is configured/);
    });
});
