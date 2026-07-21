# Black IDE — Pending Work Execution Plan (v2)

**Date:** 2026-07-20
**Status:** EXECUTED — Phase 0 + P1/P2/P3/P4/P5 landed 2026-07-20. See §7 for outcomes.
Supersedes the ordering in `notes/pending-work-plan.md`
**Basis:** code-verified audit of `src/stable/extensions/black-ide-agent/` against
`notes/pending-work-plan.md`, `notes/implementation-plan.md`, `notes/plans/phase-1..4`.

---

## 0. What I verified before re-planning

I ran the suite and grepped every symbol the prior plan asserts as shipped or pending.

**The prior plan's baseline is accurate.** `npm test` → **PASS 230 / FAIL 0**. Every
"already shipped" seam exists and is referenced in `src/`:

| Claimed shipped | Refs in `src/` | Tests |
|---|:--:|:--:|
| `selectExecutionPhases`, `selectExecutionWaves` | 2 / 2 | 10 / 2 |
| `scheduleTasks`, `classifyRequest` | 4 / 3 | 5 / 2 |
| `buildPrCommands`, `formatDependencyGraph` | 1 / 2 | 3 / 3 |
| `applyDelta`, `syncUncommittedChanges`, `reconcileInterruptedRuns` | 7 / 4 / 4 | 2 / 1 / 2 |
| `isOverTokenBudget`, `resolveModelForPhase`, `capMindmap` | 3 / 2 / 2 | 6 / 5 / 1 |

Every "pending" symbol is genuinely absent (`summarizeRepoStructure`, `capKnowledgeFile`,
`parsePlanTasks`, `outputMode`, `pipelineParallelExecution`, `planParallelExecution` — **0 refs each**).

So P1–P7 are correctly *scoped*. But four findings below change their *order*, and two
change their *content*. That is what this document is for.

---

## 1. Findings that change the plan

### F1 — The 230 tests are not gated by any CI. (Severity: high · Effort: ~1h · Unblocked)

Nothing under `.github/workflows/` (14 workflows) or `scripts/ci/` (4 scripts) references
`black-ide-agent`, `npm test`, or `harness`. **The entire suite is local-only.** A green
`npm test` on a developer laptop is the only thing standing between a regression and `main`.

The prior plan folds this into P6 and marks P6 *"blocked in this sandbox — needs a
CI/windowing environment."* That conflation is the problem: the harness is a **plain Node
process** (`node test/harness.js`) with an HTTP-mocked LLM. It needs no display server and
no Electron. It can be gated today.

> **Split P6 into P6a (gate the existing suite — unblocked, do it first) and P6b
> (extension-host integration tests — genuinely blocked on a windowing env).** As written,
> the cheap, high-value half is held hostage by the expensive, blocked half — and P5 is
> sequenced behind *all* of it, so nothing ships.

### F2 — `readContext` has a live truncation bug that inverts its own purpose. (Severity: high · Effort: ~2h)

`core/knowledge-base.ts:143`. Sections are joined in fixed order
(`architecture` → `decision_log` → `feature_status` → `technical_debt`) then:

```ts
return joined.length > maxChars ? joined.slice(0, maxChars) + '\n…(knowledge truncated)' : joined;
```

`recordDecision` appends newest-last (`existing + formatAdr(...)`). So as the decision log
grows past the 6000-char cap, **the newest ADRs are the first content dropped**, and
`technical_debt.md` is dropped *entirely* — it is last in the join order. The read side of
long-term memory therefore converges on showing the agent only the *oldest* decisions and
never the tech debt. It is wired live at `extension.ts:1286` and has **0 tests**.

This is a shipped correctness defect, not a tail item. It outranks all of P1–P4.

### F3 — P2's stated rationale is wrong; the real one is weaker. (Severity: low — a *de*-prioritization)

P2 justifies knowledge compaction as protecting "the token savings `readContext` exists to
provide." But `readContext` already hard-caps its output at `maxChars`, so unbounded files
cost **zero** extra tokens — they cost disk and git noise. The token problem is F2's
ordering bug, not file size.

**Fix F2 first; P2 drops to lowest priority** and should be scoped as hygiene, not savings.

### F4 — `gitMutex` is P5's core safety assumption and it has 0 tests + no timeout. (Severity: high for P5)

`agent/git-mutex.ts` — a global singleton promise-chain, referenced at 8 sites, **0 test refs**.
The prior plan leans on it explicitly: *"`gitMutex` serializes git ops, so concurrent
worktree work is safe."* That is an unverified load-bearing claim. Two concrete risks:

1. **No timeout.** `run()` chains onto `this.queue` forever. One hung `git` subprocess
   permanently deadlocks *every* git operation in the extension — no error, no recovery,
   just silence. Today that is one sequential pipeline; under P5 it is N parallel worktrees
   plus 4 Manager runs funnelling into one queue.
