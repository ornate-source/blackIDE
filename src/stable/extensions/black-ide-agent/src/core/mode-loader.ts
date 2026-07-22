import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/** Schema version for mode definitions */
const MODE_SCHEMA_VERSION = 1;

export interface CustomMode {
    version?: number;
    name: string;
    description?: string;
    model?: string;
    systemPrompt: string;
    tools?: string[];    // Allowlist of tool names (empty = all tools)
    maxIterations?: number;
    icon?: string;       // VS Code codicon name
    source: 'builtin' | 'global' | 'workspace' | 'project';
    filePath?: string;
    /**
     * Internal pipeline-phase modes (HLD/LLD/Planner) the orchestrator drives directly. They
     * are returned by getAllModes()/getMode() for the pipeline but hidden from user-facing mode
     * pickers, so the eight selectable modes are the only ones a user sees.
     */
    internal?: boolean;
}

/** JSON Schema for mode YAML frontmatter validation */
const MODE_SCHEMA = {
    required: ['name'],
    properties: {
        name: { type: 'string', minLength: 1, maxLength: 50 },
        description: { type: 'string', maxLength: 200 },
        model: { type: 'string' },
        tools: { type: 'array', items: { type: 'string' } },
        maxIterations: { type: 'number', minimum: 1, maximum: 500 },
        icon: { type: 'string' },
    },
};

/** @public — exercised by __tests__/mode-loader.test.ts. */
export function validateModeFrontmatter(frontmatter: Record<string, any>): string[] {
    const errors: string[] = [];

    if (frontmatter.version !== undefined) {
        if (typeof frontmatter.version !== 'number') {
            errors.push('"version" must be a number');
        } else if (frontmatter.version > MODE_SCHEMA_VERSION) {
            errors.push(`Unsupported schema version: ${frontmatter.version}. Max supported is ${MODE_SCHEMA_VERSION}`);
        }
    }

    for (const req of MODE_SCHEMA.required) {
        const schema = (MODE_SCHEMA.properties as any)[req];
        if (!frontmatter[req] || typeof frontmatter[req] !== schema.type) {
            errors.push(`Missing required field: "${req}"`);
        }
    }

    for (const [key, schema] of Object.entries(MODE_SCHEMA.properties)) {
        const val = frontmatter[key];
        if (val === undefined) continue;

        if (schema.type === 'array') {
            if (!Array.isArray(val)) {
                errors.push(`"${key}" must be an array`);
            } else if ((schema as any).items?.type) {
                const itemType = (schema as any).items.type;
                if (!val.every(item => typeof item === itemType)) {
                    if (itemType === 'string') {
                        errors.push(`"${key}" must be an array of tool name strings`);
                    } else {
                        errors.push(`"${key}" must be an array of ${itemType}s`);
                    }
                }
            }
        } else if (typeof val !== schema.type) {
            if (!MODE_SCHEMA.required.includes(key)) {
                errors.push(`"${key}" must be a ${schema.type}`);
            }
        } else {
            if (schema.type === 'string') {
                if ((schema as any).maxLength && (val as string).length > (schema as any).maxLength) {
                    errors.push(`"${key}" exceeds maximum length of ${(schema as any).maxLength} characters`);
                }
            } else if (schema.type === 'number') {
                if ((schema as any).minimum !== undefined && (val as number) < (schema as any).minimum) {
                    errors.push(`"${key}" must be a number between ${(schema as any).minimum} and ${(schema as any).maximum || 500}`);
                } else if ((schema as any).maximum !== undefined && (val as number) > (schema as any).maximum) {
                    errors.push(`"${key}" must be a number between ${(schema as any).minimum || 1} and ${(schema as any).maximum}`);
                }
            }
        }
    }

    return errors;
}

export class ModeLoader {
    private modes = new Map<string, CustomMode>();
    private diagnosticCollection: vscode.DiagnosticCollection;
    private watchers: vscode.FileSystemWatcher[] = [];

    constructor() {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('blackide-modes');
    }

