import { AgentMode, ToolDefinition } from './types';

// ─── Central Tool Registry ──────────────────────────────────────────────────
// Single source of truth for every tool the agent can call. Drives BOTH the
// provider-native tool schemas and the text-JSON fallback prompt, so the two
// can never drift apart.

const s = (description: string) => ({ type: 'string' as const, description });

/**
 * Read-only language-server tools (Phase 1).
 *
 * Exported as a group because every built-in mode declares an explicit `tools`
 * allowlist, and a tool absent from that list is filtered out before the model ever
 * sees it — being `risk: 'safe'` is not enough. Referencing this constant from
 * `mode-loader.ts` means a future LSP tool is added to every mode in one edit
 * instead of thirteen.
 */
export const LSP_READ_TOOLS = [
    'get_diagnostics', 'go_to_definition', 'find_references', 'workspace_symbols', 'hover', 'code_actions',
] as const;

/** @public — required by the test harness (test/harness.js). */
export const BASE_TOOLS: ToolDefinition[] = [
    {
        name: 'read_file',
        description: 'Read a file\'s content. Supports start_line/end_line for token efficiency.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: {
                path: s('Workspace-relative path to the file'),
                start_line: { type: 'number', description: 'Optional 1-based start line' },
                end_line: { type: 'number', description: 'Optional 1-based end line' },
            },
            required: ['path'],
        },
    },
    {
        name: 'grep_search',
        description: 'Search files for a pattern with optional regex, returning file:line matches.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: {
                query: s('Text or regex pattern to search for'),
                path: s('Optional subdirectory to scope the search'),
                is_regex: { type: 'boolean', description: 'Treat query as a regular expression' },
                case_insensitive: { type: 'boolean', description: 'Case-insensitive match' },
            },
            required: ['query'],
        },
    },
    {
        name: 'codebase_search',
        description: 'Semantic/ranked search over the whole codebase for the most relevant files and snippets for a natural-language query. Prefer this over grep for "where/how" questions.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: { query: s('Natural-language description of what you are looking for') },
            required: ['query'],
        },
    },
    {
        name: 'list_directory',
        description: 'List the contents of a directory.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: { path: s('Workspace-relative directory path') },
            required: ['path'],
        },
    },
    {
        name: 'edit_file',
        description: 'Edit an existing file using one or more SEARCH/REPLACE blocks. The ORIGINAL text must match the file exactly and be unique.',
        risk: 'edit',
        parameters: {
            type: 'object',
            properties: {
                path: s('Workspace-relative path to the file'),
                search_replace_blocks: s('One or more blocks: <<<<<<< ORIGINAL\\n...\\n=======\\n...\\n>>>>>>> UPDATED'),
            },
            required: ['path', 'search_replace_blocks'],
        },
    },
    {
        name: 'write_file',
        description: 'Create a brand-new file (or overwrite) with full content. Use edit_file for changes to existing files.',
        risk: 'create',
        parameters: {
            type: 'object',
            properties: {
                path: s('Workspace-relative path to the file'),
                content: s('Full file content'),
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'run_command',
        description: 'Run a shell command in the workspace root. Stdout, stderr and exit code are captured and returned.',
        risk: 'exec',
        parameters: {
            type: 'object',
            properties: { command: s('The shell command to run') },
            required: ['command'],
        },
    },
    {
        name: 'web_search',
        description: 'Search the web for documentation or solutions and return extracted results.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: { query: s('Search query') },
            required: ['query'],
        },
    },
    {
        name: 'browser_open',
        description: 'Launch a browser and navigate to a URL for automation or visual inspection.',
        risk: 'exec',
        parameters: {
            type: 'object',
            properties: {
                url: s('URL to open'),
                headless: { type: 'boolean', description: 'Run headless (default true)' },
                viewportWidth: { type: 'number', description: 'Viewport width' },
                viewportHeight: { type: 'number', description: 'Viewport height' },
            },
            required: ['url'],
        },
    },
    {
        name: 'browser_screenshot',
        description: 'Screenshot the open browser page. The image is fed back to you as vision input.',
        risk: 'safe',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'browser_click',
        description: 'Click a DOM element by CSS selector in the open browser page.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: { selector: s('CSS selector') },
            required: ['selector'],
        },
    },
    {
        name: 'browser_type',
        description: 'Type text into a DOM input by CSS selector in the open browser page.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: { selector: s('CSS selector'), text: s('Text to type') },
            required: ['selector', 'text'],
        },
    },
    {
        name: 'browser_read',
        description: 'Read the plain-text content of the open browser page.',
        risk: 'safe',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'browser_close',
        description: 'Close the open browser session.',
        risk: 'safe',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'mcp_call',
        description: 'Execute an external MCP (Model Context Protocol) tool.',
        risk: 'exec',
        parameters: {
            type: 'object',
            properties: {
                toolName: s('Name of the MCP tool'),
                arguments: { type: 'object', description: 'Arguments object for the tool' },
            },
            required: ['toolName'],
        },
    },
    {
        name: 'spawn_subagent',
        description: 'Spawn a nested background subagent (with full tool access) to solve a focused sub-task and report back.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: {
                name: s('Short name for the subagent'),
                task: s('The specific, self-contained sub-task to complete'),
            },
            required: ['name', 'task'],
        },
    },
    {
        name: 'update_plan',
        description: 'Create or update a live task plan shown to the user. Call this as you make progress so the user can follow along.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: {
                steps: {
                    type: 'array',
                    description: 'Ordered plan steps',
                    items: {
                        type: 'object',
                        properties: {
                            title: s('Short step description'),
                            status: { type: 'string', description: 'pending | in_progress | done' },
                        },
                        required: ['title', 'status'],
                    },
                },
            },
            required: ['steps'],
        },
    },
    {
        name: 'create_artifact',
        description: 'Create a structured markdown artifact (plan, report, walkthrough) surfaced as a reviewable card.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: {
                name: s('Artifact name'),
                type: s('plan | report | task | walkthrough | analysis'),
                content: s('Markdown content'),
            },
            required: ['name', 'content'],
        },
    },
    {
        name: 'schedule_task',
        description: 'Schedule a background notification or recurring check.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: {
                name: s('Task name/id'),
                type: s('once | recurring'),
                intervalMs: { type: 'number', description: 'Interval in milliseconds' },
                maxRuns: { type: 'number', description: 'Max runs for recurring tasks' },
                taskPrompt: s('The agent prompt to run when the task fires'),
            },
            required: ['name', 'taskPrompt'],
        },
    },
    {
        name: 'cancel_task',
        description: 'Cancel a scheduled background task by id.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: { id: s('Scheduled task id') },
            required: ['id'],
        },
    },
    {
        name: 'update_mindmap',
        description: 'Update the project OpenSpec mindmap with new module, function, or dependency information.',
        risk: 'create',
        parameters: {
            type: 'object',
            properties: {
                section: s('Section name (e.g., "Frontend Components", "API Routes")'),
                content: s('Markdown content describing the modules, classes, functions, and their linkages'),
                operation: { type: 'string', description: 'append | replace_section', enum: ['append', 'replace_section'] },
            },
            required: ['section', 'content'],
        },
    },
    {
        name: 'remember',
        description: 'Store a memory, learned pattern, user preference, or project knowledge across sessions for future context.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: {
                key: s('Unique identifier for this memory (slug/snake_case)'),
                summary: s('Short high-level description of what is being remembered'),
                content: s('Detailed description of the pattern or learning'),
                source: {
                    type: 'string',
                    description: 'The source category of this memory',
                    enum: ['user_correction', 'learned_pattern', 'project_context']
                },
                references: {
                    type: 'array',
                    description: 'Optional list of file paths or documentation references associated with this memory',
                    items: { type: 'string' }
                }
            },
            required: ['key', 'summary', 'content'],
        },
    },
    // ─── Language-server tools (Phase 1) ─────────────────────────────────────
    // Black IDE is a VS Code fork, so a language server is already running for the
    // user's languages. These expose it. Prefer them over grep for any question
    // about symbols: grep cannot tell a definition from a mention in a comment.
    // All read-only ones are 'safe', so Ask and Plan modes get them automatically.
    {
        name: 'get_diagnostics',
        description: 'Read current compiler/linter problems from the language server, for one file or the whole workspace. Use this to check whether an earlier edit is still broken, or to survey the repo before starting.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: {
                path: s('Optional workspace-relative file. Omit for all problems in the workspace.'),
                severity: { type: 'string', description: 'Which problems to report', enum: ['error', 'warning', 'all'] },
            },
            required: [],
        },
    },
    {
        name: 'go_to_definition',
        description: 'Find where a symbol is actually defined, using the language server. Much more reliable than grep for "where does this come from?".',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: {
                path: s('Workspace-relative file that mentions the symbol'),
                symbol: s('The identifier to resolve, e.g. "PipelineOrchestrator"'),
                line: { type: 'number', description: 'Optional 1-based line to disambiguate a repeated name' },
            },
            required: ['path', 'symbol'],
        },
    },
    {
        name: 'find_references',
        description: 'Find every real usage of a symbol, grouped by file, using the language server. Use before changing or deleting anything to see what depends on it.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: {
                path: s('Workspace-relative file that declares or mentions the symbol'),
                symbol: s('The identifier to find usages of'),
                line: { type: 'number', description: 'Optional 1-based line to disambiguate a repeated name' },
            },
            required: ['path', 'symbol'],
        },
    },
    {
        name: 'workspace_symbols',
        description: 'Search the whole project for a symbol by name (classes, functions, methods) without knowing which file it lives in.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: { query: s('Symbol name or fragment to search for') },
            required: ['query'],
        },
    },
    {
        name: 'hover',
        description: 'Get the type signature and documentation for a symbol, as shown on editor hover.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: {
                path: s('Workspace-relative file that mentions the symbol'),
                symbol: s('The identifier to inspect'),
                line: { type: 'number', description: 'Optional 1-based line to disambiguate a repeated name' },
            },
            required: ['path', 'symbol'],
        },
    },
    {
        name: 'code_actions',
        description: 'List the quick fixes and refactorings the language server offers at a location. Advisory: apply the change with edit_file.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: {
                path: s('Workspace-relative file'),
                symbol: s('Optional identifier to locate the position'),
                line: { type: 'number', description: 'Optional 1-based line, used when no symbol is given' },
            },
            required: ['path'],
        },
    },
    {
        // A write: renames every reference across the project in one step, so it is
        // approval-gated and checkpointed per file like any other edit.
        name: 'rename_symbol',
        description: 'Rename a symbol and every reference to it across the project, using the language server (import- and scope-aware). Safer than find-and-replace. Requires approval.',
        risk: 'edit',
        parameters: {
            type: 'object',
            properties: {
                path: s('Workspace-relative file that declares the symbol'),
                symbol: s('Current identifier name'),
                new_name: s('New identifier name'),
                line: { type: 'number', description: 'Optional 1-based line to disambiguate a repeated name' },
            },
            required: ['path', 'symbol', 'new_name'],
        },
    },
    {
        // Exec-class: it runs the project's test command.
        name: 'run_tests',
        description: 'Run the project test suite using the framework detected for this repo, returning a compact report of failures only (not the full output). Prefer this over run_command for tests.',
        risk: 'exec',
        parameters: {
            type: 'object',
            properties: {
                scope: s('Optional path or test filter to narrow the run, e.g. "tests/test_api.py"'),
            },
            required: [],
        },
    },
    {
        name: 'complete_task',
        description: 'Finish the task and present the final summary to the user.',
        risk: 'safe',
        parameters: {
            type: 'object',
            properties: { message: s('Final explanation of changes made and results') },
            required: ['message'],
        },
    },
];


