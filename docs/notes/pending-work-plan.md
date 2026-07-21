# Black IDE — Pending Work Plan

**Author:** Senior Software Architect
**Date:** 2026-07-19
**Status:** ✅ SUPERSEDED / COMPLETE — all of P1–P7 shipped 2026-07-20.
See `notes/execution-plan-v2.md`, which re-audited this plan against the code, corrected
its ordering (P6 was split; the CI half was never blocked), and records what landed.
Kept as the historical scoping record — its P1–P7 breakdown was correct.
**Original status:** FOR EXECUTION
**Companion docs:** `notes/implementation-plan.md` (the full unified roadmap) ·
`notes/agent_plan.md` (as-built changelog) · `notes/futureplan.md` (audit)

---

## 0. Purpose & baseline

This is the single, execution-ready plan for **everything still pending** after the
foundation (Phase 1 + Phase A) and the vision cores/extensions (B/C/D/F) shipped. It
does not re-plan what's done; it sequences what's left, with verified code seams, exact
new/changed files, test strategy, and risk notes.

**Current baseline (all done, verified):**
- Phase 1 correctness (B1/B2/B4/B5/B6); Phase A (B3 budget+cost, B7 trigger, B8 minors,
  durability `core/pipeline-runs.ts`, telemetry `core/telemetry-sink.ts`).
- Vision cores: `PlanningEngine.classifyRequest` (C), `core/knowledge-base.ts` (B),
  `core/task-scheduler.ts` (D). Extensions: `detectMissingRequirements` (C),
  `KnowledgeBase.readContext` (B), `formatDependencyGraph`/`dependency_graph.md` (D),
  `core/git-pr.ts` + ADR capability (F).
- **230 harness tests green**, both `tsc` projects clean, webview builds.

All paths below are relative to `src/stable/extensions/black-ide-agent/`.

---

## 1. Pending items at a glance

| # | Item | Phase | Size | Risk | Blocked on |
|:-:|------|:-----:|:----:|:----:|-----------|
| P1 | Knowledge repo-discovery scan (first-run) | C | S–M | Low | — |
| P2 | Knowledge compaction (per-file size cap) | B | S | Low | — |
| P3 | Per-task dependency graphs + richer planning artifacts | D | M | Low | — |
| P4 | PR-output **mode** wiring + full doc regime | F | M | Med | — |
| P5 | **Parallel within-feature execution** | E | L | **High** | integration tests (P6) |
| P6 | Extension-host integration tests + CI gate | A | M | Med | CI/windowing env |
| P7 | `dist/` tracking hygiene decision | A | S | Med | owner + packaging confirm |

