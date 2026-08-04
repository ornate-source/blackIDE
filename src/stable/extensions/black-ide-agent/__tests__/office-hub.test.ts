import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentGovernor } from '@blackide/agent-core/core/agent-governor';
import { TaskAgentSummary } from '@blackide/agent-core/core/task-agents';
import { buildInbox } from '@blackide/agent-core/core/agent-inbox';
import { OfficeHub } from '../src/core/office-hub';
import { JournalStore } from '../src/agent/journal-store';

/**
 * The hub, driven the way a real run drives it.
 *
 * The pure modules are tested exhaustively elsewhere; what this covers is the join — the
 * part where an event a lane emits has to become a desk field, a patch on the wire, a
 * journal line, and nothing else. It is the piece with no compiler support and the piece
 * where the previous three agent surfaces drifted apart.
 */

describe('a run, from first tool call to finished desk', () => {
    let dir: string;
    let posted: any[];
    let now: number;
    let agents: TaskAgentSummary[];
    let hub: OfficeHub;
    let journal: JournalStore;

    const agent = (over: Partial<TaskAgentSummary> = {}): TaskAgentSummary => ({
        id: 'ta_1', prompt: 'rebuild the nav header', modelId: 'sonnet', mode: 'Frontend',
        rootPath: '/repo', branch: 'blackide/agent/ta_1', status: 'running', startedAt: 1_000, ...over,
    });

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
        posted = [];
        now = 10_000;
        agents = [agent()];
        journal = new JournalStore({ directory: dir, now: () => now });
        hub = new OfficeHub({
            journal,
            listAgents: () => agents,
            listPipelines: () => [],
            listInbox: () => buildInbox([], agents, { now }),
            governorSnapshot: () => new AgentGovernor({ maxConcurrent: 4, costBudget: 5 }).snapshot(),
            post: (message) => { posted.push(message); return true; },
            now: () => now,
        });
    });
    afterEach(() => { hub.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });

    const drain = () => { now += 1_000; (hub as any).drain(); };

    it('turns a tool call into the sentence on the desk', () => {
        hub.record('ta_1', { type: 'ToolCallStarted', name: 'read_file', arguments: { path: 'src/store/apiSlice.tsx' }, ts: now });
        const [item] = hub.snapshot().items;
        expect(item.activity).toMatchObject({ verb: 'opened', label: 'apiSlice.tsx', dir: 'src/store/' });
    });

    it('clears the sentence when the tool finishes', () => {
        // A desk reading `editing NavHeader.tsx` through the thirty seconds the model then
        // spends thinking is actively misleading about where the time went.
        hub.record('ta_1', { type: 'ToolCallStarted', name: 'edit_file', arguments: { path: 'a.ts' }, ts: now });
        hub.record('ta_1', { type: 'ToolCallFinished', name: 'edit_file', ok: true, ts: now });
        expect(hub.snapshot().items[0].activity).toBeUndefined();
    });

    it('does not clear it when a *different* tool finishes', () => {
        // Two tool calls can overlap in the loop; a late finish for the previous one must
        // not blank the current one's line.
        hub.record('ta_1', { type: 'ToolCallStarted', name: 'edit_file', arguments: { path: 'a.ts' }, ts: now });
        hub.record('ta_1', { type: 'ToolCallFinished', name: 'read_file', ok: true, ts: now });
        expect(hub.snapshot().items[0].activity?.tool).toBe('edit_file');
    });

    it('reports turn and context as measurements, rounding the percentage once', () => {
        hub.record('ta_1', { type: 'TurnStarted', turn: 7, maxTurns: 25 });
        hub.record('ta_1', { type: 'ContextUsed', usedTokens: 18_000, limitTokens: 25_000 });
        const [item] = hub.snapshot().items;
        expect(item.progress).toEqual({ turn: 7, maxTurns: 25 });
        expect(item.context).toEqual({ usedTokens: 18_000, limitTokens: 25_000, percent: 72 });
    });

    it('ignores a context report with no limit rather than dividing by zero', () => {
        hub.record('ta_1', { type: 'ContextUsed', usedTokens: 100, limitTokens: 0 });
        expect(hub.snapshot().items[0].context).toBeUndefined();
    });

    it('puts a changed file on the table, saying who touched it', () => {
        hub.record('ta_1', { type: 'FileChanged', path: 'src/NavHeader.tsx', kind: 'modified' });
        expect(hub.filesInPlay()).toEqual([
            { path: 'src/NavHeader.tsx', by: 'ta_1', kind: 'modified', at: now },
        ]);
    });

    it('does not list the same file twice when an agent edits it repeatedly', () => {
        hub.record('ta_1', { type: 'FileChanged', path: 'a.ts', kind: 'created' });
        now += 5_000;
        hub.record('ta_1', { type: 'FileChanged', path: 'a.ts', kind: 'modified' });
        expect(hub.filesInPlay()).toHaveLength(1);
        expect(hub.filesInPlay()[0].kind).toBe('modified');
    });

    it('sends patches, not whole rosters, while a run is in flight', () => {
        hub.record('ta_1', { type: 'TurnStarted', turn: 1, maxTurns: 25 });
        drain();
        const patches = posted.filter(m => m.type === 'officePatch');
        expect(patches).toHaveLength(1);
        expect(patches[0].value).toEqual({ id: 'ta_1', fields: { progress: { turn: 1, maxTurns: 25 } } });
        expect(posted.filter(m => m.type === 'officeSync')).toHaveLength(0);
    });

    it('flushes immediately when the run ends, because lateness there is a lie', () => {
        hub.record('ta_1', { type: 'ToolCallStarted', name: 'edit_file', arguments: { path: 'a.ts' }, ts: now });
        hub.record('ta_1', { type: 'TaskCompleted' });
        // No drain: the terminal event forces its own flush.
        expect(posted.some(m => m.type === 'officePatch')).toBe(true);
    });

    it('journals the run as it goes, with no panel involved', () => {
        hub.journalEvent('ta_1', 'task', { type: 'TaskStarted', prompt: 'rebuild', mode: 'agent', model: 'sonnet', ts: now });
        hub.journalEvent('ta_1', 'task', { type: 'ToolStarted', name: 'read_file', arguments: { path: 'a.ts' }, ts: now });
        const page = hub.readLog('ta_1', { depth: 'verbose' })!;
        expect(page.lines.map(l => l.verb)).toEqual(['run started', 'opened']);
    });

    it('renders a log for a model with the truncation stated', () => {
        // A model handed 2 of 500 lines with no indication reasons as though it saw the run.
        hub.journalEvent('ta_1', 'task', { type: 'TaskStarted', prompt: 'p', mode: 'agent', model: 'm', ts: now });
        for (let i = 0; i < 40; i++) {
            hub.journalEvent('ta_1', 'task', { type: 'TurnStarted', turn: i, maxTurns: 25, ts: now });
        }
        const text = hub.readLogForModel({ runId: 'ta_1', depth: 'summary', limit: 5 })!;
        expect(text).toContain('Showing 5 of 41 lines');
        expect(text).toContain('turns');
    });

    it('tells a model plainly when a depth has nothing, rather than returning empty', () => {
        hub.journalEvent('ta_1', 'task', { type: 'Log', level: 'info', message: 'verbose only', ts: now });
        const text = hub.readLogForModel({ runId: 'ta_1', depth: 'summary' })!;
        expect(text).toContain('no summary-level lines');
        expect(text).toContain('normal');
    });

    it('closes and sweeps the journal once the run reaches a terminal event', () => {
        hub.journalEvent('ta_1', 'task', { type: 'TaskStarted', prompt: 'p', mode: 'agent', model: 'm', ts: now });
        hub.journalEvent('ta_1', 'task', { type: 'TaskCompleted', turns: 1, durationMs: 1, ts: now });
        // Still readable — closing releases it for retention, it does not delete it.
        expect(hub.readLog('ta_1', { depth: 'summary' })!.lines).toHaveLength(2);
    });

    it('drops an event with no run to belong to', () => {
        hub.journalEvent(undefined, 'chat', { type: 'TaskStarted', prompt: 'p', mode: 'agent', model: 'm' });
        expect(hub.listLogs()).toHaveLength(0);
    });

    it('seats the agent at a desk and frees the rest', () => {
        const snapshot = hub.snapshot();
        expect(snapshot.desks.filter(d => d.kind === 'occupied')).toHaveLength(1);
        expect(snapshot.desks.filter(d => d.kind === 'free')).toHaveLength(3);
        expect(snapshot.capacity).toBe(4);
    });

    it('moves a finished agent from running to ready, and into the inbox', () => {
        agents = [agent({ status: 'completed', endedAt: 12_000 })];
        const snapshot = hub.snapshot();
        expect(snapshot.items[0].status).toBe('ready');
        expect(snapshot.items[0].needs).toBe('review');
        expect(snapshot.counts.review).toBe(1);
    });

    it('forgets a retired item so its telemetry cannot outlive it', () => {
        hub.record('ta_1', { type: 'TurnStarted', turn: 3, maxTurns: 25 });
        hub.forget('ta_1');
        expect(hub.snapshot().items[0].progress).toBeUndefined();
        expect(hub.filesInPlay()).toHaveLength(0);
    });
});

describe('when nothing is watching', () => {
    it('stops at the publish gate rather than building a snapshot', () => {
        // The rule is that nothing is *computed* for a closed surface — the panel already
        // drops posts, but by then the producer has done all the work.
        let built = 0;
        const hub = new OfficeHub({
            listAgents: () => { built++; return []; },
            listPipelines: () => [],
            listInbox: () => [],
            governorSnapshot: () => new AgentGovernor().snapshot(),
            post: () => false,
            now: () => 0,
        });

        hub.sync();
        const afterSync = built;
        hub.record('x', { type: 'FileChanged', path: 'a.ts', kind: 'modified' });
        // `syncFiles` short-circuits on the closed surface without re-listing the lanes.
        expect(built).toBe(afterSync);
        hub.dispose();
    });
});
