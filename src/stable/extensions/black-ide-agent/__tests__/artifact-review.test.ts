import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    MAX_REGION_CHARS, buildReviewView, clipRegion, reviewCounts, routeComment,
} from '../src/core/artifact-review';
import { ArtifactRecord, addComment } from '../src/core/artifacts';
import { SteeringQueue, applySteering, renderSteering } from '../src/core/steering';

/**
 * The artifact review panel (Phase 7, M38's outstanding half).
 *
 * M38 shipped the typed store, the index and a comment API; the surface that reads them
 * was never built, which is why the milestone has been 🟡 since the phase closed. The gate
 * clause is one sentence — "a comment on an artifact region reaches the running agent
 * within one turn" — and it has been unmeetable because there was nowhere to leave the
 * comment.
 *
 * Two properties carry the weight here:
 *
 *   1. **A comment is never silently dropped.** Most review happens after a run ends, so
 *      refusing comments on finished runs would gut the feature; accepting them while
 *      implying they were delivered would be worse. Both branches are asserted.
 *   2. **The region reaches the model attached to its artifact.** A context-free "no, not
 *      like that" is the degraded form this panel exists to replace.
 */

const record = (over: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
    id: 'a1', runId: 'agent_1', type: 'plan', title: 'Implementation plan',
    path: '/artifacts/agent_1__plan__Implementation-plan.md', createdAt: 1_000, ...over,
});

// ─── Browsing ───────────────────────────────────────────────────────────────

describe('the panel browses by run and by type', () => {
    const records: ArtifactRecord[] = [
        record({ id: 'a1', runId: 'agent_1', type: 'plan', createdAt: 100 }),
        record({ id: 'a2', runId: 'agent_1', type: 'test-report', createdAt: 300 }),
        record({ id: 'a3', runId: 'agent_2', type: 'diff', createdAt: 200 }),
        record({ id: 'a4', runId: 'agent_2', type: 'screenshot', createdAt: 400 }),
    ];

    it('groups by run, most recently active run first', () => {
        const view = buildReviewView(records);
        expect(view.map(g => g.runId)).toEqual(['agent_2', 'agent_1']);
        // Newest first *within* a run — the story of one run stays together.
        expect(view[0].artifacts.map(a => a.id)).toEqual(['a4', 'a3']);
    });

    it('filters by type without losing the grouping', () => {
        const view = buildReviewView(records, { type: 'plan' });
        expect(view).toHaveLength(1);
        expect(view[0].artifacts.map(a => a.id)).toEqual(['a1']);
    });

    it('filters to one run', () => {
        expect(buildReviewView(records, { runId: 'agent_2' }).map(g => g.runId)).toEqual(['agent_2']);
    });

    it('marks the runs a comment can still reach', () => {
        const view = buildReviewView(records, { liveRunIds: ['agent_1'] });
        expect(view.find(g => g.runId === 'agent_1')!.live).toBe(true);
        expect(view.find(g => g.runId === 'agent_2')!.live).toBe(false);
    });

    it('tells the panel which artifacts it must render rather than read', () => {
        const view = buildReviewView(records);
        const screenshot = view.flatMap(g => g.artifacts).find(a => a.type === 'screenshot')!;
        const plan = view.flatMap(g => g.artifacts).find(a => a.type === 'plan')!;
        expect(screenshot.binary).toBe(true);
        expect(plan.binary).toBe(false);
    });

    it('counts by type for the filter chips', () => {
        const counts = reviewCounts(records);
        expect(counts.total).toBe(4);
        expect(counts.runs).toBe(2);
        expect(counts.byType.plan).toBe(1);
        expect(counts.byType.screenshot).toBe(1);
    });

    it('survives an empty store rather than throwing at an empty panel', () => {
        expect(buildReviewView([])).toEqual([]);
        expect(reviewCounts([])).toEqual({ total: 0, runs: 0, byType: {} });
    });
});

// ─── Routing a comment ──────────────────────────────────────────────────────