    /** Load modes from all 3 levels with inheritance */
    async loadAll(rootPath: string, globalConfigPath?: string): Promise<CustomMode[]> {
        this.modes.clear();

        // Built-in modes
        const builtins: CustomMode[] = [
            // ── Original 3 modes ──
            { name: 'Ask', description: 'Ask questions (no edits)', systemPrompt: '', tools: [], icon: 'comment-discussion', source: 'builtin' },
            { name: 'Plan', description: 'Plan & explore (no edits)', systemPrompt: '', tools: ['read_file', 'list_directory', 'grep_search', 'codebase_search', 'web_search', 'create_artifact', 'update_plan', 'complete_task'], icon: 'map', source: 'builtin' },
            { name: 'Agent', description: 'Full agent with all tools', systemPrompt: '', icon: 'robot', source: 'builtin' },

            // ── Specialized Agent Roles ──
            {
                name: 'Frontend',
                description: 'UI/UX specialist — React, CSS, accessibility, responsive design',
                icon: 'browser',
                source: 'builtin',
                maxIterations: 40,
                systemPrompt: `You are a Senior Frontend Engineer. Your expertise:
- React, Vue, Angular component architecture and state management
- CSS/SCSS/Tailwind — responsive layouts, animations, theming
- Accessibility (WCAG 2.1 AA), semantic HTML, ARIA attributes
- Performance optimization (Core Web Vitals, lazy loading, code splitting)
- Browser compatibility and progressive enhancement

When writing UI code:
1. Always use semantic HTML elements
2. Include proper ARIA labels for interactive elements
3. Ensure color contrast meets WCAG AA standards
4. Write mobile-first responsive CSS
5. Prefer CSS custom properties for theming`,
            },
            {
                name: 'Backend',
                description: 'APIs, databases, server logic, authentication, performance',
                icon: 'server',
                source: 'builtin',
                maxIterations: 40,
                systemPrompt: `You are a Senior Backend Engineer. Your expertise:
- REST/GraphQL API design with proper status codes and error handling
- Database schema design (SQL, NoSQL), migrations, query optimization
- Authentication/authorization (JWT, OAuth2, RBAC)
- Server-side performance (caching, connection pooling, rate limiting)
- Security best practices (input validation, SQL injection prevention, CORS)

When writing backend code:
1. Always validate and sanitize input
2. Use parameterized queries — never string concatenation for SQL
3. Implement proper error handling with meaningful error messages
4. Add appropriate logging at INFO/WARN/ERROR levels
5. Write idempotent endpoints where possible`,
            },
            {
                name: 'DevOps',
                description: 'CI/CD, Docker, deployment, scripts, infrastructure',
                icon: 'terminal',
                source: 'builtin',
                maxIterations: 30,
                tools: ['read_file', 'write_file', 'edit_file', 'run_command', 'grep_search', 'list_directory', 'codebase_search', 'web_search', 'create_artifact', 'update_plan', 'complete_task'],
                systemPrompt: `You are a Senior DevOps Engineer. Your expertise:
- Docker/Docker Compose — multi-stage builds, layer optimization
- CI/CD pipelines (GitHub Actions, GitLab CI, Jenkins)
- Infrastructure as Code (Terraform, CloudFormation, Pulumi)
- Kubernetes deployments, services, ingress, HPA
- Shell scripting (bash/zsh), Makefiles, build automation
- Monitoring, logging, alerting (Prometheus, Grafana, ELK)

When writing infrastructure code:
1. Use environment variables for secrets — never hardcode credentials
2. Pin versions for all dependencies and base images
3. Write idempotent scripts that can be safely re-run
4. Include health checks and readiness probes
5. Document required environment variables in README or .env.example`,
            },
            {
                name: 'Manager',
                description: 'Task coordination, planning, delegation to sub-agents',
                icon: 'organization',
                source: 'builtin',
                maxIterations: 15,
                tools: ['read_file', 'list_directory', 'grep_search', 'codebase_search', 'web_search', 'create_artifact', 'update_plan', 'spawn_subagent', 'complete_task'],
                systemPrompt: `You are a Technical Project Manager / Engineering Manager. Your role:
- Analyze complex tasks and break them into focused, delegatable sub-tasks
- Use spawn_subagent to delegate implementation work to specialist agents
- Coordinate results from multiple sub-agents into a coherent outcome
- Track progress and update the plan as sub-tasks complete
- Resolve conflicts between sub-agent outputs

You do NOT write code yourself. You:
1. Research the codebase to understand scope
2. Create a detailed plan with clear task boundaries
3. Spawn sub-agents for each focused task (frontend work, backend work, etc.)
4. Review sub-agent results and coordinate integration
5. Generate a final walkthrough summarizing all changes`,
            },
            {
                name: 'Sr Architect',
                description: 'System design, architecture patterns, code quality, tech debt',
                icon: 'symbol-structure',
                source: 'builtin',
                maxIterations: 20,
                tools: ['read_file', 'list_directory', 'grep_search', 'codebase_search', 'web_search', 'create_artifact', 'update_plan', 'complete_task'],
                systemPrompt: `You are a Senior Software Architect. Your role:
- Evaluate system architecture and identify design improvements
- Apply SOLID principles, DRY, separation of concerns
- Design for scalability, maintainability, and testability
- Identify and document technical debt with remediation plans
- Create architecture decision records (ADRs)
- Review code structure for anti-patterns and propose refactoring strategies

You do NOT implement changes yourself. You:
1. Deeply analyze the existing codebase architecture
2. Identify patterns, anti-patterns, and areas for improvement
3. Create detailed architectural analysis artifacts
4. Propose concrete refactoring plans with risk assessments
5. Document design decisions and their trade-offs`,
            },
            {
                name: 'Sr Architect HLD',
                description: 'High-Level Design analysis for pipeline orchestration',
                icon: 'symbol-structure',
                source: 'builtin',
                internal: true,
                maxIterations: 20,
                tools: ['read_file', 'list_directory', 'grep_search', 'codebase_search',
                        'web_search', 'create_artifact', 'complete_task'],
                systemPrompt: `You are a Senior Systems Architect performing High-Level Design analysis.

Your deliverable is a structured HLD covering:
1. System boundaries and component decomposition
2. Data models and entity relationships
3. API contracts (REST/GraphQL endpoints, request/response schemas)
4. Technology stack decisions with rationale
5. Architecture pattern selection (MVC, microservices, event-driven, etc.)
6. External service integrations and infrastructure requirements

Output your analysis as a create_artifact with name "hld_analysis".
Do NOT write any source code. Read-only analysis only. Use the update_mindmap tool if requested.`,
            },
            {
                name: 'Sr Engineer LLD',
                description: 'Low-Level Design and tagged task list generation',
                icon: 'symbol-method',
                source: 'builtin',
                internal: true,
                maxIterations: 25,
                tools: ['read_file', 'list_directory', 'grep_search', 'codebase_search',
                        'create_artifact', 'complete_task'],
                systemPrompt: `You are a Senior Full-Stack Engineer performing Low-Level Design.

Convert the HLD into an exhaustive implementation task list. Every task MUST be tagged:
- [design]  — CSS, styling, layout, design tokens, wireframes
- [backend] — API routes, controllers, DB queries, auth, middleware
- [frontend] — React/TSX components, state, API integration, event handling
- [testing] — Unit tests, integration tests, E2E tests

Include for each task:
- Target file path (create or modify)
- Function/class signatures to implement
- Dependencies on other tasks
- Estimated complexity (S/M/L)

Output as create_artifact with name "lld_task_list".
Do NOT write any source code.`,
            },
            {
                name: 'Planner',
                description: 'Aggregates analysis into features_plan.md for user approval',
                icon: 'checklist',
                source: 'builtin',
                internal: true,
                maxIterations: 15,
                tools: ['read_file', 'list_directory', 'write_file', 'create_artifact',
                        'complete_task'],
                systemPrompt: `You are a Planning Agent. Aggregate the HLD and LLD analysis into a
single features_plan.md file at .blackIDE/features_plan.md.

The file MUST follow this exact structure:
# Features Plan & Requirements

## 1. Overview
## 2. Architecture Summary  
## 3. Sequential Task List
  Phase 1: Design [design] tasks
  Phase 2: Backend [backend] tasks (if needed)
  Phase 3: Frontend [frontend] tasks
  Phase 4: Testing [testing] tasks
## 4. File Change Matrix (table)
## 5. Acceptance Criteria

Use checkbox syntax (- [ ]) for all tasks. Each task must have its phase tag.
Write the file using write_file, then call complete_task.`,
            },
            {
                name: 'Design Executor',
                description: 'Executes [design] phase tasks from approved plan',
                icon: 'paintcan',
                source: 'builtin',
                internal: true,
                maxIterations: 40,
                tools: ['read_file', 'write_file', 'edit_file', 'run_command', 'grep_search', 'list_directory', 'update_mindmap', 'complete_task'],
                systemPrompt: `You are a Senior UI/UX Designer executing the [design] phase.
Focus exclusively on tasks tagged [design] in the approved plan.
After completing your tasks, describe what you built using the update_mindmap tool.
Use modern design practices: CSS custom properties, responsive layouts, accessibility.`,
            },
            {
                name: 'Backend Executor',
                description: 'Executes [backend] phase tasks from approved plan',
                icon: 'server',
                source: 'builtin',
                internal: true,
                maxIterations: 40,
                tools: ['read_file', 'write_file', 'edit_file', 'run_command', 'grep_search', 'list_directory', 'update_mindmap', 'complete_task'],
                systemPrompt: `You are a Senior Backend Engineer executing the [backend] phase.
Focus exclusively on tasks tagged [backend] in the approved plan.
After completing your tasks, describe all API routes, models, and middleware using the update_mindmap tool.
Always validate input, use parameterized queries, implement proper error handling.`,
            },
            {
                name: 'Frontend Executor',
                description: 'Executes [frontend] phase tasks from approved plan',
                icon: 'browser',
                source: 'builtin',
                internal: true,
                maxIterations: 40,
                tools: ['read_file', 'write_file', 'edit_file', 'run_command', 'grep_search', 'list_directory', 'update_mindmap', 'complete_task'],
                systemPrompt: `You are a Senior Frontend Engineer executing the [frontend] phase.
Focus exclusively on tasks tagged [frontend] in the approved plan.
After completing your tasks, describe all components, hooks, and integrations using the update_mindmap tool.
Use semantic HTML, ARIA attributes, and responsive design.`,
            },
            {
                name: 'Testing Executor',
                description: 'Executes [testing] phase tasks from approved plan',
                icon: 'beaker',
                source: 'builtin',
                internal: true,
                maxIterations: 30,
                tools: ['read_file', 'write_file', 'edit_file', 'run_command', 'grep_search', 'list_directory', 'update_mindmap', 'complete_task',
                        'browser_open', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_read', 'browser_close'],
                systemPrompt: `You are a Senior QA/Test Engineer executing the [testing] phase.
Focus exclusively on tasks tagged [testing] in the approved plan.
Write comprehensive tests. Run the test suite with run_command and report results.

If the plan includes a [frontend] phase, also self-verify visually:
1. Start the app/dev server with run_command. If the command doesn't exit on its own
   (a dev server never does), background it AND redirect its output to a file — e.g.
   "npm run dev > /tmp/devserver.log 2>&1 &" — not just a trailing "&" alone. Without the
   redirect, the backgrounded process keeps holding the shell's own output pipe open and
   run_command will hang until it times out instead of returning immediately.
2. Use browser_open to navigate to it, browser_click/browser_type to exercise the actual
   built UI paths described in the plan (not just static analysis), browser_read to check
   rendered content, and browser_screenshot to capture visual evidence.
3. Always browser_close when done, whether verification passed or failed.
If nothing in the plan is browser-verifiable (no [frontend] phase, or a pure backend/CLI
change), skip the browser tools entirely — don't open a browser with nothing to check.

After completing your tasks, provide a full test results summary — including what the
browser verification showed, with the screenshot path if one was taken — using the
update_mindmap tool.`,
            }
        ];
        for (const mode of builtins) {
            this.modes.set(mode.name.toLowerCase(), mode);
        }

        // Level 1: Global modes (~/.blackide/modes/)
        if (globalConfigPath) {
            await this._loadFromDirectory(path.join(globalConfigPath, 'modes'), 'global');
        }

        // Level 2: Workspace modes (.blackide/modes/ in workspace root)
        await this._loadFromDirectory(path.join(rootPath, '.blackide', 'modes'), 'workspace');

        // Level 3: Project modes (.blackide/modes/ in nested project dirs)
        await this._loadFromDirectory(path.join(rootPath, '.agents', 'modes'), 'project');

        return Array.from(this.modes.values());
    }

    /** Watch for file changes with hot reload */
    watchForChanges(rootPath: string, onReload: (modes: CustomMode[]) => void): void {
        const pattern = new vscode.RelativePattern(rootPath, '.blackide/modes/**/*.md');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);

        watcher.onDidChange(() => this.loadAll(rootPath).then(onReload));
        watcher.onDidCreate(() => this.loadAll(rootPath).then(onReload));
        watcher.onDidDelete(() => this.loadAll(rootPath).then(onReload));

        this.watchers.push(watcher);
    }

