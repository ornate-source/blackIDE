import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    McpServerConfig, SseDecoder, buildTokenForm, classifyFailure, decideServerUse,
    describeFailure, isLoopback, parseServerConfig, parseTokenResponse, partitionByVetting,
    requestHeaders, serverIdentity, tokenExpired,
} from '../src/tools/mcp-transport';
import { EGRESS_REGISTER } from '../src/core/egress';

/**
 * MCP transports (M49 · P9-3), vetting (M51 · P9-5).
 *
 * The acceptance clause is "a remote MCP server works; **a transport failure degrades
 * with a visible reason rather than hanging**", and the weight is on the second half.
 * Before this, a crashed process, a wrong URL, an expired token and a server that was
 * never an MCP endpoint all produced the same sentence — `MCP request timeout` — after
 * ten silent seconds. That names the mechanism by which we gave up, not the cause.
 *
 * So most of this file is about failures: that each one is distinguished, and that each
 * message tells the reader what to do next. An agent told only that something failed
 * retries, and retrying a DNS failure eleven times is how a run burns its budget on a typo.
 */

const stdio = (over = {}) => parseServerConfig({ name: 's', command: 'node', args: ['x.js'], ...over });
const http = (over = {}) => parseServerConfig({ name: 'r', url: 'https://mcp.example.com/v1', ...over });

describe('config: the transport is inferred, and the failures are reported', () => {
    it('infers stdio from a command and http from a url', () => {
        expect(stdio()).toMatchObject({ ok: true, config: { kind: 'stdio', command: 'node' } });
        expect(http()).toMatchObject({ ok: true, config: { kind: 'http' } });
    });

    it('honours an explicit type, including the older sse transport', () => {
        const parsed = parseServerConfig({ name: 'r', type: 'sse', url: 'https://mcp.example.com/sse' });
        expect(parsed).toMatchObject({ ok: true, config: { kind: 'sse' } });
    });

    it('every existing command-only config keeps working without a "type"', () => {
        // There is no `type` field in any mcp.json in the wild. Requiring one would break
        // them all to gain nothing.
        expect(parseServerConfig({ name: 'g', command: 'npx', args: ['-y', 'server'] })).toMatchObject({ ok: true });
    });

    it('names the reason a config was rejected, rather than dropping it silently', () => {
        // The old loader returned `config.servers || []` and ignored anything malformed,
        // so a typo produced an agent with fewer tools and no explanation anywhere.
        expect(parseServerConfig({ command: 'node' })).toMatchObject({ ok: false, reason: 'no "name"' });
        expect(parseServerConfig({ name: 'x' })).toMatchObject({ ok: false });
        expect(parseServerConfig({ name: 'x', url: 'not a url' })).toMatchObject({ ok: false });
    });

    it('refuses plaintext to a remote host, and says why', () => {
        const parsed = parseServerConfig({ name: 'r', url: 'http://mcp.example.com/v1' });
        expect(parsed.ok).toBe(false);
        expect(parsed.ok === false && parsed.reason).toMatch(/must be https/);
        expect(parsed.ok === false && parsed.reason).toMatch(/authority of a/);
    });

    it('allows plaintext to loopback, which is how every MCP server is developed', () => {
        expect(parseServerConfig({ name: 'r', url: 'http://127.0.0.1:3000/mcp' })).toMatchObject({ ok: true });
        expect(parseServerConfig({ name: 'r', url: 'http://localhost:3000/mcp' })).toMatchObject({ ok: true });
    });

    it('is not fooled by a hostname that merely contains "localhost"', () => {
        // `http://127.0.0.1.evil.com` and `http://localhost@evil.com` both contain the
        // word, and neither is loopback. Only a URL parser reliably knows the host.
        expect(isLoopback('http://127.0.0.1.evil.com/')).toBe(false);
        expect(isLoopback('http://localhost@evil.com/')).toBe(false);
        expect(isLoopback('http://localhost:8080/')).toBe(true);
        expect(isLoopback('http://[::1]:8080/')).toBe(true);
    });

    it('refuses an OAuth token endpoint that is not https', () => {
        const parsed = parseServerConfig({
            name: 'r', url: 'https://mcp.example.com/v1',
            oauth: { clientId: 'c', tokenUrl: 'http://auth.example.com/token' },
        });
        expect(parsed.ok).toBe(false);
        expect(parsed.ok === false && parsed.reason).toMatch(/token sent in plaintext is a leaked token/);
    });
});

