// ─── The headless run (Phase 11, M63) ───────────────────────────────────────
//
// `cli.ts` shipped the parser, the event shapes and the exit-code mapping, all pure and
// all tested — and nothing that ran a task. So the gate clause read "parsing, host and
// exit codes exist and are tested; the `bin` entry that runs a task is not shipped". This
// is that entry's body: host → executor → loop → verification → output, with the CLI's
// event stream as the only thing it writes to stdout.
//
// ── The model config comes from the environment, never from the user's editor ─
// A CLI that reads the extension's stored settings would send a developer's personal API
// key from a CI runner, and would make a headless run's behaviour depend on a GUI state
// nobody can see from the terminal. Config is explicit: environment variables, or a file
// the caller points at. Unconfigured is exit 3 and says what to set.
//
// ── Verification decides the exit code, not the agent's opinion ──────────────
// `exitCodeFor` already distinguishes "completed" from "completed but unverified" — the
// case that matters most to a pipeline, because the agent believing it is done while the
// tests disagree must not be a green build. That distinction is only real if something
// actually runs the tests, which is what `verify()` below is for.

import * as path from 'node:path';
import { AgentHost } from './host';
import { CliEvent, CliExit, CliOptions, EXIT, exitCodeFor } from './cli';
import { createHostExecutor, headlessTools } from './host-executor';
import { runAgentLoop } from '../agent/agent-loop';
import { BASE_TOOLS } from '../core/tools';
import { AgentMode, LLMConfigEntry } from '../core/types';
import { CommandPolicy } from '../core/command-policy';
import { detectProjectProfile, MANIFEST_FILENAMES, ProjectProfile } from '../core/project-profiler';
import { selectTestCommand, parseTestOutput } from '../core/test-report';
import {
    Evidence, evaluateVerification, planVerification, renderVerificationReport, VerificationOutcome,
} from '../core/verification';
import { buildPrCommands, shellQuote } from '../core/git-pr';
import { UNTRUSTED_CONTENT_POSTURE } from '../core/untrusted-content';

export interface HeadlessResult {
    exit: CliExit;
    completed: boolean;
    aborted: boolean;
    turns: number;
    summary: string;
    changed: string[];
    verified?: VerificationOutcome;
    branch?: string;
}

export interface HeadlessDeps {
    host: AgentHost;
    options: CliOptions;
    /** One JSON event. The caller decides whether it reaches stdout. */
    emit: (event: CliEvent) => void;
    signal?: AbortSignal;
    /**
     * The model configuration. Injected rather than read here so a test can run the whole
     * pipeline against a scripted model — the one part of this that cannot be exercised
     * without a key is the model call itself, and everything around it can.
     */
    modelConfig: LLMConfigEntry;
    /** Overridable for tests; defaults to `runAgentLoop`. */
    runLoop?: typeof runAgentLoop;
}

/** Resolve the model from the environment. Exported so the failure mode is testable. */
export function modelFromEnv(env: Record<string, string | undefined>): LLMConfigEntry | undefined {
    const model = env.BLACKIDE_MODEL;
    const type = env.BLACKIDE_PROVIDER as LLMConfigEntry['type'] | undefined;
    if (!model || !type) return undefined;
    const key = env.BLACKIDE_API_KEY;
    // A remote provider with no key is *not* a usable config, and starting the run anyway
    // means the failure arrives one model call later wearing a provider's error message.
    if (!key && type !== 'local') return undefined;
    return {
        id: 'cli', name: `${type}/${model}`, type, model,
        ...(key ? { apiKey: key } : {}),
        ...(env.BLACKIDE_MODEL_URL ? { url: env.BLACKIDE_MODEL_URL } : {}),
        enabled: true,
    };
}

export const UNCONFIGURED = `No model configured.

Set BLACKIDE_PROVIDER and BLACKIDE_MODEL, plus BLACKIDE_API_KEY for a hosted provider:

  BLACKIDE_PROVIDER=claude BLACKIDE_MODEL=claude-opus-5 BLACKIDE_API_KEY=… blackide "…"
  BLACKIDE_PROVIDER=local  BLACKIDE_MODEL=qwen2.5-coder BLACKIDE_MODEL_URL=http://127.0.0.1:11434 blackide "…"

The CLI deliberately does not read the editor's stored settings: a CI runner would then be
sending somebody's personal key, and a headless run's behaviour would depend on GUI state
that is invisible from a terminal.`;

