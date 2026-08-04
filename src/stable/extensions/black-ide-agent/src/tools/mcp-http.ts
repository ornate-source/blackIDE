import {
    McpHttpConfig, OAuthToken, SseDecoder, TransportFailure, buildTokenForm, classifyFailure,
    describeFailure, parseTokenResponse, requestHeaders, tokenExpired,
} from './mcp-transport';

// ─── The HTTP transports (Phase 9, M49 · P9-3) ─────────────────────────────
//
// Two of them, because the specification has two and servers in the wild implement
// either:
//
//   **streamable HTTP** (`kind: 'http'`) — one endpoint. Every message is a POST; the
//   server answers with a JSON body for a simple call, or with an SSE stream when it
//   wants to send progress before the result. This is the current transport.
//
//   **HTTP+SSE** (`kind: 'sse'`) — the older two-channel shape. A long-lived `GET` opens
//   an event stream whose first event names a POST endpoint, and every request goes to
//   that endpoint while every response arrives on the stream.
//
// ── Everything is bounded, because the clause is about hanging ──────────────
// Each request carries an `AbortSignal` with a deadline, and the deadline is enforced by
// this client rather than hoped for from the server. The SSE reader has its own idle
// timeout on top: a stream that is open and silent is the exact failure the old stdio
// client could not distinguish from a slow answer, and it is the one that hangs a run.

/** Per-request deadline. Generous, because an MCP tool may legitimately do real work. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** How long a stream may stay open with nothing arriving before it is a failure. */
const IDLE_TIMEOUT_MS = 60_000;

export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: number | string;
    method: string;
    params?: unknown;
}

export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id?: number | string;
    result?: any;
    error?: { code: number; message: string; data?: unknown };
}

export class McpTransportError extends Error {
    constructor(readonly failure: TransportFailure, readonly serverName: string, where: string) {
        super(describeFailure(serverName, failure, where));
        this.name = 'McpTransportError';
    }
}

export interface HttpTransportOptions {
    timeoutMs?: number;
    /** Injected for tests. Defaults to the global. */
    fetchImpl?: typeof fetch;
    log?: (message: string) => void;
}

/**
 * A connection to a remote MCP server.
 *
 * Holds the OAuth token, the session id the server assigns, and — for the older SSE
 * transport — the endpoint the event stream told us to post to.
 */
export class HttpMcpConnection {
    private token?: OAuthToken;
    private sessionId?: string;
    private postUrl?: string;
    private nextId = 1;
    private closed = false;
    private readonly pending = new Map<number | string, {
        resolve: (value: JsonRpcResponse) => void;
        reject: (error: unknown) => void;
    }>();
    private streamAbort?: AbortController;

    constructor(
        private readonly config: McpHttpConfig,
        private readonly options: HttpTransportOptions = {},
    ) {}

    private get fetchImpl(): typeof fetch {
        return this.options.fetchImpl || fetch;
    }

    /**
     * Obtain (or refresh) the access token.
     *
     * Called before every request rather than once at connect. A connection outlives its
     * token — an editor left open overnight is the normal case — and refreshing lazily on
     * a 401 means the *first call after every expiry* fails, which for a tool with side
     * effects is not a failure you can simply retry.
     */
    private async ensureToken(): Promise<void> {
        const oauth = this.config.oauth;
        if (!oauth) return;
        if (!tokenExpired(this.token)) return;

        let response: Response;
        try {
            response = await this.fetchImpl(oauth.tokenUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
                body: buildTokenForm(oauth).toString(),
                signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
            });
        } catch (error) {
            throw new McpTransportError(classifyFailure(error), this.config.name, 'token request');
        }

        if (!response.ok) {
            const body = await safeText(response);
            throw new McpTransportError(
                classifyFailure(body, { status: response.status }), this.config.name, 'token request',
            );
        }

