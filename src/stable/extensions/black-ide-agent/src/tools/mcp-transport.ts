// ─── MCP transports: the decision layer (Phase 9, M49 · P9-3) ──────────────
//
// Until now `mcp-client.ts` spoke exactly one transport — a child process over stdio —
// and every remote MCP server in existence was unreachable. This module adds the two the
// specification defines (**streamable HTTP** and the older **HTTP+SSE**), plus OAuth, and
// it does so as *data and pure functions* so the parts that are easy to get quietly wrong
// are testable without a server.
//
// ── The acceptance clause is about failure, not success ─────────────────────
// "A remote MCP server works; **a transport failure degrades with a visible reason
// rather than hanging.**" The second half is the engineering. A local stdio server that
// crashes and a remote one behind a black-holing firewall produce the same symptom — a
// promise that never settles — and the existing client turned both into `MCP request
// timeout` after ten silent seconds. That message names the *mechanism by which we gave
// up*, not the cause, and it is identical for a wrong URL, an expired token, a crashed
// process and a server that simply is not an MCP server.
//
// So failure is a first-class type here. `classifyFailure` maps what actually happened to
// a kind, and `describeFailure` writes the sentence the user and the model both see —
// including what to do about it. A tool result saying "the token expired; re-run
// black-ide.connectMcp to re-authorise" gets a different next move out of an agent than
// one saying "timeout".
//
// ── https-only, with one exception, stated once ─────────────────────────────
// Same rule as M60's skill fetch: TLS or loopback, nothing else. An MCP server speaks
// with the authority of a tool the agent will call, over a channel carrying whatever the
// agent has read; plaintext to a remote host is not a configuration choice a user should
// be able to make by accident. Loopback is exempt because `http://127.0.0.1:3000` is how
// every MCP server is developed and refusing it would just teach people to disable the
// check.

export type McpTransportKind = 'stdio' | 'http' | 'sse';

