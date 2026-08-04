import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ToolDefinition } from '@blackide/agent-core/core/types';
import { HttpMcpConnection, JsonRpcResponse, McpTransportError } from './mcp-http';
import {
    McpServerConfig, McpStdioConfig, classifyFailure, describeFailure, isRemote,
    parseServerConfig, partitionByVetting,
} from './mcp-transport';

// ─── MCP client (Feature 9; transports M49, primitives M50, vetting M51) ────
//
// Three transports behind one interface — stdio, streamable HTTP and the older HTTP+SSE —
// plus the two primitives beyond tools that the protocol defines: **resources** (things
// the server can hand the agent as context) and **prompts** (parameterised templates the
// server offers).
//
// ── What changed, and why the old shape could not carry it ──────────────────
// This client spoke one transport and hardcoded it into `_sendRequest`, and its failure
// path reported `MCP request timeout` for a crashed process, a wrong URL, an expired
// token and a server that was never an MCP server. That message names the mechanism by
// which we gave up rather than the cause, and it is the reason M49's acceptance clause is
// phrased as "degrades with a visible reason **rather than hanging**".
//
// So the transport is now an interface with a typed failure, and every path that can fail
// produces a sentence naming a cause and a next action. See `mcp-transport.ts`.

export type { McpServerConfig } from './mcp-transport';

export interface MCPTool {
    name: string;
    description: string;
    inputSchema: any;
    _server: string;
}

/** A resource a server offers as context (M50). */
export interface MCPResource {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
    _server: string;
}

/** A prompt template a server offers (M50). */
export interface MCPPrompt {
    name: string;
    description?: string;
    arguments?: { name: string; description?: string; required?: boolean }[];
    _server: string;
}

/** What a server contributes once connected, for the UI and the audit trail. */
export interface MCPServerStatus {
    name: string;
    kind: string;
    connected: boolean;
    tools: number;
    resources: number;
    prompts: number;
    /** Why it is not connected. Present exactly when `connected` is false. */
    reason?: string;
}

interface Connection {
    config: McpServerConfig;
    /** A child process for stdio, an `HttpMcpConnection` otherwise. */
    stdio?: { proc: any; exited: boolean; exitReason?: string };
    http?: HttpMcpConnection;
}

export interface ConnectOptions {
    /**
     * True for a pipeline, scheduled or daemon run. Unvetted servers are refused (M51),
     * because there is nobody to approve the tool calls they would contribute.
     */
    unattended?: boolean;
    /** Server identities a human has vetted. See `serverIdentity`. */
    vetted?: readonly string[];
}

const REQUEST_TIMEOUT_MS = 30_000;

export interface MCPClientOptions {
    /**
     * Per-request deadline.
     *
     * Configurable rather than fixed because the right number differs by lane: an
     * interactive call can afford to wait thirty seconds for a server doing real work, a
     * pipeline step holding a concurrency slot cannot, and a test asserting the deadline
     * fires should not take thirty seconds to do it.
     */
    requestTimeoutMs?: number;
}

export class MCPClient {
    private servers: Map<string, Connection> = new Map();
    private tools: MCPTool[] = [];
    private resources: MCPResource[] = [];
    private prompts: MCPPrompt[] = [];
    /** Why each configured server is not usable. Kept so the UI can say so. */
    private readonly failures = new Map<string, string>();
    private readonly timeoutMs: number;

    constructor(options: MCPClientOptions = {}) {
        this.timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    }

