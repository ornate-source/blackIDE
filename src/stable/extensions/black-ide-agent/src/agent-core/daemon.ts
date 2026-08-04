import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    CLAIMED_DIR, DaemonRequest, DaemonResult, QUEUE_DIR, RESULTS_DIR, parseRequest, resultFilename,
} from '../core/daemon-protocol';
import { LLMConfigEntry } from '../core/types';
import { createNodeHost } from './node-host';
import { modelFromEnv, runHeadless } from './headless-run';
import { CliEvent, CliOptions } from './cli';

// ─── The local daemon (Phase 11, M65 · P11-3) ──────────────────────────────
//
// Watches `.blackIDE/daemon/queue/` for run requests, executes them headless, and writes
// results to `.blackIDE/daemon/results/` where the editor's inbox finds them.
//
// ── Claim-by-rename, which is the whole concurrency design ─────────────────
// A request is claimed by `rename`-ing it out of `queue/` into `claimed/` *before* it is
// read. `rename` within a filesystem is atomic, so exactly one daemon can win — and the
// alternative, "read it then delete it", has a window in which two daemons both read the
// same file and run the same task twice. Running a refactor twice is not idempotent, and
// a user who starts a second daemon by accident should get nothing worse than an idle
// process.
//
// It also means a crash is recoverable and *visible*: an interrupted run leaves its
// request in `claimed/`, which is a file somebody can look at, rather than in a queue it
// will be run from again on the next start.
//
// ── Polling, not watching ──────────────────────────────────────────────────
// `fs.watch` is unreliable across platforms and network filesystems, and this is a loop
// that must not miss a file. A poll every few seconds costs one `readdir` and is correct
// everywhere; the latency it adds is irrelevant to a job somebody queued for overnight.

export interface DaemonOptions {
    /** Repository root. The queue and results live under it. */
    root: string;
    /** How often to look for new work. */
    pollMs?: number;
    /** Stop after this many runs. `0` means forever. Used by the tests and by `--once`. */
    maxRuns?: number;
    /** Where log lines go. */
    log?: (message: string) => void;
    /** Injected so a test can drive the whole loop without a key. */
    execute?: (request: DaemonRequest, root: string) => Promise<DaemonResult>;
    signal?: AbortSignal;
    /** Model configuration. Resolved from the environment when absent. */
    modelConfig?: LLMConfigEntry;
}

const DEFAULT_POLL_MS = 3_000;

export interface DaemonRunSummary {
    processed: number;
    failed: number;
    refused: number;
}

/**
 * Run the daemon until it is stopped, or until `maxRuns` requests have been handled.
 *
 * Returns a summary rather than never returning, so `blackide daemon --once` — the form a
 * cron line uses — is the same code path as the long-running one. A daemon whose
 * one-shot mode is a different function is a daemon with an untested main loop.
 */
export async function runDaemon(options: DaemonOptions): Promise<DaemonRunSummary> {
    const root = path.resolve(options.root);
    const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const summary: DaemonRunSummary = { processed: 0, failed: 0, refused: 0 };

    for (const dir of [QUEUE_DIR, RESULTS_DIR, CLAIMED_DIR]) {
        fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    log(`[Daemon] Watching ${path.join(root, QUEUE_DIR)}`);

    const execute = options.execute ?? ((request, cwd) => executeHeadless(request, cwd, options, log));

    while (!options.signal?.aborted) {
        const claimed = claimNext(root);
        if (!claimed) {
            if (options.maxRuns && summary.processed >= options.maxRuns) break;
            if (options.maxRuns) break;   // `--once`: an empty queue means there is nothing to do
            await sleep(pollMs, options.signal);
            continue;
        }

        const parsed = parseRequest(claimed.body, claimed.id);
        if (!parsed.ok) {
            /*
             * A malformed request produces a *result*, not a log line.
             *
             * Anything may write into the queue, so a typo in a shell script is a normal
             * event — and the person who made it is not watching stderr. A refusal in the
             * results directory reaches them through the inbox, which is the only channel
             * this design can rely on.
             */
            writeResult(root, {
                id: claimed.id, prompt: '(unreadable request)', status: 'refused',
                startedAt: Date.now(), endedAt: Date.now(),
                summary: `The queued request was not run: ${parsed.reason}`,
                changed: [], error: parsed.reason,
            });
            summary.refused++;
            log(`[Daemon] Refused ${claimed.id}: ${parsed.reason}`);
            continue;
        }

        const request = parsed.request;
        log(`[Daemon] Running ${request.id}: ${request.prompt.slice(0, 80)}`);
        let result: DaemonResult;
        try {
            result = await execute(request, request.cwd ? path.resolve(root, request.cwd) : root);
        } catch (error: any) {
            // A crashed run is a recorded failure. The one outcome a daemon must not have
            // is a request that vanishes without trace.
            result = {
                id: request.id, prompt: request.prompt, status: 'failed',
                startedAt: request.at, endedAt: Date.now(),
                summary: 'The run threw before it could finish.',
                changed: [], error: String(error?.message || error),
            };
        }

        writeResult(root, result);
        summary.processed++;
        if (result.status !== 'completed') summary.failed++;
        log(`[Daemon] ${request.id} ${result.status}: ${result.summary}`);

        if (options.maxRuns && summary.processed >= options.maxRuns) break;
    }

    return summary;
}

/**
 * Take the next request out of the queue, atomically.
 *
 * The `rename` is the claim. Reading first and deleting after would let two daemons run
 * the same task, and a refactor run twice is not a refactor.
 */
function claimNext(root: string): { id: string; body: unknown } | undefined {
    const queue = path.join(root, QUEUE_DIR);
    let names: string[];
    try {
        names = fs.readdirSync(queue).filter(n => n.endsWith('.json')).sort();
    } catch { return undefined; }

    for (const name of names) {
        const from = path.join(queue, name);
        const to = path.join(root, CLAIMED_DIR, name);
        try {
            fs.renameSync(from, to);
        } catch {
            // Another daemon won, or the file went away. Either way it is not ours.
            continue;
        }
        try {
            return { id: name.replace(/\.json$/, ''), body: JSON.parse(fs.readFileSync(to, 'utf8')) };
        } catch {
            return { id: name.replace(/\.json$/, ''), body: undefined };
        }
    }
    return undefined;
}

function writeResult(root: string, result: DaemonResult): void {
    const target = path.join(root, RESULTS_DIR, resultFilename(result.id));
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    } catch {
        // Nothing useful to do: the result is the report, and if it cannot be written the
        // reporting channel is what failed. Logged by the caller.
    }
}