describe('a comment on an artifact goes where it can actually go', () => {
    it('steers the agent when its run is still live', () => {
        const routing = routeComment({
            artifact: record(), text: 'Use the existing helper.', region: 'export function parse(',
            liveRunIds: ['agent_1'],
        });
        expect(routing.delivery).toBe('steered');
        expect(routing.runId).toBe('agent_1');
        expect(routing.note).toEqual({
            text: 'Use the existing helper.',
            artifactPath: '/artifacts/agent_1__plan__Implementation-plan.md',
            region: 'export function parse(',
        });
    });

    it('stores — and says so — when the run has finished', () => {
        const routing = routeComment({ artifact: record(), text: 'This was the wrong approach.', liveRunIds: [] });
        expect(routing.delivery).toBe('stored');
        expect(routing.note).toBeUndefined();
        // The message is the whole safety property: a user who believes a finished run
        // was corrected is the failure this surface must not produce.
        expect(routing.message).toMatch(/finished/);
        expect(routing.message).toMatch(/nothing was steered/);
    });

    it('never claims delivery for a run that merely shares a prefix', () => {
        const routing = routeComment({ artifact: record({ runId: 'agent_1' }), text: 'x', liveRunIds: ['agent_12'] });
        expect(routing.delivery).toBe('stored');
    });

    it('refuses an empty comment instead of queueing a blank turn', () => {
        for (const text of ['', '   ', '\n\t']) {
            expect(routeComment({ artifact: record(), text, liveRunIds: ['agent_1'] }).delivery).toBe('stored');
        }
    });

    it('trims a selection that would displace the context it is a comment on', () => {
        const huge = Array.from({ length: 200 }, (_, i) => `line ${i} of a very long plan`).join('\n');
        const routing = routeComment({ artifact: record(), text: 'wrong', region: huge, liveRunIds: ['agent_1'] });
        expect(routing.note!.region!.length).toBeLessThanOrEqual(MAX_REGION_CHARS + 40);
        expect(routing.note!.region).toMatch(/selection truncated/);
    });

    it('clips on a line boundary, so the model does not read half a token', () => {
        const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
        const clipped = clipRegion(lines)!;
        expect(clipped.split('\n').slice(-2)[0]).toMatch(/^line \d+$/);
    });

    it('leaves a short selection exactly as the user made it', () => {
        expect(clipRegion('  const x = 1;  ')).toBe('const x = 1;');
        expect(clipRegion('')).toBeUndefined();
        expect(clipRegion(undefined)).toBeUndefined();
    });
});

// ─── The gate clause, end to end over the pure path ─────────────────────────

describe('a region comment reaches the running agent within one turn', () => {
    it('travels from the panel to the model\'s next turn, carrying its artifact and region', () => {
        // The M39 path, driven by what the review panel produces rather than by the
        // context-free Steer button.
        const artifact = record();
        const routing = routeComment({
            artifact,
            text: 'This step reimplements `applySearchReplace`. Reuse it.',
            region: '3. Write a new search/replace applier',
            liveRunIds: ['agent_1'],
        });
        expect(routing.delivery).toBe('steered');

        const queue = new SteeringQueue();
        queue.add(routing.note!.text, { artifactPath: routing.note!.artifactPath, region: routing.note!.region });
        expect(queue.pending).toBe(1);

        // One turn later: the loop drains at the top of the turn and folds the note in.
        const conversation = [
            { role: 'user' as const, content: 'Build the thing' },
            { role: 'assistant' as const, content: 'Here is the plan' },
        ];
        const applied = applySteering(conversation, queue.drain());
        expect(applied.applied).toHaveLength(1);
        expect(applied.deferred).toHaveLength(0);

        const text = String(applied.messages[applied.messages.length - 1].content);
        expect(text).toContain('Reuse it.');
        expect(text).toContain(artifact.path);
        expect(text).toContain('3. Write a new search/replace applier');
    });

    it('still refuses to land between a tool_use and its result', () => {
        // The panel is a new caller of an old invariant; a new entry point must not be a
        // way around it.
        const routing = routeComment({ artifact: record(), text: 'stop', liveRunIds: ['agent_1'] });
        const mid = [
            { role: 'user' as const, content: 'go' },
            { role: 'assistant' as const, content: '', toolCalls: [{ id: 't1', name: 'read_file', arguments: {} }] },
        ];
        const applied = applySteering(mid as any, [{ id: 's1', at: 1, text: routing.note!.text, artifactPath: routing.note!.artifactPath }]);
        expect(applied.applied).toEqual([]);
        expect(applied.deferred).toHaveLength(1);
    });

    it('renders the artifact and the quote so "this" has a referent', () => {
        const rendered = renderSteering([{
            id: 's1', at: 1, text: 'Not this one.',
            artifactPath: '/artifacts/agent_1__diff__change.diff',
            region: '-  return a + b;',
        }]);
        expect(rendered).toContain('/artifacts/agent_1__diff__change.diff');
        expect(rendered).toContain('> -  return a + b;');
    });
});

