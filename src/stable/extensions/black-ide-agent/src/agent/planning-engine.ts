// Planning Engine — Feature 11 (Antigravity Two-Phase Pattern)
// Every substantive user message goes through a mandatory plan-first workflow:
//   Phase 1: Research → create plan & task artifacts → complete_task → await approval
//   Phase 2: On approval → execute plan → create walkthrough → complete_task

/** Coarse request category — the `plan.md` "Request Classification" taxonomy, collapsed
 *  to the distinctions that actually change how the agent should behave. */
export type RequestKind =
    | 'question'      // explanation / research — no code change expected
    | 'bug'           // fix broken behavior
    | 'refactor'      // restructure without behavior change
    | 'performance'   // make existing code faster / lighter
    | 'security'      // harden / fix a vulnerability
    | 'test'          // add or fix tests
    | 'docs'          // documentation / comments
    | 'devops'        // CI/CD, containers, deploy, infra
    | 'build'         // net-new, multi-domain construction (pipeline territory)
    | 'feature'       // add functionality to existing code (single-ish domain)
    | 'other';

export interface RequestClassification {
    kind: RequestKind;
    /** false only for a pure question with no code-change intent. */
    isProgramming: boolean;
}

export class PlanningEngine {

    private static readonly PLAN_KEYWORDS = [
        'build', 'create', 'implement', 'refactor', 'migrate', 'add', 'fix',
        'update', 'change', 'modify', 'delete', 'remove', 'redesign', 'architect',
        'restructure', 'new', 'setup', 'integrate', 'overhaul', 'convert', 'rewrite',
        'port', 'upgrade', 'debug', 'optimize', 'improve', 'deploy', 'configure',
        'write', 'make', 'move', 'rename', 'extract', 'merge', 'split', 'install',
    ];

    /**
     * Detect if a prompt requires planning vs. direct execution.
     * Antigravity pattern: all substantive messages go through plan-first.
     * Only trivial greetings / short questions skip planning.
     */
    static shouldPlan(prompt: string): boolean {
        const lower = prompt.toLowerCase().trim();

        // Explicit /plan command always triggers planning
        if (lower.startsWith('/plan')) return true;

        // Slash commands that have their own behaviour bypass planning
        if (lower.startsWith('/explain') || lower.startsWith('/test') ||
            lower.startsWith('/fix') || lower.startsWith('/commit') ||
            lower.startsWith('/refactor') || lower.startsWith('/docs') ||
            lower.startsWith('/search') || lower.startsWith('/compact')) {
            return false;
        }

        // Trivial greetings and very short questions skip planning
        const wordCount = prompt.split(/\s+/).filter(w => w.length > 0).length;
        if (wordCount <= 5 && !PlanningEngine.PLAN_KEYWORDS.some(kw => lower.includes(kw))) {
            return false;
        }

        // Everything else goes through plan-first
        return true;
    }

    // A from-scratch build is signalled by an ACTION verb applied to a substantial SCOPE
    // noun. Requiring BOTH (not any single keyword) is what stops a lone "service" or
    // "make" from launching a 7-agent pipeline.
    private static readonly ORCHESTRATION_ACTIONS = [
        'build', 'create', 'implement', 'develop', 'scaffold', 'generate',
        'make', 'design', 'architect',
    ];
    private static readonly ORCHESTRATION_SCOPES = [
        'app', 'application', 'system', 'platform', 'website', 'web app',
        'dashboard', 'crm', 'saas', 'portal', 'marketplace', 'microservice',
        'fullstack', 'full-stack', 'full stack', 'project', 'module', 'service',
        'api', 'backend', 'frontend',
    ];
    // Signals a TARGETED change to existing code, not a from-scratch build. Present ->
    // never orchestrate, even with an action+scope match. This is the clause that keeps
    // "make this function faster in the user service" on the single-agent path.
    private static readonly ORCHESTRATION_MODIFIERS = [
        'optimize', 'optimise', 'refactor', 'faster', 'improve', 'fix', 'debug',
        'rename', 'tweak', 'adjust', 'migrate', 'upgrade', 'performance',
    ];

