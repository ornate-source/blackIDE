import { describe, expect, it } from 'vitest';
import {
    ARTIFACT_TYPES, ArtifactRecord, addComment, artifactFilename, artifactId, evidenceCoverage,
    extensionFor, groupForReview, hasVerificationEvidence, isBinaryArtifact, markDelivered,
    undeliveredComments,
} from '../src/core/artifacts';

/**
 * Phase 7, M38 — typed artifacts.
 *
 * The existing `ArtifactManager` accepted a type, dropped it, and then hardcoded
 * `type: 'report'` when listing — so the type has been accepted, ignored and misreported
 * since Feature 18, and nothing noticed because nothing rendered it. That is the shape of
 * defect this model exists to make impossible: type is carried in the record *and* in the
 * filename, so the directory stays legible even if the index is lost.
 */

const record = (over: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
    id: 'a1', runId: 'run_1', type: 'plan', title: 'Plan', path: '/a/plan.md', createdAt: 1_000, ...over,
});

describe('the type model', () => {
    it('covers every type the milestone names', () => {
        expect([...ARTIFACT_TYPES].sort()).toEqual(
            ['diff', 'plan', 'recording', 'screenshot', 'task-list', 'test-report', 'walkthrough'],
        );
    });

    it('knows which types are not text', () => {
        expect(isBinaryArtifact('screenshot')).toBe(true);
        expect(isBinaryArtifact('recording')).toBe(true);
        expect(isBinaryArtifact('plan')).toBe(false);
        expect(isBinaryArtifact('test-report')).toBe(false);
    });

    it('gives binary types a real extension rather than .md', () => {
        expect(extensionFor('screenshot')).toBe('.png');
        expect(extensionFor('recording')).toBe('.webm');
        expect(extensionFor('diff')).toBe('.diff');
        expect(extensionFor('plan')).toBe('.md');
    });
});

describe('filenames keep the type visible', () => {
    it('encodes run and type, so the directory is legible without the index', () => {
        const name = artifactFilename({ runId: 'run_1', type: 'test-report', title: 'Verification' }, '.md');
        expect(name).toBe('run_1__test-report__Verification.md');
    });

    it('sanitises a hostile title', () => {
        const name = artifactFilename({ runId: 'r/1', type: 'plan', title: '../../etc/passwd' }, '.md');
        expect(name).not.toContain('..');
        expect(name).not.toContain('/');
    });

    it('falls back to the type when the title sanitises to nothing', () => {
        expect(artifactFilename({ runId: 'r', type: 'diff', title: '///' }, '.diff')).toContain('__diff__diff');
    });

    it('accepts an extension with or without the dot', () => {
        expect(artifactFilename({ runId: 'r', type: 'plan', title: 't' }, 'md')).toMatch(/\.md$/);
        expect(artifactFilename({ runId: 'r', type: 'plan', title: 't' }, '.md')).toMatch(/\.md$/);
    });

    it('bounds a very long title', () => {
        const name = artifactFilename({ runId: 'r', type: 'plan', title: 'x'.repeat(500) }, '.md');
        expect(name.length).toBeLessThan(120);
    });
});

describe('artifactId', () => {
    it('is distinct for artifacts of the same type in the same run', () => {
        const ids = new Set(Array.from({ length: 20 }, (_, i) => artifactId('run_1', 'diff', 1_000, i)));
        expect(ids.size).toBe(20);
    });
});

describe('review ordering groups by run', () => {
    it('keeps a run\'s artifacts together instead of interleaving four agents', () => {
        // A flat newest-first list means reviewing one run is reading every fourth card,
        // which Phase 6 made the normal case.
        const groups = groupForReview([
            record({ id: '1', runId: 'A', createdAt: 100 }),
            record({ id: '2', runId: 'B', createdAt: 110 }),
            record({ id: '3', runId: 'A', createdAt: 120 }),
            record({ id: '4', runId: 'B', createdAt: 90 }),
        ]);
        expect(groups.map(g => g.runId)).toEqual(['A', 'B']);
        expect(groups[0].artifacts.map(a => a.id)).toEqual(['3', '1']);
    });

    it('orders groups by their most recent artifact', () => {
        const groups = groupForReview([
            record({ runId: 'old', createdAt: 10 }),
            record({ runId: 'new', createdAt: 500 }),
        ]);
        expect(groups[0].runId).toBe('new');
    });

    it('handles an empty set', () => {
        expect(groupForReview([])).toEqual([]);
        expect(groupForReview(undefined as any)).toEqual([]);
    });
});

