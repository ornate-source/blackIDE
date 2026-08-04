import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_RESULT_MAX_AGE_MS, DaemonResult, QUEUE_DIR, RESULTS_DIR,
    daemonInboxItems, mergeInbox, parseRequest, resultFilename,
} from '../src/core/daemon-protocol';
import { enqueue, markResultSeen, readResults, runDaemon } from '../src/agent-core/daemon';
import { InboxItem } from '../src/core/agent-inbox';

/**
 * The local daemon (Phase 11, M65 · P11-3).
 *
 * The gate clause is one sentence — "a daemon run's results appear in the inbox" — and
 * it is the sentence that rules out the obvious implementation. A daemon that logs to a
 * file has *run* but not *reported*: the user opens the editor next morning and nothing
 * tells them the overnight job finished, failed, or has been waiting since 02:00. F16
 * graded that exact defect 🔴 for the in-editor lanes, and a daemon reintroduces it in
 * the form where the user is least likely to look.
 *
 * So the end-to-end test below goes queue → daemon → result file → inbox item, and the
 * middle of it is a real process loop over a real directory.
 */

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-daemon-'));

const result = (over: Partial<DaemonResult> = {}): DaemonResult => ({
    id: 'r1', prompt: 'bump the dependencies', status: 'completed',
    startedAt: 1_000, endedAt: 2_000, summary: 'Done.', changed: ['package.json'],
    ...over,
});

describe('requests: nothing in the queue is trusted', () => {
    it('accepts a well-formed request', () => {
        const parsed = parseRequest({ prompt: 'do the thing', approve: 'edits' }, 'fallback');
        expect(parsed).toMatchObject({ ok: true, request: { prompt: 'do the thing', approve: 'edits' } });
    });

    it('defaults approval to deny, not edits', () => {
        /*
         * A daemon is the most unattended thing in the product: nobody is watching, and
         * the request may have come from a cron line somebody forgot about. G3's rule
         * applies here more than anywhere.
         */
        expect(parseRequest({ prompt: 'x' }, 'f')).toMatchObject({ ok: true, request: { approve: 'deny' } });
    });

    it('refuses a request with no prompt, and says why', () => {
        expect(parseRequest({}, 'f')).toMatchObject({ ok: false, reason: 'no "prompt"' });
        expect(parseRequest('a string', 'f')).toMatchObject({ ok: false });
        expect(parseRequest({ prompt: '   ' }, 'f')).toMatchObject({ ok: false });
    });

    it('refuses an unknown approval tier rather than defaulting it', () => {
        // Defaulting a value nobody wrote is how a request ends up doing something nobody
        // asked for.
        const parsed = parseRequest({ prompt: 'x', approve: 'everything' }, 'f');
        expect(parsed).toMatchObject({ ok: false });
        expect(parsed.ok === false && parsed.reason).toMatch(/deny, edits or all/);
    });

    it('refuses an unbounded prompt', () => {
        expect(parseRequest({ prompt: 'x'.repeat(20_001) }, 'f')).toMatchObject({ ok: false });
    });

    it('sanitises the id into a filename that cannot traverse, and does not look like it might', () => {
        // Stripping separators is what prevents traversal; collapsing `..` and dropping a
        // leading dot is so a reviewer does not have to stop and reason about whether it
        // does. Same sanitiser, and same reasoning, as `auditRelativePath`.
        expect(resultFilename('../../etc/passwd')).toBe('etc-passwd.json');
        expect(resultFilename('run-1')).toBe('run-1.json');
        expect(resultFilename('...')).toBe('run.json');
        expect(resultFilename('')).toBe('run.json');
    });
});

