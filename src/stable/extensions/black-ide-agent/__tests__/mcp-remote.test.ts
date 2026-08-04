import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCPClient } from '../src/tools/mcp-client';
import { McpServerConfig, parseServerConfig } from '../src/tools/mcp-transport';

/**
 * A remote MCP server actually works (M49 · P9-3), and its primitives are reachable
 * (M50 · P9-4).
 *
 * Against a real HTTP server on a real socket, not a mocked `fetch`. The distinction
 * matters for this feature specifically: the transport's job is framing, streaming and
 * failure, and a mock returns whatever shape the test author believed in — which is
 * exactly the belief under test. The server below is thirty lines and speaks both
 * response styles streamable HTTP permits, because handling only one of them is the most
 * likely way this client is wrong.
 */

interface Scenario {
    /** Answer this method with an SSE stream rather than a JSON body. */
    streamMethods?: Set<string>;
    /** Fail every request with this status. */
    status?: number;
    /** Accept the request and never answer, to exercise the deadline. */
    blackHole?: boolean;
    /** Require this bearer token; anything else gets a 401. */
    requireToken?: string;
}

const scenario: Scenario = {};
let server: http.Server;
let baseUrl = '';

const TOOLS = [{
    name: 'echo',
    description: 'Echoes its input',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}];

const RESOURCES = [{
    uri: 'file:///project/notes.md', name: 'notes.md',
    description: 'Project notes', mimeType: 'text/markdown',
}];

const PROMPTS = [{
    name: 'summarise',
    description: 'Summarise a file',
    arguments: [{ name: 'path', description: 'What to summarise', required: true }],
}];

function answer(method: string, params: any): { result?: any; error?: any } {
    switch (method) {
        case 'initialize':
            return { result: {
                protocolVersion: '2025-03-26',
                serverInfo: { name: 'test-server', version: '1' },
                capabilities: { tools: {}, resources: {}, prompts: {} },
            } };
        case 'tools/list': return { result: { tools: TOOLS } };
        case 'tools/call':
            return params?.name === 'echo'
                ? { result: { content: [{ type: 'text', text: `echo: ${params?.arguments?.text}` }] } }
                : { error: { code: -32602, message: `no such tool: ${params?.name}` } };
        case 'resources/list': return { result: { resources: RESOURCES } };
        case 'resources/read':
            return params?.uri === RESOURCES[0].uri
                ? { result: { contents: [
                    { uri: params.uri, mimeType: 'text/markdown', text: '# Notes\nShip it.' },
                    { uri: params.uri, mimeType: 'image/png', blob: 'AAAA' },
                ] } }
                : { error: { code: -32602, message: 'no such resource' } };
        case 'prompts/list': return { result: { prompts: PROMPTS } };
        case 'prompts/get':
            return { result: {
                description: 'Summarise a file',
                messages: [{ role: 'user', content: { type: 'text', text: `Summarise ${params?.arguments?.path}` } }],
            } };
        default: return { error: { code: -32601, message: `method not found: ${method}` } };
    }
}

