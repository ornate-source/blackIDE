# Agent Swarm Operations & Telemetry Dashboard — Production Design

A real-time, high-density **Agent Swarm Operations & Telemetry View** integrated directly into the Manager Panel (`live` tab). Styled with the architectural precision of enterprise tools like **Datadog APM, Vercel, and Linear**. Zero toy metaphors, zero cartoon graphics — built for serious software engineers orchestrating parallel AI task agents and pipeline execution waves.

## Design Vision

![Production Enterprise Agent Swarm Operations Dashboard](file:///Users/sabbir/.gemini/antigravity-ide/brain/c9b65f8f-6460-4360-8a92-351ee8ddcf7c/production_agent_ops_dashboard_1785828694295.png)

---

## Architectural Principles & Visual Language

| Attribute | Specification |
|---|---|
| **Design Language** | High-density technical dark UI (`#09090b` zinc base), 1px razor-sharp borders (`#27272a`), crisp data grids |
| **Typography** | `SF Mono` / `JetBrains Mono` for code symbols, AST targets, Git SHAs; `Inter` for technical labels |
| **Status Telemetry** | High-contrast status badges (`EMERALD` for active execution, `AMBER` for human gates, `CYAN` for IO/tool run, `ZINC` for idle) |
| **Data Visualization** | Mini SVG sparkline graphs for token rate, context window usage bars, diff deltas (`+142 / -18`) |
| **Git Worktree Visibility** | Displays target worktree branch name (`~/.blackide/worktrees/...`), commit baseline, and mutex queue status |

---

## Panel Layout & Component Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ ⚡ AGENT SWARM MONITOR                                              ● 3 WORKTREES ACTIVE    │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────────────┐ │
│ │ TOTAL TOKENS │ │ BURN RATE    │ │ CONTEXT ALLOC│ │ ACTIVE LANES │ │ GIT MUTEX QUEUE    │ │
│ │ 148.2k       │ │ $0.042/min   │ │ 64% Avg      │ │ 3 / 4        │ │ STATUS: OK         │ │
│ └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘ └────────────────────┘ │
├─────────────────────────────────────────────────────────────┬───────────────────────────────┤
│ AGENT EXECUTION LANES                                       │ EVENT BUS & LOG TRACE         │
│ ┌─────────────────────────────────────────────────────────┐ │ ┌───────────────────────────┐ │
│ │ NODE-01: FE_EXECUTOR [agent/fe-nav-build]  ● RUNNING    │ │ │ 12:30:14.201  [fe-01]     │ │
│ │ Mode: Frontend | Model: Claude 3.5 Sonnet               │ │ │ `ToolStarted` replace_file│ │
│ │ AST Target: src/components/NavigationHeader.tsx         │ │ │                           │ │
│ │ Active Tool: replace_file_content (124ms)               │ │ │ 12:30:12.890  [be-02]     │ │
│ │ Sparkline:  _/\/\_/‾\__ [Token rate: 420 t/s]           │ │ │ `VerificationPassed`      │ │
│ │ Diff: +142 / -18 lines | Context Capacity: 72% (18/25)  │ │ │   14/14 tests passing     │ │
│ │ [STEER THREAD] [HALT WORKTREE] [INSPECT DIFF]           │ │ │                           │ │
│ └─────────────────────────────────────────────────────────┘ │ │ 12:30:05.112  [arch]      │ │
│ ┌─────────────────────────────────────────────────────────┐ │ │ `PlanCreated`             │ │
│ │ NODE-02: BE_EXECUTOR [agent/be-auth-api]   ● RUNNING    │ │ │   features_plan.md        │ │
│ │ Target: src/api/auth_middleware.go                      │ │ └───────────────────────────┘ │
│ └─────────────────────────────────────────────────────────┘ │                               │
│ ┌─────────────────────────────────────────────────────────┐ │                               │
│ │ NODE-03: ARCHITECT_PLANNER                 ● GATE PAUSE │ │                               │
│ │ Action: Human Gate Approval Required for Phase Wave 2   │ │                               │
│ │ [APPROVE EXECUTION WAVE]  [REJECT & REVISE]             │ │                               │
│ └─────────────────────────────────────────────────────────┘ │                               │
└─────────────────────────────────────────────────────────────┴───────────────────────────────┘
│ DEPENDENCY GRAPH & WAVE SCHEDULER                                                            │
│  [HLD] ───> [LLD] ───> ┌─── [Design Wave] ───┐ ───> [Frontend Wave] ───> [Verification]      │
│                        └─── [Backend Wave] ──┘                                               │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Technical Component Breakdowns

### 1. `SwarmTelemetryHeader.tsx`
- **Total Burn & Tokens**: Live rolling aggregation from active `TaskAgentSummary` and `PipelineRunSummary` instances.
- **Git Mutex Status**: Live check on global lock state (`git-mutex.ts`).
- **Context Alloc**: Real-time context window usage calculation per model limit.

### 2. `AgentNodeCard.tsx` (Replaces old desk cards)
- **Header**: Agent ID, mode tag (`Frontend`, `Backend`, `Sr Architect`), model identifier (`Claude 3.5 Sonnet`), git worktree branch.
- **Live AST / Target File**: Shows precise workspace relative path currently being read/modified by `ToolStarted` / `ToolFinished` events.
- **Active Execution Metric**: Live turn progress `[Turn 18/25]`, execution time stopwatch, diff stat breakdown (`+142 / -18`).
- **Interlock Controls**:
  - `STEER THREAD` -> Sends mid-run steering injection.
  - `HALT WORKTREE` -> Triggers agent abort signal & worktree retention.
  - `APPLY DELTA` -> Merges worktree into main branch (`canApply` protected).
  - `DISCARD WORKTREE` -> Cleanly deletes isolated branch & worktree directory.

### 3. `EventTraceSidebar.tsx`
- Structured real-time feed powered by `EventBus` subscriptions (`onAny`).
- Displays formatted JSON-like events: `ToolStarted`, `ToolFinished`, `FileChanged`, `VerificationCompleted`, `SkillsFired`.
- Filterable by Node ID or event level (`info`, `warn`, `error`).

### 4. `PipelineGraphNode.tsx` (Dependency Wave Graph)
- Renders `EXECUTION_PHASE_GRAPH` visually using SVG paths and node badges.
- Highlights execution waves, active dependency locks, and gate approval status.

---

## Implementation Plan

### [NEW] [LiveAgentWorkView.tsx](file:///Users/sabbir/work/ornate_source/blackIDE/src/stable/extensions/black-ide-agent/webview/src/LiveAgentWorkView.tsx)
- ~650 lines of clean, production-grade TypeScript React code.
- Zero external UI libraries required — uses native CSS Grid, Tailwind CSS tokens, and SVG graphics.

### [MODIFY] [index.css](file:///Users/sabbir/work/ornate_source/blackIDE/src/stable/extensions/black-ide-agent/webview/src/index.css)
- Add dark technical UI utility classes (`.bg-zinc-950`, `.border-zinc-800`, `.font-mono`, `.sparkline-path`).

### [MODIFY] [tailwind.config.js](file:///Users/sabbir/work/ornate_source/blackIDE/src/stable/extensions/black-ide-agent/webview/tailwind.config.js)
- Extend zinc/slate theme colors and mono typography rules.

### [MODIFY] [ManagerPanel.tsx](file:///Users/sabbir/work/ornate_source/blackIDE/src/stable/extensions/black-ide-agent/webview/src/ManagerPanel.tsx)
- Integrate `LiveAgentWorkView` under the `Live Ops` tab (replacing old mock view).

---

## File Summary

| File | Action | Lines |
|---|---|---|
| [LiveAgentWorkView.tsx](file:///Users/sabbir/work/ornate_source/blackIDE/src/stable/extensions/black-ide-agent/webview/src/LiveAgentWorkView.tsx) | **NEW** | ~650 |
| [index.css](file:///Users/sabbir/work/ornate_source/blackIDE/src/stable/extensions/black-ide-agent/webview/src/index.css) | MODIFY | +~120 |
| [tailwind.config.js](file:///Users/sabbir/work/ornate_source/blackIDE/src/stable/extensions/black-ide-agent/webview/tailwind.config.js) | MODIFY | +~25 |
| [ManagerPanel.tsx](file:///Users/sabbir/work/ornate_source/blackIDE/src/stable/extensions/black-ide-agent/webview/src/ManagerPanel.tsx) | MODIFY | +~20 |

**Total: Zero backend changes required. All data already streams via `EventBus` and `ManagerPanel` props.**

## Verification Plan
1. **Type-Check**: Run `npx tsc --noEmit` inside `extensions/black-ide-agent/webview`.
2. **Build Test**: Run `npx vite build` in webview dir to ensure zero build bundle errors.
3. **Runtime Test**: Open Manager Panel, click `Live Ops` tab, launch parallel task agents and verify real-time telemetry, AST target updating, and dependency DAG.