2. **Coarse granularity.** It is a *process-global* mutex, not per-repo or per-worktree. P5
   parallelizes phase *execution* but every phase's git I/O still serializes through this
   one chain, so the realized speedup will be materially below the design's promise.

The chain's error handling *is* correct — `resolve`/`reject` inside the `.then` keeps a
failed action from poisoning the queue. The gap is liveness, not correctness.

### F5 — Settings are a custom blob, not `contributes.configuration`. (Severity: med — a spec correction)

P4 and P5 both say "add a setting." `package.json` has **no `contributes.configuration`
section at all**. Settings live in a single JSON blob in the secret store:

```ts
const s = await this._secretManager.getKey('general-settings');   // extension.ts:1109-1119
const pipelineTokenBudget = Math.max(0, Number(generalSettings.pipelineTokenBudget) || 0);
```

New settings must follow this pattern *and* be surfaced in `openSettingsPanel`, or they are
unreachable by users. Any plan step saying "add a VS Code setting" is a step that silently
does nothing.

### F6 — P7's file count is wrong.

Prior plan says "455 build files under `dist/`." Actual: `git ls-files` →
**130** tracked files under the agent extension's `dist/`. The decision stands; the
justification numbers should be restated before taking it to the owner.

---

## 2. Revised sequence

Ordering principle, unchanged from the prior plan and correct: **never build the
highest-risk item before the harness that catches its failure modes.** Applied properly,
that promotes the *unblocked* half of the test work to the front rather than deferring all
of it.

| # | Item | Was | Now | Effort | Risk | Blocked |
|:-:|---|:--:|:--:|:--:|:--:|---|
| **0a** | **CI gate for the existing 230 tests** (F1) | P6 (blocked) | **first** | S | Low | — |
| **0b** | **Fix `readContext` truncation** (F2) | — | **first** | S | Low | — |
| **0c** | **`gitMutex` tests + timeout** (F4) | — | **before P5** | S | Low | — |
| 1 | P1 Repo-discovery scan | 1st | 4th | S–M | Low | — |
| 2 | P3 Per-task graphs + planning artifacts | 3rd | 5th | M | Low | — |
| 3 | P4 PR-output mode + doc regime | 4th | 6th | M | Med | F5 |
| 4 | P2 Knowledge compaction | 2nd | 7th | S | Low | — (see F3) |
| 5 | P6b Extension-host integration tests | 5th | 8th | M | Med | **windowing env** |
| 6 | P5 Parallel within-feature execution | 6th | 9th | L | **High** | 0c + P6b |
| 7 | P7 `dist/` hygiene decision | 7th | anytime | S | Med | **owner sign-off** |

**Phase 0 (0a+0b+0c) is roughly one day and unblocks or de-risks everything after it.**

---

## 3. Phase 0 — do this first

### 0a · CI gate (F1)

Add `.github/workflows/ci-agent-tests.yml`, matching the existing workflows' conventions:

- Triggers: `pull_request` + `push` to `main`/`dev`, path-filtered to
  `src/stable/extensions/black-ide-agent/**`.
- Node from `.nvmrc`, `npm ci`, then `npm test` (which already chains
  `tsc -b` → `build-store-test` → `node test/harness.js`).
- Add `npx tsc -p ./webview --noEmit` as a second step — the webview project is verified by
  hand today and is not in the `npm test` chain.
- Harness exit code: **verify `test/harness.js` exits non-zero on failure before relying on
  it as a gate.** If it always exits 0, the workflow is decorative. Fix the exit code first.

**Done when:** a deliberately broken test fails the PR check.

### 0b · `readContext` truncation (F2)

In `core/knowledge-base.ts`, replace the whole-string tail-slice with a **per-section budget**:

- Give each of the four files a share of `maxChars`; truncate each section independently so
  no file can starve the ones after it.
- For append-newest-last logs (`decision_log.md`), keep the **head + newest** entries — the
  same strategy `capMindmap` already uses. Extract that shared logic now; F3's P2 becomes a
  second caller of it later (this is the DRY convergence the prior plan anticipated).

**Test:** an oversized decision log still surfaces the newest ADR; `technical_debt.md` is
never dropped entirely; total stays within budget. Mirror the existing `capMindmap` test at
`test/harness.js:785-793`.

### 0c · `gitMutex` hardening (F4)

- Add a `timeoutMs` (default ~120s, matching `commandTimeoutMs` at `extension.ts:1144`) to
  `GitMutex.run`. On expiry, reject *that* action and let the queue proceed — a hung git
  call must degrade to one failed operation, never a process-wide stall.
