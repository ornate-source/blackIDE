// ─── The `blackide` binary (Phase 11, M63) ──────────────────────────────────
//
// Everything below this line is process plumbing: argv in, exit code out, stdout kept
// clean. The decisions live in `cli.ts` (parsing, exit codes) and `headless-run.ts` (the
// run itself), both of which are pure enough to test without spawning anything — which is
// the point, because a CLI whose behaviour can only be exercised by running it is one
// nobody adds a case to.

import { EXIT, CliEvent, parseArgs, renderEvent, renderHuman } from './cli';
import { createNodeHost } from './node-host';
import { UNCONFIGURED, modelFromEnv, runHeadless } from './headless-run';
import { enqueue, readResults, runDaemon } from './daemon';

/**
 * `blackide daemon [--once] [--poll <ms>] [--root <dir>]`
 *
 * Runs whatever is in `.blackIDE/daemon/queue/` and writes results where the editor's
 * inbox finds them. `--once` drains the queue and exits, which is the form a cron line
 * uses and — deliberately — the same loop as the long-running mode.
 */
async function daemonCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
    const flag = (name: string) => {
        const index = argv.indexOf(`--${name}`);
        return index >= 0 ? argv[index + 1] : undefined;
    };
    const root = flag('root') || process.cwd();
    const once = argv.includes('--once');

    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    const summary = await runDaemon({
        root,
        pollMs: Number(flag('poll')) || undefined,
        maxRuns: once ? Number.MAX_SAFE_INTEGER : 0,
        signal: controller.signal,
        modelConfig: modelFromEnv(env),
    });

    process.stderr.write(
        `[Daemon] ${summary.processed} run(s), ${summary.failed} failed, ${summary.refused} refused.\n`);
    // A failed *run* is not a failed daemon: it did its job, which is to run things and
    // report what happened. Exit 0 unless the daemon itself could not work.
    return EXIT.completed;
}

/**
 * `blackide queue "<prompt>" [--root <dir>]`, and `blackide queue --list`.
 *
 * The enqueue side, so a shell script or a git hook can ask for work without linking
 * against anything. Nothing here starts a daemon: a request sitting in a queue directory
 * with no daemon running is a valid state, and it is the state that makes the file-based
 * design worth having.
 */
async function queueCommand(argv: string[]): Promise<number> {
    const flag = (name: string) => {
        const index = argv.indexOf(`--${name}`);
        return index >= 0 ? argv[index + 1] : undefined;
    };
    const root = flag('root') || process.cwd();

    if (argv.includes('--list')) {
        const results = readResults(root);
        if (!results.length) { process.stdout.write('No daemon results.\n'); return EXIT.completed; }
        for (const result of results) {
            process.stdout.write(
                `${result.status.padEnd(9)} ${new Date(result.endedAt).toISOString()}  ${result.prompt.slice(0, 60)}\n`);
        }
        return EXIT.completed;
    }

    const prompt = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--root');
    if (!prompt) {
        process.stderr.write('Usage: blackide queue "<prompt>" [--root <dir>] [--approve edits|all]\n');
        return EXIT.usage;
    }
    const id = enqueue(root, {
        id: `run-${Date.now().toString(36)}`,
        prompt,
        approve: (flag('approve') as 'deny' | 'edits' | 'all') || 'deny',
    });
    process.stdout.write(`Queued ${id}.\n`);
    return EXIT.completed;
}

export async function main(argv: string[], env = process.env): Promise<number> {
    /*
     * `blackide daemon` (M65 · P11-3).
     *
     * Handled before `parseArgs` because it is a different verb, not a different flag:
     * it takes no prompt, and folding it into the run parser would mean every future
     * reader of `CliOptions` wondering what `prompt` means for a daemon.
     */
    if (argv[0] === 'daemon') return daemonCommand(argv.slice(1), env);
    if (argv[0] === 'queue') return queueCommand(argv.slice(1));

    const parsed = parseArgs(argv);
    if (!parsed.ok) {
        process.stderr.write(`${parsed.message}\n`);
        return parsed.exit;
    }
    const options = parsed.options;

    const modelConfig = modelFromEnv(env);
    if (!modelConfig && !options.dryRun) {
        process.stderr.write(`${UNCONFIGURED}\n`);
        return EXIT.unconfigured;
    }

    /*
     * Ctrl-C is an abort, not a kill.
     *
     * The default SIGINT handler ends the process where it stands, which for an agent
     * mid-edit means a half-written file and no summary. Signalling the run instead lets
     * the loop stop between turns and exit 4, and a second Ctrl-C still kills outright —
     * a CLI that cannot be interrupted twice is a CLI people learn to `kill -9`.
     */
    const controller = new AbortController();
    let interrupted = false;
    const onSignal = () => {
        if (interrupted) process.exit(EXIT.aborted);
        interrupted = true;
        process.stderr.write('\nStopping after this turn. Press Ctrl-C again to force.\n');
        controller.abort();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    const emit = (event: CliEvent) => {
        if (options.json) {
            process.stdout.write(`${renderEvent(event)}\n`);
            return;
        }
        const line = renderHuman(event);
        if (line) process.stderr.write(`${line}\n`);
    };

    try {
        const result = await runHeadless({
            host: createNodeHost({ root: options.root, approve: options.approve }),
            options,
            emit,
            signal: controller.signal,
            modelConfig: modelConfig ?? { id: 'dry-run', name: 'dry-run', type: 'local', model: 'dry-run' },
        });
        if (!options.json) process.stderr.write(`${result.summary}\n`);
        return result.exit;
    } catch (error: any) {
        // An unexpected throw is exit 1, not 0. The only thing worse than a crashed agent
        // is a crashed agent that reports success.
        emit({ type: 'error', at: Date.now(), message: error?.message || String(error) });
        if (!options.json) process.stderr.write(`${error?.stack || error}\n`);
        return EXIT.incomplete;
    } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
    }
}

/* istanbul ignore next — the entry point itself. */
if (require.main === module) {
    main(process.argv.slice(2)).then(
        code => process.exit(code),
        err => { process.stderr.write(`${err?.stack || err}\n`); process.exit(EXIT.incomplete); },
    );
}