    /**
     * Load MCP server configs from the workspace.
     *
     * Malformed entries are **reported**, not dropped. The previous version returned
     * `config.servers || []` and silently ignored anything it could not read, so a typo in
     * `mcp.json` produced an agent with fewer tools and no explanation anywhere — which
     * presents to the user as the model having got worse overnight.
     */
    async loadConfigs(): Promise<McpServerConfig[]> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) return [];

        const configPaths = [
            path.join(rootPath, '.blackide', 'mcp.json'),
            path.join(rootPath, '.vscode', 'mcp.json'),
        ];

        for (const configPath of configPaths) {
            if (!fs.existsSync(configPath)) continue;
            let parsed: any;
            try {
                parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            } catch (error: any) {
                this.failures.set(path.basename(configPath), `${configPath} is not valid JSON: ${error?.message || error}`);
                continue;
            }

            const out: McpServerConfig[] = [];
            for (const raw of parsed.servers || []) {
                const result = parseServerConfig(raw);
                if (result.ok) out.push(result.config);
                else this.failures.set(result.name, `MCP server "${result.name}" was not loaded — ${result.reason}`);
            }
            return out;
        }
        return [];
    }

    /**
     * Connect every configured server that this run is allowed to use.
     *
     * The vetting split happens here rather than inside `connectServer`, so a refusal is
     * reported once with a reason a user can act on instead of appearing as a connection
     * that quietly did not happen.
     */
    async connectAll(configs: McpServerConfig[], options: ConnectOptions = {}): Promise<MCPServerStatus[]> {
        const { allowed, refused } = partitionByVetting(configs, {
            unattended: !!options.unattended,
            vetted: options.vetted,
        });
        for (const entry of refused) this.failures.set(entry.config.name, entry.reason);

        await Promise.all(allowed.map(config => this.connectServer(config)));
        return this.status(configs);
    }

    /** Connect to one server. Returns false and records a reason rather than throwing. */
    async connectServer(config: McpServerConfig): Promise<boolean> {
        try {
            if (isRemote(config)) {
                const connection = new HttpMcpConnection(config, { timeoutMs: this.timeoutMs });
                await connection.open();
                this.servers.set(config.name, { config, http: connection });
            } else {
                this.spawnStdio(config);
            }

            const initialize = await this.send(config.name, 'initialize', {
                protocolVersion: '2025-03-26',
                clientInfo: { name: 'black-ide-agent', version: '1.0.0' },
                // Declared honestly: this client consumes tools, resources and prompts and
                // does not implement sampling or roots. A server told otherwise may send
                // requests nothing here answers, which is a hang on its side.
                capabilities: { tools: {}, resources: {}, prompts: {} },
            });
            if (!initialize?.result) {
                throw new Error('the server answered `initialize` without a result, so it is not an MCP endpoint');
            }

            await this.notify(config.name, 'notifications/initialized');
            const offered = initialize.result.capabilities || {};

            await this.discoverTools(config.name);
            // Resources and prompts are optional in the protocol. Asking a server that
            // declared neither produces a `-32601 method not found` on every connect,
            // which is noise in the log and a round trip nobody needed.
            if (offered.resources) await this.discoverResources(config.name);
            if (offered.prompts) await this.discoverPrompts(config.name);

            this.failures.delete(config.name);
            return true;
        } catch (error) {
            this.failures.set(config.name, reasonFor(config, error));
            this.disconnectServer(config.name);
            return false;
        }
    }

    // ─── Tools ──────────────────────────────────────────────────────────────

    private async discoverTools(serverName: string): Promise<void> {
        const response = await this.send(serverName, 'tools/list');
        for (const tool of response?.result?.tools || []) {
            this.tools.push({
                name: tool.name,
                description: tool.description || '',
                inputSchema: tool.inputSchema || {},
                _server: serverName,
            });
        }
    }

    async callTool(toolName: string, args: any): Promise<any> {
        const bare = toolName.startsWith('mcp_') ? toolName.slice(4) : toolName;
        const tool = this.tools.find(t => t.name === bare || t.name === toolName);
        if (!tool) throw new Error(`MCP tool not found: ${toolName}`);

        const response = await this.send(tool._server, 'tools/call', { name: tool.name, arguments: args });
        if (response?.error) {
            throw new Error(`MCP tool error: ${response.error.message || JSON.stringify(response.error)}`);
        }
        return response?.result;
    }

    // ─── Resources (M50) ────────────────────────────────────────────────────

    private async discoverResources(serverName: string): Promise<void> {
        const response = await this.send(serverName, 'resources/list');
        for (const resource of response?.result?.resources || []) {
            if (!resource?.uri) continue;
            this.resources.push({
                uri: String(resource.uri),
                name: String(resource.name || resource.uri),
                description: resource.description ? String(resource.description) : undefined,
                mimeType: resource.mimeType ? String(resource.mimeType) : undefined,
                _server: serverName,
            });
        }
    }

    listResources(): MCPResource[] { return [...this.resources]; }

    /**
     * Read a resource as text.
     *
     * Binary contents are described rather than decoded. A base64 blob injected into a
     * prompt is tokens spent on something no model can read, and the description is what
     * lets the agent decide to ask for something else.
     */
    async readResource(uri: string): Promise<string> {
        const resource = this.resources.find(r => r.uri === uri);
        if (!resource) throw new Error(`MCP resource not found: ${uri}`);

        const response = await this.send(resource._server, 'resources/read', { uri });
        if (response?.error) throw new Error(`MCP resource error: ${response.error.message}`);

        const contents = response?.result?.contents || [];
        const parts: string[] = [];
        for (const item of contents) {
            if (typeof item?.text === 'string') parts.push(item.text);
            else if (item?.blob) parts.push(`[binary ${item.mimeType || 'content'}, ${String(item.blob).length} base64 chars — not inlined]`);
        }
        return parts.join('\n\n') || '(the resource is empty)';
    }

    // ─── Prompts (M50) ──────────────────────────────────────────────────────

    private async discoverPrompts(serverName: string): Promise<void> {
        const response = await this.send(serverName, 'prompts/list');
        for (const prompt of response?.result?.prompts || []) {
            if (!prompt?.name) continue;
            this.prompts.push({
                name: String(prompt.name),
                description: prompt.description ? String(prompt.description) : undefined,
                arguments: Array.isArray(prompt.arguments) ? prompt.arguments.map((a: any) => ({
                    name: String(a?.name || ''),
                    description: a?.description ? String(a.description) : undefined,
                    required: !!a?.required,
                })).filter((a: any) => a.name) : undefined,
                _server: serverName,
            });
        }
    }

    listPrompts(): MCPPrompt[] { return [...this.prompts]; }

    /** Invoke a prompt template, returning the messages it expands to. */
    async getPrompt(name: string, args: Record<string, string> = {}): Promise<{ description?: string; text: string }> {
        const prompt = this.prompts.find(p => p.name === name);
        if (!prompt) throw new Error(`MCP prompt not found: ${name}`);

        const missing = (prompt.arguments || []).filter(a => a.required && !args[a.name]).map(a => a.name);
        // Checked here rather than left to the server, because a server's error for a
        // missing argument is a JSON-RPC code and this one names the argument.
        if (missing.length) throw new Error(`MCP prompt "${name}" requires: ${missing.join(', ')}`);

        const response = await this.send(prompt._server, 'prompts/get', { name, arguments: args });
        if (response?.error) throw new Error(`MCP prompt error: ${response.error.message}`);

        const messages = response?.result?.messages || [];
        const text = messages
            .map((m: any) => {
                const content = m?.content;
                if (typeof content === 'string') return content;
                if (Array.isArray(content)) return content.map((c: any) => c?.text || '').filter(Boolean).join('\n');
                return content?.text || '';
            })
            .filter(Boolean)
            .join('\n\n');
        return { description: response?.result?.description, text };
    }

    // ─── The advertised surface ─────────────────────────────────────────────

    getToolDescriptions(): string {
        if (this.tools.length === 0) return '';
        return this.tools.map(t => {
            const params = t.inputSchema?.properties
                ? Object.keys(t.inputSchema.properties).join(', ')
                : 'no parameters';
            return `- mcp_${t.name}: ${t.description} (params: ${params})`;
        }).join('\n');
    }

    /**
     * Expose each discovered MCP tool as a real ToolDefinition, carrying the server's
     * own inputSchema so the model gets true per-tool typing rather than a free-form
     * arguments blob. Names are `mcp_`-prefixed; the executor strips the prefix.
     */
    getToolDefinitions(): ToolDefinition[] {
        return this.tools.map(t => ({
            name: `mcp_${t.name}`,
            description: `[MCP:${t._server}] ${t.description}`,
            risk: 'exec' as const,
            parameters: normalizeSchema(t.inputSchema),
        }));
    }

    getToolNames(): string[] { return this.tools.map(t => t.name); }

    isMCPTool(action: string): boolean {
        return action.startsWith('mcp_') && this.tools.some(t => `mcp_${t.name}` === action);
    }

    /** Everything the user needs to know about their MCP configuration, connected or not. */
    status(configured: McpServerConfig[] = []): MCPServerStatus[] {
        const names = new Set([...configured.map(c => c.name), ...this.servers.keys(), ...this.failures.keys()]);
        return [...names].map(name => {
            const connection = this.servers.get(name);
            const config = connection?.config || configured.find(c => c.name === name);
            return {
                name,
                kind: config?.kind || 'unknown',
                connected: !!connection,
                tools: this.tools.filter(t => t._server === name).length,
                resources: this.resources.filter(r => r._server === name).length,
                prompts: this.prompts.filter(p => p._server === name).length,
                reason: connection ? undefined : this.failures.get(name),
            };
        });
    }

    /** Why a server is unusable, for the UI and for a tool result the model reads. */
    failureFor(name: string): string | undefined { return this.failures.get(name); }

    // ─── Transport plumbing ─────────────────────────────────────────────────

    private async send(serverName: string, method: string, params?: unknown): Promise<JsonRpcResponse | undefined> {
        const connection = this.servers.get(serverName);
        if (!connection) throw new Error(`Server not connected: ${serverName}`);
        if (connection.http) return connection.http.request(method, params);
        return this.stdioRequest(connection, method, params);
    }

    private async notify(serverName: string, method: string, params?: unknown): Promise<void> {
        const connection = this.servers.get(serverName);
        if (!connection) return;
        if (connection.http) { await connection.http.notify(method, params); return; }
        try {
            connection.stdio?.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })}\n`);
        } catch { /* a notification has no response, so nobody could act on a failure */ }
    }

    private spawnStdio(config: McpStdioConfig): void {
        const { spawn } = require('child_process');
        const proc = spawn(config.command, config.args || [], {
            env: { ...process.env, ...(config.env || {}) },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const state: Connection['stdio'] = { proc, exited: false };

        /*
         * Watch for the process dying.
         *
         * This is the fix for the clause. Without it, a server that crashes on startup —
         * a missing binary, a bad argument, an unhandled exception in its own code —
         * leaves every request waiting for a ten-second timeout, and the message blames
         * the timeout. `stderr` is captured for the same reason: it is where the actual
         * reason is, and the old client threw it away.
         */
        let stderr = '';
        proc.stderr?.on('data', (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-2_000);
        });
        proc.on('exit', (code: number | null, signal: string | null) => {
            state.exited = true;
            state.exitReason = `exit code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`
                + (stderr.trim() ? `; stderr: ${stderr.trim().slice(-400)}` : '');
        });
        proc.on('error', (error: Error) => {
            state.exited = true;
            state.exitReason = error.message;
        });

        this.servers.set(config.name, { config, stdio: state });
    }

    /**
     * One JSON-RPC round trip over stdio.
     *
     * Settles on three things rather than one: the matching response, the process exiting,
     * or the deadline. The old version listened only for the response, so a dead server
     * and a slow one were the same event.
     */
    private stdioRequest(connection: Connection, method: string, params?: unknown): Promise<JsonRpcResponse> {
        const stdio = connection.stdio!;
        const id = Date.now() + Math.floor(Math.random() * 1_000);
        const name = connection.config.name;

        return new Promise((resolve, reject) => {
            if (stdio.exited) {
                reject(new Error(describeFailure(
                    name, { kind: 'exited', detail: stdio.exitReason || 'it is not running' }, method)));
                return;
            }

            let buffer = '';
            const settle = (fn: () => void) => {
                clearTimeout(timer);
                stdio.proc.stdout.off('data', onData);
                stdio.proc.off('exit', onExit);
                fn();
            };
            const onData = (chunk: Buffer) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                // Keep the trailing partial line; a JSON-RPC message can straddle chunks.
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.id === id) { settle(() => resolve(parsed)); return; }
                    } catch { /* interleaved log output from the server */ }
                }
            };
            const onExit = () => settle(() => reject(new Error(describeFailure(
                name, { kind: 'exited', detail: stdio.exitReason || 'it exited while this request was in flight' }, method))));
            const timer = setTimeout(() => settle(() => reject(new Error(describeFailure(
                name, { kind: 'timeout', detail: `no answer within ${this.timeoutMs} ms` }, method)))), this.timeoutMs);

            stdio.proc.stdout.on('data', onData);
            stdio.proc.once('exit', onExit);

            try {
                stdio.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`);
            } catch (error) {
                settle(() => reject(new Error(describeFailure(name, classifyFailure(error, { exited: true }), method))));
            }
        });
    }

    disconnectServer(name: string): void {
        const connection = this.servers.get(name);
        if (!connection) return;
        try { connection.http?.close(); } catch { /* already closed */ }
        try { connection.stdio?.proc.kill(); } catch { /* already gone */ }
        this.servers.delete(name);
        this.tools = this.tools.filter(t => t._server !== name);
        this.resources = this.resources.filter(r => r._server !== name);
        this.prompts = this.prompts.filter(p => p._server !== name);
    }

    async disconnectAll(): Promise<void> {
        for (const [name] of [...this.servers]) this.disconnectServer(name);
    }

    get connectedServers(): number { return this.servers.size; }
    get toolCount(): number { return this.tools.length; }
    get resourceCount(): number { return this.resources.length; }
    get promptCount(): number { return this.prompts.length; }
}

/** The user-facing reason a server did not connect. */
function reasonFor(config: McpServerConfig, error: unknown): string {
    if (error instanceof McpTransportError) return error.message;
    return describeFailure(config.name, classifyFailure(error), 'connection');
}

/** MCP servers are free to return a partial or absent inputSchema; providers are not. */
function normalizeSchema(schema: any): ToolDefinition['parameters'] {
    const properties = schema && typeof schema.properties === 'object' && schema.properties !== null
        ? schema.properties
        : {};
    const required = Array.isArray(schema?.required)
        ? schema.required.filter((r: any) => typeof r === 'string')
        : undefined;
    return { type: 'object', properties, ...(required?.length ? { required } : {}) };
}
