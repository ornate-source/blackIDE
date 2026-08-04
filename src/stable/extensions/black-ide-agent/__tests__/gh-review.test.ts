import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReviewFinding } from '../src/core/code-review';
import {
    buildGhReviewCommand, buildReviewPayload, parsePrTarget, reviewOutboundAction,
} from '../src/core/gh-review';
import { buildConfirmation, decideOutbound } from '../src/core/task-sources';
import { EGRESS_REGISTER } from '../src/core/egress';
import { readSource } from './source-roots';

/**
 * Posting a review to a pull request (Phase 9, M48 · P9-6).
 *
 * The acceptance clause is one sentence — "never ambient — posts only through the M67/M68
 * per-action confirmation, which cannot be granted in advance" — and most of this file
 * asserts that sentence rather than the feature. A review posted under someone's name to
 * a colleague's PR is the least reversible thing this product does.
 */

/** Declarations only. Several assertions here would otherwise match the prose that
 *  promises the property they are checking for. */
const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
    id: 'r-1', file: 'src/pagination.ts', line: 12, severity: 'high', category: 'correctness',
    summary: 'Slice end is off by one', confidence: 0.9,
    failureScenario: 'With size=10, pages 0 and 1 both contain item index 10.',
    ...over,
});

describe('the payload', () => {
    it('anchors findings with a line as inline comments', () => {
        // An inline comment is anchored to the diff and is what a reviewer reads; a
        // body-only review of nine findings is a wall nobody maps back to the code.
        const payload = buildReviewPayload([finding()]);
        expect(payload.comments).toHaveLength(1);
        expect(payload.comments[0]).toMatchObject({ path: 'src/pagination.ts', line: 12 });
        expect(payload.comments[0].body).toMatch(/Fails when:/);
    });

    it('puts findings without a line in the body rather than dropping them', () => {
        const payload = buildReviewPayload([finding({ line: 0 })]);
        expect(payload.comments).toHaveLength(0);
        expect(payload.body).toMatch(/Findings not anchored to a line/);
        expect(payload.body).toMatch(/Slice end is off by one/);
    });

    it('is always a COMMENT, never an approval or a change request', () => {
        /*
         * Both of the others are decisions about someone's work with process
         * consequences — a requested change blocks a merge, an approval unblocks one —
         * and neither is a call a locally-run model gets to make under the user's
         * identity. A comment says the same things and asserts nothing.
         */
        expect(buildReviewPayload([finding()]).event).toBe('COMMENT');
        expect(buildReviewPayload([]).event).toBe('COMMENT');
    });

    it('does not post code suggestions, even for findings that offer a fix locally', () => {
        // A generated suggestion on a colleague's PR under your name is a different
        // social act from one you wrote. The fix belongs in the editor.
        const payload = buildReviewPayload([finding({ confidence: 0.95, suggestedFix: 'return items.slice(start, start + size);' })]);
        expect(payload.comments[0].body).not.toMatch(/```suggestion/);
        expect(payload.comments[0].body).toMatch(/available in the editor/);
    });

    it('says who produced it, so a reader knows what they are reading', () => {
        expect(buildReviewPayload([finding()], { model: 'claude-sonnet-5' }).body)
            .toMatch(/Produced by Black IDE using claude-sonnet-5/);
    });

    it('posts a clean review rather than nothing, and does not claim correctness', () => {
        const payload = buildReviewPayload([]);
        expect(payload.body).toMatch(/no findings/i);
        expect(payload.body).toMatch(/not a guarantee it is correct/);
    });

    it('caps inline comments AND says it capped them', () => {
        // A review that shows twenty of thirty findings without saying so reads as a
        // complete review, which is worse than posting fewer.
        const many = Array.from({ length: 30 }, (_, i) => finding({ id: `r-${i}`, line: i + 1 }));
        const payload = buildReviewPayload(many, { maxInline: 20 });
        expect(payload.comments).toHaveLength(20);
        expect(payload.body).toMatch(/10 further finding\(s\) were not posted/);
    });
});

describe('the confirmation shows what will actually be sent', () => {
    it('carries every inline comment into the body the user reads', () => {
        /*
         * The gate's whole value. A dialogue saying "post 9 comments to #123?" asks the
         * user to approve something they have not read, and `buildConfirmation` shows
         * `action.body` verbatim — so the body has to be the real thing.
         */
        const payload = buildReviewPayload([finding(), finding({ id: 'r-2', line: 40, summary: 'Second defect' })]);
        const action = reviewOutboundAction({ owner: 'o', repo: 'r', number: 7, title: 'Fix paging' }, payload);
        expect(action.body).toMatch(/Slice end is off by one/);
        expect(action.body).toMatch(/Second defect/);
        expect(action.body).toMatch(/src\/pagination\.ts:40/);
        expect(action.destination).toBe('o/r#7 (Fix paging)');
    });

    it('warns that it is public, attributed and permanent', () => {
        const payload = buildReviewPayload([finding()]);
        const confirmation = buildConfirmation(reviewOutboundAction({ owner: 'o', repo: 'r', number: 7 }, payload));
        expect(confirmation.prompt).toMatch(/visible to everyone/);
        expect(confirmation.prompt).toMatch(/under your account/);
        expect(confirmation.prompt).toMatch(/cannot be unsent/);
    });
});

describe('never ambient', () => {
    const action = reviewOutboundAction({ owner: 'o', repo: 'r', number: 7 }, buildReviewPayload([finding()]));

    it('an unconfirmed post is refused, and the refusal says there is no "always allow"', () => {
        const decision = decideOutbound(action, { allowExternalPosting: true, confirmedNow: false });
        expect(decision.allowed).toBe(false);
        expect(decision.allowed === false && decision.reason).toMatch(/no "always allow"/);
    });

    it('org policy can forbid it outright, over a fresh confirmation', () => {
        expect(decideOutbound(action, { allowExternalPosting: false, confirmedNow: true }).allowed).toBe(false);
    });

    it('only a confirmation given now allows it', () => {
        expect(decideOutbound(action, { allowExternalPosting: true, confirmedNow: true }).allowed).toBe(true);
    });

    it('the outbound context has no field a standing grant could be stored in', () => {
        /*
         * The structural version of the clause, and the one that survives a refactor.
         * A "don't ask me again" checkbox is the natural feature request and is exactly
         * what makes this an ambient bot: the tenth post is authorised by a click from
         * three weeks ago on a different repository. There is no field for it, so adding
         * one means changing a type a reviewer sees.
         */
        const source = readSource('core', 'task-sources.ts');
        const context = source.match(/export interface OutboundContext \{[\s\S]*?\n\}/)?.[0] || '';
        expect(context).toBeTruthy();
        expect(context).toMatch(/confirmedNow/);

        // Fields only. The doc comments in this block say "there is deliberately no
        // standing grant", so matching the prose would fail on the sentence that promises
        // the property — the assertion has to look at the declarations.
        const fields = stripComments(context);
        expect(fields).not.toMatch(/alwaysAllow|remember|standing|persist|dontAsk|skipConfirm/i);
    });

    it('the command is the only caller, and it is not chained to running a review', () => {
        // Chaining "review, then offer to post" would put the posting decision inside the
        // flow of a local action taken for the user's own benefit, which is how a
        // per-action confirmation becomes a dialogue people click through.
        const source = readSource('core', 'review-command.ts');
        expect(source).toMatch(/registerCommand\('black-ide\.postReviewToPr'/);

        // A *call*, not a mention — `reviewChanges` comments explain why the two are not
        // chained, and a bare name match would fail on the explanation.
        const reviewChanges = stripComments(source.match(/async function reviewChanges[\s\S]*?\n\}/)?.[0] || '');
        expect(reviewChanges).toBeTruthy();
        expect(reviewChanges).not.toMatch(/postReviewToPr\(|buildGhReviewCommand\(|ghInput\(/);
    });
});

describe('the gh invocation', () => {
    it('is an argv with the payload on stdin, never an interpolated shell string', () => {
        /*
         * The body contains a model's prose about a diff — backticks, quotes, `$(…)` if a
         * finding quotes shell code. This is the one call in the codebase where untrusted
         * text meets a command line, so it never becomes one.
         */
        const command = buildGhReviewCommand({ owner: 'o', repo: 'r', number: 7 });
        expect(command.argv).toEqual([
            'api', '--method', 'POST', 'repos/o/r/pulls/7/reviews', '--input', '-',
        ]);
        const hostile = buildReviewPayload([finding({ summary: '`rm -rf /` $(whoami) "quoted"' })]);
        const stdin = command.stdin(hostile);
        // It is JSON, so the metacharacters are data.
        expect(() => JSON.parse(stdin)).not.toThrow();
        expect(JSON.parse(stdin).comments[0].body).toContain('rm -rf /');
    });
});

describe('resolving the pull request', () => {
    it('reads number, title and slug', () => {
        const target = parsePrTarget(JSON.stringify({
            number: 42, title: 'Fix paging', headRepository: { nameWithOwner: 'acme/widgets' },
        }));
        expect(target).toEqual({ owner: 'acme', repo: 'widgets', number: 42, title: 'Fix paging' });
    });

    it('accepts the slug from the caller when gh did not supply one', () => {
        expect(parsePrTarget(JSON.stringify({ number: 42 }), 'acme/widgets'))
            .toMatchObject({ owner: 'acme', repo: 'widgets', number: 42 });
    });

    it('returns undefined rather than a partial target', () => {
        // A review posted to the wrong PR number is the failure this feature must not
        // have, and half a target is how you get one.
        expect(parsePrTarget('not json')).toBeUndefined();
        expect(parsePrTarget(JSON.stringify({ number: 42 }))).toBeUndefined();
        expect(parsePrTarget(JSON.stringify({ headRepository: { nameWithOwner: 'a/b' } }))).toBeUndefined();
        expect(parsePrTarget(JSON.stringify({ number: 0, headRepository: { nameWithOwner: 'a/b' } }))).toBeUndefined();
    });
});

describe('it is declared egress', () => {
    it('review-command.ts is registered, as a user action', () => {
        const point = EGRESS_REGISTER.find(p => p.module === 'core/review-command.ts');
        expect(point, 'a module that runs `gh api` must be registered').toBeTruthy();
        expect(point!.trigger).toBe('user-action');
        expect(point!.why).toMatch(/cannot be granted in advance/);
    });
});