const SYSTEM = `You are Black IDE's agent, running headlessly with no editor and no user watching.

Work in a loop: think, call a tool, observe the result, repeat. Read a file before editing
it. Prefer grep_search to locate code — there is no language server here, and the
navigation tools will tell you so rather than returning a wrong answer.

Nobody can answer a question, so do not ask one. If you cannot proceed, call complete_task
and say precisely what is blocking you. When you finish, call complete_task with a summary
of what changed and why.

${UNTRUSTED_CONTENT_POSTURE}`;

export async function runHeadless(deps: HeadlessDeps): Promise<HeadlessResult> {
    const { host, options, emit } = deps;
    const at = () => Date.now();
    const root = path.resolve(options.root);
    const mode: AgentMode = options.mode.toLowerCase() === 'ask' ? 'ask'
        : options.mode.toLowerCase() === 'plan' ? 'plan' : 'agent';

    let profile: ProjectProfile | undefined;
    const getProjectProfile = async () => {
        if (!profile) {
            try { profile = await profileRoot(host, root); } catch { profile = undefined; }
        }
        return profile;
    };

    const executor = createHostExecutor({
        host, mode, root, signal: deps.signal,
        policy: new CommandPolicy({ autoApprove: false }),
        getProjectProfile,
        onFileChanged: (p, kind) => emit({ type: 'file', at: at(), path: path.relative(root, p) || p, kind }),
        onPlan: (steps) => emit({ type: 'text', at: at(), plan: steps }),
    });

    const tools = headlessTools(BASE_TOOLS, mode);
    emit({ type: 'started', at: at(), prompt: options.prompt, mode: options.mode, model: deps.modelConfig.model, tools: tools.length });

    if (options.dryRun) {
        // A `finished` event even here. The stream's contract is that every run ends with
        // one, and a consumer that has to special-case dry runs to avoid hanging on a
        // terminal event that never arrives is a consumer with a bug we shipped.
        const summary = `Would run "${options.prompt}" as ${options.mode} against ${root} with ${tools.length} tools, output ${options.output}.`;
        emit({ type: 'finished', at: at(), completed: true, aborted: false, turns: 0, changed: [], dryRun: true, summary, exit: EXIT.completed });
        return { exit: EXIT.completed, completed: true, aborted: false, turns: 0, changed: [], summary };
    }

    const loop = deps.runLoop || runAgentLoop;
    const result = await loop({
        modelConfig: deps.modelConfig,
        system: SYSTEM,
        initialMessage: { role: 'user', content: options.prompt },
        tools,
        executor: executor as any,
        maxLoops: options.maxTurns,
        signal: deps.signal,
        callbacks: {
            onTurn: (turn: number, max: number) => emit({ type: 'turn', at: at(), turn, maxTurns: max }),
            onToolCall: (tc) => emit({ type: 'tool', at: at(), name: tc.name }),
            // Deliberately no per-token event. One JSON object per token would make the
            // stream unusable for the consumers it exists for — the final text arrives
            // once, in `finished`.
            onToolResult: (tc, r) => { if (r.isError) emit({ type: 'error', at: at(), tool: tc.name, message: r.content.slice(0, 300) }); },
        },
    });

    const changed = executor.changed.slice();

    // Verification runs whenever the agent changed something. A read-only answer has
    // nothing to verify, and reporting `unverifiable` for it would make the outcome
    // meaningless on the runs where it matters.
    let verified: VerificationOutcome | undefined;
    if (changed.length && !result.aborted) {
        verified = await verify(deps, root, changed, getProjectProfile, emit);
    }

    let branch: string | undefined;
    let published = true;
    if (options.output === 'pr' && changed.length && !result.aborted) {
        const outcome = await publish(deps, root, options, emit);
        branch = outcome.branch;
        published = outcome.ok;
    }

    /*
     * A failed publish is a failed run, and this line is a defect caught by running it.
     *
     * The first version returned the branch name and let `exitCodeFor` see only the
     * agent's own verdict, so `--output pr` against a repo with no `origin` wrote the
     * commit, failed the push, printed the error — and exited **0**. That is precisely the
     * failure `cli.ts` opens by warning about: a CLI that exits 0 when it did not do what
     * it was asked turns a red build green. `--output pr` means "leave me a PR"; if there
     * is no PR, the run did not complete, whatever the agent thinks.
     */
    const exit = !published
        ? EXIT.incomplete
        : exitCodeFor({ completed: result.completed, aborted: result.aborted, verified });
    const summary = result.finalText?.trim() || (result.completed ? 'Task complete.' : 'The agent stopped before completing the task.');
    emit({ type: 'finished', at: at(), completed: result.completed, aborted: !!result.aborted, turns: result.turns, changed, verified, branch, summary, exit });

    return { exit, completed: result.completed, aborted: !!result.aborted, turns: result.turns, summary, changed, verified, branch };
}