/**
 * Tools available in a given mode. Ask = read-only; Plan = read-only + planning; Agent = all.
 *
 * `spawn_subagent` and `schedule_task` are risk-`safe` because they touch nothing
 * themselves — but they start a *new* agent turn that has its own tools. Both are
 * only safe to offer outside Agent mode because their callers propagate the current
 * mode to the delegate; a plan-mode subagent gets plan-mode tools. Never hardcode
 * `toolsForMode('agent')` at a delegation site or read-only mode becomes writable.
 */
export function toolsForMode(mode: AgentMode): ToolDefinition[] {
    if (mode === 'ask') {
        return BASE_TOOLS.filter(t => t.risk === 'safe' && t.name !== 'spawn_subagent' && t.name !== 'schedule_task');
    }
    if (mode === 'plan') {
        // read-only + planning artifacts, but no writes/exec
        return BASE_TOOLS.filter(t => t.risk === 'safe');
    }
    return BASE_TOOLS;
}

/**
 * The sandbox gate. Advertising a tool to the model is only a hint — this is the
 * check the executor enforces, so a tool that leaks into the advertised list (e.g.
 * a dynamically-appended MCP tool) still cannot run in a mode that forbids it.
 */
export function isToolAllowedInMode(name: string, mode: AgentMode): boolean {
    // MCP tools are discovered at runtime and are not in BASE_TOOLS. They invoke an
    // arbitrary external process, so they are exec-class: Agent mode only.
    if (name.startsWith('mcp_')) return mode === 'agent';
    return toolsForMode(mode).some(t => t.name === name);
}

/** Human-readable fallback docs for models without native tool calling. */
export function renderToolDocs(tools: ToolDefinition[]): string {
    const lines = tools.map((t, i) => {
        const props = Object.entries(t.parameters.properties)
            .map(([k, v]: [string, any]) => `"${k}": <${v.type}${(t.parameters.required || []).includes(k) ? '' : '?'}>`)
            .join(', ');
        return `${i + 1}. ${t.name} — ${t.description}\n\`\`\`json\n{ "action": "${t.name}"${props ? ', ' + props : ''} }\n\`\`\``;
    });
    return lines.join('\n\n');
}
