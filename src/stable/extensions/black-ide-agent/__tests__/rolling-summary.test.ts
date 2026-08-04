import { describe, expect, it } from 'vitest';
import { ChatMessage } from '@blackide/agent-core/core/types';
import { ContextManager } from '@blackide/agent-core/core/context-manager';
import {
    applySummary, buildSummaryPrompt, hasSummary, selectForSummary, stripSummary,
} from '@blackide/agent-core/core/rolling-summary';

/**
 * Phase 5, M30 — rolling summarization.
 *
 * The gate is "auto-summarization never drops a pending approval or tool result", and it
 * is the whole reason `selectForSummary` is a pure function that makes no model call:
 * the safety rules can then be tested exhaustively without a provider, at the level where
 * they are actually decided.
 *
 * Two of the three rules protect against a *hard* failure rather than a degraded one. A
 * `tool_result` whose `tool_use` was folded away is rejected outright by Anthropic and
 * OpenAI — the run does not get worse, it dies at the next request.
 */

const estimate = (m: ChatMessage) => new ContextManager().estimateMessageTokens(m);

const user = (content: string): ChatMessage => ({ role: 'user', content });
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content });
const calls = (id: string, name = 'read_file'): ChatMessage =>
    ({ role: 'assistant', content: '', toolCalls: [{ id, name, arguments: { path: 'a.ts' } }] });
const results = (id: string, name = 'read_file'): ChatMessage =>
    ({ role: 'user', content: '', toolResults: [{ id, name, content: 'file contents' }] });

/** A conversation long enough to be eligible: task, then n filler turns. */
function conversation(turns: number): ChatMessage[] {
    const out: ChatMessage[] = [user('Add retry logic to the payment client')];
    for (let i = 0; i < turns; i++) {
        out.push(assistant(`step ${i}: ${'reasoning '.repeat(40)}`));
        out.push(user(`observation ${i}: ${'output '.repeat(40)}`));
    }
    return out;
}

const options = (over: Partial<Parameters<typeof selectForSummary>[1]> = {}) => ({
    maxTokens: 4_000, estimate, ...over,
});

// ─── The gate ───────────────────────────────────────────────────────────────

describe('the gate: a pending approval stops summarization outright', () => {
    it('refuses while an approval is open, however full the window is', () => {
        const selection = selectForSummary(conversation(40), options({ pendingApproval: true }));
        expect(selection.summarize).toEqual([]);
        expect(selection.skipped).toBe('approval-pending');
    });

    it('refuses even when the user forced it with /compact', () => {
        // A manual override overrides the *policy*, never the correctness rules.
        const selection = selectForSummary(conversation(40), options({ pendingApproval: true, force: true }));
        expect(selection.summarize).toEqual([]);
        expect(selection.skipped).toBe('approval-pending');
    });

    it('keeps every message intact when it refuses', () => {
        const messages = conversation(40);
        const selection = selectForSummary(messages, options({ pendingApproval: true }));
        expect([selection.head, ...selection.keep]).toEqual(messages);
    });
});

describe('the gate: a tool result never outlives its call', () => {
    it('never leaves the kept window starting on tool results', () => {
        // Built so the naive recency cut lands exactly between a call and its result.
        const messages: ChatMessage[] = [user('task')];
        for (let i = 0; i < 20; i++) {
            messages.push(calls(`call-${i}`));
            messages.push(results(`call-${i}`));
        }
        const selection = selectForSummary(messages, options({ keepRecent: 6, force: true }));

        expect(selection.keep.length).toBeGreaterThan(0);
        const first = selection.keep[0];
        expect(first.role === 'user' && !!first.toolResults?.length).toBe(false);
    });

    it('holds that invariant at every recency window, not just one', () => {
        const messages: ChatMessage[] = [user('task')];
        for (let i = 0; i < 20; i++) {
            messages.push(calls(`call-${i}`));
            messages.push(results(`call-${i}`));
        }
        for (let keepRecent = 1; keepRecent <= 15; keepRecent++) {
            const selection = selectForSummary(messages, options({ keepRecent, force: true }));
            const first = selection.keep[0];
            if (!first) continue;
            expect(first.role === 'user' && !!first.toolResults?.length, `keepRecent=${keepRecent}`).toBe(false);
        }
    });

    it('never folds away a call whose results are in the kept window', () => {
        const messages: ChatMessage[] = [user('task')];
        for (let i = 0; i < 20; i++) {
            messages.push(calls(`call-${i}`));
            messages.push(results(`call-${i}`));
        }
        const selection = selectForSummary(messages, options({ keepRecent: 7, force: true }));

        const foldedCallIds = new Set(selection.summarize.flatMap(m => (m.toolCalls || []).map(c => c.id)));
        const keptResultIds = selection.keep.flatMap(m => (m.toolResults || []).map(r => r.id));
        for (const id of keptResultIds) {
            expect(foldedCallIds.has(id), `result ${id} would have been orphaned`).toBe(false);
        }
    });
});