describe('OAuth', () => {
    const config = { clientId: 'client', tokenUrl: 'https://auth.example.com/token' };

    it('treats an absent token as expired and a lifetime-less token as eternal', () => {
        expect(tokenExpired(undefined)).toBe(true);
        // A server that did not declare a lifetime gets no invented one — spurious
        // refreshes of a still-good token are worse than none for a rate-limited server.
        expect(tokenExpired({ accessToken: 'a', tokenType: 'Bearer' })).toBe(false);
    });

    it('refreshes a minute early, so a token cannot expire in flight', () => {
        const now = 1_000_000;
        const token = { accessToken: 'a', tokenType: 'Bearer', expiresAt: now + 30_000 };
        expect(tokenExpired(token, now)).toBe(true);
        expect(tokenExpired({ ...token, expiresAt: now + 120_000 }, now)).toBe(false);
    });

    it('uses refresh_token when there is one and client_credentials otherwise', () => {
        expect(buildTokenForm({ ...config, refreshToken: 'r' }).get('grant_type')).toBe('refresh_token');
        expect(buildTokenForm(config).get('grant_type')).toBe('client_credentials');
        expect(buildTokenForm({ ...config, scopes: ['a', 'b'] }).get('scope')).toBe('a b');
    });

    it('parses a token response and only sets an expiry the server stated', () => {
        const now = 1_000;
        expect(parseTokenResponse({ access_token: 'a', expires_in: 60 }, now))
            .toMatchObject({ accessToken: 'a', tokenType: 'Bearer', expiresAt: 61_000 });
        expect(parseTokenResponse({ access_token: 'a' }, now)?.expiresAt).toBeUndefined();
        expect(parseTokenResponse({ error: 'invalid_grant' })).toBeUndefined();
    });

    it('accepts both content types on every request, so streaming is not silently opted out of', () => {
        // Streamable HTTP lets the server answer a POST with JSON *or* an SSE stream, and
        // it chooses on this header. Sending only application/json disables streaming
        // everywhere it is supported, invisibly.
        const headers = requestHeaders({ kind: 'http', name: 'r', url: 'https://x/y' });
        expect(headers.accept).toContain('application/json');
        expect(headers.accept).toContain('text/event-stream');
    });

    it('puts the token in the authorization header, and lets it beat a static one', () => {
        const headers = requestHeaders(
            { kind: 'http', name: 'r', url: 'https://x/y', headers: { authorization: 'Bearer stale' } },
            { accessToken: 'fresh', tokenType: 'Bearer' },
        );
        expect(headers.authorization).toBe('Bearer fresh');
    });
});

describe('SSE decoding survives arbitrary chunk boundaries', () => {
    it('decodes a complete frame', () => {
        const decoder = new SseDecoder();
        expect(decoder.push('data: {"id":1}\n\n')).toEqual([{ event: undefined, id: undefined, data: '{"id":1}' }]);
    });

    it('reassembles a frame split across chunks — the bug body.split() cannot have', () => {
        /*
         * The failure this class exists for. `body.split('\n\n')` passes every test
         * written against a recorded response and fails against a real server the first
         * time a chunk boundary lands inside a frame — intermittently, under load, looking
         * like the server dropping messages.
         */
        const decoder = new SseDecoder();
        expect(decoder.push('data: {"id"')).toEqual([]);
        expect(decoder.push(':1,"result"')).toEqual([]);
        expect(decoder.push(':{}}\n\n')).toEqual([{ event: undefined, id: undefined, data: '{"id":1,"result":{}}' }]);
    });

    it('joins multi-line data with a newline, per the spec', () => {
        const decoder = new SseDecoder();
        expect(decoder.push('data: line one\ndata: line two\n\n')[0].data).toBe('line one\nline two');
    });

    it('reads the event name and the id', () => {
        const decoder = new SseDecoder();
        expect(decoder.push('event: endpoint\nid: 7\ndata: /messages?s=1\n\n')[0])
            .toEqual({ event: 'endpoint', id: '7', data: '/messages?s=1' });
    });

    it('ignores comments and keep-alives without emitting an event', () => {
        const decoder = new SseDecoder();
        expect(decoder.push(': keep-alive\n\n')).toEqual([]);
    });

    it('normalises CRLF, so a stray carriage return does not end up inside the JSON', () => {
        const decoder = new SseDecoder();
        expect(decoder.push('data: {"a":1}\r\n\r\n')[0].data).toBe('{"a":1}');
    });

    it('emits several frames from one chunk', () => {
        const decoder = new SseDecoder();
        expect(decoder.push('data: a\n\ndata: b\n\n').map(e => e.data)).toEqual(['a', 'b']);
    });

    it('holds an unterminated frame rather than emitting half of it', () => {
        const decoder = new SseDecoder();
        expect(decoder.push('data: incomplete')).toEqual([]);
        expect(decoder.pending).toContain('incomplete');
    });
});

