import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    MAX_DETAIL_BYTES, atOrBelow, formatJournalLine, toJournalLines,
} from '@blackide/agent-core/core/run-journal';
import { parseJournal, readPage, readTail, summarize } from '@blackide/agent-core/core/journal-reader';
import { JournalStore } from '../src/agent/journal-store';

/**
 * The run journal — the durable half of the Agent Office.
 *
 * Three properties carry the feature, and each is here because getting it wrong would be
 * invisible until the moment somebody needed the log:
 *
 *   **It survives an interrupted run.** The file is appended to by a process the user can
 *   kill at any moment, so a half-written final line is the *normal* ending of exactly the
 *   run whose log matters most. Refusing to parse it would lose the evidence.
 *
 *   **It is redacted on write.** The tab offers "open as file"; a journal that is only
 *   clean when rendered leaks the first time anyone takes it up on that.
 *
 *   **It is bounded, and a live run is never pruned.** The failure mode of a verbose log
 *   is a full disk; the failure mode of an over-eager sweep is deleting the trace of the
 *   agent that is running right now.
 */

const ctx = { id: 'ta_1', lane: 'task', seq: 0 };

describe('projecting events into lines', () => {
    it('puts the run spine at summary depth', () => {
        for (const event of [
            { type: 'TaskStarted', prompt: 'p', mode: 'agent', model: 'sonnet' },
            { type: 'TurnStarted', turn: 3, maxTurns: 25 },
            { type: 'TaskCompleted', turns: 7, durationMs: 1_000 },
        ]) {
            expect(toJournalLines(event, ctx)[0].depth).toBe('summary');
        }
    });

    it('narrates a tool call the way the desk does', () => {
        const [line] = toJournalLines(
            { type: 'ToolStarted', name: 'read_file', arguments: { path: 'src/a.ts' }, toolCallId: 't1' }, ctx);
        expect(line.kind).toBe('tool');
        expect(line.depth).toBe('normal');
        expect(line.verb).toBe('opened');
        expect(line.target).toBe('src/a.ts');
    });

    it('marks a failed tool as an error so problems-only finds it', () => {
        const [line] = toJournalLines({ type: 'ToolFinished', name: 'run_command', ok: false, durationMs: 12 }, ctx);
        expect(line.level).toBe('error');
    });

    it('keeps the pre-flight — the lines the "thinking, doing nothing" defect hid', () => {
        // Every one of these already exists as a `log()` call in chat-task.ts and has, until
        // now, gone to a two-line collapsed strip and nowhere else.
        const [line] = toJournalLines(
            { type: 'Log', level: 'info', message: '[Index] 1,204 chunks — 12 indexed, 1,192 reused (870ms).' }, ctx);
        expect(line.kind).toBe('log');
        expect(line.depth).toBe('verbose');
        expect(line.verb).toContain('[Index]');
    });

    it('does not journal reasoning', () => {
        // Thousands of events per turn, already streamed to the panel that wants it, and
        // not a record of what the agent *did*.
        expect(toJournalLines({ type: 'ReasoningChunk', text: 'hmm' }, ctx)).toEqual([]);
    });

    it('produces nothing for an event it does not recognise', () => {
        // A generic "something happened" line is indistinguishable from the silence it was
        // meant to fix, and would become the bulk of the file.
        expect(toJournalLines({ type: 'SomeFutureEvent', a: 1 }, ctx)).toEqual([]);
        expect(toJournalLines(undefined, ctx)).toEqual([]);
    });

    it('caps an enormous detail and says that it did', () => {
        const [line] = toJournalLines(
            { type: 'TaskStarted', prompt: 'x'.repeat(50_000), mode: 'agent', model: 'm' }, ctx);
        expect(JSON.stringify(line.detail).length).toBeLessThan(MAX_DETAIL_BYTES + 200);
        expect(line.detail!.truncated).toBe(true);
    });

    it('redacts on the way in, not on the way out', () => {
        const [line] = toJournalLines({
            type: 'ToolStarted', name: 'run_command',
            arguments: { command: 'curl -H "Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"' },
        }, ctx);
        const serialised = JSON.stringify(line);
        expect(serialised).not.toContain('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    });

    it('orders depths so a reader sees everything at or below its selection', () => {
        expect(atOrBelow('summary', 'normal')).toBe(true);
        expect(atOrBelow('verbose', 'normal')).toBe(false);
        expect(atOrBelow('verbose', 'verbose')).toBe(true);
    });

    it('formats a line the way the tab renders it', () => {
        const [line] = toJournalLines({ type: 'ToolFinished', name: 'read_file', ok: true, durationMs: 1_400, ts: 0 }, ctx);
        expect(formatJournalLine(line)).toContain('read_file finished');
        expect(formatJournalLine(line)).toContain('1.4s');
    });
});

describe('reading', () => {
    const line = (seq: number, over: any = {}) => ({
        ts: 1_000 + seq, seq, id: 'ta_1', lane: 'task',
        kind: 'tool', level: 'info', depth: 'normal', verb: 'opened', target: `src/f${seq}.ts`,
        ...over,
    });

    it('filters by depth', () => {
        const lines = [line(0, { depth: 'summary' }), line(1, { depth: 'normal' }), line(2, { depth: 'verbose' })] as any;
        expect(readPage(lines, { depth: 'summary' }).lines).toHaveLength(1);
        expect(readPage(lines, { depth: 'normal' }).lines).toHaveLength(2);
        expect(readPage(lines, { depth: 'verbose' }).lines).toHaveLength(3);
    });

    it('pages by sequence number, not by offset', () => {
        // An offset cursor drifts by exactly the number of lines a live run appended
        // between the two requests, which silently skips entries while scrolling.
        const lines = Array.from({ length: 10 }, (_, i) => line(i)) as any;
        const first = readPage(lines, { limit: 4 });
        expect(first.lines.map((l: any) => l.seq)).toEqual([0, 1, 2, 3]);
        expect(first.nextCursor).toBe(3);

        const grown = [...lines, line(10), line(11)] as any;
        expect(readPage(grown, { after: first.nextCursor, limit: 4 }).lines.map((l: any) => l.seq))
            .toEqual([4, 5, 6, 7]);
    });

    it('reports how many matched, so the tab can say "200 of 2,418"', () => {
        const lines = Array.from({ length: 500 }, (_, i) => line(i)) as any;
        const page = readPage(lines, { limit: 200 });
        expect(page.lines).toHaveLength(200);
        expect(page.matched).toBe(500);
        expect(page.total).toBe(500);
    });

    it('searches the verb, the target and the detail', () => {
        const lines = [
            line(0, { target: 'src/apiSlice.tsx' }),
            line(1, { target: 'src/other.ts' }),
            line(2, { verb: 'running', target: 'npm test', detail: { tool: 'run_command' } }),
        ] as any;
        expect(readPage(lines, { filter: 'apislice' }).lines).toHaveLength(1);
        expect(readPage(lines, { filter: 'run_command' }).lines).toHaveLength(1);
    });

    it('finds the problems without reading the log', () => {
        const lines = [line(0), line(1, { level: 'error' }), line(2, { level: 'warn' })] as any;
        expect(readPage(lines, { problemsOnly: true }).lines).toHaveLength(2);
    });

    it('tails the end, which is what a finished run is opened at', () => {
        const lines = Array.from({ length: 100 }, (_, i) => line(i)) as any;
        expect(readTail(lines, { limit: 5 }).lines.map((l: any) => l.seq)).toEqual([95, 96, 97, 98, 99]);
    });

    it('summarizes a run the way the footer reports it', () => {
        const lines = [
            line(0, { kind: 'turn', depth: 'summary' }),
            line(1, { kind: 'tool' }), line(2, { kind: 'tool' }),
            line(3, { kind: 'log', depth: 'verbose', level: 'error' }),
        ] as any;
        const summary = summarize(lines);
        expect(summary.total).toBe(4);
        expect(summary.turns).toBe(1);
        expect(summary.tools).toBe(1); // one start plus one finish is one call
        expect(summary.errors).toBe(1);
        expect(summary.byDepth.verbose).toBe(1);
    });

    it('parses a file whose last line was cut off mid-write', () => {
        // The normal ending of a killed run, and the run whose log matters most.
        const text = '{"ts":1,"seq":0,"verb":"a"}\n{"ts":2,"seq":1,"verb":"b"}\n{"ts":3,"se';
        expect(parseJournal(text)).toHaveLength(2);
    });
});

describe('the store on disk', () => {
    let dir: string;
    let now = Date.parse('2026-08-04T12:00:00Z');

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
        now = Date.parse('2026-08-04T12:00:00Z');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const store = (over: any = {}) => new JournalStore({ directory: dir, now: () => now, ...over });

    it('writes a run and reads it back', () => {
        const s = store();
        s.record('ta_1', 'task', { type: 'TaskStarted', prompt: 'do it', mode: 'agent', model: 'sonnet', ts: now });
        s.record('ta_1', 'task', { type: 'ToolStarted', name: 'read_file', arguments: { path: 'a.ts' }, ts: now });
        s.record('ta_1', 'task', { type: 'TaskCompleted', turns: 2, durationMs: 5, ts: now });

        const page = s.read('ta_1', { depth: 'verbose' });
        expect(page.lines.map(l => l.verb)).toEqual(['run started', 'opened', 'run finished']);
        expect(page.summary.total).toBe(3);
    });

    it('assigns monotonic sequence numbers', () => {
        const s = store();
        for (let i = 0; i < 5; i++) s.record('ta_1', 'task', { type: 'TurnStarted', turn: i, maxTurns: 25, ts: now });
        expect(s.read('ta_1', { depth: 'verbose' }).lines.map(l => l.seq)).toEqual([0, 1, 2, 3, 4]);
    });

    it('spills a large body to a payload file instead of inlining it', () => {
        const s = store();
        s.record('ta_1', 'task', { type: 'ToolFinished', name: 'run_command', ok: true, output: 'x'.repeat(5_000), ts: now });
        const [line] = s.read('ta_1', { depth: 'verbose' }).lines;
        expect(line.payloadRef).toMatch(/^p_\d+\.txt$/);
        expect(s.payload('ta_1', line.payloadRef!)!.length).toBe(5_000);
    });

    it('refuses a payload reference that tries to escape its directory', () => {
        const s = store();
        s.record('ta_1', 'task', { type: 'TaskStarted', prompt: 'p', mode: 'agent', model: 'm', ts: now });
        expect(s.payload('ta_1', '../../../etc/passwd')).toBeUndefined();
    });

    it('degrades to summary rather than stopping when a run fills its budget', () => {
        // A runaway agent must still leave a readable record of how it ended.
        const s = store({ maxRunBytes: 2_000 });
        for (let i = 0; i < 200; i++) {
            s.record('ta_1', 'task', { type: 'Log', level: 'info', message: `noise ${i} ${'y'.repeat(100)}`, ts: now });
        }
        s.record('ta_1', 'task', { type: 'TaskCompleted', turns: 1, durationMs: 1, ts: now });

        const all = s.read('ta_1', { depth: 'verbose' });
        expect(all.lines.some(l => l.verb.includes('budget'))).toBe(true);
        expect(all.lines[all.lines.length - 1].verb).toBe('run finished');
    });

    it('never prunes a run that is still live, whatever its age', () => {
        const s = store({ maxAgeDays: 1 });
        s.record('ta_live', 'task', { type: 'TaskStarted', prompt: 'p', mode: 'agent', model: 'm', ts: now });

        now += 30 * 24 * 60 * 60_000; // a month later
        s.sweep();

        expect(s.read('ta_live', { depth: 'verbose' }).lines).toHaveLength(1);
    });

    it('drops whole days once they age out', () => {
        const s = store({ maxAgeDays: 1 });
        s.record('ta_old', 'task', { type: 'TaskStarted', prompt: 'p', mode: 'agent', model: 'm', ts: now });
        s.close('ta_old');

        now += 5 * 24 * 60 * 60_000;
        s.sweep();

        expect(fs.readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n))).toHaveLength(0);
    });

    it('writes nothing at all when retention is switched off', () => {
        const s = store({ maxAgeDays: 0 });
        s.record('ta_1', 'task', { type: 'TaskStarted', prompt: 'p', mode: 'agent', model: 'm', ts: now });
        expect(s.enabled).toBe(false);
        expect(fs.readdirSync(dir)).toHaveLength(0);
    });

    it('sanitises a run id so it cannot write outside the journal directory', () => {
        // A run id reaches the store from a webview message, so separators are stripped
        // rather than trusted. The property is containment: whatever the id, the file
        // lands inside the day directory as one flat name.
        const s = store();
        s.record('../../evil', 'task', { type: 'TaskStarted', prompt: 'p', mode: 'agent', model: 'm', ts: now });

        const written = s.fileFor('../../evil')!;
        expect(path.dirname(written)).toBe(path.join(dir, '2026-08-04'));
        expect(path.basename(written)).not.toContain('/');
        expect(fs.existsSync(written)).toBe(true);
        // Nothing was created beside the journal root.
        expect(fs.existsSync(path.join(dir, '..', 'evil.jsonl'))).toBe(false);
    });

    it('streams each written line to the live tail', () => {
        const seen: string[] = [];
        const s = store({ onLine: (line: any) => seen.push(line.verb) });
        s.record('ta_1', 'task', { type: 'TurnStarted', turn: 1, maxTurns: 25, ts: now });
        expect(seen).toEqual(['turn 1 / 25']);
    });

    it('survives a run whose journal directory was deleted underneath it', () => {
        // A user clearing their storage while an agent runs must not take the agent down.
        const s = store();
        s.record('ta_1', 'task', { type: 'TaskStarted', prompt: 'p', mode: 'agent', model: 'm', ts: now });
        fs.rmSync(dir, { recursive: true, force: true });
        expect(() => s.record('ta_1', 'task', { type: 'TurnStarted', turn: 2, maxTurns: 25, ts: now })).not.toThrow();
    });
});
