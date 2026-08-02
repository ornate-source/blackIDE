import { describe, expect, it } from 'vitest';
import { ChatMessage } from '../src/core/types';
import {
    SteeringQueue, applySteering, describeSteering, renderSteering,
} from '../src/core/steering';

/**
 * Phase 7, M39 — mid-run steering.
 *
 * The gate is "a comment changes executor behaviour within one turn without losing
 * accumulated context". Losing context is the easy half — nothing here restarts anything.
 * The hard half is *where the text lands*, because the mid-run message list is a protocol
 * rather than a transcript and two placements produce a hard provider rejection:
 *
 *   1. between a `tool_use` and its `tool_result` — an unanswered tool call;
 *   2. two `user` messages in a row — Anthropic requires alternating roles.
 *
 * Both failures are 400s from somebody else's API, so a pure function is the only place
 * they can be tested at all. That is what this file is.
 */

const user = (content: string): ChatMessage => ({ role: 'user', content });
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content });
const withCalls = (id: string): ChatMessage =>
    ({ role: 'assistant', content: '', toolCalls: [{ id, name: 'read_file', arguments: { path: 'a.ts' } }] });
const withResults = (id: string): ChatMessage =>
    ({ role: 'user', content: '', toolResults: [{ id, name: 'read_file', content: 'contents' }] });

const notes = (queue: SteeringQueue) => queue.drain();

function queueWith(...texts: string[]): SteeringQueue {
    const queue = new SteeringQueue();
    for (const text of texts) queue.add(text, { at: 1_000 });
    return queue;
}

// ─── Rule 1: never between a call and its result ────────────────────────────

describe('rule 1: an unanswered tool call is never interrupted', () => {
    it('defers when the last message has pending tool calls', () => {
        const messages = [user('task'), withCalls('c1')];
        const outcome = applySteering(messages, notes(queueWith('use the existing helper')));

        expect(outcome.applied).toEqual([]);
        expect(outcome.deferred).toHaveLength(1);
        expect(outcome.messages).toBe(messages);   // untouched, not a copy with edits
    });

    it('injects on the very next turn, once the results have landed', () => {
        const queue = queueWith('use the existing helper');

        // Turn N: declined, and requeued by the loop.
        const first = applySteering([user('task'), withCalls('c1')], queue.drain());
        for (const note of first.deferred) queue.requeue(note);
        expect(queue.pending).toBe(1);

        // Turn N+1: the results are in, so it lands.
        const second = applySteering([user('task'), withCalls('c1'), withResults('c1')], queue.drain());
        expect(second.applied).toHaveLength(1);
        expect(second.messages[2].content).toContain('use the existing helper');
    });

    it('does not defer for an assistant turn that made no tool calls', () => {
        const outcome = applySteering([user('task'), assistant('here is my plan')], notes(queueWith('narrower, please')));
        expect(outcome.applied).toHaveLength(1);
        expect(outcome.messages).toHaveLength(3);
        expect(outcome.messages[2].role).toBe('user');
    });
});

// ─── Rule 2: roles must alternate ───────────────────────────────────────────

describe('rule 2: never two user messages in a row', () => {
    it('folds into the trailing tool-results message rather than appending', () => {
        const messages = [user('task'), withCalls('c1'), withResults('c1')];
        const outcome = applySteering(messages, notes(queueWith('use the existing helper')));

        expect(outcome.messages).toHaveLength(3);
        const last = outcome.messages[2];
        expect(last.role).toBe('user');
        expect(last.content).toContain('use the existing helper');
        // …and the results stay attached to their call.
        expect(last.toolResults?.[0].id).toBe('c1');
    });

    it('never produces consecutive user turns, from any starting shape', () => {
        const shapes: ChatMessage[][] = [
            [user('task')],
            [user('task'), assistant('thinking')],
            [user('task'), withCalls('c1'), withResults('c1')],
            [user('task'), assistant('a'), user('b'), assistant('c')],
            [user('task'), withCalls('c1'), withResults('c1'), assistant('done')],
        ];
        for (const shape of shapes) {
            const outcome = applySteering(shape, notes(queueWith('correction')));
            for (let i = 1; i < outcome.messages.length; i++) {
                expect(
                    outcome.messages[i].role === 'user' && outcome.messages[i - 1].role === 'user',
                    `consecutive user turns in ${JSON.stringify(shape.map(m => m.role))}`,
                ).toBe(false);
            }
        }
    });

    it('preserves existing content when folding into a user turn', () => {
        const messages = [user('task'), assistant('a'), { role: 'user' as const, content: 'original text' }];
        const outcome = applySteering(messages, notes(queueWith('correction')));
        expect(outcome.messages[2].content).toContain('original text');
        expect(outcome.messages[2].content).toContain('correction');
    });
});

// ─── Purity and accumulated context ─────────────────────────────────────────

