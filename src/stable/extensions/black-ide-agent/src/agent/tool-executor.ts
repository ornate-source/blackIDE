import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentMode, ToolCall, ToolResult, ImagePart } from '../core/types';
import { isToolAllowedInMode } from '../core/tools';
import { ToolRunner } from '../tools/tool-runner';
import { WebSearchTool } from '../tools/web-search';
import { BrowserTool } from '../tools/browser-tool';
import { MCPClient } from '../tools/mcp-client';
import { ArtifactManager } from './artifact-manager';
import { KnowledgeStore } from '../memory/knowledge-store';
import { CheckpointManager } from '../core/checkpoint-manager';
import { CodebaseIndex } from '../core/codebase-index';

export interface ApprovalRequest {
    kind: 'edit' | 'create' | 'exec' | 'mcp';
    path?: string;
    command?: string;
    originalContent?: string;
    updatedContent?: string;
    toolName?: string;
}

export interface ExecutorDeps {
    /** The sandbox this executor runs under. Enforced on every call, not just advertised. */
    mode: AgentMode;
    rootPath: string;
    browserTool: BrowserTool;
    mcpClient: MCPClient;
    artifactManager: ArtifactManager;
    knowledgeStore: KnowledgeStore;
    codebaseIndex: CodebaseIndex;
    checkpoint: CheckpointManager;
    log: (msg: string) => void;
    approve: (req: ApprovalRequest) => Promise<boolean>;
    signal?: AbortSignal;
    commandTimeoutMs?: number;
    onPlan?: (steps: { title: string; status: string }[]) => void;
    onArtifact?: (a: { name: string; type: string; path: string }) => void;
    /** Live stdout/stderr from run_command, so a long build is watchable. */
    onTerminalChunk?: (stream: 'stdout' | 'stderr', text: string) => void;
    onFileChanged?: (path: string, kind: 'created' | 'modified' | 'deleted') => void;
    scheduleTask?: (tc: ToolCall) => void;
    cancelTask?: (id: string) => void;
    /** Provided by the main loop; undefined inside a subagent to prevent recursion. */
    spawnSubagent?: (name: string, task: string) => Promise<string>;
}

/** Executes a single tool call and returns a structured result for the model. */
export class AgentToolExecutor {
    constructor(private readonly d: ExecutorDeps) {}

    private abs(p: string): string {
        return path.isAbsolute(p) ? p : path.join(this.d.rootPath, p);
    }

    private ok(tc: ToolCall, content: string, images?: ImagePart[]): ToolResult {
        return { id: tc.id, name: tc.name, content, images };
    }
    private err(tc: ToolCall, content: string): ToolResult {
        return { id: tc.id, name: tc.name, content, isError: true };
    }