describe('failures are distinguished, and each says what to do next', () => {
    it('tells a refused connection from a wrong hostname from a TLS problem', () => {
        expect(classifyFailure({ code: 'ECONNREFUSED' }).kind).toBe('refused');
        expect(classifyFailure({ code: 'ENOTFOUND' }).kind).toBe('dns');
        expect(classifyFailure({ code: 'CERT_HAS_EXPIRED' }).kind).toBe('tls');
        expect(classifyFailure({ code: 'ETIMEDOUT' }).kind).toBe('timeout');
        expect(classifyFailure({ name: 'AbortError' }).kind).toBe('cancelled');
    });

    it('reads a code out of a wrapped cause, which is where fetch puts it', () => {
        expect(classifyFailure({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }).kind).toBe('refused');
    });

    it('separates auth from other HTTP statuses', () => {
        expect(classifyFailure('nope', { status: 401 }).kind).toBe('auth');
        expect(classifyFailure('nope', { status: 403 }).kind).toBe('auth');
        expect(classifyFailure('nope', { status: 500 }).kind).toBe('http');
    });

    it('a dead process is "exited", never "timeout"', () => {
        // The whole point. A crashed server and a slow one were the same event before.
        const failure = classifyFailure(new Error('spawn ENOENT'), { exited: true });
        expect(failure.kind).toBe('exited');
        expect(describeFailure('s', failure)).toMatch(/crash on its side, not a network problem/);
        expect(describeFailure('s', failure)).toMatch(/stderr is where the reason is/);
    });

    it('every message names a next action, and says when retrying is pointless', () => {
        const kinds = ['timeout', 'refused', 'dns', 'auth'] as const;
        for (const kind of kinds) {
            const message = describeFailure('s', { kind, detail: 'x', status: 401 });
            expect(message, `${kind} should say retrying will not help`).toMatch(/(Do not retry|will not help|will fail identically)/);
        }
    });

    it('a protocol failure points at the likeliest cause rather than at itself', () => {
        expect(describeFailure('s', { kind: 'protocol', detail: '<html>' }))
            .toMatch(/ordinary web server rather than an MCP endpoint/);
    });

    it('a TLS failure points at the loopback exemption for dev servers', () => {
        expect(describeFailure('s', { kind: 'tls', detail: 'self signed' })).toMatch(/loopback address/);
    });
});

// ─── Vetting (M51 · P9-5) ───────────────────────────────────────────────────

const config = (over: Partial<McpServerConfig> = {}): McpServerConfig =>
    ({ kind: 'stdio', name: 'github', command: 'npx', args: ['-y', 'mcp-github'], ...over } as McpServerConfig);

