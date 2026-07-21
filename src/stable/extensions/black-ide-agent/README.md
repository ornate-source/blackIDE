# Black IDE Agent

## Multi-Agent Pipeline

Substantial, multi-domain requests ("Build a CRM with contact management and deal
pipeline tracking") are automatically routed through a 7-agent sequential pipeline
instead of the single-agent loop:

```
Architect (HLD) → Sr Engineer (LLD) → Planner
    → [user approval on features_plan.md]
    → Design → Backend (if needed) → Frontend → Testing
```

**Trigger:** a heuristic (`PlanningEngine.shouldOrchestrate`) fires only for from-scratch,
multi-domain builds — the prompt must contain an **action** verb (build/create/implement/…)
**and** a **scope** noun (app/platform/api/dashboard/service/…), and must **not** read as a
targeted change to existing code (optimize/refactor/fix/faster/…). So "Build a CRM with
contacts and deals" orchestrates, but "make this function faster in the user service" does
not. Everything else uses the single-agent flow. It is deliberately conservative: a missed
build costs only a `/orchestrate`, whereas a false trigger spends a full 7-agent run.

**Manual overrides:** `/orchestrate` (or the "orchestrator" mode) forces the pipeline on;
`/single` forces a request onto the single-agent path even if it looks like a build.

**Approval gate:** after the Planner phase, the generated `.blackIDE/features_plan.md`
is shown in chat for review — edit the file on disk if needed, then Approve or Reject.
Execution only proceeds on approval.

**Isolation:** once approved, the Design/Backend/Frontend/Testing execution phases run
inside an isolated git worktree, not the live workspace — a failed phase, a rejected
plan, or a mid-run cancellation never leaves partial changes in your actual files. The
worktree starts as a copy of the live workspace's current state (including uncommitted
changes, so it always sees the plan the Planner just wrote) and its changes are applied
back to the live workspace only once every execution phase has succeeded. If reconciling
back conflicts with something you edited concurrently, the worktree is preserved (not
discarded) so nothing generated is lost — the pipeline error message includes where to
find it. Because execution changes land via git, **their undo path is git** (not the
per-message checkpoint/undo used for chat edits).

**Command approval in pipelines:** a pipeline run is unattended (it may not even have a
chat surface, when launched from the Pipeline Manager), so it never raises per-command
modals. It still enforces your command allow/deny policy: allow-listed commands run,
deny-listed commands are refused and logged, and any command that *would* prompt for
confirmation in interactive chat is **refused (and logged), never auto-run** — the
auto-approve-terminal setting is intentionally not honored in this unattended lane. File
edits/creates inside the isolated worktree are allowed without prompting (they are
reviewed at the plan-approval gate and reconciled only on success); MCP tools are refused.

**Self-verification:** the Testing Executor has browser tools (navigate, click, type,
read, screenshot) and will start the dev server and click through the actual built UI
when the plan includes a `[frontend]` phase, rather than relying on static analysis alone.

**Per-phase models:** each phase can be assigned its own model in Settings → Pipeline
Phase Models (e.g. a fast/cheap model for HLD/LLD scaffolding, a stronger one for
execution) — unset or stale assignments fall back to the pipeline's main selected model.

**Outputs**, written under `.blackIDE/`:
- `features_plan.md` — the user-editable plan, tagged by phase (`[design]`, `[backend]`,
  `[frontend]`, `[testing]`)
- `mindmap/project_mindmap.md` — shared architecture knowledge the execution agents read
  and update across phases (updated deterministically by the orchestrator itself as a
  backstop, in addition to whatever agents write via the `update_mindmap` tool)
- `overview.md` — generated automatically on completion, with phase timing and a
  file-change table

**Settings** (Settings panel → this extension's own settings, not native VS Code
settings — everything here lives in one `general-settings` blob, same as the rest of the
extension's config):
- **Auto-Open All Pipeline Files** (`pipelineAutoOpenAllFiles`, off by default) — open
  every file the pipeline touches in a preview tab, not just the plan/mindmap/overview.
- **Pipeline Phase Models** (`pipelinePhaseModels`) — per-phase model assignment, see above.
- **Pipeline Token Budget** (`pipelineTokenBudget`, `0` = unlimited) — stop a run once its
  cumulative input+output tokens exceed this ceiling; a guardrail against a runaway
  multi-agent run. Pipeline runs also report live token usage and cost, the same as chat.

See `notes/agent_plan.md` for the full design record and changelog.
