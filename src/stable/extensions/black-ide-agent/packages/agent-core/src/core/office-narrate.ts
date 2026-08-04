// ─── Narration: a tool call, as a person would say it (the Agent Office) ────
//
// The Office's graphical tab shows one sentence per desk — `opened apiSlice.tsx` — and
// this is the whole of how that sentence is produced. It is a lookup, not a model call,
// and that is a design decision rather than an optimisation: a summarising call would
// charge the user per tool invocation for a phrase a table can produce, and would make
// "what is this agent doing" depend on a provider being up.
//
// ── Why the table is closed ──────────────────────────────────────────────────
// An unlisted tool renders **its own name**, not a guessed verb. The temptation is to
// infer — anything starting with `read` is "reading" — and that is wrong in the one case
// that matters: a destructive tool given a friendly verb misleads exactly when the user
// most needs to know what is happening. A name the user does not recognise is a much
// smaller failure than a verb that is untrue, so unknown tools degrade to honesty.
//
// Pure and vscode-free, tested one row at a time.

/** What a desk renders in its activity line. Every field is optional except the tool. */
export interface Activity {
    /** The real tool name, always. The verb is a rendering of it, not a replacement. */
    tool: string;
    /** How a person would say it: `opened`, `running`, `searching for`. */
    verb: string;
    /**
     * The raw argument the verb acts on, or **undefined when the lane did not forward
     * arguments**. R1: the desk then renders `—`, never a plausible-looking guess. The
     * task lane is in exactly this state until it publishes `ToolStarted.arguments`.
     */
    target?: string;
    /** `apiSlice.tsx` — the part worth rendering large. */
    label?: string;
    /** `src/store/` — the part worth rendering small, when the target was a path. */
    dir?: string;
    /** Epoch ms, for `staleness`. Absent when the lane publishes no start time. */
    startedAt?: number;
}

/**
 * tool name → the verb, and which argument the verb acts on.
 *
 * One row per tool in `core/tools.ts`, with two deliberate omissions:
 * `complete_task` (not an activity — it is the run ending) and `expand_output` (an
 * internal fetch of output the agent already has; narrating it as work would put a
 * bookkeeping step on the same footing as an edit).
 */
const VERBS: Record<string, { verb: string; arg: string }> = {
    read_file:         { verb: 'opened',            arg: 'path' },
    edit_file:         { verb: 'editing',           arg: 'path' },
    write_file:        { verb: 'writing',           arg: 'path' },
    list_directory:    { verb: 'listing',           arg: 'path' },
    grep_search:       { verb: 'searching for',     arg: 'query' },
    codebase_search:   { verb: 'searching for',     arg: 'query' },
    web_search:        { verb: 'searching the web', arg: 'query' },
    run_command:       { verb: 'running',           arg: 'command' },
    run_tests:         { verb: 'running tests in',  arg: 'path' },
    get_diagnostics:   { verb: 'checking',          arg: 'path' },
    go_to_definition:  { verb: 'looking up',        arg: 'symbol' },
    find_references:   { verb: 'tracing uses of',   arg: 'symbol' },
    workspace_symbols: { verb: 'looking for',       arg: 'query' },
    hover:             { verb: 'inspecting',        arg: 'symbol' },
    code_actions:      { verb: 'checking fixes for', arg: 'path' },
    rename_symbol:     { verb: 'renaming',          arg: 'symbol' },
    impact_analysis:   { verb: 'tracing impact of', arg: 'path' },
    search_history:    { verb: 'searching history for', arg: 'query' },
    blame:             { verb: 'blaming',           arg: 'path' },
    why_was_this_changed: { verb: 'reading history of', arg: 'path' },
    read_notebook:     { verb: 'opened',            arg: 'path' },
    edit_notebook_cell: { verb: 'editing',          arg: 'path' },
    browser_open:      { verb: 'opening',           arg: 'url' },
    browser_screenshot: { verb: 'screenshotting',   arg: 'url' },
    browser_click:     { verb: 'clicking',          arg: 'selector' },
    browser_type:      { verb: 'typing into',       arg: 'selector' },
    browser_read:      { verb: 'reading the page',  arg: 'selector' },
    browser_close:     { verb: 'closing the browser', arg: '' },
    mcp_call:          { verb: 'calling',           arg: 'tool' },
    spawn_subagent:    { verb: 'delegating to',     arg: 'name' },
    update_plan:       { verb: 'updating the plan', arg: '' },
    create_artifact:   { verb: 'writing',           arg: 'name' },
    update_mindmap:    { verb: 'updating the mindmap', arg: '' },
    remember:          { verb: 'remembering',       arg: 'text' },
    schedule_task:     { verb: 'scheduling',        arg: 'task' },
    cancel_task:       { verb: 'cancelling',        arg: 'taskId' },
};

