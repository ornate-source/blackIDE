# Phase 2 — Observability & UX Honesty

**Source:** `notes/futureplan.md` §2 (B3, B7, B8) + §3 (F7 partial, F11 partial).
**Depends on:** nothing in Phase 1 (parallel-safe), but ship after it — visibility into a
feature matters less than the feature being safe.

---

## 2.1 Per-tool activity + token tracking in pipeline phases (B3)

**Problem:** `PipelineCallbacks.loopCallbacks` (`src/agent/pipeline-orchestrator.ts:71`)
is never provided by `src/extension.ts` → pipeline phases run `runAgentLoop` with no
callbacks: no ToolStarted/ToolFinished in the activity panel, no TokenUsage, no
loop-limit warning. A 7-agent pipeline reports zero cost.

**Fix:**
- In `_runPipelineCore`, construct a `loopCallbacks: LoopCallbacks` and pass it through
  the orchestrator callbacks object. Model it on `_runAgentTask`'s callbacks block
  (`extension.ts` ~:1495–1575) but keep it lean:
  - `onToolCall`/`onToolResult` → `emit({type:'ToolStarted'/'ToolFinished', ...})` with
    the same duration-map pattern (`toolStartedAt`).
  - `onUsage` → reuse a per-run `TokenTracker` instance; emit `TokenUsage` events and
    post the same `tokenUsage` webview message shape the chat flow sends, so the existing
    UI renders it unchanged.
  - `onLoopLimitReached` → for pipeline phases, do **not** show the chat flow's modal per
    phase (7 modals per run); return `{continueWith: 0}` and let the phase-retry flow
    handle it, or auto-extend once by +10 with a log entry. Pick one, document it.
- The webview already renders ToolStarted/Finished into `message.activity[]` via the
  `agentEvent` path for chat runs; for Manager runs, `ManagerPanel.tsx`'s per-run
  `agentReducer` already handles these event types (`agent-store.ts:136,150`) — the
  activity data will appear once the events flow. Add an `ActivityPanel` render inside
  the expanded run card (component already imported-adjacent in `AgentPanels.tsx`).

**Cost cap (new, small):** with token usage now measured, add a
`pipelineTokenBudget` setting (general-settings blob, default 0 = unlimited): when a
run's cumulative tokens exceed it, abort the run with a clear `PipelinePhaseError`. This
is the cheapest possible runaway-cost protection and neither Cursor nor Continue expose
an equivalent per-run cap.

**Test:** harness — run a `PipelineOrchestrator` phase against the existing mock LLM
server (sections [1]–[2] pattern) with a spy `loopCallbacks`, assert tool events fire.

## 2.2 Tune `shouldOrchestrate` (B7)

**Problem:** single-keyword match + >5 words over-triggers ("make this function faster
in the user service" → full pipeline).

**Fix (heuristic, no LLM call):** in `PlanningEngine.shouldOrchestrate`
(`src/agent/planning-engine.ts`):
- Split keywords into **action** (build/create/implement/develop/make/design/architect)
  and **scope** (app/application/system/platform/website/dashboard/crm/fullstack/
  full-stack/project/module/service/feature).
- Require: (action ∧ scope) ∨ explicit override. Drop bare `make`-style matches.
- Keep `/orchestrate` + orchestrator-mode overrides unchanged.
- Update harness section [14] cases; add the false-positive prompts from the audit as
  regression cases (they must NOT orchestrate).

**Escape hatch:** when orchestration triggers, the first pipeline log entry should name
the trigger ("auto-detected multi-domain build — send /single to run as one agent
instead" — requires a small `/single` bypass in the slash-command block,
`extension.ts:~420`). Cheap insurance against residual false positives.

## 2.3 Minor fixes bundle (B8)

1. **overview.md action column:** `generateOverview` (`pipeline-orchestrator.ts`)
   hardcodes "Modified". Thread the `kind` from `onFileChanged` into `filesByPhase`
   (change `Set<string>` → `Map<string, 'created'|'modified'|'deleted'>` in
   `_runPipelineCore` and the `getFilesForPhase` signature).
2. **Titles after pipeline runs:** covered by Phase 1.5's hook; if Phase 1.5 is deferred,
   add the `_generateConversationTitle` call to `_runPipeline`'s success path directly.
3. **Retry budget:** `runPhase(…, maxRetries = 1)` → 2, and include the attempt number in
   the retry dialog text ("attempt 2 of 3").
4. **Mindmap growth:** add a size guard to the deterministic auto-sync
   (`autoSyncMindmap`) — when `project_mindmap.md` exceeds ~100KB, drop the oldest
   Auto-Sync sections (they're regenerable from git history; agent-authored sections are
   kept). Prevents unbounded growth poisoning the token savings that justify the mindmap.

---

**Exit criteria:** pipeline runs show per-tool activity and a running token/cost figure
in both chat and Manager panel; the audit's false-positive prompts have regression tests;
`npm test` green.