export interface McpStdioConfig {
    kind: 'stdio';
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

export interface McpHttpConfig {
    kind: 'http' | 'sse';
    name: string;
    url: string;
    /** Static headers. Secrets belong in `oauth` or the keychain, not here. */
    headers?: Record<string, string>;
    oauth?: OAuthConfig;
    /** Bearer token supplied directly, for servers issuing long-lived tokens. */
    bearerToken?: string;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export function isRemote(config: McpServerConfig): config is McpHttpConfig {
    return config.kind === 'http' || config.kind === 'sse';
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface ConfigParseOk { ok: true; config: McpServerConfig }
export interface ConfigParseError { ok: false; name: string; reason: string }
export type ConfigParseResult = ConfigParseOk | ConfigParseError;

/**
 * Is this URL one we are willing to speak plaintext to?
 *
 * Hostname-based rather than a regex over the string, because `http://127.0.0.1.evil.com`
 * and `http://localhost@evil.com` both contain "localhost" and neither is loopback. The
 * URL parser is the only thing that reliably knows which part is the host.
 */
export function isLoopback(url: string): boolean {
    try {
        const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
        // The 127.0.0.0/8 check is anchored at BOTH ends. `/^127\./` alone — which is what
        // this was first written as — matches `127.0.0.1.evil.com`, so a prefix test on a
        // hostname is the same class of mistake as the `includes('localhost')` it replaced.
        return host === 'localhost' || host === '::1'
            || host.endsWith('.localhost')
            || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
    } catch { return false; }
}

/**
 * Validate one entry from `mcp.json`.
 *
 * Returns a *reason* on failure rather than dropping the entry. The old loader returned
 * `config.servers || []` and silently ignored anything malformed, so a typo in a server
 * name produced an agent with fewer tools and no explanation anywhere — which presents as
 * the model being unable to do something it could do yesterday.
 */
export function parseServerConfig(raw: unknown): ConfigParseResult {
    if (!raw || typeof raw !== 'object') return { ok: false, name: '(unnamed)', reason: 'not an object' };
    const entry = raw as Record<string, unknown>;
    const name = String(entry.name ?? '').trim();
    if (!name) return { ok: false, name: '(unnamed)', reason: 'no "name"' };

    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    const command = typeof entry.command === 'string' ? entry.command.trim() : '';

    // The transport is inferred from which field is present unless stated, because every
    // existing config in the wild has a `command` and no `type`, and requiring one would
    // break them all to gain nothing.
    const declared = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : '';
    const kind: McpTransportKind | '' = declared === 'stdio' || declared === 'http' || declared === 'sse'
        ? declared
        : (url ? 'http' : command ? 'stdio' : '');

    if (!kind) return { ok: false, name, reason: 'needs either "command" (stdio) or "url" (http/sse)' };

    if (kind === 'stdio') {
        if (!command) return { ok: false, name, reason: 'stdio transport needs a "command"' };
        return {
            ok: true,
            config: {
                kind: 'stdio', name, command,
                args: Array.isArray(entry.args) ? entry.args.map(String) : undefined,
                env: isStringMap(entry.env) ? entry.env : undefined,
            },
        };
    }

    if (!url) return { ok: false, name, reason: `${kind} transport needs a "url"` };
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { ok: false, name, reason: `"${url}" is not a valid URL` }; }

    if (parsed.protocol !== 'https:' && !isLoopback(url)) {
        return {
            ok: false, name,
            reason: `refusing ${parsed.protocol}//${parsed.host} — an MCP server speaks with the authority of a `
                + 'tool the agent will call, so remote connections must be https. Loopback addresses are exempt.',
        };
    }

    const oauth = parseOAuthConfig(entry.oauth);
    if (oauth && !oauth.ok) return { ok: false, name, reason: `oauth: ${oauth.reason}` };

    return {
        ok: true,
        config: {
            kind, name, url,
            headers: isStringMap(entry.headers) ? entry.headers : undefined,
            bearerToken: typeof entry.bearerToken === 'string' ? entry.bearerToken : undefined,
            oauth: oauth?.ok ? oauth.config : undefined,
        },
    };
}

function isStringMap(value: unknown): value is Record<string, string> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && Object.values(value as object).every(v => typeof v === 'string');
}

// ─── OAuth ──────────────────────────────────────────────────────────────────

export interface OAuthConfig {
    clientId: string;
    /** Absent for a public client using PKCE — which is the shape most MCP servers use. */
    clientSecret?: string;
    tokenUrl: string;
    scopes?: string[];
    /** Obtained out of band, exchanged for access tokens from here on. */
    refreshToken?: string;
}

export interface OAuthToken {
    accessToken: string;
    tokenType: string;
    /** Epoch ms. Absent when the server did not say, in which case it is never refreshed. */
    expiresAt?: number;
    refreshToken?: string;
}

function parseOAuthConfig(raw: unknown): { ok: true; config: OAuthConfig } | { ok: false; reason: string } | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'object') return { ok: false, reason: 'not an object' };
    const entry = raw as Record<string, unknown>;

    const clientId = String(entry.clientId ?? '').trim();
    const tokenUrl = String(entry.tokenUrl ?? '').trim();
    if (!clientId) return { ok: false, reason: 'no "clientId"' };
    if (!tokenUrl) return { ok: false, reason: 'no "tokenUrl"' };
    try {
        if (new URL(tokenUrl).protocol !== 'https:' && !isLoopback(tokenUrl)) {
            return { ok: false, reason: 'the token endpoint must be https — a token sent in plaintext is a leaked token' };
        }
    } catch { return { ok: false, reason: `"${tokenUrl}" is not a valid URL` }; }

    return {
        ok: true,
        config: {
            clientId, tokenUrl,
            clientSecret: typeof entry.clientSecret === 'string' ? entry.clientSecret : undefined,
            scopes: Array.isArray(entry.scopes) ? entry.scopes.map(String) : undefined,
            refreshToken: typeof entry.refreshToken === 'string' ? entry.refreshToken : undefined,
        },
    };
}

