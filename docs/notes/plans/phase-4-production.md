# Phase 4 — Production Operations & Competitive Positioning

**Source:** `notes/futureplan.md` §4 (blockers 4, 6, 7) + §1 competitive gaps.
**Depends on:** Phases 1–3. This phase is what turns "hardened beta" into "shippable
product" and adds the two capabilities where Cursor/Antigravity still lead.

---

## 4.1 Extension-host integration tests (closes audit blocker 4)

The 150-test harness covers the core runtime; the ~2000-line `extension.ts` glue and the
webviews have zero automated coverage, and the Manager panel has never run in a live
extension host.

- Adopt `@vscode/test-electron` (the standard — `vscode/test/` in this repo shows the
  upstream patterns). Minimum viable suite:
  1. Activate extension, open chat view, send a trivial prompt against a mock LLM server
    (reuse `test/harness.js`'s HTTP mock — it already speaks all 4 provider protocols).
  2. Trigger a pipeline with a mock that returns scripted phase outputs; assert
    approval card appears; approve; assert overview.md exists.
  3. Open Pipeline Manager (`black-ide.openPipelineManager`); start 2 concurrent runs;
    cancel one; assert statuses.
  4. Reload window mid-run; assert Phase 3's recovery card.
- Wire into CI (`scripts/ci/` exists for the product build; add an extension-test job).
  Gate PRs on harness + integration suite.

## 4.2 Agent telemetry (closes audit blocker 6)

`wiki_docs/Telemetry.md` covers editor telemetry only. The agent runtime needs operational
signals — and the typed EventBus (`core/event-bus.ts`) means this is a **subscriber, not
a rewire**:
- New `TelemetrySink` subscribing via `bus.onAny`: counts and durations for
  TaskCompleted/TaskFailed, PipelinePhaseError rates by phase, TokenUsage aggregates,
  worktree reconciliation failures.
- Respect the existing `allowAnonymousTelemetry` setting; no prompts, no file contents,
  no paths — counts, durations, model *types* only. Document in `wiki_docs/Telemetry.md`.
- Local-first: write to a rotating JSONL in extension storage even when remote telemetry
  is off, so users can self-diagnose ("why did my pipeline fail") — surfaced via a
  "Export diagnostics" command.

## 4.3 Background-capable runs (competitive: Cursor cloud agents / Antigravity scheduled)

Full cloud VMs are out of scope for this codebase's architecture. The achievable ladder:
1. **(Phase 3 delivered)** runs survive reload via recover-or-report.
2. **Detached-process runs:** extract the pipeline core into a standalone Node entry
   point (`black ide-cli` already exists as a product surface — `vscode-cli/black-ide`)
   that runs a pipeline headless against a workspace path, writing the same
   `.blackIDE/` artifacts and a run-state JSONL the extension's Manager panel can tail.
   The Manager panel gains a "run in background" toggle → spawns the CLI detached; the
   run then survives even *closing the IDE*. The worktree isolation from 2.1 is what
   makes this safe — the detached run never touches the live tree until reconciliation.
3. **(Later / optional)** remote execution — only worth designing after (2) proves demand.

**Scheduled runs:** `AgentScheduler` (`agent/scheduler.ts`) already does one-shot +
recurring timers and is barely used — wire a "schedule pipeline run" action (Manager
panel) through it for Antigravity-style scheduled tasks. Cheap once (2) exists.

## 4.4 PR-generation output mode (competitive: Cursor background agents open PRs)

After a pipeline's execution succeeds, offer "Create branch + PR" instead of
apply-to-live: the work is *already on a git branch* (`pipeline-<ts>`) before
`applyDelta` — this mode simply skips reconciliation, pushes the branch, and opens a PR
(gh CLI if available, else compare-URL). Small delta over existing worktree machinery;
high perceived-parity value.

## 4.5 Repo hygiene (closes audit blocker 7)

- Decide `continue/`'s fate: extract to a submodule/removed-with-README-pointer, or
  document its purpose + Apache-2.0 attribution in `ThirdPartyNotices`. It is referenced
  by no build script today.
- Stop tracking `src/stable/extensions/black-ide-agent/dist/` build output (currently
  committed and churning in every agent-extension PR); build in CI/packaging instead.
  Note: the top-level `.gitignore`'s `VSCode*` pattern already caused one silent-ignore
  incident (`vscode-api.ts`, 2026-07-19) — audit the ignore file's broad patterns while
  in there.
- Remove `.DS_Store`, `package.json.bak`, `product.json.bak` from tracking.

---

**Exit criteria:** CI runs harness + integration suite on every PR; failure-rate and
token-spend dashboards possible from telemetry JSONL; a pipeline run can outlive the IDE
window; a pipeline result can land as a PR; repo contains no unreferenced vendored
product or committed build output.