    async execute(tc: ToolCall): Promise<ToolResult> {
        const a = tc.arguments || {};

        // The sandbox gate. A tool the current mode forbids never reaches a handler,
        // even if it somehow got advertised to the model.
        if (!isToolAllowedInMode(tc.name, this.d.mode)) {
            return this.err(tc, `Tool "${tc.name}" is not available in ${this.d.mode} mode.`);
        }

        try {
            // MCP tools are discovered at runtime, so they cannot be switch cases.
            // Their arguments are passed through verbatim to the server.
            if (tc.name.startsWith('mcp_') && tc.name !== 'mcp_call') {
                const toolName = tc.name.slice('mcp_'.length);
                const approved = await this.d.approve({ kind: 'mcp', toolName });
                if (!approved) return this.ok(tc, `User rejected MCP tool ${toolName}.`);
                const result = await this.d.mcpClient.callTool(toolName, a);
                return this.ok(tc, typeof result === 'string' ? result : JSON.stringify(result, null, 2));
            }

            switch (tc.name) {
                case 'read_file': {
                    const result = await ToolRunner.readFile(a.path, a.start_line, a.end_line);
                    return this.ok(tc, result);
                }
                case 'grep_search': {
                    const results = await ToolRunner.grepSearch(a.query, a.path, { isRegex: a.is_regex, caseInsensitive: a.case_insensitive });
                    return this.ok(tc, results.length ? results.map(r => `${r.file}:${r.line}: ${r.content}`).join('\n') : 'No matches.');
                }
                case 'codebase_search': {
                    const hits = await this.d.codebaseIndex.search(a.query, 6);
                    if (!hits.length) return this.ok(tc, 'No relevant code found. Try grep_search for exact strings.');
                    const text = hits.map(h => `### ${h.file}:${h.startLine} (score ${h.score})\n${h.snippet}`).join('\n\n');
                    return this.ok(tc, text);
                }
                case 'list_directory': {
                    return this.ok(tc, await ToolRunner.listDirectory(a.path));
                }
                case 'edit_file': {
                    const absPath = this.abs(a.path);
                    const current = await ToolRunner.readFile(a.path);
                    const updated = ToolRunner.applySearchReplace(current, a.search_replace_blocks);
                    const approved = await this.d.approve({ kind: 'edit', path: a.path, originalContent: current, updatedContent: updated });
                    if (!approved) return this.ok(tc, `User rejected the edit to ${a.path}.`);
                    this.d.checkpoint.snapshot(absPath);
                    await ToolRunner.writeFile(a.path, updated);
                    this.d.onFileChanged?.(absPath, 'modified');
                    const diagnostics = await ToolRunner.collectDiagnostics(a.path);
                    return this.ok(tc, `Applied edit to ${a.path}.${diagnostics ? diagnostics + '\nFix any errors above.' : ' No lint/compile errors detected.'}`);
                }
                case 'write_file': {
                    const absPath = this.abs(a.path);
                    const existed = fs.existsSync(absPath);
                    const approved = await this.d.approve({ kind: 'create', path: a.path, originalContent: existed ? fs.readFileSync(absPath, 'utf8') : '', updatedContent: a.content });
                    if (!approved) return this.ok(tc, `User rejected creation of ${a.path}.`);
                    this.d.checkpoint.snapshot(absPath);
                    await ToolRunner.writeFile(a.path, a.content);
                    this.d.onFileChanged?.(absPath, existed ? 'modified' : 'created');
                    return this.ok(tc, `Wrote ${a.path}.`);
                }
                case 'run_command': {
                    const approved = await this.d.approve({ kind: 'exec', command: a.command });
                    if (!approved) return this.ok(tc, `User/policy rejected command: ${a.command}`);
                    const r = await ToolRunner.executeCommand(
                        a.command, this.d.rootPath, this.d.commandTimeoutMs ?? 120000, this.d.signal,
                        (stream, text) => this.d.onTerminalChunk?.(stream, text),
                    );
                    const parts = [
                        `Exit code: ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}`,
                        r.stdout ? `Stdout:\n${r.stdout}` : 'Stdout: (empty)',
                        r.stderr ? `Stderr:\n${r.stderr}` : 'Stderr: (empty)',
                    ];
                    return this.ok(tc, parts.join('\n'));
                }
                case 'web_search': {
                    return this.ok(tc, await WebSearchTool.search(a.query));
                }
                case 'browser_open': {
                    const msg = await this.d.browserTool.launch({ url: a.url, headless: a.headless, viewportWidth: a.viewportWidth, viewportHeight: a.viewportHeight });
                    // browserScreenshotOnNav (B8): auto-capture the freshly loaded page and
                    // feed it back as vision input, so the agent "sees" where it landed.
                    if (this.d.browserTool.shouldScreenshotOnNav) {
                        try {
                            const shotPath = await this.d.browserTool.screenshot();
                            const images: ImagePart[] = [{ mediaType: 'image/png', dataBase64: fs.readFileSync(shotPath).toString('base64') }];
                            return this.ok(tc, `${msg} A screenshot of the page is attached.`, images);
                        } catch { /* screenshot is best-effort; fall through to the text result */ }
                    }
                    return this.ok(tc, msg);
                }
                case 'browser_screenshot': {
                    const shotPath = await this.d.browserTool.screenshot();
                    let images: ImagePart[] | undefined;
                    try { images = [{ mediaType: 'image/png', dataBase64: fs.readFileSync(shotPath).toString('base64') }]; } catch {}
                    return this.ok(tc, `Screenshot captured (${shotPath}). It is attached as an image.`, images);
                }
                case 'browser_click': return this.ok(tc, await this.d.browserTool.click(a.selector));
                case 'browser_type': return this.ok(tc, await this.d.browserTool.type(a.selector, a.text));
                case 'browser_read': return this.ok(tc, (await this.d.browserTool.getPageContent()).slice(0, 5000));
                case 'browser_close': { await this.d.browserTool.close(); return this.ok(tc, 'Browser closed.'); }
                case 'mcp_call': {
                    const approved = await this.d.approve({ kind: 'mcp', toolName: a.toolName });
                    if (!approved) return this.ok(tc, `User rejected MCP tool ${a.toolName}.`);
                    const result = await this.d.mcpClient.callTool(a.toolName, a.arguments || {});
                    return this.ok(tc, JSON.stringify(result, null, 2));
                }
                case 'spawn_subagent': {
                    if (!this.d.spawnSubagent) return this.ok(tc, 'Subagents cannot spawn further subagents.');
                    const result = await this.d.spawnSubagent(a.name, a.task);
                    return this.ok(tc, `Subagent "${a.name}" reported:\n${result}`);
                }
                case 'update_plan': {
                    const steps = Array.isArray(a.steps) ? a.steps : [];
                    this.d.onPlan?.(steps);
                    return this.ok(tc, `Plan updated (${steps.length} steps).`);
                }
                case 'create_artifact': {
                    const p = this.d.artifactManager.save(a.name, a.content, a.type || 'report');
                    this.d.onArtifact?.({ name: a.name, type: a.type || 'report', path: p });
                    return this.ok(tc, `Artifact "${a.name}" created at ${p}.`);
                }
                case 'schedule_task': {
                    this.d.scheduleTask?.(tc);
                    return this.ok(tc, `Scheduled task "${a.name}".`);
                }
                case 'cancel_task': {
                    this.d.cancelTask?.(a.id);
                    return this.ok(tc, `Cancelled task "${a.id}".`);
                }
                case 'update_mindmap': {
                    const mindmapPath = path.join(this.d.rootPath, '.blackIDE', 'mindmap', 'project_mindmap.md');
                    const dir = path.dirname(mindmapPath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    
                    const existing = fs.existsSync(mindmapPath) ? fs.readFileSync(mindmapPath, 'utf8') : '';
                    const timestamp = new Date().toISOString();
                    const header = `\n\n## ${a.section} (Updated: ${timestamp})\n`;
                    
                    if (a.operation === 'replace_section') {
                        const regex = new RegExp(`## ${a.section}[\\s\\S]*?(?=\\n## |$)`, 'g');
                        const updated = existing.replace(regex, '') + header + a.content;
                        fs.writeFileSync(mindmapPath, updated, 'utf8');
                    } else {
                        fs.writeFileSync(mindmapPath, existing + header + a.content, 'utf8');
                    }
                    
                    this.d.onFileChanged?.(mindmapPath, 'modified');
                    return this.ok(tc, `Mindmap updated: section "${a.section}".`);
                }
                case 'remember': {
                    await this.d.knowledgeStore.save(a.key, {
                        summary: a.summary,
                        content: a.content,
                        source: a.source || 'learned_pattern',
                        references: a.references,
                    });
                    return this.ok(tc, `Remembered: "${a.summary}".`);
                }
                default:
                    return this.err(tc, `Unknown tool: ${tc.name}`);
            }
        } catch (err: any) {
            return this.err(tc, `Error running ${tc.name}: ${err?.message || String(err)}`);
        }
    }
}

/** Best-effort mime type from a file path, for vision attachments. */
function imageMime(p: string): string | undefined {
    const ext = path.extname(p).toLowerCase();
    const map: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    return map[ext];
}

/** Read UI attachments into vision image parts (images) + inlined text (docs). */
export function readAttachments(attachments: any[] | undefined): { images: ImagePart[]; text: string } {
    const images: ImagePart[] = [];
    let text = '';
    for (const att of attachments || []) {
        try {
            if (!att?.path || !fs.existsSync(att.path)) continue;
            const mime = imageMime(att.path);
            if (att.type === 'image' && mime) {
                const buf = fs.readFileSync(att.path);
                if (buf.length <= 5_000_000) images.push({ mediaType: mime, dataBase64: buf.toString('base64') });
                else text += `\n\n[Image ${att.name} skipped: too large]`;
            } else {
                const content = fs.readFileSync(att.path, 'utf8');
                text += `\n\n--- Attached file: ${att.name} ---\n${content.length > 20000 ? content.slice(0, 20000) + '\n...(truncated)' : content}`;
            }
        } catch { /* skip unreadable */ }
    }
    return { images, text };
}