    /**
     * Detect if a prompt warrants the full multi-agent pipeline (HLD → LLD → Plan →
     * Design/Backend/Frontend/Testing) rather than the single-agent plan-first flow.
     * Deliberately conservative: false negatives cost only a `/orchestrate`, whereas a
     * false positive spends a full 7-agent run on a one-line change. Checked before
     * shouldPlan() since orchestration is the superset workflow.
     */
    static shouldOrchestrate(prompt: string, mode?: string): boolean {
        // Manual overrides win in both directions.
        if (mode === 'orchestrator') return true;
        const lower = prompt.toLowerCase().trim();
        if (lower.startsWith('/orchestrate')) return true;
        if (lower.startsWith('/single')) return false;   // explicit "run as one agent"

        // Other slash commands have their own behaviour and never orchestrate.
        if (lower.startsWith('/')) return false;

        // action + scope already implies ≥2 meaningful words; a tiny floor just rejects
        // terse noise like "make app".
        const wordCount = prompt.split(/\s+/).filter(w => w.length > 0).length;
        if (wordCount < 3) return false;

        const hasAction = PlanningEngine.ORCHESTRATION_ACTIONS.some(kw => lower.includes(kw));
        const hasScope = PlanningEngine.ORCHESTRATION_SCOPES.some(kw => lower.includes(kw));
        const isModification = PlanningEngine.ORCHESTRATION_MODIFIERS.some(kw => lower.includes(kw));
        return hasAction && hasScope && !isModification;
    }

    /**
     * Classifies a request into a coarse intent category (the `plan.md` "Request
     * Classification" step). Priority-ordered: the most specific/highest-signal intent
     * wins, so "fix the slow query" is a bug-flavoured performance issue → `performance`
     * ranks above `bug` only where perf words dominate; the ordering below encodes those
     * precedence calls. Pure/exported-shaped for testing. This drives logging, telemetry,
     * and right-sizing — a `question` never needs the plan-first or pipeline machinery.
     */
    static classifyRequest(prompt: string): RequestClassification {
        const lower = prompt.toLowerCase().trim();
        const has = (...kw: string[]) => kw.some(k => lower.includes(k));
        const hasActionVerb = PlanningEngine.PLAN_KEYWORDS.some(kw => lower.includes(kw));

        // A pure question: interrogative lead or trailing '?', and no imperative to change code.
        const questionLead = /^(what|why|how|when|where|who|which|is|are|does|do|can|could|should|would|explain|describe|tell me|show me)\b/.test(lower);
        if ((questionLead || lower.endsWith('?')) && !hasActionVerb) {
            return { kind: 'question', isProgramming: false };
        }

        // Specific intents, most distinctive first.
        if (has('security', 'vulnerab', 'exploit', 'injection', 'sanitize', 'cve', 'xss', 'csrf')) return { kind: 'security', isProgramming: true };
        if (has('performance', 'faster', 'optimize', 'optimise', 'slow', 'latency', 'memory leak', 'throughput')) return { kind: 'performance', isProgramming: true };
        if (has('refactor', 'restructure', 'clean up', 'cleanup', 'simplify', 'extract', 'rename', 'dedupe', 'deduplicate')) return { kind: 'refactor', isProgramming: true };
        if (has('bug', 'fix', 'broken', 'not working', "doesn't work", 'crash', 'regression', 'debug', 'stack trace', 'exception')) return { kind: 'bug', isProgramming: true };
        if (has('unit test', 'integration test', 'e2e', 'coverage', 'test suite', 'write tests', 'add tests', 'failing test')) return { kind: 'test', isProgramming: true };
        if (has('document', 'readme', 'changelog', 'jsdoc', 'docstring', 'comment the', 'api docs')) return { kind: 'docs', isProgramming: true };
        if (has('deploy', 'ci/cd', 'cicd', 'docker', 'kubernetes', 'k8s', 'terraform', 'pipeline yaml', 'github action', 'infra')) return { kind: 'devops', isProgramming: true };

        // Net-new multi-domain build vs. a single-domain feature add.
        if (PlanningEngine.shouldOrchestrate(prompt)) return { kind: 'build', isProgramming: true };
        if (has('add', 'implement', 'create', 'build', 'feature', 'support for', 'endpoint', 'component', 'page')) return { kind: 'feature', isProgramming: true };

        return { kind: 'other', isProgramming: hasActionVerb };
    }

