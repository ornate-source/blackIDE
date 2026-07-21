# Phase 1 — Correctness & Security (Release Blockers)

> **Execution-ready version:** see [`phase-1-implementation.md`](phase-1-implementation.md)
> for verified line-anchored steps, resolved design decisions, per-item test specs, and a
> file-change map. That doc also corrects three things this higher-level plan
> under-scoped (notably: B5 is a *concurrency* bug via the shared `CheckpointManager`, so
> the fix is store isolation, not scoped-commit). This file remains the "what/why".

**Source:** `notes/futureplan.md` §2 (bugs B1, B2, B4, B5, B6). All five items are
independent — implement and test in any order, but ship together: each closes a verified
bug in a shipped feature. All paths relative to `src/stable/extensions/black-ide-agent/`.

---

## 1.1 Enforce command-approval policy in pipeline runs (B1) 🔴

**Problem:** `_runPipelineCore`'s `baseDeps` hardcodes `approve: async () => true`
(`src/extension.ts:949`), bypassing `CommandPolicy` and every auto-approve setting the
chat flow honors.

**Fix:**
- Extract the chat flow's approval construction (the `commandPolicy` instantiation from
  `settings.commandAllowList`/`commandDenyList`/`autoApproveTerminal` and the `approve`
  closure inside `_runAgentTask`) into a private helper
  `_buildApprovalGate(settings, webview?): (req: ApprovalRequest) => Promise<boolean>`.
- Use it in `_runPipelineCore`. The general-settings blob is already read there
  (`generalSettings`), so the policy inputs are available.
- **Design decision needed at implementation time:** what "prompt the user" means for a
  *Manager-panel* run with no chat surface. Recommended v1: for pipeline runs, apply the
  policy strictly (deny-listed commands are refused with a clear error into the phase log;
  allow-listed and auto-approved pass), and treat "would need to ask" as **deny with
  log entry** rather than blocking a background-style run on a modal. Document this in
  README.md.
- The executor already routes every exec/edit/create/mcp through `this.d.approve(...)`
  (`src/agent/tool-executor.ts:78,106,117,125,155`) — no executor changes needed.

**Test:** harness section — build an executor with a deny-listed command policy, assert
`run_command` on a denied command returns `isError` without executing (the vscode-stub
pattern in `test/harness.js:18` supports this; `CommandPolicy` is already imported there).

## 1.2 Close browser/MCP resources in pipeline runs (B2) 🔴

**Problem:** `_runPipelineCore` creates `BrowserTool` + `MCPClient` and never closes
them; only `_runAgentTask` has the cleanup (`src/extension.ts:1677–1678`).

**Fix:** wrap `_runPipelineCore`'s body's tail in `finally { try { await
browserTool.close(); } catch {} try { await mcpClient.disconnectAll(); } catch {} }` —
identical to the chat flow's block.

**Test:** hard to automate without an extension host; verify by code review + add a
comment cross-referencing the chat flow's block so the next reader keeps them in sync.

## 1.3 Scope checkpoint snapshots correctly for pipeline runs (B5) 🟠

**Problem:** pipeline writes call `checkpoint.snapshot()` (via `tool-executor.ts:108,119`)
into the shared open transaction but never `commit()` — snapshots bleed into the next
chat task's checkpoint (wrong undo grouping) and execution-phase snapshots reference
deleted worktree paths.

**Fix (choose at implementation; recommendation = first):**
- **(a) Commit per pipeline run:** in `_runPipelineCore`, after `orchestrator.run()`
  resolves, call `this._checkpoints.commit(runOrTaskId, userPrompt.slice(0,60), rootPath)`
  — mirrors the chat flow (`extension.ts` commit near :1590). Worktree-path snapshots:
  filter them out at commit time (commit already takes `rootPath`; add a guard that drops
  files outside it) — worktree changes are already recoverable via git, they don't need
  checkpoint coverage.
- (b) Alternative: pass a null/no-op checkpoint into pipeline executor deps and rely on
  git alone. Simpler, but loses undo for analysis-phase writes (features_plan.md) which
  DO hit the live workspace.

**Test:** harness — snapshot a file inside a fake worktree dir + one inside rootPath,
commit with rootPath, assert only the in-root file is in the checkpoint.

## 1.4 Fix `spawn_subagent` silent work loss (B6) 🟠

**Problem:** subagent flow (`src/extension.ts` ~:1150–1230) does
`createWorktree → runAgentLoop → mergeWorktree → removeWorktree`, but nothing commits in
the worktree, so `mergeWorktree` merges zero commits and `removeWorktree` deletes all the
subagent's output.

**Fix:** replace the `mergeWorktree(branchName)` call with the exact sequence the
pipeline path already uses (`src/agent/pipeline-orchestrator.ts` `run()` reconciliation
block):
1. `const baseline = await worktreeManager.commitWorktreeChanges(branch, 'subagent: baseline')`
   — **immediately after** `syncUncommittedChanges`… note the subagent path currently
   *doesn't* sync uncommitted changes either; add `syncUncommittedChanges(branch)` after
   `createWorktree` for the same features_plan-shaped reasons documented in
   `worktree-manager.ts`.
2. After the loop: `const exec = await commitWorktreeChanges(branch, 'subagent: ' + name)`
3. `await worktreeManager.applyDelta(branch, baseline, exec)`
4. Existing `removeWorktree` cleanup stays.
- Also raise `maxLoops: 6` → configurable, default 15 (6 is too small for any real task
  and made B6 harder to notice — subagents rarely finished anything worth merging).

**Test:** extend harness section [16] — it already builds a real git repo and exercises
the exact same WorktreeManager sequence; add a variant asserting the baseline-commit →
work → delta-apply path preserves subagent-created files in the live root.

## 1.5 Feed pipeline results into conversation context (B4) 🟠

**Problem:** `this._conversation` is only updated by `_runAgentTask`
(`src/extension.ts:1582`); follow-up messages after a pipeline run know nothing about it.
Spec F14 claims this ships; it doesn't.

**Fix (deliberately cheap):** full message-history splicing from 7 agent loops would blow
the context budget. Instead, after a successful chat-initiated pipeline run
(`_runPipeline`, after `_runPipelineCore` resolves without error), append **two synthetic
messages** to `this._conversation`:
- user: the original prompt
- assistant: a compact summary — read `.blackIDE/overview.md` (just generated; contains
  phase log + file table) and use it as the assistant-turn content, capped at ~4000 chars.
Then persist via the existing `_pruneForPersistence` + `setConversationState` sequence
(`extension.ts:1585–1587`). Manager-panel runs: skip (they're not part of any chat
thread).
- Also trigger `_generateConversationTitle` here (closes part of B8).

**Test:** harness-level test of the summary-construction function if extracted pure;
otherwise covered by the Phase 4 integration-test work.

---

**Exit criteria:** all five fixes landed; `npm test` green (new sections for 1.1, 1.3,
1.4); `notes/agent_plan.md` changelog updated; README updated for the 1.1 policy
semantics.