describe('the gate: an unresolved tool call is never folded away', () => {
    it('stops the cut before a call whose results have not come back', () => {
        // Long enough that recency alone would happily fold the pending call away.
        const messages: ChatMessage[] = [user('task')];
        for (let i = 0; i < 3; i++) {
            messages.push(calls(`done-${i}`));
            messages.push(results(`done-${i}`));
        }
        messages.push(calls('pending-one'));            // no results anywhere after it
        for (let i = 0; i < 20; i++) messages.push(assistant(`later ${i}`));

        const selection = selectForSummary(messages, options({ keepRecent: 2, force: true }));
        const folded = selection.summarize.flatMap(m => (m.toolCalls || []).map(c => c.id));
        expect(folded).not.toContain('pending-one');
    });
});

// ─── Threshold behaviour ────────────────────────────────────────────────────

describe('threshold', () => {
    it('does nothing below the threshold', () => {
        const selection = selectForSummary(conversation(2), options({ maxTokens: 1_000_000 }));
        expect(selection.summarize).toEqual([]);
        expect(selection.skipped).toBe('below-threshold');
    });

    it('fires above it', () => {
        const selection = selectForSummary(conversation(40), options({ maxTokens: 2_000 }));
        expect(selection.summarize.length).toBeGreaterThan(0);
    });

    it('respects a custom threshold fraction', () => {
        const messages = conversation(20);
        const total = messages.reduce((n, m) => n + estimate(m), 0);
        // A threshold just above the total does not fire; just below it does.
        expect(selectForSummary(messages, options({ maxTokens: total * 2, thresholdFraction: 0.9 })).summarize).toEqual([]);
        expect(selectForSummary(messages, options({ maxTokens: total * 2, thresholdFraction: 0.4 })).summarize.length).toBeGreaterThan(0);
    });

    it('force ignores the threshold but not the invariants', () => {
        const selection = selectForSummary(conversation(20), options({ maxTokens: 1_000_000, force: true }));
        expect(selection.summarize.length).toBeGreaterThan(0);
        expect(selection.head).toEqual(conversation(20)[0]);
    });

    it('declines when there is nothing worth a model call', () => {
        const selection = selectForSummary([user('task'), assistant('done')], options({ force: true }));
        expect(selection.summarize).toEqual([]);
        expect(selection.skipped).toBe('nothing-eligible');
    });

    it('handles an empty conversation without throwing', () => {
        const selection = selectForSummary([], options({ force: true }));
        expect(selection.summarize).toEqual([]);
    });
});

describe('the task message survives everything', () => {
    it('is never in the summarized set', () => {
        for (const keepRecent of [1, 3, 6, 12]) {
            const messages = conversation(30);
            const selection = selectForSummary(messages, options({ keepRecent, force: true }));
            expect(selection.head).toBe(messages[0]);
            expect(selection.summarize).not.toContain(messages[0]);
        }
    });
});

// ─── Applying ───────────────────────────────────────────────────────────────

