// ─── Tool execution against the host (Phase 11, M63) ────────────────────────
//
// `agent/tool-executor.ts` is the editor's executor: it reaches for `vscode.workspace`,
// the LSP bridge, the checkpoint manager and the browser. The loop only ever needed its
// *shape* — M62 made that import type-only — and this is the second implementation of that
// shape, built on `AgentHost` and nothing else.
//
// ── Why a second executor rather than making the first one host-aware ────────
// The editor executor is 500 lines of which most is editor semantics: applying a
// `WorkspaceEdit`, saving dirty documents, feeding vision attachments back, driving
// Playwright. Threading a host through it would leave every one of those paths in a class
// the CLI loads, and the boundary test would then be satisfied by a module that is mostly
// unreachable code. Two implementations of a narrow interface is the same answer M62 gave
// for the host itself: the second implementation is what proves the first was an interface
// rather than a description of one caller.
//
// ── What is deliberately absent, and why absence is the right answer ─────────
// No language server, no codebase index, no browser, no MCP, no subagents. A headless run
// gets an explicit refusal naming the reason, never a silent miss: an agent told
// "go_to_definition is not available without an editor; use grep_search" adapts in one
// turn, while an agent whose tool returns nothing concludes the symbol does not exist.

import * as path from 'node:path';
import { AgentHost } from './host';
import { ToolCall, ToolDefinition, ToolResult } from '../core/types';
import { isToolAllowedInMode } from '../core/tools';
import { AgentMode } from '../core/types';
import { CommandPolicy } from '../core/command-policy';
import { guardPath } from '../core/workspace-guard';
import { compactGrep, RawOutputStore, withRawPointer } from '../core/output-compact';
import { formatTestReport, parseTestOutput, selectTestCommand } from '../core/test-report';
import { ProjectProfile } from '../core/project-profiler';
import * as Notebook from '../core/notebook';
import { applySearchReplace } from '../core/search-replace';

export interface HostExecutorDeps {
    host: AgentHost;
    mode: AgentMode;
    /** The acting mode's declared allowlist. Empty/undefined means no per-mode restriction. */
    allowedTools?: string[];
    /** The root the agent acts in. Defaults to the host's first root. */
    root?: string;
    policy?: CommandPolicy;
    commandTimeoutMs?: number;
    signal?: AbortSignal;
    getProjectProfile?: () => Promise<ProjectProfile | undefined>;
    onFileChanged?: (path: string, kind: 'created' | 'modified' | 'deleted') => void;
    onPlan?: (steps: { title: string; status: string }[]) => void;
}

/** Tools a headless run cannot offer, and what to do instead. */
const UNAVAILABLE: Record<string, string> = {
    go_to_definition: 'There is no language server in a headless run. Use grep_search or workspace_symbols on the text.',
    find_references: 'There is no language server in a headless run. Use grep_search.',
    workspace_symbols: 'There is no language server in a headless run. Use grep_search.',
    hover: 'There is no language server in a headless run. Read the declaration with read_file.',
    code_actions: 'There is no language server in a headless run.',
    rename_symbol: 'There is no language server in a headless run, so a scope-aware rename is not possible. Edit the files yourself after grep_search.',
    get_diagnostics: 'There is no language server in a headless run. Run the project\'s build or test command with run_command to see errors.',
    codebase_search: 'Semantic search is not available in a headless run. Use grep_search.',
    impact_analysis: 'The code graph is not built in a headless run. Use grep_search.',
    web_search: 'Web search is not available in a headless run.',
    browser_open: 'Browser automation is not available in a headless run.',
    browser_screenshot: 'Browser automation is not available in a headless run.',
    browser_click: 'Browser automation is not available in a headless run.',
    browser_type: 'Browser automation is not available in a headless run.',
    browser_read: 'Browser automation is not available in a headless run.',
    browser_close: 'Browser automation is not available in a headless run.',
    mcp_call: 'MCP servers are not connected in a headless run.',
    spawn_subagent: 'Subagents are not available in a headless run.',
    schedule_task: 'Scheduling is not available in a headless run.',
    cancel_task: 'Scheduling is not available in a headless run.',
};