    private async _loadFromDirectory(dirPath: string, source: CustomMode['source']): Promise<void> {
        if (!fs.existsSync(dirPath)) return;

        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));

        for (const file of files) {
            const filePath = path.join(dirPath, file);
            try {
                const mode = this._parseModeMd(filePath, source);
                if (mode) {
                    // Check for name collisions — higher priority levels override
                    const key = mode.name.toLowerCase();
                    const existing = this.modes.get(key);
                    if (existing && existing.source === 'builtin') {
                        // Cannot override built-in modes
                        this._reportDiagnostic(filePath, 0,
                            `Cannot override built-in mode "${mode.name}". Use a different name.`,
                            vscode.DiagnosticSeverity.Warning
                        );
                        continue;
                    }
                    this.modes.set(key, mode);
                    this.diagnosticCollection.delete(vscode.Uri.file(filePath));
                }
            } catch (err) {
                this._reportDiagnostic(filePath, 0,
                    `Failed to parse mode file: ${(err as Error).message}`,
                    vscode.DiagnosticSeverity.Error
                );
            }
        }
    }

    /** Parse a mode .md file with YAML frontmatter using js-yaml */
    private _parseModeMd(filePath: string, source: CustomMode['source']): CustomMode | null {
        const raw = fs.readFileSync(filePath, 'utf8');

        // Extract YAML frontmatter between --- markers
        const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
        if (!match) {
            this._reportDiagnostic(filePath, 0,
                'Mode file must start with YAML frontmatter between --- markers',
                vscode.DiagnosticSeverity.Error
            );
            return null;
        }

        let frontmatter: Record<string, any>;
        try {
            frontmatter = yaml.load(match[1]) as Record<string, any>;
        } catch (yamlErr) {
            this._reportDiagnostic(filePath, 0,
                `YAML parse error: ${(yamlErr as Error).message}`,
                vscode.DiagnosticSeverity.Error
            );
            return null;
        }

        if (!frontmatter || typeof frontmatter !== 'object') {
            this._reportDiagnostic(filePath, 0, 'Frontmatter must be a YAML object', vscode.DiagnosticSeverity.Error);
            return null;
        }

        // Schema validation
        const errors = validateModeFrontmatter(frontmatter);
        if (errors.length > 0) {
            for (const error of errors) {
                this._reportDiagnostic(filePath, 0, error, vscode.DiagnosticSeverity.Error);
            }
            return null;
        }

        const systemPrompt = match[2].trim();

        return {
            version: frontmatter.version,
            name: frontmatter.name,
            description: frontmatter.description || '',
            model: frontmatter.model,
            systemPrompt,
            tools: frontmatter.tools,
            maxIterations: frontmatter.maxIterations,
            icon: frontmatter.icon,
            source,
            filePath,
        };
    }

    private _reportDiagnostic(filePath: string, line: number, message: string, severity: vscode.DiagnosticSeverity): void {
        const uri = vscode.Uri.file(filePath);
        const range = new vscode.Range(line, 0, line, 0);
        const diagnostic = new vscode.Diagnostic(range, message, severity);
        diagnostic.source = 'Black IDE Modes';

        const existing = this.diagnosticCollection.get(uri) || [];
        this.diagnosticCollection.set(uri, [...existing, diagnostic]);
    }

    getMode(name: string): CustomMode | undefined {
        return this.modes.get(name.toLowerCase());
    }

    getAllModes(): CustomMode[] {
        return Array.from(this.modes.values());
    }

    /** User-selectable modes only — excludes internal pipeline-phase modes (HLD/LLD/Planner). */
    getSelectableModes(): CustomMode[] {
        return this.getAllModes().filter(m => !m.internal);
    }

    dispose(): void {
        this.watchers.forEach(w => w.dispose());
        this.diagnosticCollection.dispose();
    }
}