describe('the loop', () => {
    it('runs a queued request and writes a result', async () => {
        const root = scratch();
        enqueue(root, { id: 'run-1', prompt: 'bump the dependencies' });

        const summary = await runDaemon({
            root, maxRuns: 1, log: () => {},
            execute: async request => result({ id: request.id, prompt: request.prompt }),
        });

        expect(summary.processed).toBe(1);
        expect(readResults(root)).toHaveLength(1);
        expect(readResults(root)[0].prompt).toBe('bump the dependencies');
    });

    it('claims by rename, so a second daemon cannot run the same task', async () => {
        /*
         * The concurrency design. "Read it then delete it" has a window in which two
         * daemons both read the same file and run the same task twice, and running a
         * refactor twice is not a refactor.
         */
        const root = scratch();
        enqueue(root, { id: 'run-1', prompt: 'the only job' });

        const seen: string[] = [];
        const execute = async (request: { id: string; prompt: string }) => {
            seen.push(request.id);
            return result({ id: request.id, prompt: request.prompt });
        };

        await Promise.all([
            runDaemon({ root, maxRuns: 1, log: () => {}, execute }),
            runDaemon({ root, maxRuns: 1, log: () => {}, execute }),
        ]);

        expect(seen).toEqual(['run-1']);
    });

    it('leaves an interrupted request in claimed/, not back in the queue', async () => {
        // Visible and inspectable, rather than re-run on the next start.
        const root = scratch();
        enqueue(root, { id: 'run-1', prompt: 'a job that throws' });

        await runDaemon({
            root, maxRuns: 1, log: () => {},
            execute: async () => { throw new Error('the run exploded'); },
        });

        expect(fs.readdirSync(path.join(root, QUEUE_DIR))).toEqual([]);
        expect(fs.readdirSync(path.join(root, '.blackIDE/daemon/claimed'))).toEqual(['run-1.json']);
    });

    it('a crashed run is a recorded failure, never a request that vanishes', async () => {
        const root = scratch();
        enqueue(root, { id: 'run-1', prompt: 'a job that throws' });

        const summary = await runDaemon({
            root, maxRuns: 1, log: () => {},
            execute: async () => { throw new Error('the run exploded'); },
        });

        expect(summary.failed).toBe(1);
        const [recorded] = readResults(root);
        expect(recorded.status).toBe('failed');
        expect(recorded.error).toMatch(/the run exploded/);
    });

    it('a malformed request produces a RESULT, not just a log line', async () => {
        /*
         * Anything may write into the queue — that is the feature — so a typo in a shell
         * script is a normal event, and the person who made it is not watching stderr. A
         * refusal in the results directory reaches them through the inbox, which is the
         * only channel this design can rely on.
         */
        const root = scratch();
        fs.mkdirSync(path.join(root, QUEUE_DIR), { recursive: true });
        fs.writeFileSync(path.join(root, QUEUE_DIR, 'bad.json'), '{"nope": true}', 'utf8');

        const summary = await runDaemon({ root, maxRuns: 1, log: () => {}, execute: async () => result() });
        expect(summary.refused).toBe(1);
        const [recorded] = readResults(root);
        expect(recorded.status).toBe('refused');
        expect(recorded.summary).toMatch(/no "prompt"/);
    });

    it('an empty queue with --once exits rather than spinning', async () => {
        const summary = await runDaemon({ root: scratch(), maxRuns: 1, log: () => {} });
        expect(summary).toEqual({ processed: 0, failed: 0, refused: 0 });
    });

    it('enqueue writes atomically, so a poll cannot claim half a file', () => {
        // Without the temp-and-rename, a daemon can readdir between `open` and the last
        // `write`, claim a half-written file, and refuse a request that was perfectly
        // well formed a millisecond later.
        const root = scratch();
        enqueue(root, { id: 'run-1', prompt: 'x' });
        expect(fs.readdirSync(path.join(root, QUEUE_DIR))).toEqual(['run-1.json']);
    });

    it('skips a half-written result rather than letting it hide the others', () => {
        const root = scratch();
        fs.mkdirSync(path.join(root, RESULTS_DIR), { recursive: true });
        fs.writeFileSync(path.join(root, RESULTS_DIR, 'good.json'), JSON.stringify(result()), 'utf8');
        fs.writeFileSync(path.join(root, RESULTS_DIR, 'torn.json'), '{"id": "r2", "pro', 'utf8');
        expect(readResults(root)).toHaveLength(1);
    });
});

// ─── The gate clause ────────────────────────────────────────────────────────