describe('applySummary', () => {
    const selection = () => selectForSummary(conversation(30), options({ force: true }));

    it('folds the summary into the task message rather than adding a message', () => {
        const before = selection();
        const after = applySummary(before, 'The client retries on 5xx only.');

        expect(after[0].role).toBe('user');
        expect(after[0].content).toContain('Add retry logic');
        expect(after[0].content).toContain('retries on 5xx only');
        expect(after.length).toBe(1 + before.keep.length);
    });

    it('replaces the previous summary rather than nesting one inside another', () => {
        // What actually happens in a long run: fold, keep working, fold again. The second
        // fold must not produce a summary of a summary — nesting is how a "compaction"
        // grows the thing it exists to shrink.
        const first = applySummary(selection(), 'Summary A');
        const continued = [...first, ...conversation(30).slice(1)];
        const second = applySummary(selectForSummary(continued, options({ force: true })), 'Summary B');

        const occurrences = second[0].content.split('[Conversation summary so far:').length - 1;
        expect(occurrences).toBe(1);
        expect(second[0].content).toContain('Summary B');
        expect(second[0].content).not.toContain('Summary A');
        // And the original task text is still the first thing in it.
        expect(second[0].content.startsWith('Add retry logic')).toBe(true);
    });

    it('is idempotent: the same fold applied twice produces the same conversation', () => {
        const once = applySummary(selection(), 'Summary A');
        const twice = applySummary(selection(), 'Summary A');
        expect(twice).toEqual(once);
    });

    it('declines a second fold when the first left nothing to fold', () => {
        const first = applySummary(selection(), 'Summary A');
        const second = selectForSummary(first, options({ force: true }));
        expect(second.summarize).toEqual([]);
        expect(applySummary(second, 'Summary B')).toEqual(first);
    });

    it('returns the conversation unchanged when there is nothing to fold', () => {
        const messages = conversation(2);
        const empty = selectForSummary(messages, options({ maxTokens: 1_000_000 }));
        expect(applySummary(empty, 'ignored')).toEqual(messages);
    });

    it('returns the conversation unchanged for an empty summary', () => {
        const before = selection();
        const after = applySummary(before, '   ');
        expect(after).toEqual([before.head, ...before.keep]);
    });

    it('keeps the tail verbatim', () => {
        const before = selection();
        const after = applySummary(before, 'Summary');
        expect(after.slice(1)).toEqual(before.keep);
    });
});

describe('stripSummary / hasSummary', () => {
    it('round-trips the task text', () => {
        const folded = applySummary(selectForSummary(conversation(30), options({ force: true })), 'Some summary');
        expect(hasSummary(folded)).toBe(true);
        expect(stripSummary(folded[0].content)).toBe('Add retry logic to the payment client');
    });

    it('leaves content with no summary alone', () => {
        expect(stripSummary('just the task')).toBe('just the task');
        expect(hasSummary([user('just the task')])).toBe(false);
    });

    it('reports false for an empty conversation', () => {
        expect(hasSummary([])).toBe(false);
    });
});

describe('buildSummaryPrompt', () => {
    it('asks for what did not work, which is the part worth keeping', () => {
        const prompt = buildSummaryPrompt([assistant('tried X'), user('failed')], 'the task');
        expect(prompt).toContain('did NOT work');
        expect(prompt).toContain('the task');
    });

    it('renders tool calls and results as text, not as call syntax', () => {
        const prompt = buildSummaryPrompt([calls('c1', 'grep_search'), results('c1', 'grep_search')], 'task');
        expect(prompt).toContain('grep_search');
        expect(prompt).toContain('file contents');
    });

    it('marks an error result as an error', () => {
        const failed: ChatMessage = { role: 'user', content: '', toolResults: [{ id: 'x', name: 'run_tests', content: 'boom', isError: true }] };
        expect(buildSummaryPrompt([failed], 'task')).toContain('[error]');
    });
});

// ─── Composition with the deterministic floor ───────────────────────────────

describe('summarization composes with ContextManager.fit', () => {
    it('leaves a conversation fit() can still bound', () => {
        const context = new ContextManager(2_000);
        const folded = applySummary(
            selectForSummary(conversation(60), options({ maxTokens: 2_000 })),
            'Everything that happened, in prose.',
        );

        const fitted = context.fit(folded, 'system prompt');
        // The invariant `fit` has always held must survive the new list shape: the kept
        // window never starts on results whose call was dropped.
        const first = fitted.messages[1];
        if (first) expect(first.role === 'user' && !!first.toolResults?.length).toBe(false);
        expect(fitted.messages[0].content).toContain('Add retry logic');
    });
});