describe('verification evidence (the M40 half of the gate)', () => {
    it('detects a run that emitted a test report', () => {
        const records = [record({ runId: 'r1', type: 'test-report' }), record({ runId: 'r2', type: 'plan' })];
        expect(hasVerificationEvidence(records, 'r1')).toBe(true);
        expect(hasVerificationEvidence(records, 'r2')).toBe(false);
    });

    it('does not accept a plan as evidence', () => {
        expect(hasVerificationEvidence([record({ runId: 'r', type: 'walkthrough' })], 'r')).toBe(false);
    });

    it('measures coverage across runs, which is what the gate is stated in', () => {
        const records = [
            record({ runId: 'a', type: 'test-report' }),
            record({ runId: 'b', type: 'test-report' }),
            record({ runId: 'c', type: 'plan' }),
        ];
        expect(evidenceCoverage(records, ['a', 'b', 'c', 'd'])).toBe(0.5);
        expect(evidenceCoverage(records, ['a', 'b'])).toBe(1);
    });

    it('is 1 for no runs rather than 0, so an idle session is not a failure', () => {
        expect(evidenceCoverage([], [])).toBe(1);
    });
});

describe('comments', () => {
    it('attaches without mutating the original', () => {
        // Artifacts cross a postMessage boundary; mutating one in place is how a panel
        // renders a comment the extension host has not persisted.
        const original = record();
        const updated = addComment(original, 'this step is wrong', { at: 2_000 });
        expect(original.comments).toBeUndefined();
        expect(updated.comments).toHaveLength(1);
    });

    it('keeps the quoted region, so "this" has a referent', () => {
        const updated = addComment(record(), 'wrong', { region: '3. Delete the cache', at: 1 });
        expect(updated.comments?.[0].region).toBe('3. Delete the cache');
    });

    it('ignores an empty comment', () => {
        expect(addComment(record(), '   ')).toEqual(record());
    });

    it('accumulates in order', () => {
        let r = addComment(record(), 'first', { at: 1 });
        r = addComment(r, 'second', { at: 2 });
        expect(r.comments?.map(c => c.text)).toEqual(['first', 'second']);
    });

    it('gives comments distinct ids', () => {
        let r = addComment(record(), 'a', { at: 1 });
        r = addComment(r, 'b', { at: 1 });
        expect(r.comments![0].id).not.toBe(r.comments![1].id);
    });
});

describe('delivery tracking', () => {
    it('lists undelivered comments oldest first, across artifacts', () => {
        const a = addComment(record({ id: 'a', path: '/a.md' }), 'later', { at: 200 });
        const b = addComment(record({ id: 'b', path: '/b.md' }), 'earlier', { at: 100 });
        expect(undeliveredComments([a, b]).map(x => x.comment.text)).toEqual(['earlier', 'later']);
    });

    it('stops listing a comment once it has been delivered', () => {
        const withComment = addComment(record(), 'note', { at: 1, id: 'c1' });
        const delivered = markDelivered(withComment, ['c1']);
        expect(undeliveredComments([delivered])).toEqual([]);
    });

    it('marks only the named comments', () => {
        let r = addComment(record(), 'one', { at: 1, id: 'c1' });
        r = addComment(r, 'two', { at: 2, id: 'c2' });
        const delivered = markDelivered(r, ['c1']);
        expect(delivered.comments?.map(c => !!c.delivered)).toEqual([true, false]);
    });

    it('does not mutate on delivery either', () => {
        const withComment = addComment(record(), 'note', { at: 1, id: 'c1' });
        markDelivered(withComment, ['c1']);
        expect(withComment.comments?.[0].delivered).toBeUndefined();
    });

    it('tolerates artifacts with no comments', () => {
        expect(undeliveredComments([record()])).toEqual([]);
        expect(undeliveredComments(undefined as any)).toEqual([]);
    });
});