describe('a daemon run\'s results appear in the inbox', () => {
    it('a completed run is a review item — it wrote files nobody has read', () => {
        /*
         * `review` is `agent-inbox.ts`'s word for "nothing is wrong, nothing is waiting
         * on a timer, and the work quietly never lands". A daemon makes that the *most*
         * likely outcome, because the alternative is discovering the change in
         * `git status` three days later.
         */
        const [item] = daemonInboxItems([result({ endedAt: Date.now(), branch: 'agent/bump' })]);
        expect(item.reason).toBe('review');
        expect(item.id).toBe('daemon:r1');
        expect(item.detail).toMatch(/Ran in the background on agent\/bump/);
        expect(item.detail).toMatch(/Nothing has looked at it yet/);
    });

    it('a failed run outranks a completed one', () => {
        const items = daemonInboxItems([
            result({ id: 'ok', endedAt: Date.now() }),
            result({ id: 'bad', status: 'failed', error: 'tests did not pass', endedAt: Date.now() }),
        ]);
        expect(items.map(i => i.reason)).toEqual(['failed', 'review']);
    });

    it('a seen result disappears', () => {
        // Otherwise Monday's four results are still at the top of the inbox on Friday,
        // and the inbox stops being a list of things to do.
        expect(daemonInboxItems([result({ endedAt: Date.now(), seen: true })])).toEqual([]);
    });

    it('an ancient result disappears', () => {
        const old = Date.now() - DEFAULT_RESULT_MAX_AGE_MS - 1;
        expect(daemonInboxItems([result({ endedAt: old })])).toEqual([]);
    });

    it('merges with the editor items under one ordering rule', () => {
        const editor: InboxItem[] = [
            { id: 'p1', kind: 'pipeline', reason: 'blocked', title: 'a', detail: '', since: 500, priority: 1 },
            { id: 't1', kind: 'task', reason: 'review', title: 'b', detail: '', since: 900, priority: 3 },
        ];
        const merged = mergeInbox(editor, daemonInboxItems([
            result({ id: 'd1', status: 'failed', endedAt: Date.now() }),
            result({ id: 'd2', endedAt: Date.now() }),
        ]));
        // blocked (1) → failed (2) → review (3), with review newest-first.
        expect(merged.map(i => i.id)).toEqual(['p1', 'daemon:d1', 'daemon:d2', 't1']);
    });

    it('end to end: queue → daemon → result file → inbox item', async () => {
        const root = scratch();
        enqueue(root, { id: 'nightly', prompt: 'bump the dependencies and run the tests' });

        await runDaemon({
            root, maxRuns: 1, log: () => {},
            execute: async request => result({
                id: request.id, prompt: request.prompt,
                changed: ['package.json', 'package-lock.json'],
                branch: 'agent/nightly', endedAt: Date.now(),
            }),
        });

        const items = daemonInboxItems(readResults(root));
        expect(items).toHaveLength(1);
        expect(items[0].title).toBe('bump the dependencies and run the tests');
        expect(items[0].detail).toMatch(/changed 2 file\(s\)/);

        // …and acknowledging it removes it, so it does not nag forever.
        markResultSeen(root, 'nightly');
        expect(daemonInboxItems(readResults(root))).toEqual([]);
    });
});

describe('wiring', () => {
    const src = (...parts: string[]) => fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8');

    it('the editor lane merges daemon results into its inbox', () => {
        // The gate clause is about the editor's inbox, so the assertion is about the
        // editor's inbox — not just about `daemonInboxItems` being correct in isolation.
        const lane = src('agent', 'task-agent-lane.ts');
        expect(lane).toMatch(/mergeInbox\(editorItems, daemonInboxItems\(readResults\(root\)\)\)/);
    });

    it('a missing daemon directory does not break the in-editor inbox', () => {
        // The normal case for everyone who has never run a daemon.
        expect(src('agent', 'task-agent-lane.ts')).toMatch(/return editorItems;/);
    });

    it('the CLI exposes both halves: running the daemon and filling its queue', () => {
        const main = src('agent-core', 'main.ts');
        expect(main).toMatch(/argv\[0\] === 'daemon'/);
        expect(main).toMatch(/argv\[0\] === 'queue'/);
    });

    it('the daemon never opens a pull request unattended', () => {
        // Egress under the user's identity, which M48 settled needs a per-action
        // confirmation nobody is present to give.
        expect(src('agent-core', 'daemon.ts')).toMatch(/output: 'apply'/);
        expect(src('agent-core', 'daemon.ts')).not.toMatch(/output: 'pr'/);
    });
});