/**
 * Refresh a minute early.
 *
 * The skew is not politeness. A token that expires between the moment it is checked and
 * the moment the request lands produces a 401 on a call the agent has already committed
 * to, and the retry costs a round trip and — for a tool with side effects — is not always
 * safe to make. Refreshing early costs one extra token request an hour.
 */
export const TOKEN_REFRESH_SKEW_MS = 60_000;

export function tokenExpired(token: OAuthToken | undefined, now = Date.now(), skewMs = TOKEN_REFRESH_SKEW_MS): boolean {
    if (!token?.accessToken) return true;
    if (token.expiresAt === undefined) return false;
    return now + skewMs >= token.expiresAt;
}

/** The form body for a refresh, or for a client-credentials grant when there is no refresh token. */
export function buildTokenForm(config: OAuthConfig): URLSearchParams {
    const form = new URLSearchParams();
    if (config.refreshToken) {
        form.set('grant_type', 'refresh_token');
        form.set('refresh_token', config.refreshToken);
    } else {
        form.set('grant_type', 'client_credentials');
    }
    form.set('client_id', config.clientId);
    if (config.clientSecret) form.set('client_secret', config.clientSecret);
    if (config.scopes?.length) form.set('scope', config.scopes.join(' '));
    return form;
}

export function parseTokenResponse(body: unknown, now = Date.now()): OAuthToken | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const json = body as Record<string, unknown>;
    const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
    if (!accessToken) return undefined;

    const expiresIn = Number(json.expires_in);
    return {
        accessToken,
        tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
        // Only when the server said. Inventing a lifetime for a token that did not
        // declare one produces spurious refreshes of a token that was still good, and
        // for a server with a low rate limit that is worse than not refreshing.
        expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1_000 : undefined,
        refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    };
}

/** Headers for a request: static ones, then auth, which wins. */
export function requestHeaders(config: McpHttpConfig, token?: OAuthToken): Record<string, string> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        // Both, always: streamable HTTP lets the server answer a single POST with either
        // a JSON body or an SSE stream, and it chooses based on this header. Sending only
        // `application/json` silently opts out of streaming on every server that supports it.
        accept: 'application/json, text/event-stream',
        ...(config.headers || {}),
    };
    const bearer = token?.accessToken || config.bearerToken;
    if (bearer) headers.authorization = `${token?.tokenType || 'Bearer'} ${bearer}`;
    return headers;
}

// ─── Server-sent events ─────────────────────────────────────────────────────

export interface SseEvent {
    event?: string;
    data: string;
    id?: string;
}

/**
 * An incremental SSE decoder.
 *
 * A class with state rather than a function over a whole body, because the entire point
 * of the transport is that the body arrives in pieces and a message can straddle any two
 * of them. The naive `body.split('\n\n')` works in every test written against a recorded
 * response and fails against a real server the first time a chunk boundary lands inside
 * a frame — which is intermittent, load-dependent, and looks like the server dropping
 * messages.
 *
 * Multi-line `data:` fields are joined with a newline, per the spec: a JSON-RPC message
 * long enough to be split across `data:` lines is otherwise silently corrupted.
 */
export class SseDecoder {
    private buffer = '';

    push(chunk: string): SseEvent[] {
        this.buffer += chunk;
        const events: SseEvent[] = [];

        // Frames end with a blank line. Normalise CRLF first — some servers send it and
        // the spec permits it, and a stray `\r` ends up inside the JSON otherwise.
        this.buffer = this.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        let boundary = this.buffer.indexOf('\n\n');
        while (boundary !== -1) {
            const frame = this.buffer.slice(0, boundary);
            this.buffer = this.buffer.slice(boundary + 2);
            const parsed = parseFrame(frame);
            if (parsed) events.push(parsed);
            boundary = this.buffer.indexOf('\n\n');
        }
        return events;
    }

    /** Anything left when the stream ended. A frame without its terminator is discarded. */
    get pending(): string { return this.buffer; }
}

