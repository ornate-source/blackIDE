// ─── Egress control (Phase 12) ──────────────────────────────────────────────
//
// G4 is "local-only telemetry + diagnostics export", and the roadmap calls it "a selling
// point, not a placeholder". The Phase 12 gate turns that into something checkable: **the
// default build phones home to nobody, asserted in tests**, and **disabling the sink
// removes all egress**.
//
// The difficulty is that "we don't phone home" is a claim about code that does not exist,
// and you cannot test for the absence of a thing by looking at the thing. So this module
// inverts it: every outbound destination is *registered here, with a reason and a
// trigger*, and a test walks the source for network calls and fails on any that is not
// accounted for. The claim becomes "the only egress is this list", which is checkable, and
// the list is short enough to read.
//
// ── The distinction that makes the list honest ──────────────────────────────
// There is a real difference between egress that is **the feature the user asked for** —
// an LLM request, a documentation crawl, a web search — and egress that happens *because
// we decided it should*. Only the second is phoning home, and this codebase has none of
// it. Recording both kinds in one list, labelled, is what stops the claim being a word
// game: "we don't send telemetry" is easy to say while sending everything else.

export type EgressTrigger =
    /** The user asked for this exact thing, now. No egress without an explicit action. */
    | 'user-action'
    /** Part of running a task the user started (an LLM call). */
    | 'agent-run'
    /** Opt-in and off by default; disabling it removes the egress entirely. */
    | 'opt-in';

export interface EgressPoint {
    id: string;
    /** Where the request goes. `configured` means the user supplied the host. */
    destination: string;
    trigger: EgressTrigger;
    /** The module that makes the call. Kept current by the accounting test. */
    module: string;
    why: string;
    /** The setting that switches it off, when there is one. */
    disabledBy?: string;
}

/**
 * Every outbound network call this extension can make.
 *
 * Adding one without adding it here fails `__tests__/egress.test.ts`. That is the point:
 * the register is not documentation, it is the allowlist the test enforces.
 */