/** Run one request through the headless pipeline. */
async function executeHeadless(
    request: DaemonRequest,
    cwd: string,
    options: DaemonOptions,
    log: (message: string) => void,
): Promise<DaemonResult> {
    const startedAt = Date.now();
    const modelConfig = options.modelConfig ?? modelFromEnv(process.env);
    if (!modelConfig) {
        return {
            id: request.id, prompt: request.prompt, status: 'refused',
            startedAt, endedAt: Date.now(),
            summary: 'No model is configured for the daemon.',
            changed: [],
            error: 'Set BLACKIDE_MODEL and the matching API key in the daemon\'s environment.',
        };
    }

    const host = createNodeHost({ root: cwd, approve: request.approve ?? 'deny', onLog: log });
    const cliOptions: CliOptions = {
        prompt: request.prompt,
        mode: request.mode ?? 'agent',
        // `apply` rather than `pr`: a daemon opening pull requests unattended is egress
        // under the user's identity, which M48 settled requires a per-action
        // confirmation nobody is present to give. The work lands on a branch and the
        // inbox tells someone about it.
        output: 'apply',
        root: cwd,
        approve: request.approve ?? 'deny',
        maxTurns: 40,
        // Structured events, because the daemon's "console" is a log file somebody greps.
        json: true,
        dryRun: false,
        model: request.model,
    };

    const outcome = await runHeadless({
        host,
        options: cliOptions,
        emit: (event: CliEvent) => log(`[Daemon] ${JSON.stringify(event)}`),
        modelConfig,
        signal: options.signal,
    });

    return {
        id: request.id,
        prompt: request.prompt,
        status: outcome.completed ? 'completed' : 'failed',
        startedAt,
        endedAt: Date.now(),
        summary: outcome.summary,
        changed: outcome.changed,
        branch: outcome.branch,
        error: outcome.completed ? undefined : outcome.summary,
    };
}

/** Read every result, newest first. Used by the editor's inbox. */
export function readResults(root: string): DaemonResult[] {
    const dir = path.join(root, RESULTS_DIR);
    let names: string[];
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return []; }

    const out: DaemonResult[] = [];
    for (const name of names) {
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
            if (parsed && typeof parsed.id === 'string') out.push(parsed);
        } catch {
            // A half-written result from a daemon that died mid-write. Skipped rather
            // than fatal: one unreadable result must not hide the other nine.
        }
    }
    return out.sort((a, b) => b.endedAt - a.endedAt);
}

/** Mark a result seen, so it stops appearing in the inbox. */
export function markResultSeen(root: string, id: string): void {
    const target = path.join(root, RESULTS_DIR, resultFilename(id));
    try {
        const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
        fs.writeFileSync(target, `${JSON.stringify({ ...parsed, seen: true }, null, 2)}\n`, 'utf8');
    } catch { /* already gone, or unreadable — either way it will not be shown again */ }
}

/** Enqueue a run. Exported so the editor and the CLI use the same writer. */
export function enqueue(root: string, request: Omit<DaemonRequest, 'at'> & { at?: number }): string {
    const id = request.id || `run-${Date.now().toString(36)}`;
    const target = path.join(root, QUEUE_DIR, resultFilename(id));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    /*
     * Write to a temporary name and rename into place.
     *
     * A daemon polling the directory can otherwise `readdir` between `open` and the last
     * `write` and claim a half-written file — which parses as malformed and is refused,
     * losing a request that was perfectly well formed a millisecond later.
     */
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ ...request, id, at: request.at ?? Date.now() }, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, target);
    return id;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        }
        signal?.addEventListener('abort', done);
    });
}