function parseFrame(frame: string): SseEvent | undefined {
    const dataLines: string[] = [];
    let event: string | undefined;
    let id: string | undefined;

    for (const line of frame.split('\n')) {
        if (!line || line.startsWith(':')) continue;   // comment / keep-alive
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        // One optional space after the colon is part of the framing, not the data.
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');

        if (field === 'data') dataLines.push(value);
        else if (field === 'event') event = value;
        else if (field === 'id') id = value;
    }

    if (!dataLines.length) return undefined;
    return { event, id, data: dataLines.join('\n') };
}

// ─── Failure ────────────────────────────────────────────────────────────────

export type FailureKind =
    | 'timeout' | 'refused' | 'dns' | 'tls' | 'auth' | 'http' | 'protocol' | 'exited' | 'cancelled';

export interface TransportFailure {
    kind: FailureKind;
    /** The underlying detail, for the log. */
    detail: string;
    /** HTTP status, when there was one. */
    status?: number;
}

/**
 * Turn whatever went wrong into a kind.
 *
 * Node's error codes are the signal where they exist, because they distinguish the cases
 * a user can act on: `ECONNREFUSED` means the server is not running, `ENOTFOUND` means
 * the URL is wrong, `CERT_*` means TLS. Collapsing those into "connection failed" is what
 * turns a thirty-second fix into an afternoon.
 */
export function classifyFailure(error: unknown, context: { status?: number; exited?: boolean } = {}): TransportFailure {
    if (context.exited) {
        return { kind: 'exited', detail: detailOf(error) || 'the server process exited' };
    }
    if (context.status !== undefined) {
        if (context.status === 401 || context.status === 403) {
            return { kind: 'auth', status: context.status, detail: detailOf(error) || `HTTP ${context.status}` };
        }
        return { kind: 'http', status: context.status, detail: detailOf(error) || `HTTP ${context.status}` };
    }

    const code = errorCode(error);
    const message = detailOf(error);

    if (code === 'ABORT_ERR' || (error as any)?.name === 'AbortError') return { kind: 'cancelled', detail: message };
    if (code === 'ECONNREFUSED') return { kind: 'refused', detail: message };
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { kind: 'dns', detail: message };
    if (/^(CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO)/.test(String(code))) return { kind: 'tls', detail: message };
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || /timed? ?out/i.test(message)) {
        return { kind: 'timeout', detail: message };
    }
    return { kind: 'protocol', detail: message || 'the server sent something this client could not parse' };
}

/**
 * Dig the OS error code out of whatever `fetch` threw.
 *
 * Three levels of wrapping, all of them real. `fetch` rejects with a bare
 * `TypeError: fetch failed` and hides the cause one level down; on a dual-stack host it
 * hides it *two* levels down, inside an `AggregateError` holding one attempt per address
 * family. A lookup that reads only `error.code` sees `undefined` every time and reports
 * every network failure as a protocol error — which is worse than no classification,
 * because it points the reader at the wrong thing with confidence.
 */
function errorCode(error: unknown, depth = 0): string {
    if (!error || typeof error !== 'object' || depth > 3) return '';
    const record = error as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === 'string') return record.code;
    if (Array.isArray(record.errors)) {
        for (const inner of record.errors) {
            const code = errorCode(inner, depth + 1);
            if (code) return code;
        }
    }
    return errorCode(record.cause, depth + 1);
}

function detailOf(error: unknown): string {
    if (!error) return '';
    if (typeof error === 'string') return error;
    return String((error as any)?.message || error);
}

/**
 * The sentence the user and the model both read.
 *
 * Every branch names a cause and a next action. That pairing is the requirement: an agent
 * told only that something failed retries, and retrying a DNS failure eleven times is how
 * a run burns its budget on a typo.
 */