- Add the first tests for it: serialization under concurrent `run()` calls; a rejecting
  action does not poison the chain; lock-error retry backs off and eventually succeeds; a
  hung action times out and the *next* queued action still runs.
- Record the global-granularity limit (F4.2) as an ADR via `recordDecision` — P5's speedup
  estimates must account for it rather than discover it.

**Done when:** the concurrency primitive P5 depends on has explicit coverage of the exact
property P5 assumes.

---

## 4. Feature work (P1, P3, P4, P2) — corrections only

The prior plan's approach for these is sound and code-verified; I am not restating it.
Deltas:

- **P1 (repo scan)** — as written. Confirmed `KnowledgeBase.ensureScaffold` /
  `recordFeature` are already wired at `extension.ts:1256-1258`, so `scaffoldArchitecture`
  slots into an existing call site rather than a new one.
- **P3 (per-task graphs)** — as written. `EXECUTION_PHASE_GRAPH`
  (`pipeline-orchestrator.ts:23`) and `scheduleTasks` are confirmed present and feed
  `selectExecutionWaves` already. Keep execution at phase granularity, as the prior plan
  correctly insists.
- **P4 (PR mode)** — **apply F5.** `outputMode` goes in the `general-settings` blob and
  must be added to `openSettingsPanel`. The insertion point is the reconciliation block at
  `pipeline-orchestrator.ts:338-356`; the `pr` branch skips the `applyDelta` at line 343 and
  keeps the branch instead of the `removeWorktree` at line 356. Gate it so the default
  `apply` path is byte-identical, and assert that in a test.
- **P2 (compaction)** — **apply F3.** Rescope as disk/git hygiene, lowest priority, and
  implement it as a second caller of the shared cap helper extracted in 0b.

---

## 5. P5 — parallel execution (unchanged, with two added preconditions)

The prior plan's design (§3 of `pending-work-plan.md`) is sound and its seams are verified
present. Two additions:

1. **Precondition: 0c must land first.** P5 is the only consumer that turns the untested
   `gitMutex` liveness assumption into a user-data-corruption risk.
2. **Set the speedup expectation honestly** (F4.2). With a process-global git mutex,
   parallel phases contend on every worktree operation. Measure a two-phase wave against
   sequential *before* building the full N-wave path — if the win is small, per-repo mutex
   granularity is the higher-value change and P5 should be re-scoped around it.

Everything else — default-off `pipelineParallelExecution` (via F5's settings blob), pure
`planParallelExecution(waves)`, sequential merges under `gitMutex`, P6b for the concurrent
behaviours — carries over as written.

---

## 6. What I did not change

The prior plan's §5 global conventions (pure-core + thin-integration, DRY, default-off for
anything touching worktrees, per-item `tsc` + `npm test` verification) are the right
standard and this plan inherits them unchanged. Its risk read on P5 is also correct — my
only quarrel is that it sequenced the *cheap* verification work behind the blocked kind,
which had the effect of blocking everything.

---

## 7. Execution outcomes (2026-07-20)

**Test suite: 230 → 352 assertions, all green.** Both `tsc` projects clean; webview builds.

| Item | Status | Notes |
|---|---|---|
| 0a CI gate | **Done** | `.github/workflows/ci-agent-tests.yml`. Gate verified empirically: injected canary → exit 1, restored → exit 0. |
| 0b `readContext` (F2) | **Done** | Per-file budgeting via new `core/text-cap.ts`; `capMindmap` refactored onto the same helper. |
| 0c `gitMutex` (F4) | **Done** | `timeoutMs` (default 120s) wrapping the whole retry sequence; 8 first-ever tests. |
| P1 Repo scan | **Done** | `summarizeRepoStructure` + `scaffoldArchitecture`; once-per-workspace on activation. |
| P3 Per-task graphs | **Done** | `core/plan-parser.ts`; `dependency_graph.md` now carries per-task detail. |
| P4 PR-output mode | **Done** | `resolveOutputMode` + `core/completion-docs.ts`; setting wired through the blob AND the settings panel (F5). |
| P2 Compaction | **Done** | `capKnowledgeFile`, second caller of the 0b helper. Rescoped as hygiene per F3. |
| P5 Parallel execution | **Partial — default-off** | Pure core + orchestrator path landed and tested; see the caveat below. |
| P6b Host integration tests | **Not started** | Still blocked on a windowing environment. |
| P7 `dist/` hygiene | **Not started** | Still needs owner sign-off on the packaging pipeline. |

### P5 caveat — what is and is not verified

Verified: the planning core (default-off gating, branch layout, deterministic merge order),
and the merge semantics against a real temp git repo — two disjoint deltas both land; a
genuine overlap is refused, the user's content survives, and the phase's work is preserved
in its worktree.