**Recommended order:** P1 → P2 → P3 → P4 (low-risk, self-contained, each shippable), then
P6 (unblocks P5's verification), then P5 (behind a default-off setting), and P7 whenever
the owner confirms the packaging pipeline. Rationale: never build the highest-risk item
(P5) until the test harness that can catch its failure modes (P6) exists.

---

## 2. Low-risk tails (P1–P4) — do these first

### P1 — Repository-discovery scan (Phase C)
**Goal:** on first use in a workspace, populate the knowledge base's `architecture.md`
from the actual project, so the read-side (`KnowledgeBase.readContext`, already shipped)
has real content to inject.

**Approach (reuse, don't reinvent):**
- Add a pure `summarizeRepoStructure(files: string[], pkgJson?: object): string` to
  `core/knowledge-base.ts` — groups files by top-level dir, notes entry points, detected
  framework/stack from `package.json` deps. Pure → unit-testable.
- Add `KnowledgeBase.scaffoldArchitecture(summary: string)` that writes it into
  `architecture.md` only if that file is still the seeded header (never overwrite
  human/agent edits).
- Wire a one-time scan in `extension.ts` — reuse `CodebaseIndex`/`vscode.workspace.findFiles`
  (already used elsewhere) to get the file list; call on activation if
  `.blackIDE/knowledge/architecture.md` is unseeded. Guard with a workspace-scoped
  `globalState` flag so it runs once.

**Test:** `summarizeRepoStructure` against a synthetic file list + package.json → asserts
grouping, stack detection, entry-point call-out.

### P2 — Knowledge compaction (Phase B)
**Goal:** the append-only knowledge files (esp. `decision_log.md`, `feature_status.md`)
must not bloat away the token savings `readContext` exists to provide — the same concern
the mindmap already solved with `PipelineOrchestrator.capMindmap`.

**Approach:** add a pure `capKnowledgeFile(content, maxBytes)` to `core/knowledge-base.ts`
mirroring `capMindmap`'s strategy (preserve head + newest entries, drop oldest, add a
"pruned; full history in git" notice). Apply it in `KnowledgeBase.writeFile` for the
log-style files. **DRY note:** consider extracting the shared cap logic used by both
`capMindmap` and `capKnowledgeFile` into one helper if they converge.

**Test:** oversized decision log caps under budget, keeps newest ADRs + header, drops
oldest, adds notice (mirror the existing `capMindmap` test).

### P3 — Per-task graphs + richer planning artifacts (Phase D)
**Goal:** move dependency-aware scheduling from per-*phase* to per-*task*, and emit the
remaining `plan.md` planning docs.

**Approach:**
- Add `parsePlanTasks(planContent): SchedulableTask[]` (pure, in `pipeline-orchestrator.ts`
  or a new `core/plan-parser.ts`) that extracts `- [ ]` tasks under each `[tag]` phase and
  assigns cross-phase dependencies from `EXECUTION_PHASE_GRAPH` (a task depends on all
  tasks in prerequisite phases). Feed through the existing `scheduleTasks`.
- Emit `risk_analysis.md`, `api_contract.md`, `database_plan.md` as **prompted artifacts**
  from the Architect/Engineer phases (richer mode prompts + `create_artifact`), reusing the
  existing artifact machinery — this is prompt+output work, not new plumbing.

**Test:** `parsePlanTasks` on a sample plan → correct task list + dependency edges; the
scheduler orders them correctly.

**Note:** per-task *execution* (each task as its own agent call) would multiply cost — keep
execution at phase granularity; the per-task graph informs ordering/parallelism, not a
per-task LLM call, unless P5 uses it.

### P4 — PR-output mode + doc regime (Phase F)
**Goal:** let a completed pipeline open a PR instead of applying to the live tree, and
auto-maintain the completion doc set. Command builders (`core/git-pr.ts`) already exist and
are tested.

**Approach:**
- Add an `outputMode: 'apply' | 'pr'` to the pipeline (setting + optional Manager-panel
  toggle). In `PipelineOrchestrator.run()`'s reconciliation block, when `pr`: **skip
  `applyDelta`**, keep the branch, and run `buildPrCommands(...)` through `ToolRunner` under
  `gitMutex` (check `gh` availability; fall back to `compareUrlFallback` → open the URL).
  The worktree/branch already holds the committed work, so this is a branch-off, not a
  re-diff.
- On completion, write `CHANGELOG.md` / `RELEASE_NOTES.md` / `PROJECT_OVERVIEW.md` entries
  — reuse the `generateOverview` pattern + `KnowledgeBase` (a pure formatter per doc, tested).

**Test:** the PR-command path is already covered; add a test for the `apply` vs `pr` branch
decision (pure predicate) and the doc formatters.

**Risk (Med):** the `pr` path changes the reconciliation flow — gate behind the setting so
the default `apply` path is untouched; add a harness test that `apply` mode still calls
`applyDelta` and `pr` mode does not.

---

## 3. P5 — Parallel within-feature execution (Phase E) — the large one

**Goal:** run a dependency wave's phases **concurrently**, each in its own worktree, then
join their (disjoint) deltas — `plan.md`'s "parallel specialized teams". This is the
competitive frontier vs Cursor/Antigravity and the single biggest remaining feature.

**Why it's last and highest-risk:** it mutates how execution touches git worktrees, and a
defect can corrupt the user's working tree. It **must not** ship without the P6 integration
tests, and **must** be behind a default-off setting so the proven sequential path stays the
default until the parallel path earns trust.

**Verified seams already in place:**
- `selectExecutionWaves(planContent)` → `string[][]` (parallelizable waves).
- `worktreeManager.createWorktree / syncUncommittedChanges / commitWorktreeChanges /
  applyDelta / removeWorktree` — the full per-worktree lifecycle.
- `gitMutex` serializes git ops, so concurrent worktree *work* is safe and the *merges*
  are serialized.
- The pipeline already runs execution in a worktree with baseline→execution→`applyDelta`.

**Design (per wave):**
1. For each phase in the wave, create its **own** worktree off the current live state,
   `syncUncommittedChanges`, commit a per-phase baseline.
2. Run the wave's phases **concurrently** (`Promise.all`) — each its own `runPhase` +
   executor + worktree root. Share the run's abort/budget signal.
3. After the wave, for each phase: commit execution, `applyDelta(baseline→execution)` onto
   live **sequentially under `gitMutex`**. Disjoint deltas (design=CSS, backend=API) apply
   cleanly; a genuine overlap surfaces the existing "preserve worktree, report" path.
4. The next wave syncs from the now-updated live state. `removeWorktree` per phase.

**Setting:** `pipelineParallelExecution` (default `false`). When off, the current
sequential single-worktree path runs unchanged.

**Test strategy (needs P6 for the real thing):**
- Pure: a `planParallelExecution(waves)` scheduler-shaped function → unit-testable.
- Harness (real temp git repo, extend section [16]): two disjoint deltas applied
  sequentially both land; an overlapping delta triggers the preserve-and-report path.
- Full concurrent behavior (cancellation mid-wave, budget trip across parallel phases):
  **integration test only (P6)**.

**Effort:** L. Treat as its own PR after P6.

---

## 4. Infra / owner decisions (P6, P7)

### P6 — Extension-host integration tests + CI gate (Phase A)
**Goal:** the ~2000-line `extension.ts` glue and the webviews have no automated coverage;
the Manager panel and the P5 parallel path can only be validated in a real host.

**Approach:** adopt `@vscode/test-electron` (patterns exist under `vscode/test/`). Minimum
suite: activate → chat task against the mock LLM (reuse `test/harness.js`'s HTTP mock) →
pipeline with scripted phases → Manager concurrent runs → reload-recovery. Wire a CI job
(`scripts/ci/`). **Blocked in this sandbox** — needs a CI/windowing environment; the suite
is designed, it just can't run here.

### P7 — `dist/` tracking hygiene (Phase A)
**Decision, not a blind change:** 455 build files under `dist/` are tracked and the
extension's `main` is `./dist/extension.js`. Removing them from git is only safe once the
packaging/CI pipeline is confirmed to rebuild `dist/` (`npm run compile`). Action: confirm
that, then `git rm -r --cached dist/` + add to `.gitignore`, or leave as-is and document
why. *(`continue/`, `.DS_Store`, `VSCode*` are already gitignored — no action.)*

---

## 5. Global conventions (apply to every item)

- **Pure-core + thin-integration:** the algorithmic heart of each item goes in a
  vscode-free module with harness tests (the pattern used throughout: `selectExecutionPhases`,
  `resolveModelForPhase`, `isOverTokenBudget`, `reconcileInterruptedRuns`,
  `scheduleTasks`, `classifyRequest`, `buildPrCommands`). Integration in `extension.ts` /
  the orchestrator stays thin.
- **DRY:** reuse `capMindmap`-style capping, the worktree lifecycle, the artifact writers,
  the approval gate, `TokenTracker`. Extract a shared helper when two call sites converge.
- **Safety:** anything touching git worktrees or the live tree is default-off until
  integration-tested. Cost-bearing additions respect the `pipelineTokenBudget` guard.
- **Verification per item:** `npx tsc -p . --noEmit` + `npx tsc -p ./webview --noEmit` +
  `npm test` green, with new harness sections; update `notes/implementation-plan.md` and the
  `notes/agent_plan.md` changelog.

---

## 6. Suggested sequencing summary

1. **P1, P2, P3, P4** — low-risk, self-contained, each independently shippable and tested.
2. **P6** — stand up integration tests in CI (unblocks trustworthy P5).
3. **P5** — parallel execution, behind `pipelineParallelExecution=false`, PR of its own.
4. **P7** — `dist/` decision, whenever the owner confirms the packaging pipeline.

Each of P1–P4 is a clean, reviewable unit; none depends on the others. Start anywhere in
that group; do P5 last.