describe('the conversation is preserved, not rebuilt', () => {
    it('does not mutate the caller\'s array', () => {
        // A failed turn must not leave half-applied steering behind.
        const messages = [user('task'), assistant('a')];
        const snapshot = JSON.parse(JSON.stringify(messages));
        applySteering(messages, notes(queueWith('correction')));
        expect(messages).toEqual(snapshot);
    });

    it('keeps every earlier turn — the whole point of not restarting', () => {
        const messages = [user('task'), withCalls('c1'), withResults('c1'), assistant('progress')];
        const outcome = applySteering(messages, notes(queueWith('correction')));
        expect(outcome.messages.slice(0, 4)).toEqual(messages);
    });

    it('is a no-op with nothing pending', () => {
        const messages = [user('task')];
        const outcome = applySteering(messages, []);
        expect(outcome.messages).toBe(messages);
        expect(outcome.applied).toEqual([]);
    });

    it('defers rather than dropping when the conversation is empty', () => {
        const outcome = applySteering([], notes(queueWith('correction')));
        expect(outcome.applied).toEqual([]);
        expect(outcome.deferred).toHaveLength(1);
    });
});

// ─── The queue ──────────────────────────────────────────────────────────────

describe('SteeringQueue', () => {
    it('keeps every comment, not just the last', () => {
        // A user reading a plan leaves three comments in fifteen seconds; a single slot
        // would silently keep one, and the two dropped are the ones they assume landed.
        const queue = queueWith('first', 'second', 'third');
        expect(queue.pending).toBe(3);
        expect(queue.drain().map(n => n.text)).toEqual(['first', 'second', 'third']);
        expect(queue.pending).toBe(0);
    });

    it('ignores empty and whitespace-only comments', () => {
        const queue = new SteeringQueue();
        expect(queue.add('')).toBeUndefined();
        expect(queue.add('   \n ')).toBeUndefined();
        expect(queue.pending).toBe(0);
    });

    it('requeues a deferred note ahead of newer ones', () => {
        // Otherwise a note held back for one turn becomes the *last* thing the agent
        // reads, silently reversing the order the user wrote them in.
        const queue = queueWith('first');
        const [deferred] = queue.drain();
        queue.add('second', { at: 2_000 });
        queue.requeue(deferred);

        expect(queue.drain().map(n => n.text)).toEqual(['first', 'second']);
    });

    it('carries the artifact and region a comment was left on', () => {
        const queue = new SteeringQueue();
        const note = queue.add('this step is wrong', { artifactPath: '/a/plan.md', region: '3. Delete the cache' });
        expect(note?.artifactPath).toBe('/a/plan.md');
        expect(note?.region).toBe('3. Delete the cache');
    });

    it('gives each note a distinct id', () => {
        const queue = queueWith('a', 'b', 'c');
        expect(new Set(queue.peek().map(n => n.id)).size).toBe(3);
    });

    it('peek does not drain', () => {
        const queue = queueWith('a');
        queue.peek();
        expect(queue.pending).toBe(1);
    });
});

// ─── Rendering ──────────────────────────────────────────────────────────────

describe('renderSteering', () => {
    it('says the correction arrived now and outranks the plan', () => {
        // Rendered as ordinary context it gets weighed against the original task and
        // frequently loses — which looks exactly like steering not working.
        const text = renderSteering(notes(queueWith('use the existing helper')));
        expect(text).toContain('just sent a correction');
        expect(text).toContain('before continuing with the original plan');
        expect(text).toContain('use the existing helper');
    });

    it('counts multiple corrections', () => {
        expect(renderSteering(notes(queueWith('a', 'b')))).toContain('just sent 2 corrections');
    });

    it('quotes the artifact region so "this" has a referent', () => {
        const queue = new SteeringQueue();
        queue.add('wrong step', { artifactPath: 'plan.md', region: '3. Delete the cache' });
        const text = renderSteering(queue.drain());
        expect(text).toContain('On plan.md');
        expect(text).toContain('> 3. Delete the cache');
    });

    it('quotes a multi-line region on every line', () => {
        const queue = new SteeringQueue();
        queue.add('no', { artifactPath: 'plan.md', region: 'line one\nline two' });
        const text = renderSteering(queue.drain());
        expect(text).toContain('> line one');
        expect(text).toContain('> line two');
    });

    it('is empty for no notes', () => {
        expect(renderSteering([])).toBe('');
    });
});

describe('describeSteering', () => {
    it('names the artifact for the run log', () => {
        const queue = new SteeringQueue();
        const note = queue.add('narrower', { artifactPath: 'plan.md' })!;
        expect(describeSteering(note)).toBe('steering on plan.md: narrower');
    });

    it('flattens and truncates a long comment', () => {
        const queue = new SteeringQueue();
        const note = queue.add('x'.repeat(400) + '\nmore')!;
        const described = describeSteering(note);
        expect(described.length).toBeLessThan(140);
        expect(described).not.toContain('\n');
    });
});
