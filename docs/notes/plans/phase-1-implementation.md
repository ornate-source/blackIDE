# Phase 1 — Implementation Plan (Execution-Ready)

**Derived from:** `notes/plans/phase-1-correctness.md` (the "what/why") and
`notes/futureplan.md` §2. This document is the "exactly how" — every reference below was
re-verified against the working tree on 2026-07-19 with the Phase 0–2.3 changes in place.
All paths relative to `src/stable/extensions/black-ide-agent/`.

**Line numbers are anchors, not contracts** — they drift; the surrounding code shapes
quoted here are how to actually locate each site.

---

## 0. Corrections to the planning doc (from deeper code reading)

Three things the higher-level plan got slightly wrong or under-scoped. These change the
implementation:

1. **B5 is a concurrency bug, not just an ordering bug.** `this._checkpoints` is a
   *single shared* `CheckpointManager` instance (`extension.ts:216`, `private readonly
   _checkpoints`). Its `pending` map (`checkpoint-manager.ts:64` `snapshot`, `:82`
   `commit` which does `this.pending.clear()`) is written by **every** executor — chat,
   each pipeline phase, each subagent — because they all receive `checkpoint:
   this._checkpoints` in their deps. With the Manager panel now allowing 4 concurrent
   pipeline runs plus a chat task, up to 5 flows snapshot into one `pending` map and the
   first `commit()` sweeps everyone's snapshots into one checkpoint under one message id.
   → **The fix is isolation, not scoped-commit:** give each pipeline run and each
   subagent its own in-memory `CheckpointManager`. This is cleaner than the planning
   doc's "filter by rootPath at commit time" and also fixes the concurrent-Manager case.

2. **B1 can't reuse the chat approval closure verbatim.** The chat `approve` closure
   (`extension.ts:1340–1363`) is *interactive*: `edit`/`create` fall through to
   `DiffContentProvider.showDiff` (a modal) and `exec`'s "ask" branch calls
   `vscode.window.showWarningMessage(..., {modal:true})`. A pipeline — especially a
   Manager-panel run with no chat surface — must not raise modals mid-run across 7
   agents. → **Two behaviors from one builder,** parameterized by `interactive: boolean`.

3. **B2 needs the resource handles hoisted.** In `_runPipelineCore`, `browserTool` and
   `mcpClient` are declared *inside* the `try` (`extension.ts:919–920`); a `finally`
   can't see them. Hoist the declarations above the `try`.

---

## 1.1 — B1: Enforce approval policy in pipeline runs 🔴 (release blocker)

**Site of the bug:** `extension.ts:949` — inside `_runPipelineCore`'s `baseDeps`:
```
log, approve: async () => true, signal, commandTimeoutMs: 120000,
```
**Reference (correct behavior):** the chat closure at `extension.ts:1340–1363`, using
`autoEdits`/`autoCreate` (`:1231–1232`), `commandPolicy` (`:1244`), and
`commandPolicy.evaluate()` (`:1352`, returns `{decision: 'allow'|'deny'|<ask>, reason}`).

**Step 1 — Extract a builder.** Add a private method on `BlackIdeChatProvider`:
```ts
private _buildApprovalGate(opts: {
  settings: any;                 // the general-settings blob
  interactive: boolean;          // true = chat (may show modals); false = pipeline
  log: (m: string) => void;
}): (req: ApprovalRequest) => Promise<boolean>
```
Behavior matrix:

| req.kind | interactive (chat) | non-interactive (pipeline) |
|---|---|---|
| `edit` | `autoEdits ? true : showDiff(...)==='Apply'` | **`true`** — worktree-isolated, reviewed at the plan gate + final diff |
| `create` | `autoCreate ? true : showDiff==='Apply'` | **`true`** — same rationale |
| `exec` | policy: allow→true, deny→(log)false, ask→modal | policy: allow→true, deny→(log)false, **ask→(log)false** |
| `mcp` | `showInformationMessage` Allow/Deny | **false** (log) — no unattended external-process calls |

