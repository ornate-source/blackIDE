// ─── The headless CLI (Phase 11, M63) ───────────────────────────────────────
//
// `blackide "add a test for X" --output pr` with no editor running. F10 has read ⬜/❌ since
// rev 1 — "Blocks CI use and background agents" — and this is what unblocks both.
//
// ── stdout is a protocol, stderr is for humans ───────────────────────────────
// Every line on stdout is one JSON event. That is not a formatting preference: a CI step
// consumes this, and a tool whose machine output is interleaved with progress text forces
// every consumer to write a parser that guesses. Logs, warnings and progress go to stderr,
// so `blackide ... | jq` works and `blackide ... 2>/dev/null` is silent.
//
// ── Exit codes are the CI contract ──────────────────────────────────────────
// A CLI that exits 0 when the agent gave up is a CLI that turns a red build green. The
// codes below distinguish the cases a pipeline needs to branch on, and `completed` is the
// only one that is 0.

export type CliExit =
    | 0    // completed
    | 1    // the agent ran and did not finish the task
    | 2    // bad usage
    | 3    // no model configured / no credentials
    | 4    // aborted (signal)
    | 5;   // verification failed — the change exists but its tests do not pass

export const EXIT = {
    completed: 0, incomplete: 1, usage: 2, unconfigured: 3, aborted: 4, unverified: 5,
} as const;

export interface CliOptions {
    prompt: string;
    mode: string;
    output: 'apply' | 'pr';
    root: string;
    /** Approval tier for the run's host. CI should leave this at `deny`. */
    approve: 'deny' | 'edits' | 'all';
    maxTurns: number;
    json: boolean;
    /** Print what would run and exit. */
    dryRun: boolean;
    model?: string;
    /**
     * The command that decides whether this run verified.
     *
     * An override rather than a preference. Detection reads the manifest and is right for
     * most repos, but a CI job already knows its own command — including the cases
     * detection cannot see: a monorepo package, a make target, a suite that needs a flag.
     * Without this, "no framework detected" makes every headless run on such a repo exit 5,
     * and the response to a gate that is always red is to stop reading it.
     */
    testCommand?: string;
}

export type ParseResult =
    | { ok: true; options: CliOptions }
    | { ok: false; exit: CliExit; message: string };

const USAGE = `blackide — run a Black IDE agent without an editor

  blackide "<prompt>" [options]

Options
  --mode <name>        Agent mode (default: Agent)
  --model <id>         Model id from your configuration
  --output apply|pr    Apply to the working tree, or leave a branch and open a PR (default: apply)
  --approve deny|edits|all
                       What the agent may do unattended (default: deny — CI-safe)
  --max-turns <n>      Tool iterations before stopping (default: 25)
  --root <path>        Repository root (default: cwd)
  --test-command <cmd> The command that decides verification (default: detected from the repo)
  --json               One JSON event per line on stdout (default when not a TTY)
  --dry-run            Print the resolved plan and exit
  -h, --help           This text

Exit codes
  0 completed · 1 incomplete · 2 usage · 3 not configured · 4 aborted · 5 verification failed`;

/**
 * Parse argv.
 *
 * Written as a pure function over an array so the whole surface is testable without
 * spawning a process — argument handling is where CLIs rot, and a parser that can only be
 * exercised by running the binary is one nobody adds a case to.
 */
export function parseArgs(argv: string[]): ParseResult {
    const args = argv.slice();
    if (!args.length || args.includes('-h') || args.includes('--help')) {
        return { ok: false, exit: EXIT.usage, message: USAGE };
    }

    const options: CliOptions = {
        prompt: '', mode: 'Agent', output: 'apply', root: process.cwd(),
        approve: 'deny', maxTurns: 25, json: !process.stdout.isTTY, dryRun: false,
    };
    const positional: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const value = () => args[++i];
        switch (arg) {
            case '--mode': options.mode = value() || options.mode; break;
            case '--model': options.model = value(); break;
            case '--test-command': options.testCommand = value(); break;
            case '--root': options.root = value() || options.root; break;
            case '--json': options.json = true; break;
            case '--dry-run': options.dryRun = true; break;
            case '--output': {
                const next = value();
                if (next !== 'apply' && next !== 'pr') {
                    return { ok: false, exit: EXIT.usage, message: `--output must be "apply" or "pr", not "${next}".` };
                }
                options.output = next;
                break;
            }
            case '--approve': {
                const next = value();
                if (next !== 'deny' && next !== 'edits' && next !== 'all') {
                    return { ok: false, exit: EXIT.usage, message: `--approve must be deny, edits or all, not "${next}".` };
                }
                options.approve = next;
                break;
            }
            case '--max-turns': {
                const next = Number(value());
                if (!Number.isFinite(next) || next < 1) {
                    return { ok: false, exit: EXIT.usage, message: '--max-turns must be a positive integer.' };
                }
                options.maxTurns = Math.floor(next);
                break;
            }
            default:
                if (arg.startsWith('--')) {
                    // Refused rather than ignored: a typo'd flag that is silently dropped is
                    // a CI job that runs with the wrong settings and reports success.
                    return { ok: false, exit: EXIT.usage, message: `Unknown option "${arg}".\n\n${USAGE}` };
                }
                positional.push(arg);
        }
    }

    options.prompt = positional.join(' ').trim();
    if (!options.prompt) {
        return { ok: false, exit: EXIT.usage, message: `No prompt given.\n\n${USAGE}` };
    }
    return { ok: true, options };
}

/** One line of the stdout stream. */
export interface CliEvent {
    type: 'started' | 'turn' | 'tool' | 'text' | 'file' | 'verification' | 'finished' | 'error';
    at: number;
    [key: string]: unknown;
}

export function renderEvent(event: CliEvent): string {
    return JSON.stringify(event);
}

/**
 * Human-readable rendering, for a terminal.
 *
 * Deliberately not the same information: the JSON stream is complete and this is a
 * summary. A CLI that prints its event stream prettified is one whose humans learn to
 * read JSON, and a CLI whose JSON is its pretty output is one machines cannot consume.
 */
export function renderHuman(event: CliEvent): string | undefined {
    switch (event.type) {
        case 'started': return `▸ ${event.prompt}`;
        case 'turn': return `  turn ${event.turn}/${event.maxTurns}`;
        case 'tool': return `  · ${event.name}`;
        case 'file': return `  ${event.kind === 'deleted' ? '−' : '±'} ${event.path}`;
        case 'verification': return `  ✓ ${event.summary}`;
        case 'finished': return event.completed ? `✔ ${event.summary ?? 'done'}` : `✖ ${event.summary ?? 'stopped'}`;
        case 'error': return `✖ ${event.message}`;
        default: return undefined;
    }
}

/**
 * Which exit code a finished run deserves.
 *
 * Separated from the run so the mapping is testable and so it is written down in one
 * place. "Completed but unverified" being distinct from "completed" is the case a pipeline
 * most needs: it means the agent believes it is done and the tests disagree, which should
 * not be a green build.
 */
export function exitCodeFor(result: {
    completed: boolean;
    aborted?: boolean;
    verified?: 'verified' | 'failed' | 'unverifiable' | 'incomplete';
}): CliExit {
    if (result.aborted) return EXIT.aborted;
    if (!result.completed) return EXIT.incomplete;
    if (result.verified && result.verified !== 'verified') return EXIT.unverified;
    return EXIT.completed;
}

export { USAGE };
