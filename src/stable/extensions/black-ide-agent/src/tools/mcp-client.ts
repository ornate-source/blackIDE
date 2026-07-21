import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ToolDefinition } from '../core/types';

// MCP (Model Context Protocol) Client — Feature 9
// Connects to MCP servers via stdio transport using JSON-RPC protocol.

export interface MCPServerConfig {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

export interface MCPTool {
    name: string;
    description: string;
    inputSchema: any;
    _server: string; // internal: which server provides this tool
}

export class MCPClient {
    private servers: Map<string, { proc: any; config: MCPServerConfig }> = new Map();
    private tools: MCPTool[] = [];

    /** Load MCP server configs from workspace config files */
    async loadConfigs(): Promise<MCPServerConfig[]> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) return [];

        const configPaths = [
            path.join(rootPath, '.blackide', 'mcp.json'),
            path.join(rootPath, '.vscode', 'mcp.json'),
        ];

        for (const configPath of configPaths) {
            if (fs.existsSync(configPath)) {
                try {
                    const raw = fs.readFileSync(configPath, 'utf8');
                    const config = JSON.parse(raw);
                    return config.servers || [];
                } catch {
                    continue;
                }
            }
        }
        return [];
    }

    /** Connect to an MCP server via stdio transport */
    async connectServer(config: MCPServerConfig): Promise<boolean> {
        const { spawn } = require('child_process');

        try {
            const proc = spawn(config.command, config.args || [], {
                env: { ...process.env, ...(config.env || {}) },
                stdio: ['pipe', 'pipe', 'pipe']
            });

            this.servers.set(config.name, { proc, config });

            // Send initialize request
            const initResponse = await this._sendRequest(config.name, {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    clientInfo: { name: 'black-ide-agent', version: '1.0.0' },
                    capabilities: {}
                }
            });

            if (!initResponse?.result) {
                this.disconnectServer(config.name);
                return false;
            }

            // Send initialized notification
            proc.stdin.write(JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/initialized',
                params: {}
            }) + '\n');

            // Fetch available tools
            const toolsResponse = await this._sendRequest(config.name, {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
                params: {}
            });

            if (toolsResponse?.result?.tools) {
                for (const tool of toolsResponse.result.tools) {
                    this.tools.push({
                        name: tool.name,
                        description: tool.description || '',
                        inputSchema: tool.inputSchema || {},
                        _server: config.name,
                    });
                }
            }

            return true;
        } catch (err) {
            console.error(`Failed to connect MCP server ${config.name}:`, err);
            return false;
        }
    }

    /** Call an MCP tool */
    async callTool(toolName: string, args: any): Promise<any> {
        const tool = this.tools.find(t => t.name === toolName);
        if (!tool) throw new Error(`MCP tool not found: ${toolName}`);

        const response = await this._sendRequest(tool._server, {
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: { name: toolName, arguments: args }
        });

        if (response?.error) {
            throw new Error(`MCP tool error: ${response.error.message || JSON.stringify(response.error)}`);
        }

        return response?.result;
    }

    /** Get available tools for system prompt injection */
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

    /** Get list of available tool names */
    getToolNames(): string[] {
        return this.tools.map(t => t.name);
    }

    /** Check if a tool name is an MCP tool */
    isMCPTool(action: string): boolean {
        return action.startsWith('mcp_') && this.tools.some(t => `mcp_${t.name}` === action);
    }

    /** Send a JSON-RPC request to an MCP server */
    private async _sendRequest(serverName: string, request: any): Promise<any> {
        const server = this.servers.get(serverName);
        if (!server) throw new Error(`Server not connected: ${serverName}`);

        return new Promise((resolve, reject) => {
            const data = JSON.stringify(request) + '\n';
            server.proc.stdin.write(data);

            let buffer = '';
            const handler = (chunk: Buffer) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const parsed = JSON.parse(line);
                            if (parsed.id === request.id) {
                                server.proc.stdout.off('data', handler);
                                resolve(parsed);
                                return;
                            }
                        } catch {}
                    }
                }
                buffer = lines[lines.length - 1] || '';
            };

            server.proc.stdout.on('data', handler);

            // Timeout after 10 seconds
            setTimeout(() => {
                server.proc.stdout.off('data', handler);
                reject(new Error(`MCP request timeout for ${serverName}`));
            }, 10000);
        });
    }

    /** Disconnect a specific server */
    disconnectServer(name: string): void {
        const server = this.servers.get(name);
        if (server) {
            try {
                server.proc.kill();
            } catch {}
            this.servers.delete(name);
            this.tools = this.tools.filter(t => t._server !== name);
        }
    }

    /** Disconnect all servers */
    async disconnectAll(): Promise<void> {
        for (const [name] of this.servers) {
            this.disconnectServer(name);
        }
    }

    /** Get connected server count */
    get connectedServers(): number {
        return this.servers.size;
    }

    /** Get total tool count */
    get toolCount(): number {
        return this.tools.length;
    }
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