// ─── Persistence ────────────────────────────────────────────────────────────

describe('comments outlive the run they were left on', () => {
    it('is delivered only once, so a redraw cannot re-send it', () => {
        const commented = addComment(record(), 'Look at this again', { region: 'line 3', at: 5 });
        expect(commented.comments).toHaveLength(1);
        expect(commented.comments![0].delivered).toBeUndefined();
    });
});

// ─── The wiring ─────────────────────────────────────────────────────────────

describe('the panel is actually reachable', () => {
    const src = (...parts: string[]) => fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8');
    const web = (...parts: string[]) => fs.readFileSync(path.join(__dirname, '..', 'webview', 'src', ...parts), 'utf8');
    const panel = src('core', 'manager-panel.ts');

    it('handles every message the review surface sends', () => {
        for (const message of ['listArtifacts', 'readArtifact', 'openArtifact', 'commentArtifact']) {
            expect(panel, message).toContain(`case '${message}'`);
        }
    });

    it('routes a comment through routeComment rather than a second copy of the rule', () => {
        expect(panel).toMatch(/routeComment\(/);
        expect(panel).toMatch(/liveRunIds: this\._host\.taskAgents\.liveIds\(\)/);
    });

    it('persists the comment before it steers, and marks it delivered only after', () => {
        const block = panel.slice(panel.indexOf("case 'commentArtifact'"), panel.indexOf("case 'raceOutcome'"));
        expect(block.indexOf('artifacts.comment(')).toBeLessThan(block.indexOf('taskAgents.steer('));
        expect(block.indexOf('taskAgents.steer(')).toBeLessThan(block.indexOf('markCommentsDelivered'));
        // A steer that fails must not leave a comment claiming it was sent.
        expect(block).toMatch(/if \('error' in result\)/);
    });

    it('asks the registry which agents are live, from the map steer itself uses', () => {
        expect(src('agent', 'task-agent-registry.ts')).toMatch(/liveIds\(\): string\[\]/);
        expect(src('agent', 'task-agent-lane.ts')).toMatch(/liveIds\(\)/);
    });

    it('serves a screenshot through a webview URI, not a file:// path the CSP blocks', () => {
        expect(panel).toMatch(/asWebviewUri/);
        expect(panel).toMatch(/localResourceRoots[\s\S]{0,800}artifacts\.directory/);
    });

    it('renders the surface, with the region-comment affordance', () => {
        const review = web('ArtifactReview.tsx');
        expect(review).toMatch(/commentArtifact/);
        expect(review).toMatch(/getSelection/);
        expect(review).toMatch(/region/);
        // And the panel mounts it behind its own tab.
        expect(web('ManagerPanel.tsx')).toMatch(/<ArtifactReview/);
        expect(web('ManagerPanel.tsx')).toMatch(/'pipeline', 'agent', 'review'/);
    });

    it('tells the user which of the two things happened to their comment', () => {
        const review = web('ArtifactReview.tsx');
        expect(review).toMatch(/reaches the agent on its next turn/);
        expect(review).toMatch(/saved with the artifact rather than sent/);
    });
});