    /**
     * Requirement discovery (plan.md "Requirement Discovery"): for a net-new build, spot
     * the high-value dimensions the request leaves unspecified and return concise
     * clarifying questions — the agency should ask rather than assume. Returns [] when the
     * request isn't a build or already names the dimension. Pure/exported for testing.
     *
     * Intentionally conservative: only a `build`-class request is worth interrupting for
     * questions; smaller intents proceed directly.
     */
    static detectMissingRequirements(prompt: string): string[] {
        if (PlanningEngine.classifyRequest(prompt).kind !== 'build') return [];
        const lower = prompt.toLowerCase();
        const questions: string[] = [];
        const mentions = (...kw: string[]) => kw.some(k => lower.includes(k));

        if (!mentions('user', 'customer', 'admin', 'audience', 'who ', 'for people', 'for teams')) {
            questions.push('Who are the primary users, and what is the single most important thing they need to do?');
        }
        if (!mentions('react', 'vue', 'svelte', 'angular', 'next', 'express', 'fastapi', 'django', 'rails', 'node', 'python', 'stack', 'framework', 'typescript', 'postgres', 'mysql', 'mongo', 'sqlite')) {
            questions.push('Any required tech stack or framework, or should I choose sensible defaults?');
        }
        if (!mentions('auth', 'login', 'sign in', 'sign up', 'account', 'permission', 'role', 'no auth', 'public')) {
            questions.push('Does this need authentication / user accounts, and if so what roles?');
        }
        if (!mentions('scope', 'mvp', 'minimum', 'just ', 'only ', 'for now', 'v1', 'prototype', 'must have', 'acceptance')) {
            questions.push('What is in scope for a first version vs. explicitly out of scope?');
        }
        return questions;
    }

    /** Generate the Phase 1 planning-mode system prompt extension */
    static getPlanningPromptExtension(): string {
        return `
PLANNING MODE — MANDATORY WORKFLOW (Do NOT skip any step):

## Step 1: RESEARCH (No file edits allowed)
- Use read_file, grep_search, codebase_search, list_directory to understand the codebase
- Identify affected files, dependencies, and existing patterns
- Do NOT create or edit any source files during this phase

## Step 2: CREATE IMPLEMENTATION PLAN
Call create_artifact with these exact parameters:
- name: "implementation_plan"
- type: "plan"
- content: A detailed markdown plan following this template:

\`\`\`
# Implementation Plan: [Goal Description]

## Summary
Brief description of the problem, background context, and what changes accomplish.

## Proposed Changes

### [Component/Feature Name]

#### [MODIFY] filename
- What changes will be made and why

#### [NEW] filename
- New file purpose and contents

#### [DELETE] filename
- Why this file should be removed

## Verification Plan
### Automated Tests
- Commands to run to verify

### Manual Verification
- Steps the user should take to verify
\`\`\`

## Step 3: CREATE TASK LIST
Call create_artifact with these exact parameters:
- name: "task_list"
- type: "task"
- content: A markdown checklist following this template:

\`\`\`
# Task List

- [ ] Task 1: Description of what to do
  - [ ] Sub-task 1a: Specific file/change detail
  - [ ] Sub-task 1b: Specific file/change detail
- [ ] Task 2: Description
- [ ] Task 3: Verification & testing
\`\`\`

## Step 4: COMPLETE
Call complete_task with a brief summary of your plan.
The user will review and approve before execution begins.

CRITICAL RULES:
- Do NOT edit or create source code files. Only use read-only tools and create_artifact.
- The plan must be specific enough that another agent could execute it without ambiguity.
- Include file paths, function names, and concrete change descriptions — not vague instructions.`;
    }

    /** Generate the Phase 2 execution-mode system prompt extension */
    static getExecutionPromptExtension(planContent: string, taskContent: string): string {
        return `
EXECUTION MODE — The user has reviewed and approved the following plan. Execute it now.

## APPROVED IMPLEMENTATION PLAN
${planContent}

## APPROVED TASK CHECKLIST
${taskContent}

## EXECUTION RULES
1. Follow the approved plan step by step. Do not skip tasks.
2. After completing each major task, call update_plan to mark progress so the user can track:
   - Set completed tasks to status "done"
   - Set the current task to status "in_progress"
   - Keep upcoming tasks as "pending"
3. If you encounter an issue that requires deviating from the plan, explain why before proceeding.
4. After ALL tasks are complete, call create_artifact with:
   - name: "walkthrough"
   - type: "walkthrough"
   - content: A comprehensive overview of everything you did, organized as:

\`\`\`
# Walkthrough: [Goal Description]

## Changes Made
### [Component Name]
- **[filename]**: Description of what was changed/created and why

## Commands Run
- \`command\`: What it did and the result

## Key Decisions
- Decision 1: Why this approach was chosen over alternatives

## How to Verify
- Step-by-step instructions to confirm everything works

## Summary
Brief paragraph summarizing the overall outcome.
\`\`\`

5. Finally, call complete_task with a concise final summary.

CRITICAL: Deliver the walkthrough artifact BEFORE calling complete_task.`;
    }
}