/** The tools a headless run does offer, for the advertised list. */
export function headlessTools(all: ToolDefinition[], mode: AgentMode): ToolDefinition[] {
    return all.filter(t => !UNAVAILABLE[t.name] && isToolAllowedInMode(t.name, mode));
}

export interface HostExecutor {
    execute(tc: ToolCall): Promise<ToolResult>;
    /** Files this run wrote, in order, for the CLI's summary and the PR body. */
    readonly changed: string[];
}

export function createHostExecutor(deps: HostExecutorDeps): HostExecutor {
    const root = path.resolve(deps.root || deps.host.roots[0]?.path || process.cwd());
    const roots = [{ path: root, name: path.basename(root) }];
    const rawOutputs = new RawOutputStore();
    const changed: string[] = [];
    const policy = deps.policy;

    const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(root, p));
    const rel = (p: string) => path.relative(root, p).replace(/\\/g, '/') || p;

    const ok = (tc: ToolCall, content: string): ToolResult => ({ id: tc.id, name: tc.name, content });
    const err = (tc: ToolCall, content: string): ToolResult => ({ id: tc.id, name: tc.name, content, isError: true });

    /**
     * The boundary check, on every path that names a file.
     *
     * Central rather than per-tool for M55's reason: four tools each doing their own
     * `startsWith(root)` is four chances to get traversal, prefix collision or symlinks
     * wrong, and the one that is wrong is the one that matters.
     */
    const guarded = async (p: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }> => {
        const target = abs(p);
        const realpath = deps.host.fs.realpath;
        let resolver: ((x: string) => string) | undefined;
        if (realpath) {
            // The guard is synchronous by design (it is pure and testable); the host's
            // resolver is not. Resolve first, then hand the guard a function that returns
            // the answer we already have.
            try {
                const resolved = await realpath(target);
                resolver = () => resolved;
            } catch { /* does not exist yet — normal for a create */ }
        }
        const result = guardPath(target, roots, resolver ? { realpath: resolver } : {});
        return result.verdict.allowed
            ? { ok: true, path: target }
            : { ok: false, reason: result.verdict.reason || `${p} is outside the workspace.` };
    };

    const readText = async (p: string): Promise<string> => deps.host.fs.read(p);

    /** Approve, write, record. Shared so no write path can skip a step. */
    const writeApproved = async (
        tc: ToolCall, target: string, current: string, updated: string, kind: 'edit' | 'create',
    ): Promise<ToolResult | undefined> => {
        const approved = await deps.host.approval.request({
            kind, path: rel(target), originalContent: current, updatedContent: updated,
        });
        if (!approved) {
            return ok(tc, `The host refused the ${kind === 'create' ? 'creation of' : 'edit to'} ${rel(target)}. `
                + 'Unattended runs deny writes unless started with --approve edits or all; say what you would have changed.');
        }
        await deps.host.fs.write(target, updated);
        if (!changed.includes(rel(target))) changed.push(rel(target));
        deps.onFileChanged?.(target, kind === 'create' ? 'created' : 'modified');
        return undefined;
    };

    const runCommand = async (tc: ToolCall, command: string, timeoutMs: number) => {
        const decision = policy?.evaluate(command);
        if (decision?.decision === 'deny') {
            return err(tc, `The command policy refused: ${decision.reason || command}`);
        }
        const approved = await deps.host.approval.request({ kind: 'exec', command });
        if (!approved) {
            return ok(tc, `The host refused the command: ${command}\n`
                + 'Unattended runs deny commands by default (G3). Report what you would have run rather than retrying.');
        }
        const r = await deps.host.process.run(command, { cwd: root, timeoutMs, signal: deps.signal });
        return { r, refusal: undefined as ToolResult | undefined };
    };

    return {
        changed,
        async execute(tc: ToolCall): Promise<ToolResult> {
            const a = tc.arguments || {};

            if (!isToolAllowedInMode(tc.name, deps.mode)) {
                return err(tc, `Tool "${tc.name}" is not available in ${deps.mode} mode.`);
            }
            if (deps.allowedTools?.length && !deps.allowedTools.includes(tc.name)) {
                return err(tc, `Tool "${tc.name}" is not in the allowlist for the acting mode.`);
            }
            const unavailable = UNAVAILABLE[tc.name] ?? (tc.name.startsWith('mcp_') ? UNAVAILABLE.mcp_call : undefined);
            if (unavailable) return err(tc, unavailable);

            try {
                switch (tc.name) {
                    case 'read_file': {
                        if (Notebook.isNotebookPath(a.path)) {
                            return err(tc, `${a.path} is a Jupyter notebook. Use read_notebook.`);
                        }
                        const target = await guarded(a.path);
                        if (!target.ok) return err(tc, target.reason);
                        if (!(await deps.host.fs.exists(target.path))) return err(tc, `File not found: ${a.path}`);
                        const content = await readText(target.path);
                        if (a.start_line == null) return ok(tc, content);
                        const lines = content.split(/\r?\n/);
                        const from = Math.max(0, Number(a.start_line) - 1);
                        const to = a.end_line == null ? lines.length : Math.min(lines.length, Number(a.end_line));
                        return ok(tc, lines.slice(from, to).join('\n'));
                    }

                    case 'read_notebook': {
                        const target = await guarded(a.path);
                        if (!target.ok) return err(tc, target.reason);
                        const parsed = Notebook.parseNotebook(await readText(target.path));
                        const cells = parsed.notebook.cells || [];
                        if (!cells.length) return ok(tc, `${a.path} has no cells.`);
                        if (a.cell != null) {
                            const index = Number(a.cell);
                            if (!Number.isInteger(index) || index < 0 || index >= cells.length) {
                                return err(tc, `Cell ${a.cell} does not exist — ${a.path} has ${cells.length} cells (0–${cells.length - 1}).`);
                            }
                            const one = { ...parsed.notebook, cells: [cells[index]] };
                            return ok(tc, Notebook.renderNotebook(one, { includeOutputs: !!a.include_outputs })
                                .replace(/^--- cell 0 /gm, `--- cell ${index} `));
                        }
                        const listing = Notebook.summarizeCells(parsed.notebook)
                            .map(c => `${c.index}. ${c.type}${c.hasOutput ? ' (has output)' : ''} — ${c.preview || '(empty)'}`)
                            .join('\n');
                        return ok(tc, `${a.path} — ${cells.length} cells\n${listing}\n\n`
                            + Notebook.renderNotebook(parsed.notebook, { includeOutputs: !!a.include_outputs }));
                    }

                    case 'list_directory': {
                        const target = await guarded(a.path || '.');
                        if (!target.ok) return err(tc, target.reason);
                        const entries = await deps.host.fs.list(target.path);
                        if (!entries.length) return ok(tc, `${a.path || '.'} is empty.`);
                        return ok(tc, entries
                            .sort((x, y) => Number(y.isDirectory) - Number(x.isDirectory) || x.name.localeCompare(y.name))
                            .map(e => (e.isDirectory ? `${e.name}/` : e.name)).join('\n'));
                    }

                    case 'grep_search': {
                        const results = await grepFiles(deps.host, root, String(a.query), {
                            scope: a.path, isRegex: !!a.is_regex, caseInsensitive: !!a.case_insensitive,
                        });
                        if (!results.length) return ok(tc, 'No matches.');
                        const raw = results.map(r => `${r.file}:${r.line}: ${r.content}`).join('\n');
                        return ok(tc, withRawPointer(compactGrep(results), rawOutputs, raw).text);
                    }

                    case 'expand_output': {
                        const raw = rawOutputs.get(String(a.id));
                        return ok(tc, raw ?? `No stored output with id "${a.id}". Re-run the original tool.`);
                    }

                    case 'write_file': {
                        const target = await guarded(a.path);
                        if (!target.ok) return err(tc, target.reason);
                        const existed = await deps.host.fs.exists(target.path);
                        const current = existed ? await readText(target.path) : '';
                        const refusal = await writeApproved(tc, target.path, current, String(a.content ?? ''), existed ? 'edit' : 'create');
                        return refusal ?? ok(tc, `Wrote ${rel(target.path)}.`);
                    }

                    case 'edit_file': {
                        if (Notebook.isNotebookPath(a.path)) {
                            return err(tc, `${a.path} is a Jupyter notebook and cannot be edited with edit_file. Use edit_notebook_cell.`);
                        }
                        const target = await guarded(a.path);
                        if (!target.ok) return err(tc, target.reason);
                        if (!(await deps.host.fs.exists(target.path))) return err(tc, `File not found: ${a.path}. Use write_file to create it.`);
                        if (!a.search_replace_blocks) {
                            // `intent` needs the apply-role model (M25), which a headless
                            // run has not wired. Refusing beats a silent no-op.
                            return err(tc, 'Provide search_replace_blocks. Fast apply by `intent` is not available in a headless run.');
                        }
                        const current = await readText(target.path);
                        const updated = applySearchReplace(current, String(a.search_replace_blocks));
                        const refusal = await writeApproved(tc, target.path, current, updated, 'edit');
                        return refusal ?? ok(tc, `Applied edit to ${rel(target.path)}.`);
                    }

                    case 'edit_notebook_cell': {
                        if (!Notebook.isNotebookPath(a.path)) return err(tc, `${a.path} is not a .ipynb file. Use edit_file.`);
                        const target = await guarded(a.path);
                        if (!target.ok) return err(tc, target.reason);
                        const current = await readText(target.path);
                        const parsed = Notebook.parseNotebook(current);
                        const operation = String(a.operation || 'replace');
                        const index = a.index == null ? undefined : Number(a.index);

                        let result: Notebook.EditResult;
                        if (operation === 'delete') {
                            if (index === undefined) return err(tc, 'delete needs an index.');
                            result = Notebook.deleteCell(parsed.notebook, index);
                        } else if (operation === 'insert') {
                            if (typeof a.text !== 'string') return err(tc, 'insert needs text.');
                            result = Notebook.insertCell(parsed.notebook, (a.cell_type || 'code') as Notebook.CellType, a.text, index);
                        } else if (operation === 'replace') {
                            if (index === undefined) return err(tc, 'replace needs an index.');
                            if (typeof a.text !== 'string') return err(tc, 'replace needs text.');
                            result = Notebook.editCell(parsed.notebook, index, a.text);
                        } else {
                            return err(tc, `Unknown operation "${operation}". Use replace, insert or delete.`);
                        }
                        if (!result.ok) return err(tc, result.error);

                        const updated = Notebook.serializeNotebook({ ...parsed, notebook: result.notebook });
                        const refusal = await writeApproved(tc, target.path, current, updated, 'edit');
                        return refusal ?? ok(tc, `${operation} on cell ${result.index} of ${rel(target.path)}. `
                            + `The notebook now has ${(result.notebook.cells || []).length} cells.`);
                    }

                    case 'run_command': {
                        const outcome = await runCommand(tc, String(a.command), deps.commandTimeoutMs ?? 120_000);
                        if ('id' in outcome) return outcome;
                        const { r } = outcome;
                        return ok(tc, [
                            `Exit code: ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}`,
                            r.stdout ? `Stdout:\n${r.stdout}` : 'Stdout: (empty)',
                            r.stderr ? `Stderr:\n${r.stderr}` : 'Stderr: (empty)',
                        ].join('\n'));
                    }

                    case 'run_tests': {
                        const profile = await deps.getProjectProfile?.();
                        if (!profile) return ok(tc, 'No project profile, so no test command could be selected. Use run_command.');
                        const selected = selectTestCommand(profile, a.scope);
                        if (!selected) {
                            return ok(tc, `No test framework detected (stacks: ${profile.stacks.join(', ') || 'none'}). Use run_command.`);
                        }
                        const outcome = await runCommand(tc, selected.command, Math.max(deps.commandTimeoutMs ?? 120_000, 300_000));
                        if ('id' in outcome) return outcome;
                        return ok(tc, formatTestReport(parseTestOutput(selected.framework, outcome.r, selected.command)));
                    }

                    case 'search_history':
                    case 'blame':
                    case 'why_was_this_changed': {
                        // Read-only git, through the host's process rather than shelling out
                        // directly: a remote runner (M66) implements `process`, and a direct
                        // `spawn` here would be the one call that could not follow it.
                        return ok(tc, await gitQuery(deps.host, root, tc.name, a));
                    }

                    case 'update_plan': {
                        const steps = Array.isArray(a.steps) ? a.steps : [];
                        deps.onPlan?.(steps);
                        return ok(tc, `Plan updated (${steps.length} steps).`);
                    }

                    case 'create_artifact': {
                        const name = String(a.name || 'artifact').replace(/[^A-Za-z0-9._-]/g, '-');
                        const target = path.join(root, '.blackIDE', 'artifacts', `${name}.md`);
                        await deps.host.fs.write(target, String(a.content ?? ''));
                        return ok(tc, `Artifact "${a.name}" written to ${rel(target)}.`);
                    }

                    case 'remember':
                        // No knowledge store headless. Acknowledged rather than refused: the
                        // agent's next step does not depend on it, and an error here would
                        // read as the task failing.
                        return ok(tc, 'Memory is not persisted in a headless run; noted for this run only.');

                    case 'complete_task':
                        return ok(tc, String(a.message ?? 'Task complete.'));

                    default:
                        return err(tc, `Unknown tool: ${tc.name}`);
                }
            } catch (error: any) {
                return err(tc, `Error running ${tc.name}: ${error?.message || String(error)}`);
            }
        },
    };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface GrepHit { file: string; line: number; content: string }

