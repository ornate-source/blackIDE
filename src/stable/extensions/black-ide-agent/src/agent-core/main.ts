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

export async function main(argv: string[], env = process.env): Promise<number> {
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