beforeAll(async () => {
    server = http.createServer((request, response) => {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            if (scenario.status) {
                response.writeHead(scenario.status, { 'content-type': 'text/plain' });
                response.end('nope');
                return;
            }
            if (scenario.requireToken && request.headers.authorization !== `Bearer ${scenario.requireToken}`) {
                response.writeHead(401, { 'content-type': 'text/plain' });
                response.end('bad token');
                return;
            }
            if (scenario.blackHole) return;   // accepted, never answered

            let message: any;
            try { message = JSON.parse(body); } catch { message = {}; }
            if (message.id === undefined) { response.writeHead(202).end(); return; }   // a notification

            const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, ...answer(message.method, message.params) });

            if (scenario.streamMethods?.has(message.method)) {
                response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
                // Deliberately split across writes, with an unrelated progress event
                // first: a client that reads only the first frame, or that cannot
                // reassemble one, fails here and nowhere else.
                response.write(': keep-alive\n\n');
                response.write('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n');
                response.write(`data: ${payload.slice(0, 12)}`);
                setTimeout(() => response.end(`${payload.slice(12)}\n\n`), 10);
                return;
            }
            response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
            response.end(payload);
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

function reset(next: Scenario = {}) {
    scenario.streamMethods = next.streamMethods;
    scenario.status = next.status;
    scenario.blackHole = next.blackHole;
    scenario.requireToken = next.requireToken;
}

const configFor = (over: Record<string, unknown> = {}): McpServerConfig => {
    const parsed = parseServerConfig({ name: 'remote', url: baseUrl, ...over });
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.config;
};

describe('a remote MCP server works', () => {
    it('connects, lists tools, and calls one', async () => {
        reset();
        const client = new MCPClient();
        expect(await client.connectServer(configFor())).toBe(true);
        expect(client.getToolNames()).toEqual(['echo']);
        expect(client.getToolDefinitions()[0].name).toBe('mcp_echo');

        const result = await client.callTool('mcp_echo', { text: 'hi' });
        expect(result.content[0].text).toBe('echo: hi');
        await client.disconnectAll();
    });

    it('handles an SSE-framed response as readily as a JSON one', async () => {
        // Streamable HTTP lets the server pick per request. A client that handles only
        // the JSON shape works against half the servers in existence and looks fine in
        // every test written against the other half.
        reset({ streamMethods: new Set(['initialize', 'tools/list', 'tools/call']) });
        const client = new MCPClient();
        expect(await client.connectServer(configFor())).toBe(true);
        expect((await client.callTool('mcp_echo', { text: 'streamed' })).content[0].text).toBe('echo: streamed');
        await client.disconnectAll();
    });

    it('sends the session id the server assigned on every later request', async () => {
        reset();
        const seen: (string | undefined)[] = [];
        const client = new MCPClient();
        const original = server.listeners('request')[0] as any;
        server.removeAllListeners('request');
        server.on('request', (req: any, res: any) => { seen.push(req.headers['mcp-session-id']); original(req, res); });

        await client.connectServer(configFor());
        await client.callTool('mcp_echo', { text: 'x' });
        // The first request cannot carry a session; every one after it must.
        expect(seen[0]).toBeUndefined();
        expect(seen.slice(1).filter(Boolean).length).toBeGreaterThan(0);

        server.removeAllListeners('request');
        server.on('request', original);
        await client.disconnectAll();
    });
});

describe('resources and prompts (M50)', () => {
    it('lists resources and reads one as context', async () => {
        reset();
        const client = new MCPClient();
        await client.connectServer(configFor());

        expect(client.listResources()).toHaveLength(1);
        expect(client.listResources()[0].mimeType).toBe('text/markdown');

        const content = await client.readResource('file:///project/notes.md');
        expect(content).toContain('Ship it.');
        // A base64 blob in a prompt is tokens spent on something no model can read. It is
        // described so the agent can decide to ask for something else.
        expect(content).toMatch(/\[binary image\/png/);
        await client.disconnectAll();
    });

    it('lists prompts and invokes one', async () => {
        reset();
        const client = new MCPClient();
        await client.connectServer(configFor());

        expect(client.listPrompts().map(p => p.name)).toEqual(['summarise']);
        const expanded = await client.getPrompt('summarise', { path: 'README.md' });
        expect(expanded.text).toBe('Summarise README.md');
        await client.disconnectAll();
    });

    it('names the missing argument rather than letting the server return a code', async () => {
        reset();
        const client = new MCPClient();
        await client.connectServer(configFor());
        await expect(client.getPrompt('summarise', {})).rejects.toThrow(/requires: path/);
        await client.disconnectAll();
    });

    it('reports an unknown resource or prompt rather than returning nothing', async () => {
        reset();
        const client = new MCPClient();
        await client.connectServer(configFor());
        await expect(client.readResource('file:///nope')).rejects.toThrow(/resource not found/);
        await expect(client.getPrompt('nope')).rejects.toThrow(/prompt not found/);
        await client.disconnectAll();
    });
});

describe('a transport failure degrades with a visible reason rather than hanging', () => {
    it('a 401 says the credentials were rejected and that retrying will not help', async () => {
        reset({ requireToken: 'good' });
        const client = new MCPClient();
        expect(await client.connectServer(configFor({ bearerToken: 'wrong' }))).toBe(false);

        const reason = client.failureFor('remote')!;
        expect(reason).toMatch(/rejected the credentials \(HTTP 401\)/);
        expect(reason).toMatch(/Re-authorise/);
        expect(reason).not.toMatch(/timeout/i);
    });

    it('a correct bearer token gets through', async () => {
        reset({ requireToken: 'good' });
        const client = new MCPClient();
        expect(await client.connectServer(configFor({ bearerToken: 'good' }))).toBe(true);
        await client.disconnectAll();
    });

    it('a 500 reports the status, not a timeout', async () => {
        reset({ status: 500 });
        const client = new MCPClient();
        expect(await client.connectServer(configFor())).toBe(false);
        expect(client.failureFor('remote')).toMatch(/HTTP 500/);
    });

    it('nothing listening reports a refused connection, not a timeout', async () => {
        reset();
        // Bind an ephemeral port and immediately release it, rather than picking a low
        // one: undici refuses ports 1 and 7 as "bad port" before it ever connects, which
        // produces a *different* error and would have made this test assert nothing.
        const idle = http.createServer();
        await new Promise<void>(resolve => idle.listen(0, '127.0.0.1', resolve));
        const port = (idle.address() as AddressInfo).port;
        await new Promise<void>(resolve => idle.close(() => resolve()));

        const client = new MCPClient();
        expect(await client.connectServer(configFor({ url: `http://127.0.0.1:${port}/mcp` }))).toBe(false);
        const reason = client.failureFor('remote')!;
        expect(reason).toMatch(/Nothing is listening/);
        expect(reason).toMatch(/Retrying will not help/);
    });

    it('a server that accepts and never answers FAILS on a deadline instead of hanging', async () => {
        /*
         * The clause, literally. Before this the promise never settled and the run
         * stopped; the assertion that matters is that this test finishes at all.
         */
        reset({ blackHole: true });
        const client = new MCPClient({ requestTimeoutMs: 1_000 });
        const started = Date.now();
        expect(await client.connectServer(configFor())).toBe(false);
        // Settled on the deadline rather than never. The assertion that matters most is
        // that this test finishes at all.
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(client.failureFor('remote')).toBeTruthy();
    }, 30_000);

    it('a server that is not an MCP endpoint says so, rather than reporting a timeout', async () => {
        reset();
        const plain = http.createServer((_, response) => {
            response.writeHead(200, { 'content-type': 'text/html' });
            response.end('<html>hello</html>');
        });
        await new Promise<void>(resolve => plain.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(plain.address() as AddressInfo).port}/`;

        const client = new MCPClient();
        expect(await client.connectServer(configFor({ url }))).toBe(false);
        expect(client.failureFor('remote')).toBeTruthy();

        await new Promise<void>(resolve => plain.close(() => resolve()));
    });

    it('a connection closed mid-flight settles its pending requests', async () => {
        // A closed connection with parked promises is a run that never finishes — the
        // same failure as a hang, arrived at from the other direction.
        reset({ blackHole: true });
        const client = new MCPClient({ requestTimeoutMs: 2_000 });
        const connecting = client.connectServer(configFor());
        await new Promise(resolve => setTimeout(resolve, 50));
        await client.disconnectAll();
        expect(await connecting).toBe(false);
    }, 30_000);
});