/**
 * Run the project's tests and judge the evidence.
 *
 * Writes the report on **every** path including the one where nothing ran, because M40's
 * argument holds harder here than in the editor: a CI job with no artifact and a CI job
 * that verified clean are indistinguishable from the outside.
 */
async function verify(
    deps: HeadlessDeps, root: string, changed: string[],
    getProjectProfile: () => Promise<ProjectProfile | undefined>,
    emit: (event: CliEvent) => void,
): Promise<VerificationOutcome> {
    // An explicit `--test-command` wins over detection. Detection is a good guess about a
    // repository; the caller is an authority on their own CI. Preferring the guess would
    // make the flag advisory, which is the same failure as a tool toggle that only
    // unadvertises.
    const profile = await getProjectProfile();
    const selected = deps.options.testCommand
        ? { framework: 'command', command: deps.options.testCommand }
        : (profile ? selectTestCommand(profile) : undefined);
    const plan = planVerification(changed, selected ? { framework: selected.framework, command: selected.command } : undefined);

    const evidence: Evidence = {};
    if (!selected) {
        evidence.testsUnavailable = profile
            ? `No test framework detected for this project (stacks: ${profile.stacks.join(', ') || 'none'}).`
            : 'The project could not be profiled, so no test command could be selected.';
    } else {
        const r = await deps.host.process.run(selected.command, { cwd: root, timeoutMs: 600_000, signal: deps.signal });
        // A runner that could not start is `unavailable`, not `failed`: exit 127 means the
        // command is missing, and calling that a test failure sends the next reader
        // looking for a bug in the change.
        if (r.exitCode === 127) evidence.testsUnavailable = `The test command could not be run: ${r.stderr.trim().slice(0, 300)}`;
        else evidence.tests = parseTestOutput(selected.framework, r, selected.command);
    }

    const result = evaluateVerification(plan, evidence);
    const report = renderVerificationReport(plan, evidence, result);
    try {
        await deps.host.fs.write(path.join(root, '.blackIDE', 'artifacts', 'verification.md'), report);
    } catch { /* the report is evidence, not the run */ }
    emit({ type: 'verification', at: Date.now(), outcome: result.outcome, summary: result.summary, missing: result.missing });
    return result.outcome;
}

/**
 * `--output pr`: branch, commit, push, open a PR.
 *
 * Every step goes through the host's process, and every failure stops the sequence rather
 * than continuing to the next one — a `gh pr create` that runs after a failed push opens a
 * PR against a branch that is not there, and reports success doing it.
 */
async function publish(
    deps: HeadlessDeps, root: string, options: CliOptions, emit: (event: CliEvent) => void,
): Promise<{ ok: boolean; branch: string }> {
    const branch = `blackide/${slug(options.prompt)}-${Date.now().toString(36)}`;
    const title = options.prompt.length > 72 ? `${options.prompt.slice(0, 69)}…` : options.prompt;
    const steps = [
        `git checkout -b ${shellQuote(branch)}`,
        'git add -A',
        `git commit -m ${shellQuote(title)}`,
        ...buildPrCommands({ branch, title, body: `Headless run.\n\n> ${options.prompt}` }),
    ];

    for (const command of steps) {
        const r = await deps.host.process.run(command, { cwd: root, timeoutMs: 120_000, signal: deps.signal });
        if (r.exitCode !== 0) {
            emit({ type: 'error', at: Date.now(), message: `${command} failed (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 300)}` });
            return { ok: false, branch };
        }
    }
    return { ok: true, branch };
}

/**
 * Profile the repository through the host.
 *
 * `detectProjectProfile` is pure — a file list plus manifest contents — which is exactly
 * why it can be used here at all. The alternative, letting it read the disk, would make
 * stack detection impossible on a remote runner (M66) where the files are not local.
 */
async function profileRoot(host: AgentHost, root: string): Promise<ProjectProfile> {
    const files = await host.fs.find('**/*', { limit: 4_000 });
    const relative = files.map(f => path.relative(root, f).replace(/\\/g, '/'));
    const manifests: Record<string, string> = {};
    for (const name of MANIFEST_FILENAMES) {
        const hit = files.find(f => path.basename(f) === name && !path.relative(root, f).includes(path.sep));
        if (!hit) continue;
        try { manifests[name] = await host.fs.read(hit); } catch { /* unreadable manifest is no manifest */ }
    }
    return detectProjectProfile(relative, manifests);
}

function slug(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
}