export function describeFailure(serverName: string, failure: TransportFailure, where = 'request'): string {
    const head = `MCP server "${serverName}" — the ${where} did not succeed.`;
    switch (failure.kind) {
        case 'timeout':
            return `${head} It accepted the connection and never answered. The server may be wedged; `
                + 'check its logs. Do not retry — a second identical request will hang the same way.';
        case 'refused':
            return `${head} Nothing is listening at that address. Start the server, or correct the "url" `
                + 'in mcp.json. Retrying will not help.';
        case 'dns':
            return `${head} The host does not resolve, so the "url" in mcp.json is wrong or the network `
                + 'is down. Retrying will not help.';
        case 'tls':
            return `${head} Its TLS certificate could not be verified (${failure.detail}). If this is a `
                + 'development server, use a loopback address, which is exempt from the https requirement.';
        case 'auth':
            return `${head} It rejected the credentials (HTTP ${failure.status}). The token has expired or `
                + 'lacks the scope for this call. Re-authorise the server; retrying with the same token will fail identically.';
        case 'http':
            return `${head} It answered HTTP ${failure.status}: ${failure.detail}`;
        case 'exited':
            return `${head} The server process exited (${failure.detail}). This is a crash on its side, `
                + 'not a network problem — its stderr is where the reason is.';
        case 'cancelled':
            return `${head} The run was cancelled before it answered.`;
        default:
            return `${head} It answered with something this client could not parse: ${failure.detail}. `
                + 'That usually means the URL points at an ordinary web server rather than an MCP endpoint.';
    }
}

// ─── Vetting (M51 · P9-5) ───────────────────────────────────────────────────

/**
 * An MCP server's identity, for the vetted allowlist.
 *
 * Identity is the *command or URL*, not the name. A name is a label the config file's
 * author chose, so vetting by name would mean an entry called `github` stays vetted after
 * someone edits it to run a different binary — which is the whole attack, and it does not
 * even need to be malicious to happen.
 */
export function serverIdentity(config: McpServerConfig): string {
    if (config.kind === 'stdio') {
        return `stdio:${[config.command, ...(config.args || [])].join(' ')}`;
    }
    try {
        const url = new URL(config.url);
        // Origin plus path: a vetted `https://mcp.example.com/v1` must not vet
        // `https://mcp.example.com/admin`.
        return `${config.kind}:${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
        return `${config.kind}:${config.url}`;
    }
}

export interface VettingDecision {
    allowed: boolean;
    reason?: string;
}

/**
 * May this server be used in *this* run?
 *
 * G3's default is that an unattended run refuses what it cannot ask about, and an MCP
 * server is the strongest case for it in the codebase: it contributes tools the agent
 * will call, over a channel the user cannot see, and the approval prompt that gates it
 * interactively has nobody to show itself to.
 *
 * Vetting is per server and explicit — an identity in the list, put there by a human. It
 * is deliberately not a wildcard, a domain pattern or a "trust all local servers" flag:
 * each of those is a rule about servers that do not exist yet, and the entire value of
 * the list is that somebody looked at each entry.
 */
export function decideServerUse(
    config: McpServerConfig,
    options: { unattended: boolean; vetted?: readonly string[] },
): VettingDecision {
    if (!options.unattended) return { allowed: true };

    const identity = serverIdentity(config);
    if ((options.vetted || []).includes(identity)) return { allowed: true };

    return {
        allowed: false,
        reason: `MCP server "${config.name}" is not vetted for unattended runs, so it was not connected. `
            + 'An unattended run has nobody to approve a tool call, and an MCP server contributes tools the '
            + `agent will call. Add this exact identity to mcpVettedServers to allow it:\n  ${identity}`,
    };
}

/** Partition a config list into what an unattended run may use and what it may not. */
export function partitionByVetting(
    configs: readonly McpServerConfig[],
    options: { unattended: boolean; vetted?: readonly string[] },
): { allowed: McpServerConfig[]; refused: { config: McpServerConfig; reason: string }[] } {
    const allowed: McpServerConfig[] = [];
    const refused: { config: McpServerConfig; reason: string }[] = [];
    for (const config of configs) {
        const decision = decideServerUse(config, options);
        if (decision.allowed) allowed.push(config);
        else refused.push({ config, reason: decision.reason! });
    }
    return { allowed, refused };
}
