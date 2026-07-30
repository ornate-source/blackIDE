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
import { ProjectProfile } from '../core/project-profiler';
import { selectTestCommand, parseTestOutput, formatTestReport } from '../core/test-report';
import * as LspTools from '../tools/lsp-tools';
import { analyseImpact, formatImpact } from '../tools/graph-tools';
import { compactGrep, RawOutputStore, withRawPointer } from '../core/output-compact';
import { searchHistory, blame, whyWasThisChanged } from '../tools/git-history';

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
    /**
     * The acting mode's declared tool allowlist, enforced as a second gate. Undefined
     * or empty means "no per-mode restriction" (Agent mode, and custom modes that omit
     * `tools`), matching how the advertised list is built.
     */
    allowedTools?: string[];
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
    /** Records a finished command for the `@terminal` provider (Phase 3, M19). */
    recordTerminal?: (command: string, output: string) => void;
    onFileChanged?: (path: string, kind: 'created' | 'modified' | 'deleted') => void;
    scheduleTask?: (tc: ToolCall) => void;
    cancelTask?: (id: string) => void;
    /** Provided by the main loop; undefined inside a subagent to prevent recursion. */
    spawnSubagent?: (name: string, task: string) => Promise<string>;
    /**
     * Detected stack, used by `run_tests` to pick the project's test command
     * (Phase 1). Optional: when absent the tool says so and points at run_command
     * rather than guessing a command for the wrong ecosystem.
     */
    getProjectProfile?: () => Promise<ProjectProfile>;
}

/** Executes a single tool call and returns a structured result for the model. */
export class AgentToolExecutor {
    /**
     * Uncompressed copies of recent compacted results (Phase 3, M18), so
     * `expand_output` can hand back exactly what was grouped away.
     *
     * Per-executor, not global: an executor's lifetime is the run's, and an id from a
     * finished run pointing at a live buffer is a way for one run to read another's
     * file contents.
     */
    private readonly rawOutputs = new RawOutputStore();

    constructor(private readonly d: ExecutorDeps) {}

    private abs(p: string): string {
        return path.isAbsolute(p) ? p : path.join(this.d.rootPath, p);
    }