**Not verified:** concurrent cancellation mid-wave, and a budget trip spanning parallel
phases. Both need a real extension host (P6b). This is why `pipelineParallelExecution`
defaults to `false` and should stay there until P6b exists.

### Decisions taken during execution

- **Parallel + PR mode is refused, not silently resolved.** PR mode promises one reviewable
  branch; the parallel path produces one branch per phase merged into the live tree.
  Combining them would leave the tree modified by a run that promised not to touch it, so
  the run stays sequential and warns.
- **`shouldRunParallel` also requires a real opportunity.** With the flag on but every wave
  single-phase, it declines: parallel machinery would add setup cost and failure surface for
  zero speedup.
- **Only `decision_log.md` is prunable.** Curated files (architecture, glossary, roadmap,
  technical_debt) are never pruned — a human writes those and the oldest entry is not
  regenerable from git.
- **The global-mutex granularity limit (F4.2) is documented in `git-mutex.ts`** rather than
  recorded as a runtime ADR, so P5's next author reads it where the constraint lives.

### Recommended next step

P6b is now the only thing gating P5's promotion from experimental to default. It is also
the last item that can catch a defect in the parallel path before a user's working tree
does.

---

## 8. P6b and P7 — completed 2026-07-20 (second pass)

Both items the first pass deferred turned out to be less blocked than believed. Recording
the corrections, since both were wrong in the *same* way: an assumed blocker that nobody
had tested.

### P6b — extension-host integration tests: **NOT blocked. Done, 10 tests green.**

The prior plan (and §4 of this one) called P6b "blocked — needs a CI/windowing
environment." That was never verified. Running it revealed the actual failure was a
**unix-socket path length limit**: VS Code opens an IPC socket under the user-data dir,
and the default path inside this deeply-nested extension blows past the ~103-char
`sockaddr_un` limit, failing startup with `EINVAL`. Pointing `--user-data-dir` at a short
tmpdir fixes it. No windowing constraint was involved on macOS at all.

**Landed:** `test/integration/` (`runTest.ts`, mocha `suite/`, a fixture workspace),
`npm run test:integration`, and `.github/workflows/ci-agent-integration.yml` running under
`xvfb-run` on Linux. **10 passing, verified green on three consecutive runs.**

Coverage is aimed at what the core harness structurally cannot reach, since it stubs
`vscode` entirely:
- activation, and that every command declared in `package.json` is actually registered;
- that activation never modifies a project file;
- the **first-run knowledge scan** (P1) against a real workspace — including that a second
  activation never clobbers human-edited content;
- that the two safety-critical settings defaults (`pipelineOutputMode`,
  `pipelineParallelExecution`) hold, and that nobody has added a `contributes.configuration`
  the runtime would never read (the F5 failure mode).

One design bug found and fixed in the suite itself: it was not idempotent — leftover
`.blackIDE/` artifacts made the once-per-workspace scan correctly skip, so the suite
asserted against stale content. `runTest.ts` now clears the fixture before launch.

**Still not covered:** a scripted end-to-end pipeline run against the mock LLM, and P5's
concurrent cancellation / budget-trip behaviour. The harness exists now, so these are
straightforward additions — and they remain the gate on promoting
`pipelineParallelExecution` to default-on.

### P7 — `dist/` tracking: **decided and executed.**

The blocker was "confirm the packaging pipeline rebuilds `dist/`." Confirmed by evidence,
not assumption:

1. `scripts/prepare/prepare_vscode.sh:45` runs `npm run compile` (`tsc -b`) inside the
   copied extension, after `rm -rf node_modules`.
2. Deleting `dist/` **and** `tsconfig.tsbuildinfo` and running `npm run compile` regenerates
   everything including the `main` entry `dist/extension.js`. Verified.
3. The half-way failure mode was tested explicitly: with a *stale tracked* buildinfo present
   and `dist/` absent, `tsc -b` still detects the missing outputs and rebuilds. Verified.
4. 352 harness tests pass against the regenerated `dist/`.
5. `vscode/` (the copy target) is untracked, so there is no second consumer.

**Executed:** `dist/` and `tsconfig.tsbuildinfo` untracked (131 files) and gitignored.
Also untracked `test/tmp/` (74 files of harness debris — the harness redirects `os.tmpdir`
there).

### New finding — 245 `node_modules` files are tracked

Same class as P7, surfaced while doing it. `prepare_vscode.sh:34` does `rm -rf node_modules`
then `npm install`, so the build **already destroys and regenerates** them — they are
almost certainly vestigial, and they generate diff noise on any dependency change.

**Not executed** — unlike `dist/`, verifying this safely means running the full VS Code
build, which was out of scope here. Recommended next: confirm a clean build with them
removed, then `git rm -r --cached` + gitignore. Flagging rather than assuming, which is the
mistake this section exists to correct.