const NUL = String.fromCharCode(0);

/**
 * Grep, over the host filesystem.
 *
 * Deliberately not `spawn('grep')`: the host may not be a POSIX machine, and on a remote
 * runner (M66) the files are not where the process is. Bounded on both axes because an
 * unbounded search of a monorepo is a minute of I/O and a context window of matches.
 */
async function grepFiles(
    host: AgentHost, root: string, query: string,
    options: { scope?: string; isRegex?: boolean; caseInsensitive?: boolean },
): Promise<GrepHit[]> {
    const flags = options.caseInsensitive ? 'i' : '';
    let pattern: RegExp;
    try {
        pattern = options.isRegex
            ? new RegExp(query, flags)
            : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    } catch {
        return [];
    }

    const base = options.scope ? path.join(root, options.scope) : root;
    const files = await host.fs.find('**/*', { limit: 4_000 });
    const hits: GrepHit[] = [];
    for (const file of files) {
        if (!file.startsWith(base.replace(/\\/g, '/'))) continue;
        if (hits.length >= 400) break;
        let text: string;
        try { text = await host.fs.read(file); } catch { continue; }
        // Binary files produce matches nobody can read and blow the budget doing it.
        // The sentinel is built from a char code rather than written literally: a raw
        // NUL in source is invisible in an editor and makes the file binary to
        // `grep`. This codebase has shipped three, and writing this line cost it a
        // fourth before `source-hygiene.test.ts` could object.
        if (text.includes(NUL)) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < 400; i++) {
            if (pattern.test(lines[i])) {
                hits.push({
                    file: path.relative(root, file).replace(/\\/g, '/'),
                    line: i + 1,
                    content: lines[i].slice(0, 400),
                });
            }
        }
    }
    return hits;
}

async function gitQuery(host: AgentHost, root: string, tool: string, a: any): Promise<string> {
    const quote = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    let command: string;
    if (tool === 'blame') {
        command = `git blame -L ${Number(a.start_line) || 1},${Number(a.end_line) || 1} --porcelain -- ${quote(a.path)}`;
    } else if (tool === 'search_history') {
        const max = Math.min(Number(a.max_commits) || 25, 100);
        command = `git log -n ${max} --oneline --grep=${quote(a.query)} -S${quote(a.query)}`;
    } else {
        command = `git log -n 10 --format=%H%n%an%n%ad%n%B%n---- -S${quote(a.symbol)}`;
    }
    const r = await host.process.run(command, { cwd: root, timeoutMs: 30_000 });
    if (r.exitCode !== 0) {
        // Naming *why* rather than returning nothing: an empty answer reads as "no
        // history", which is a different and wrong conclusion (M22's rule).
        return `git could not answer this (exit ${r.exitCode}): ${r.stderr.trim() || 'no detail'}`;
    }
    return r.stdout.trim() || 'No matching history.';
}