    /**
     * Is `name` permitted by the acting mode's declared allowlist?
     *
     * MCP tools are discovered at runtime as `mcp_<serverTool>`, so they can never
     * appear in a hand-written allowlist. A mode opts into MCP by listing `mcp_call`;
     * without it, no dynamic MCP tool is reachable either.
     */
    private isAllowedByMode(name: string): boolean {
        const allowed = this.d.allowedTools || [];
        if (name.startsWith('mcp_')) return allowed.includes('mcp_call');
        return allowed.includes(name);
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

        /*
         * Second gate: the acting mode's own allowlist (Phase 2).
         *
         * `isToolAllowedInMode` only knows the three coarse AgentModes, and every mode
         * except Ask and Plan resolves to `agent` — so until now the `tools` arrays
         * declared by Manager, Sr Architect, the HLD/LLD/Planner phases and the four
         * pipeline Executors were *advertising-only*. Manager's prompt says it must not
         * write code and its allowlist omits every write tool, but a `write_file` call
         * emitted anyway would have executed. This closes that: the declared allowlist
         * is now enforced where the tool actually runs.
         */
        if (this.d.allowedTools?.length && !this.isAllowedByMode(tc.name)) {
            return this.err(tc, `Tool "${tc.name}" is not in the allowlist for the acting mode.`);
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
                    if (!results.length) return this.ok(tc, 'No matches.');
                    // Grouped by file (Phase 3, M18). The raw form stays fetchable, so
                    // this trades repeated path prefixes for context and nothing else.
                    const raw = results.map(r => `${r.file}:${r.line}: ${r.content}`).join('\n');
                    const compacted = withRawPointer(compactGrep(results), this.rawOutputs, raw);
                    return this.ok(tc, compacted.text);
                }
                case 'expand_output': {
                    const raw = this.rawOutputs.get(String(a.id));
                    return this.ok(tc, raw ?? `No stored output with id "${a.id}". Ids expire once ${this.rawOutputs.size} newer results have been produced; re-run the original tool.`);
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
                    // Feeds the `@terminal` context provider (Phase 3, M19), so the
                    // user can hand a previous command's output back to the agent
                    // without re-running it — which for a slow build or a
                    // non-idempotent script is the difference between usable and not.
                    this.d.recordTerminal?.(a.command, parts.join('\n'));
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
                // ─── Language-server tools (Phase 1) ─────────────────────────
                // Read-only and self-degrading: when no server answers, each falls
                // back to grep with an explicit note rather than erroring, so a cold
                // server never turns into a task failure.
                case 'get_diagnostics':
                    return this.ok(tc, await LspTools.getDiagnostics(a.path, a.severity));
                case 'go_to_definition':
                    return this.ok(tc, await LspTools.goToDefinition(a.path, a.symbol, a.line));
                case 'find_references':
                    return this.ok(tc, await LspTools.findReferences(a.path, a.symbol, a.line));
                case 'workspace_symbols':
                    return this.ok(tc, await LspTools.workspaceSymbols(a.query));
                case 'hover':
                    return this.ok(tc, await LspTools.hoverInfo(a.path, a.symbol, a.line));
                case 'code_actions':
                    return this.ok(tc, await LspTools.codeActions(a.path, a.symbol, a.line));

                // ─── Graph-backed analysis (Phase 3, M16) ────────────────────
                // The offline counterpart to find_references: no language server
                // needed, whole-repo, and ranked by hop distance rather than
                // returned as a flat location list. Depth is clamped because the
                // third hop is reliably noise — everything imports the config.
                // ─── Git history (Phase 3, M22) ──────────────────────────────
                // All read-only, all shelling out with an argument array rather than
                // a shell string, and all reporting *why* history is unavailable
                // rather than returning an empty answer that reads as "no history".
                case 'search_history':
                    return this.ok(tc, await searchHistory(String(a.query), {
                        cwd: this.d.rootPath,
                        ...(a.max_commits ? { maxCommits: Math.min(Number(a.max_commits), 100) } : {}),
                    }));
                case 'blame':
                    return this.ok(tc, await blame(
                        String(a.path), Number(a.start_line), Number(a.end_line), { cwd: this.d.rootPath }));
                case 'why_was_this_changed':
                    return this.ok(tc, await whyWasThisChanged(String(a.symbol), { cwd: this.d.rootPath }));

                case 'impact_analysis': {
                    const depth = Math.min(Math.max(Number(a.depth) || 2, 1), 3);
                    return this.ok(tc, formatImpact(
                        analyseImpact(this.d.codebaseIndex.graph, String(a.symbol), depth)));
                }

                case 'rename_symbol': {
                    const plan = await LspTools.planRename(a.path, a.symbol, a.new_name, a.line);
                    if ('error' in plan) return this.ok(tc, plan.error);

                    // Snapshot every affected file *before* asking, so the checkpoint
                    // exists no matter which way approval goes and a rejected-then-
                    // retried rename cannot lose the pre-rename content.
                    for (const file of plan.files) this.d.checkpoint.snapshot(file);

                    const summary = LspTools.describeRenamePlan(plan, a.symbol, a.new_name);
                    // A project-wide rename is reviewed as one edit: the diff view takes
                    // a single before/after, so the file list is what the user approves.
                    const approved = await this.d.approve({
                        kind: 'edit',
                        path: `${plan.files.length} file(s)`,
                        originalContent: summary,
                        updatedContent: summary,
                    });
                    if (!approved) return this.ok(tc, `User rejected the rename of "${a.symbol}".`);

                    const applied = await vscode.workspace.applyEdit(plan.workspaceEdit);
                    if (!applied) return this.err(tc, `The editor refused the rename edit for "${a.symbol}".`);

                    // applyEdit leaves the documents dirty; without saving, the change
                    // is invisible to git, to the test runner, and to the next tool call.
                    for (const file of plan.files) {
                        try {
                            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                            if (doc.isDirty) await doc.save();
                        } catch { /* a file the provider touched but we cannot reopen */ }
                        this.d.onFileChanged?.(file, 'modified');
                    }
                    return this.ok(tc, `${summary}\nApplied and saved.`);
                }

                case 'run_tests': {
                    const profile = await this.d.getProjectProfile?.();
                    if (!profile) return this.ok(tc, 'Project profile unavailable, so no test command could be selected. Use run_command with the project\'s own test command.');

                    const selected = selectTestCommand(profile, a.scope);
                    if (!selected) {
                        return this.ok(tc, `No test framework detected for this project (stacks: ${profile.stacks.join(', ') || 'none'}). Use run_command with the project's own test command.`);
                    }

                    // Exec-class: goes through the same approval/policy gate as run_command.
                    const approved = await this.d.approve({ kind: 'exec', command: selected.command });
                    if (!approved) return this.ok(tc, `User/policy rejected the test command: ${selected.command}`);

                    const r = await ToolRunner.executeCommand(
                        selected.command, this.d.rootPath,
                        // Test suites legitimately run longer than a normal command.
                        Math.max(this.d.commandTimeoutMs ?? 120000, 300000),
                        this.d.signal,
                        (stream, text) => this.d.onTerminalChunk?.(stream, text),
                    );
                    const report = parseTestOutput(selected.framework, r, selected.command);
                    return this.ok(tc, formatTestReport(report));
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
