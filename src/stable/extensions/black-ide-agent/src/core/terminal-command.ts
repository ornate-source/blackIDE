import { CommandPolicy, PolicyDecision } from './command-policy';

// ─── Terminal Cmd+K (Phase 5, M29) ──────────────────────────────────────────
//
// Natural language at the shell prompt: "undo the last commit but keep the changes"
// becomes `git reset --soft HEAD~1`, typed into the terminal for the developer to read
// and press Enter on.
//
// ── The one defect this module exists to prevent ─────────────────────────────
// `Terminal.sendText(text, false)` is documented as "do not execute" and that is true of
// the *last* line only. A newline inside `text` is a keypress like any other, so a model
// that helpfully returns
//
//     rm -rf build
//     npm run build
//
// gets `rm -rf build` executed the instant it is inserted, with no preview and no
// keystroke from the user. The `false` argument suppresses exactly one trailing newline
// and nothing else. Every path out of this module therefore returns a **single line**,
// and `sanitizeCommand` is the only way to produce one — which is why joining is explicit
// and reported rather than quietly done.
//
// ── Never auto-run, including for allow-listed commands ──────────────────────
// The command policy (G1) decides whether a command may run *at all*; it does not decide
// whether this feature may press Enter. It may not, ever. An allow-listed `npm test` is
// still inserted and still waits. The developer asked for a command, not for an action,
// and the gap between those two is the whole safety story of a natural-language shell.

/** What the prompt asks for when it cannot answer. */
export const NO_COMMAND = 'NO_COMMAND';

export interface ShellContext {
    /** `vscode.env.shell` or equivalent — zsh and PowerShell need different answers. */
    shell?: string;
    /** `process.platform`. */
    platform?: string;
    /** Where the terminal is, so relative paths in the answer are meaningful. */
    cwd?: string;
    /** Detected stacks from `ProjectProfile`, so "run the tests" resolves correctly. */
    stacks?: string[];
}

/**
 * The generation prompt.
 *
 * Single-line output is stated as a hard rule rather than left to chance, because the
 * sanitizer's fallback for multi-line output (joining with `&&`) changes the semantics of
 * what the model wrote — correct for a sequence, wrong for two alternatives it was
 * offering. Getting one line from the model is better than repairing several.
 */
export function buildTerminalPrompt(request: string, context: ShellContext = {}): string {
    const facts = [
        context.shell ? `Shell: ${context.shell}` : '',
        context.platform ? `Platform: ${context.platform}` : '',
        context.cwd ? `Working directory: ${context.cwd}` : '',
        context.stacks?.length ? `Project stack: ${context.stacks.join(', ')}` : '',
    ].filter(Boolean);

    return [
        'Translate the request into ONE shell command for the environment described below.',
        '',
        'Rules, all mandatory:',
        '1. Output the command and NOTHING else — no prose, no markdown fences, no `$` prompt.',
        '2. Exactly one line. Chain steps with the shell\'s own operators if you must.',
        '3. Use the real flags for the shell and platform given. Do not invent options.',
        '4. Prefer the least destructive command that does the job. Never add `--force`,',
        '   `-y`, or a `rm` the request did not ask for.',
        `5. If the request cannot be expressed as one command, output exactly: ${NO_COMMAND}`,
        '',
        ...facts,
        '',
        `Request: ${request}`,
    ].join('\n');
}

export interface SanitizedCommand {
    /** Guaranteed free of newlines. This is the only thing that may reach `sendText`. */
    command: string;
    /** How many command lines the model produced before joining. */
    lines: number;
    /** True when several lines were chained — surfaced in the preview, never hidden. */
    joined: boolean;
}

/**
 * Reduce a model response to one line, or nothing.
 *
 * Comment lines are dropped rather than chained: a `#` line is explanation the model was
 * told not to give, and chaining it would put a comment in the middle of an `&&` sequence
 * where it comments out everything after it in some shells.
 */
export function sanitizeCommand(response: string): SanitizedCommand | undefined {
    if (!response) return undefined;

    let text = response.trim();
    if (text.includes(NO_COMMAND)) return undefined;

    // Fenced output is the most common wrapper even when the prompt forbids it.
    const fenced = text.match(/```[a-zA-Z]*\r?\n([\s\S]*?)```/);
    if (fenced) text = fenced[1];

    const lines = text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .filter(line => !line.startsWith('#'))
        .map(stripPromptMarker);

    if (!lines.length) return undefined;
    if (lines.length === 1) return { command: lines[0], lines: 1, joined: false };

    return { command: lines.join(' && '), lines: lines.length, joined: true };
}

/** `$ git status` and `> git status` are prompts the model copied, not part of the command. */
function stripPromptMarker(line: string): string {
    return line.replace(/^[$>]\s+/, '');
}

export interface CommandVerdict {
    decision: PolicyDecision;
    reason?: string;
    /** False when the command must not be offered at all. */
    insertable: boolean;
}

/**
 * Run the generated command past the same policy that gates the agent's `run_command`.
 *
 * Reusing `CommandPolicy` rather than writing a check here is the point: a
 * natural-language shell that is *more* permissive than the agent would be a hole
 * straight through G1's deny list, and two implementations of "is this destructive"
 * would diverge on their first edit.
 *
 * `ask` and `allow` are both insertable and both still require the developer to press
 * Enter, so the distinction affects only what the preview says. `deny` is refused
 * outright — a hard-denied command is not something to show with a warning, because a
 * command sitting at the prompt is one keystroke from running.
 */
export function judgeCommand(command: string, policy: CommandPolicy): CommandVerdict {
    const verdict = policy.evaluate(command);
    return {
        decision: verdict.decision,
        reason: verdict.reason,
        insertable: verdict.decision !== 'deny',
    };
}

/**
 * Final assertion before the string reaches the terminal.
 *
 * Belt to `sanitizeCommand`'s braces. It is one line of code guarding the one mistake in
 * this feature that executes something nobody read, and every future edit to the paths
 * above has to get past it.
 */
export function isSafeToInsert(command: string): boolean {
    return command.length > 0 && !/[\r\n]/.test(command);
}