export const EGRESS_REGISTER: EgressPoint[] = [
    {
        id: 'llm',
        destination: 'configured',
        trigger: 'agent-run',
        module: 'core/llm-client.ts',
        why: 'The model request itself. The endpoint is whichever provider the user configured, '
            + 'including a local one — a llama.cpp run makes no network call at all.',
    },
    {
        id: 'embeddings',
        destination: 'configured',
        trigger: 'agent-run',
        module: 'core/embeddings-client.ts',
        why: 'Vector embeddings for the codebase index. Local runtimes are supported and used '
            + 'when configured; with no embedding model the index falls back to BM25 and makes no request.',
        disabledBy: 'no embedding model configured',
    },
    {
        id: 'web-search',
        destination: 'configured',
        trigger: 'agent-run',
        module: 'tools/web-search.ts',
        why: 'The `web_search` tool, when the agent uses it. Brave/Tavily/Google CSE if a key is '
            + 'set, DuckDuckGo otherwise.',
        disabledBy: 'the web_search tool being unavailable in the mode',
    },
    {
        id: 'gh-pr-review',
        destination: 'github.com (via the `gh` CLI)',
        trigger: 'user-action',
        module: 'core/review-command.ts',
        why: 'Posting a Reviewer artifact to a pull request (M48), from `black-ide.postReviewToPr` '
            + 'and nowhere else. Every post goes through M67/M68\'s per-action confirmation, which '
            + 'shows the payload verbatim and cannot be granted in advance — `OutboundContext` has '
            + 'no field for a remembered answer.',
        disabledBy: 'allowExternalPosting, and by simply not running the command',
    },
    {
        id: 'mcp-remote',
        destination: 'configured',
        trigger: 'agent-run',
        module: 'tools/mcp-http.ts',
        why: 'A remote MCP server the user configured in mcp.json (M49), plus its OAuth token '
            + 'endpoint. https-only except loopback. No remote server is contacted unless one is '
            + 'configured, and an unattended run refuses any that is not explicitly vetted (M51).',
        disabledBy: 'configuring no http/sse MCP server',
    },
    {
        id: 'docs-crawl',
        destination: 'user-supplied URL',
        trigger: 'user-action',
        module: 'core/docs-index.ts',
        why: 'The `@docs` crawl, which only ever runs from an explicit `black-ide.addDocs` command. '
            + 'Crawling on stack detection would be a surprise involving egress (see M20).',
    },
    {
        id: 'browser',
        destination: 'user-supplied URL',
        trigger: 'agent-run',
        module: 'tools/browser-tool.ts',
        why: 'Playwright navigating where the agent was asked to look. Gated by an allowlist and '
            + 'off unless browser support is installed.',
        disabledBy: 'browserEnabled',
    },
    {
        id: 'browser-install',
        destination: 'npm registry',
        trigger: 'user-action',
        module: 'tools/browser-install.ts',
        why: 'Installing Playwright, only from the explicit `black-ide.installBrowserSupport` command.',
    },
    {
        id: 'model-list',
        destination: 'configured',
        trigger: 'user-action',
        module: 'agent/model-fetcher.ts',
        why: 'Fetching the provider\'s model list when the user opens Settings and asks to refresh. '
            + 'Goes to whichever provider they configured, with their own key.',
    },
    {
        id: 'local-runtime-probe',
        destination: 'loopback only (127.0.0.1)',
        trigger: 'user-action',
        module: 'core/webview-message-handler.ts',
        why: 'Probing a local Ollama/LM Studio for installed models when the settings panel asks. '
            + 'Loopback by construction — it never leaves the machine — but it is a network call and '
            + 'is registered so the accounting stays complete rather than nearly complete.',
    },
    {
        id: 'git-publish',
        destination: 'the repository\'s own git remote',
        trigger: 'user-action',
        module: 'agent/pipeline-entry.ts',
        why: '`git push -u origin <branch>` and `gh pr create`, when a pipeline run is configured to '
            + 'output a PR rather than a working-tree change. Found undeclared on 2026-08-03 while '
            + 'adding the skill fetch: it is a subprocess, so the source walk never saw it. The '
            + 'destination is the remote the user\'s own repository already points at, with their own '
            + 'credentials, and only when they chose the PR output mode.',
        disabledBy: 'the run\'s output mode being `apply` (the default) rather than `pr`',
    },
    {
        id: 'cli-git-publish',
        destination: 'the repository\'s own git remote',
        trigger: 'user-action',
        module: 'agent-core/headless-run.ts',
        why: 'The same push-and-open-a-PR sequence as `git-publish`, from the headless CLI, and only '
            + 'under `--output pr`. Listed separately because it is a second caller rather than the '
            + 'same one: the register names modules, and a module that pushes is egress whether or '
            + 'not another module already does the same thing.',
        disabledBy: '`--output apply`, which is the default',
    },
    {
        id: 'skill-pack-fetch',
        destination: 'user-supplied https git URL',
        trigger: 'user-action',
        module: 'tools/skill-fetch.ts',
        why: 'Fetching a third-party skill pack, only from the explicit `black-ide.addSkillFrom` '
            + 'command, at a ref the user pinned. It is a git subprocess rather than an in-process '
            + 'HTTP request, so the second accounting walk is the one that enforces this entry — a '
            + 'register that only lists the egress its first test can see documents the test.',
    },
    {
        id: 'verification-preview-probe',
        destination: 'loopback, or the preview URL the user configured',
        trigger: 'agent-run',
        module: 'agent/visual-capture.ts',
        why: 'A HEAD request asking whether a dev server is listening, before a run that changed a '
            + 'UI file spends two seconds launching Chromium to find out the slow way. Loopback '
            + 'unless the user set `verificationPreviewUrl` to something else, and registered '
            + 'anyway: a request that usually goes to 127.0.0.1 is still a request, and an '
            + 'accounting that skips the boring entries is one nobody can rely on for the '
            + 'interesting ones.',
        disabledBy: 'browserEnabled, and any change that touches no user-visible file',
    },
    {
        id: 'mcp-remote',
        destination: 'user-configured MCP server',
        trigger: 'agent-run',
        module: 'tools/mcp-client.ts',
        why: 'Talking to an MCP server the user configured. Today stdio only; remote transports '
            + 'are M49 and are not shipped.',
        disabledBy: 'no MCP server configured',
    },
];