/** Fallback argument keys, tried in order when the row's named key is absent. */
const ARG_FALLBACKS = ['path', 'file', 'command', 'query', 'url', 'symbol', 'name', 'selector'];

/**
 * A tool call as a sentence, or undefined when there is no tool.
 *
 * Accepts the bus's `ToolStarted` shape structurally rather than importing it, so this
 * stays usable from the registry (which sees a private event shape) and from tests.
 */
export function narrate(
    event: { name?: string; arguments?: any; ts?: number } | undefined,
): Activity | undefined {
    const tool = String(event?.name || '').trim();
    if (!tool) return undefined;

    const row = VERBS[tool];
    // An unlisted tool is named, never guessed at. See this file's header.
    const verb = row?.verb ?? tool;
    const target = pickArgument(event?.arguments, row?.arg);
    const parts: { label?: string; dir?: string } = target === undefined ? {} : splitTarget(target);

    return {
        tool,
        verb,
        target,
        label: parts.label,
        dir: parts.dir,
        startedAt: typeof event?.ts === 'number' ? event.ts : undefined,
    };
}

/**
 * Split a target into the part worth rendering large and the part worth rendering small.
 *
 * Path-shaped values split at the last separator; everything else (a query, a command)
 * is its own label with no directory. Both are capped, because a 4 000-character grep
 * pattern is a real thing a model emits and a desk is 30 columns wide.
 */
export function splitTarget(value: string): { label: string; dir?: string } {
    const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!flat) return { label: '' };

    // Only treat it as a path when it has a separator *and* no spaces before it — a
    // command like `npm test -- src/a.ts` is a command, and rendering `a.ts` as its
    // label would hide the thing that is actually running.
    const looksLikePath = /^[^\s]+[\\/][^\s]*$/.test(flat);
    if (!looksLikePath) return { label: cap(flat, 64) };

    const separator = Math.max(flat.lastIndexOf('/'), flat.lastIndexOf('\\'));
    const label = flat.slice(separator + 1);
    const dir = flat.slice(0, separator + 1);
    return { label: cap(label || flat, 48), dir: cap(dir, 40) };
}

/** `opened apiSlice.tsx`, or `opened —` when the lane forwarded no arguments (R1). */
export function describeActivity(activity: Activity | undefined): string {
    if (!activity) return '';
    const target = activity.label ?? activity.target;
    return target ? `${activity.verb} ${target}` : `${activity.verb} —`;
}

export type Staleness = 'ok' | 'slow' | 'stalled';

/**
 * How worried to be about a tool that has not finished.
 *
 * The single highest-value cell on a desk, because a stalled agent looks *identical* to a
 * working one on every surface we have today: both show a spinner. The thresholds are
 * deliberately generous — a test suite legitimately runs for a minute — so `slow` reads as
 * "this is the long one" and `stalled` as "go and look".
 *
 * Returns `ok` when there is no start time, rather than guessing. A lane that does not
 * publish timing gets no warning badge, which is the honest outcome; inventing one from
 * the desk's own render time would flag every agent the moment the panel opened.
 */
export const SLOW_AFTER_MS = 8_000;
export const STALLED_AFTER_MS = 30_000;

export function staleness(startedAt: number | undefined, now: number): Staleness {
    if (!startedAt || !Number.isFinite(startedAt)) return 'ok';
    const elapsed = now - startedAt;
    if (elapsed >= STALLED_AFTER_MS) return 'stalled';
    if (elapsed >= SLOW_AFTER_MS) return 'slow';
    return 'ok';
}

/**
 * Read the argument a verb acts on.
 *
 * Returns undefined — never `''`, never `'unknown'` — when the lane forwarded no
 * arguments at all, because "we did not measure this" and "this tool took no argument"
 * are different facts and the desk renders them differently.
 */
function pickArgument(args: any, key: string | undefined): string | undefined {
    if (args === undefined || args === null) return undefined;
    if (typeof args === 'string') return args.trim() || undefined;
    if (typeof args !== 'object') return undefined;

    const keys = key ? [key, ...ARG_FALLBACKS] : ARG_FALLBACKS;
    for (const candidate of keys) {
        if (!candidate) continue;
        const value = (args as Record<string, unknown>)[candidate];
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number') return String(value);
    }
    return undefined;
}

function cap(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