Build `commandPolicy` inside the helper from `settings.commandAllowList /
commandDenyList`, with `autoApprove` = `!!settings.autoApproveTerminal` for interactive,
and `autoApprove: false` for non-interactive (a pipeline should never treat "ask" as
"yes" just because the user checked auto-approve-terminal for interactive chat — keep the
two lanes independent; this is a deliberate safety choice, document it).

**Step 2 — Use it in both callers.**
- `_runAgentTask`: replace the inline `approve` (`:1340–1363`) with
  `const approve = this._buildApprovalGate({ settings, interactive: true, log });`
  (verify `autoEdits`/`autoCreate` are consumed only there; the builder now owns them).
- `_runPipelineCore`: it already reads `generalSettings` (for `pipelineAutoOpenAllFiles`
  / `pipelinePhaseModels`). Replace `approve: async () => true` (`:949`) with
  `approve: this._buildApprovalGate({ settings: generalSettings, interactive: false, log })`.

**Executor:** no change — every exec/edit/create/mcp already routes through
`this.d.approve(...)` (`tool-executor.ts:78,106,117,125,155`).

**Test (`test/harness.js`):** `CommandPolicy` is already imported at the harness top and
the `AgentToolExecutor` is exercised in section starting `:216`. Add a section:
- Construct deps with a denying policy gate (deny-list matching `rm`), execute a
  `run_command` tool call for `rm -rf x`, assert the result `isError` and that the
  command did **not** run (the vscode-stub `ToolRunner` won't actually shell out in the
  harness, so assert on the returned error text / the gate's `false` return). Simplest:
  unit-test the extracted gate logic directly if you also export a pure
  `evaluateExecApproval(policy, command, interactive)` helper — recommended, mirrors how
  `selectExecutionPhases`/`resolveModelForPhase` were made testable.

**Docs:** README.md "Isolation" section — add one line: pipeline runs apply the command
allow/deny policy non-interactively; a command that would prompt in chat is **refused**
(logged) in a pipeline, never auto-run.

---

## 1.2 — B2: Close browser/MCP in pipeline runs 🔴

**Site:** `_runPipelineCore` — `browserTool`/`mcpClient` created at `:919–920` inside the
`try`; the method's `catch` (`:959–962`) has no `finally`. Chat's cleanup is at
`:1677–1678`.

**Fix:**
```ts
// before the try:
let browserTool: BrowserTool | undefined;
let mcpClient: MCPClient | undefined;
try {
  ...
  browserTool = new BrowserTool();
  mcpClient = new MCPClient();
  ...
} catch (e:any) { ... emit TaskFailed ... }
finally {
  try { await browserTool?.close(); } catch {}
  try { await mcpClient?.disconnectAll(); } catch {}
}
```
Add a comment: `// Mirror _runAgentTask's finally (extension.ts ~L1677) — keep in sync.`

**Test:** not automatable without an extension host. Gate on code review; the
cross-reference comment is the durable safeguard.

---

## 1.3 — B5: Isolate pipeline checkpoints 🟠 (revised approach — see §0.1)

**Do NOT** add rootPath-filtering to `commit()`. Instead isolate the store.

**Fix:** in `_runPipelineCore`, the `baseDeps` object (~`:946`) currently has
`checkpoint: this._checkpoints`. Change to a **per-run in-memory manager**:
```ts
const runCheckpoints = new CheckpointManager(); // no storageDir → in-memory (see ctor :57)
const baseDeps = { ..., checkpoint: runCheckpoints, ... };
```
- This stops all pipeline snapshots (analysis-phase live writes *and* execution-phase
  worktree writes) from polluting the shared `this._checkpoints` that chat commits.
- **Undo semantics for pipeline output (decide + document):** execution-phase changes
  reach the live workspace via `git apply` in `WorktreeManager.applyDelta` — they bypass
  the executor, so they were never checkpoint-covered anyway; **git is their undo path.**
  Analysis-phase writes (e.g. `features_plan.md`) hit the live root through the executor
  and now land in `runCheckpoints`, which is discarded at run end. For v1 that's
  acceptable (those are planning artifacts under `.blackIDE/`). If you want them
  undoable, `commit()` `runCheckpoints` scoped to rootPath at run end and surface it —
  but that is an enhancement, not required to close B5. **Recommended v1: isolate +
  discard; note git as the undo path in README.**

**Test (`test/harness.js`):** `CheckpointManager` is imported at the harness top.
- Snapshot a file via a fresh `new CheckpointManager()` (call it `runCp`) and a separate
  file via another instance (`sharedCp`). Assert committing `runCp` does not empty
  `sharedCp.pending` / does not appear in `sharedCp`'s checkpoints. This locks in the
  isolation invariant that the shared-instance bug violated.

---

## 1.4 — B6: Fix `spawn_subagent` silent work loss 🟠

**Site:** `spawnSubagent` (`extension.ts:1388–1482`). Sequence today:
`createWorktree (:1405)` → build `subDeps` from `baseDeps(undefined)` (`:1412`, carries
`checkpoint: this._checkpoints` and `approve` interactive) → `runAgentLoop (:1432,
maxLoops: 6)` → `mergeWorktree (:1456)` → `removeWorktree (:1477, finally)`.

**Two bugs here:** (a) `mergeWorktree` merges commits but nothing committed inside the
worktree → all subagent work discarded (B6); (b) subagent executor writes into the
worktree snapshot into the *shared* `this._checkpoints` (same class of bug as §1.3).

**Fix:**
1. After `createWorktree` (`:1405`), add
   `await worktreeManager.syncUncommittedChanges(branchName);` then
   `const baseline = await worktreeManager.commitWorktreeChanges(branchName, 'subagent baseline: ' + name);`
   (same reasoning as the pipeline path — the worktree must see the parent's uncommitted
   live state, and needs a real baseline commit to diff against).
2. In `subDeps` (`:1412`), override `checkpoint: new CheckpointManager()` so worktree
   snapshots don't pollute the shared store (fixes 1.3-class bleed for subagents too).
3. Replace `await worktreeManager.mergeWorktree(branchName);` (`:1456`) with:
   ```ts
   const execSha = await worktreeManager.commitWorktreeChanges(branchName, 'subagent: ' + name);
   await worktreeManager.applyDelta(branchName, baseline, execSha);
   ```
   (matches `pipeline-orchestrator.ts` `run()`'s reconciliation block — reuse, don't
   reinvent). On `applyDelta` failure, follow the pipeline's convention: leave the
   worktree in place and surface where the work is, rather than `removeWorktree` in
   `finally` discarding it — so the `finally` removal (`:1475–1481`) must be made
   conditional on success, OR wrap the reconcile in its own try that, on failure, sets a
   flag to skip removal. **Mirror the pipeline's exact error copy** so users get a
   consistent "work preserved on branch X" message.
4. `maxLoops: 6` (`:1434`) → `15` (config-driven if a setting exists; else the literal).
   6 was too small to finish real work, which masked B6.

**Test:** extend harness section `[16]` (already builds a real temp git repo and drives
the WorktreeManager lifecycle). Add: create worktree → sync → baseline commit → write a
new file *in the worktree* → exec commit → `applyDelta(baseline, exec)` → assert the file
now exists in the live root **and** the pre-existing live uncommitted edit survived
(the exact scenario B6 silently dropped).

---

## 1.5 — B4: Feed pipeline results into conversation context 🟠

**Site:** the chat wrapper `_runPipeline` (`extension.ts:842–888`). `this._conversation`
is only ever assigned in `_runAgentTask` (`:1582`). The wrapper has the needed context:
`userPrompt`, `this._activeThreadId`, and (compute) `rootPath`.

**Fix — inside `_runPipeline`, in the `try` after the `await this._runPipelineCore(...)`
resolves (so a throw skips it):**
```ts
// Give follow-up chat turns memory of what the pipeline built. Full 7-loop history
// would blow the budget; the overview is the intended compact summary.
try {
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const overviewPath = path.join(rootPath, '.blackIDE', 'overview.md');
  const summary = fs.existsSync(overviewPath)
    ? fs.readFileSync(overviewPath, 'utf8').slice(0, 4000)
    : 'Pipeline completed.';
  this._conversation.push(
    { role: 'user', content: userPrompt },
    { role: 'assistant', content: summary },
  );
  await this._historyStore.setConversationState(
    this._activeThreadId, this._pruneForPersistence(this._conversation));
  this._generateConversationTitle(userPrompt, /* modelConfig */).catch(() => {});
} catch {}
```
Notes:
- `_generateConversationTitle`'s current signature takes `(userPrompt, modelConfig)`
  (`:1328` region) — resolve `modelConfig` from `modelId` here, or refactor the title
  helper to look it up itself (cleaner; one lookup site). Confirm signature at
  implementation.
- **Only the chat wrapper** does this — Manager-panel runs (`_runPipelineInManager`) are
  not part of any chat thread; do **not** touch `_conversation` there.
- This is the honest implementation of spec F14 (currently claimed shipped, isn't).

**Test:** extract the summary construction (`readOverviewSummary(rootPath): string`) as a
pure function and unit-test the truncation + missing-file fallback in the harness. The
`_conversation` splicing itself is covered by Phase 4 integration tests.

---

## 2. Sequencing & dependencies

Mostly independent; two shared mechanisms mean a natural order:

1. **1.3 first** (introduce per-run `CheckpointManager` isolation in the pipeline) — it
   establishes the pattern 1.4 reuses. Tiny.
2. **1.4** (subagent fix) — reuses 1.3's isolation idea + the pipeline's
   commit/applyDelta sequence.
3. **1.1** (approval gate) — self-contained; the biggest review surface (security). Land
   with its own PR/commit for a clean audit trail.
4. **1.2** (resource cleanup) — trivial, can ride with any of the above.
5. **1.5** (conversation context) — self-contained, chat-wrapper only.

Ship the set together (all are release blockers per §4 of the audit), but keep 1.1 as a
distinct commit.

## 3. File-change map

| File | Change |
|---|---|
| `src/extension.ts` | `_buildApprovalGate` helper (1.1); use it in `_runAgentTask` + `_runPipelineCore`; hoist+`finally` browser/mcp close (1.2); per-run `CheckpointManager` in pipeline `baseDeps` (1.3); subagent sync+baseline+applyDelta+own checkpoint+maxLoops (1.4); conversation splice in `_runPipeline` (1.5) |
| `src/core/checkpoint-manager.ts` | none required (in-memory ctor already exists, `:57`) — only if you choose the optional scoped-commit enhancement |
| `src/agent/planning-engine.ts` | none (B7 trigger tuning is Phase 2, not here) |
| `test/harness.js` | new sections: approval-gate deny (1.1), checkpoint isolation (1.3), subagent commit→delta preservation (extend `[16]`, 1.4), overview-summary purity (1.5) |
| `README.md` | pipeline approval-policy semantics (1.1); git-as-undo-path for pipeline execution (1.3) |
| `notes/agent_plan.md` | changelog entry: Phase 1 correctness pass; correct F14 from "shipped" to "shipped in Phase 1" |

## 4. Verification (exit criteria)

```
cd src/stable/extensions/black-ide-agent
npx tsc -p . --noEmit                 # extension host: clean
(cd webview && npx tsc -p . --noEmit) # webview: clean (unaffected, but confirm)
npm test                               # all sections green incl. new 1.1/1.3/1.4/1.5
```
Manual (real VS Code extension host — cannot be done from CI yet, Phase 4 closes this):
- Configure a deny-list entry; run a pipeline whose Testing Executor would run that
  command; confirm it's refused and logged, run continues/ends cleanly.
- Run a pipeline using browser verification; confirm no orphan Chromium after completion
  (`ps` for headless chrome).
- Run a pipeline, then send a chat follow-up ("what did you just build?") — confirm the
  agent answers from context, not blindly.
- Use Manager-mode `spawn_subagent` delegation; confirm the subagent's file edits land in
  the workspace (not silently dropped).

**Done when:** all five verified fixes merged, `npm test` green with the new coverage,
docs updated, and the four manual checks pass in a live host.