describe('vetting: identity is what runs, not what it is called', () => {
    it('identifies a stdio server by its command line', () => {
        expect(serverIdentity(config())).toBe('stdio:npx -y mcp-github');
    });

    it('renaming a server does not change its identity', () => {
        expect(serverIdentity(config({ name: 'anything-else' }))).toBe(serverIdentity(config()));
    });

    it('changing the command DOES change it — that is the attack', () => {
        // Vetting by name would mean an entry called `github` stays vetted after someone
        // edits it to run a different binary. It does not even need to be malicious.
        expect(serverIdentity(config({ args: ['-y', 'something-else'] }))).not.toBe(serverIdentity(config()));
    });

    it('identifies a remote server by origin AND path', () => {
        const base = { kind: 'http', name: 'r', url: 'https://mcp.example.com/v1/' } as McpServerConfig;
        expect(serverIdentity(base)).toBe('http:https://mcp.example.com/v1');
        // A vetted /v1 must not vet /admin.
        expect(serverIdentity({ ...base, url: 'https://mcp.example.com/admin' } as McpServerConfig))
            .not.toBe(serverIdentity(base));
    });

    it('an attended run may use anything — a human is there to approve the calls', () => {
        expect(decideServerUse(config(), { unattended: false }).allowed).toBe(true);
    });

    it('an unattended run refuses an unvetted server — G3\'s default holds', () => {
        const decision = decideServerUse(config(), { unattended: true, vetted: [] });
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toMatch(/not vetted for unattended runs/);
        // The refusal hands over the exact string to paste, so acting on it is one step.
        expect(decision.reason).toContain('stdio:npx -y mcp-github');
    });

    it('an unattended run uses a server whose exact identity was vetted', () => {
        expect(decideServerUse(config(), { unattended: true, vetted: ['stdio:npx -y mcp-github'] }).allowed).toBe(true);
    });

    it('vetting is per server: one vetted entry does not admit the others', () => {
        const { allowed, refused } = partitionByVetting(
            [config(), config({ name: 'other', command: 'other-bin' })],
            { unattended: true, vetted: ['stdio:npx -y mcp-github'] },
        );
        expect(allowed.map(c => c.name)).toEqual(['github']);
        expect(refused.map(r => r.config.name)).toEqual(['other']);
    });

    it('a name in the vetted list does not vet anything — only an identity does', () => {
        expect(decideServerUse(config(), { unattended: true, vetted: ['github'] }).allowed).toBe(false);
    });
});

describe('the lanes ask for vetting the way their audience implies', () => {
    const src = (...parts: string[]) =>
        readFileSync(join(__dirname, '..', 'src', ...parts), 'utf8');

    it('the pipeline lane connects unattended, against the vetted list', () => {
        // Structural, and worth defending. Before this the pipeline constructed an
        // `MCPClient` and never connected anything to it, so MCP was unavailable
        // unattended *by accident*. Unavailable-by-accident and refused-by-policy look
        // identical right up until somebody "fixes" the missing call — which is exactly
        // the kind of change a unit test over pure functions cannot see.
        const pipeline = src('agent', 'pipeline-entry.ts');
        expect(pipeline).toMatch(/mcpVettedServers/);
        expect(pipeline).toMatch(/connectAll\([\s\S]*?unattended:\s*true/);
    });

    it('the chat lane connects attended — a human approves each call there', () => {
        expect(src('agent', 'chat-task.ts')).toMatch(/connectAll\([\s\S]*?unattended:\s*false/);
    });

    it('a pipeline MCP failure does not fail the run', () => {
        // An optional integration that did not load must not take a build down with it.
        expect(src('agent', 'pipeline-entry.ts')).toMatch(/\[MCP\] Skipped:/);
    });
});

describe('the remote transport is declared egress', () => {
    it('mcp-http.ts is in the register, with the vetting rule stated', () => {
        const point = EGRESS_REGISTER.find(p => p.module === 'tools/mcp-http.ts');
        expect(point, 'a new outbound module must be registered').toBeTruthy();
        expect(point!.why).toMatch(/https-only except loopback/);
        expect(point!.why).toMatch(/vetted/);
    });

    it('it is not a phone-home point — the destination is the user\'s own server', () => {
        const point = EGRESS_REGISTER.find(p => p.module === 'tools/mcp-http.ts')!;
        expect(point.destination).toBe('configured');
        expect(point.trigger).toBe('agent-run');
    });
});