/**
 * Egress that happens without the user having asked for anything.
 *
 * The gate's "phones home to nobody" reduces to this list being **empty**, and that is how
 * the test states it. It is deliberately computed rather than written down: a future entry
 * with no `trigger` — or one added as always-on — shows up here automatically.
 */
export function phoneHomePoints(register: EgressPoint[] = EGRESS_REGISTER): EgressPoint[] {
    return register.filter(point => point.trigger !== 'user-action'
        && point.trigger !== 'agent-run'
        && point.trigger !== 'opt-in');
}

/** Points that vanish entirely when their switch is off. */
export function optionalPoints(register: EgressPoint[] = EGRESS_REGISTER): EgressPoint[] {
    return register.filter(point => !!point.disabledBy);
}

/**
 * The analytics sink (M69), which is the one thing that *could* be a phone-home and is not.
 *
 * Off by default, self-hosted only, and pointed at a URL the org supplies. There is no
 * default endpoint — not an empty string that falls back to ours, no constant elsewhere in
 * the codebase. If the URL is absent the sink does nothing, which is what makes "disabling
 * the sink removes all egress" true by construction rather than by care.
 */
export interface AnalyticsConfig {
    enabled: boolean;
    /** The org's own collector. No default, deliberately. */
    endpoint?: string;
}

export type SinkDecision =
    | { send: false; reason: string }
    | { send: true; endpoint: string };

export function decideAnalyticsSend(config: AnalyticsConfig | undefined): SinkDecision {
    if (!config?.enabled) return { send: false, reason: 'Team analytics is off (the default).' };
    const endpoint = String(config.endpoint || '').trim();
    if (!endpoint) {
        return { send: false, reason: 'Team analytics is on but no self-hosted endpoint is configured, so nothing is sent.' };
    }
    if (!/^https?:\/\//i.test(endpoint)) {
        return { send: false, reason: `"${endpoint}" is not an http(s) URL, so nothing is sent.` };
    }
    return { send: true, endpoint };
}

/**
 * What the analytics payload may contain.
 *
 * Derived from the Phase 9 audit trail, which is already redacted (M54) — but redaction is
 * about *secrets*, and this is about a second question: an org's analytics sink should
 * learn how much the team used the agent, not what they were working on. So prompts, file
 * paths, file contents and tool arguments are excluded by construction, and the test
 * asserts a payload built from a hostile trail carries none of them.
 */
export interface AnalyticsEvent {
    at: number;
    kind: string;
    /** Counts only. */
    tokens?: number;
    costUsd?: number;
    durationMs?: number;
    /** The tool's *name*, never its arguments. */
    tool?: string;
    ok?: boolean;
    model?: string;
}

const ALLOWED_KEYS = new Set(['at', 'kind', 'tokens', 'costUsd', 'durationMs', 'tool', 'ok', 'model']);

/**
 * Project an audit entry into an analytics event, dropping everything else.
 *
 * An **allowlist**, not a redaction pass. Redaction asks "does this look like a secret";
 * this asks "is this one of the eight things we said we would send". The second is the
 * only one that survives somebody adding a field to the audit trail later.
 */
export function toAnalyticsEvent(entry: { at: number; kind: string; detail?: Record<string, unknown> }): AnalyticsEvent {
    const event: Record<string, unknown> = { at: entry.at, kind: entry.kind };
    for (const [key, value] of Object.entries(entry.detail || {})) {
        if (!ALLOWED_KEYS.has(key)) continue;
        if (typeof value === 'string' && key !== 'tool' && key !== 'model') continue;
        event[key] = value;
    }
    return event as unknown as AnalyticsEvent;
}
