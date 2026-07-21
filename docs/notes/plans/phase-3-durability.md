# Phase 3 — Durability: Runs That Survive Reloads

**Source:** `notes/futureplan.md` §2 (B8 restart items) + §4 blocker 5.
**Depends on:** Phase 1 (checkpoint scoping — 1.3 — must land first so persisted run
state references clean checkpoint boundaries).

The largest architectural gap vs Cursor (cloud VMs) and Antigravity (scheduled tasks)
that is closable **without any cloud infrastructure**: today a window reload silently
kills every in-flight pipeline and forgets it existed. Full survive-and-resume of an
in-flight LLM loop is not feasible in-process — but *detect, report, and offer recovery*
is, and that's 90% of the user-facing value.

---

## 3.1 Persist run state to Memento

- Serialize a durable subset of each `PipelineRunRecord` (`src/extension.ts` — the
  existing `PipelineRunSummary` type is exactly this shape) into
  `HistoryStore.setConversationState('pipeline-runs', …)`-style storage on every status
  transition (the `emit` switch in `_runPipelineInManager` already centralizes these).
- Include per-run: prompt, modelId, status, timestamps, current phase, worktree branch
  name (if execution had started), and the pipeline-log entries accumulated so far
  (bounded: last ~200 entries).
- Chat-initiated runs: persist under the owning threadId so the log panel repopulates on
  thread reload (the `message.pipelineLog[]` persistence path already covers the chat
  case — verify, then reuse rather than duplicate).

## 3.2 Reload reconciliation

On `resolveWebviewView` (extension activation / reload — `extension.ts:~370`, where
pending-plan restoration already happens):
- Load persisted runs. Any with non-terminal status (`running`/`awaiting_approval`) were
  killed by the reload → mark `failed` with error "interrupted by window reload", and:
  - If the run had a worktree branch: **check whether the branch still exists**
    (`git branch --list <name>` via ToolRunner). If yes, the execution work up to the
    kill is preserved on that branch — surface a recovery card in the Manager panel:
    "Run interrupted — completed work is on branch `pipeline-xxx`: [Apply delta]
    [Discard]". Apply = the existing `commitWorktreeChanges` + `applyDelta` sequence;
    Discard = `removeWorktree`.
  - `worktreeManager.pruneOrphans()` for anything unrecoverable.
- Manager panel's `listPipelineRuns` then returns history + recovery cards, not an empty
  list.

## 3.3 Pending-approval restart survival (both lanes)

- The chat single-agent flow already persists `_pendingApproval` to Memento and restores
  the approval card on reload (`extension.ts:~380` restore block). Extend the same
  pattern to `_pendingPipelineApproval` and per-run `pendingApproval`:
  - Persist `{planContent, planPath, threadId|runId}` at gate time.
  - On reload, the resolver function is gone — so restoration **cannot resume the same
    Promise**. Instead, restore into a state where clicking Approve **restarts execution
    from the approval gate**: plan is on disk, `selectExecutionPhases(planContent)` is
    pure, and execution phases take the plan file as input — a fresh
    "resume-from-approved-plan" entry point on `PipelineOrchestrator` (skip analysis
    phases, go straight to worktree + execution) makes this a clean restart, not a hack.
- This also fixes the chat/pipeline asymmetry noted in the audit (B8).

## 3.4 Run history UX

- Terminal runs (completed/failed/cancelled) persist for N days (setting, default 7) and
  render collapsed at the bottom of the Manager panel with their final log.
- "Clear history" action; per-run "Re-run" action (same prompt/model → new run).

---

**Exit criteria:** reload mid-pipeline produces a recovery card (verified manually in a
live extension host — see phase-4 test infra); approval gates survive restarts in both
lanes; no orphan worktrees accumulate after repeated interrupted runs (harness-testable:
the reconciliation logic on a real temp repo, minus the webview).