        const token = parseTokenResponse(await safeJson(response));
        if (!token) {
            throw new McpTransportError(
                { kind: 'protocol', detail: 'the token endpoint returned no access_token' },
                this.config.name, 'token request',
            );
        }
        // A rotated refresh token replaces the configured one for the rest of this
        // session. Not persisted: writing a credential into the user's mcp.json behind
        // their back is a decision this layer does not get to make.
        this.token = token;
        if (token.refreshToken) this.config.oauth = { ...oauth, refreshToken: token.refreshToken };
    }

    /** Open the connection. For `sse`, this also opens the event stream. */
    async open(): Promise<void> {
        await this.ensureToken();
        if (this.config.kind === 'sse') await this.openEventStream();
    }

    /**
     * Send a request and wait for its response.
     *
     * For streamable HTTP the answer comes back on this POST — either as JSON or as an
     * SSE stream that this method drains until the matching id arrives. For the older
     * transport the POST is acknowledged and the answer arrives on the long-lived stream,
     * so the promise is parked in `pending` and settled from there.
     */
    async request(method: string, params?: unknown): Promise<JsonRpcResponse> {
        if (this.closed) {
            throw new McpTransportError({ kind: 'cancelled', detail: 'the connection was closed' }, this.config.name, method);
        }
        await this.ensureToken();

        const id = this.nextId++;
        const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, params: params ?? {} };
        const target = this.config.kind === 'sse' ? this.postUrl : this.config.url;
        if (!target) {
            throw new McpTransportError(
                { kind: 'protocol', detail: 'the event stream never announced a POST endpoint' },
                this.config.name, method,
            );
        }

        const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const waiter = this.config.kind === 'sse' ? this.park(id, timeoutMs, method) : undefined;

        let response: Response;
        try {
            response = await this.fetchImpl(target, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify(message),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            this.pending.delete(id);
            throw new McpTransportError(classifyFailure(error), this.config.name, method);
        }

        // Streamable HTTP assigns a session on the initialize response and expects it
        // echoed on every subsequent request. Absent on servers that do not use one.
        const session = response.headers.get('mcp-session-id');
        if (session) this.sessionId = session;

        if (!response.ok) {
            this.pending.delete(id);
            throw new McpTransportError(
                classifyFailure(await safeText(response), { status: response.status }), this.config.name, method,
            );
        }

        if (waiter) return waiter;

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/event-stream')) {
            return this.drainForId(response, id, method);
        }
        const body = await safeJson(response);
        if (!body || typeof body !== 'object') {
            throw new McpTransportError(
                { kind: 'protocol', detail: 'the response body was not a JSON-RPC message' }, this.config.name, method,
            );
        }
        return body as JsonRpcResponse;
    }

    /** Fire-and-forget, for `notifications/*`. */
    async notify(method: string, params?: unknown): Promise<void> {
        if (this.closed) return;
        const target = this.config.kind === 'sse' ? this.postUrl : this.config.url;
        if (!target) return;
        try {
            await this.fetchImpl(target, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }),
                signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
            });
        } catch {
            // A notification has no response by definition, so a failure to deliver one
            // cannot be reported to anybody who could act on it. Swallowed rather than
            // thrown so `initialized` failing does not abort an otherwise-open connection.
        }
    }

    close(): void {
        this.closed = true;
        this.streamAbort?.abort();
        for (const [, waiter] of this.pending) {
            // Settle everything in flight. A closed connection with parked promises is a
            // run that never finishes, which is the failure this whole module is about.
            waiter.reject(new McpTransportError(
                { kind: 'cancelled', detail: 'the connection was closed while this request was in flight' },
                this.config.name, 'request',
            ));
        }
        this.pending.clear();
    }

    private headers(): Record<string, string> {
        const headers = requestHeaders(this.config, this.token);
        if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
        return headers;
    }

    private park(id: number, timeoutMs: number, method: string): Promise<JsonRpcResponse> {
        return new Promise<JsonRpcResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new McpTransportError(
                    { kind: 'timeout', detail: `no response on the event stream within ${timeoutMs} ms` },
                    this.config.name, method,
                ));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); },
            });
        });
    }

    /**
     * Read an SSE response until the message with `id` arrives.
     *
     * Notifications and progress events for other ids stream past and are dropped here
     * rather than buffered: this client has no consumer for server-initiated messages
     * yet, and holding them would be a leak with no reader.
     */
    private async drainForId(response: Response, id: number, method: string): Promise<JsonRpcResponse> {
        const decoder = new SseDecoder();
        const reader = response.body?.getReader();
        if (!reader) {
            throw new McpTransportError(
                { kind: 'protocol', detail: 'the server announced an event stream and sent no body' },
                this.config.name, method,
            );
        }

        const text = new TextDecoder();
        const deadline = Date.now() + (this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        try {
            while (Date.now() < deadline) {
                const { done, value } = await reader.read();
                if (done) break;
                for (const event of decoder.push(text.decode(value, { stream: true }))) {
                    const message = safeParse(event.data);
                    if (message && message.id === id) return message;
                }
            }
        } finally {
            try { await reader.cancel(); } catch { /* already closed */ }
        }

        throw new McpTransportError(
            { kind: 'timeout', detail: 'the event stream ended without answering this request' },
            this.config.name, method,
        );
    }

    /**
     * The older transport's long-lived channel.
     *
     * Opened once and read for the connection's lifetime, dispatching responses to parked
     * promises. Deliberately not awaited by `open()` beyond the endpoint announcement:
     * awaiting the whole stream would never return, and the first thing the server sends
     * is the one thing `open` needs.
     */
    private async openEventStream(): Promise<void> {
        this.streamAbort = new AbortController();
        let response: Response;
        try {
            response = await this.fetchImpl(this.config.url, {
                method: 'GET',
                headers: { ...requestHeaders(this.config, this.token), accept: 'text/event-stream' },
                signal: this.streamAbort.signal,
            });
        } catch (error) {
            throw new McpTransportError(classifyFailure(error), this.config.name, 'event stream');
        }
        if (!response.ok) {
            throw new McpTransportError(
                classifyFailure(await safeText(response), { status: response.status }),
                this.config.name, 'event stream',
            );
        }
        const reader = response.body?.getReader();
        if (!reader) {
            throw new McpTransportError(
                { kind: 'protocol', detail: 'the event stream had no body' }, this.config.name, 'event stream',
            );
        }

        const endpoint = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new McpTransportError(
                { kind: 'timeout', detail: 'the event stream opened and never announced its POST endpoint' },
                this.config.name, 'event stream',
            )), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
            void this.pump(reader, () => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
        });
        await endpoint;
    }

    private async pump(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        onEndpoint: () => void,
        onFailure: (error: unknown) => void,
    ): Promise<void> {
        const decoder = new SseDecoder();
        const text = new TextDecoder();
        let lastActivity = Date.now();

        try {
            while (!this.closed) {
                const read = await Promise.race([
                    reader.read(),
                    // The idle guard. A stream that is open and silent is indistinguishable
                    // from a slow answer without one, and it is the case that hangs a run.
                    new Promise<'idle'>(resolve => setTimeout(() => resolve('idle'), IDLE_TIMEOUT_MS)),
                ]);
                if (read === 'idle') {
                    if (Date.now() - lastActivity >= IDLE_TIMEOUT_MS) {
                        throw new McpTransportError(
                            { kind: 'timeout', detail: `the event stream sent nothing for ${IDLE_TIMEOUT_MS} ms` },
                            this.config.name, 'event stream',
                        );
                    }
                    continue;
                }
                if (read.done) break;
                lastActivity = Date.now();

                for (const event of decoder.push(text.decode(read.value, { stream: true }))) {
                    if (event.event === 'endpoint') {
                        this.postUrl = new URL(event.data, this.config.url).toString();
                        onEndpoint();
                        continue;
                    }
                    const message = safeParse(event.data);
                    if (!message?.id) continue;
                    const waiter = this.pending.get(message.id);
                    if (waiter) { this.pending.delete(message.id); waiter.resolve(message); }
                }
            }
            // The stream ended. Anything still parked will never be answered, so it is
            // settled here rather than left to its individual timeout — the difference
            // between a run reporting a dead server in a second and in thirty.
            this.failPending({ kind: 'exited', detail: 'the event stream closed' });
        } catch (error) {
            onFailure(error);
            this.failPending(
                error instanceof McpTransportError ? error.failure : classifyFailure(error),
            );
        }
    }

    private failPending(failure: TransportFailure): void {
        for (const [id, waiter] of [...this.pending]) {
            this.pending.delete(id);
            waiter.reject(new McpTransportError(failure, this.config.name, 'request'));
        }
    }
}

function safeParse(text: string): JsonRpcResponse | undefined {
    try {
        const value = JSON.parse(text);
        return value && typeof value === 'object' ? value as JsonRpcResponse : undefined;
    } catch { return undefined; }
}

async function safeText(response: Response): Promise<string> {
    try { return (await response.text()).slice(0, 500); } catch { return ''; }
}

async function safeJson(response: Response): Promise<unknown> {
    try { return await response.json(); } catch { return undefined; }
}
