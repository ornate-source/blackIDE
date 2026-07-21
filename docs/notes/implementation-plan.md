# Black IDE — Unified Implementation Plan

**Author:** Senior Software Architect
**Date:** 2026-07-19
**Status:** FOR REVIEW
**Reconciles:** `notes/plan.md` (product vision) · `notes/futureplan.md` (engineering audit) ·
`notes/plans/phase-1..4` (hardening phases) · `notes/agent_plan.md` (as-built pipeline record)

---

## 0. Purpose & how to read this

There are three planning documents in this repo pulling in different directions. This is
the one plan that reconciles them into a single ordered roadmap you can approve and
execute against. It is a **decision document** — scan §1–§4 to understand the shape,
read §5 for the feature-by-feature mapping, and use §8 to sign off.

The central judgment call, stated up front so you can challenge it:

> **`notes/plan.md` describes a 10/10 destination. The current product is a 6/10 that
> only reached "correct" this session. We sequence the destination onto a trustworthy
> foundation, deliver the vision as value-gated capabilities (not an org-chart of 30
> literal agents), and refuse to add ambition on top of unmeasured cost or unverified
> reliability.**

If you disagree with that framing, stop here and tell me — everything below follows from it.

---

## 1. The three inputs, reconciled

| Source | What it is | What it gets right | The gap it ignores |
|---|---|---|---|
| `plan.md` | Aspirational "AI Software Agency OS" — departments, requirement discovery, long-term memory, dependency/sprint planning, ADRs, ~13 deliverable docs | The *right north star*: business-before-code, plan-before-implementation, persistent knowledge, quality gates. Much of it maps to machinery that already exists. | Says nothing about cost, latency, reliability, or testing the agent runtime itself. Taken literally (30 agents/run) it is slow, expensive, and amplifies today's bugs. |
| `futureplan.md` | Engineering audit — bugs B1–B8, production-readiness verdict, competitive analysis | Ground truth on what's broken/missing. Correctly calls the product a "strong beta, not production." | Scoped to fixing what exists; not a vision for what the product becomes. |
| `plans/phase-1..4` | Hardening roadmap derived from the audit | Correct near-term sequence: correctness → observability → durability → production ops. | Phase 1 is now **done** (this session); the docs predate that. |

**Resolution:** the audit/hardening work is the *foundation*; `plan.md` is the *superstructure*.
This plan runs them as one sequence — foundation first, then the vision in increments that
each stand on their own.

---

## 2. Current state (honest baseline — what is actually built)

**Working today:**
- 7-agent sequential pipeline: Architect(HLD) → Sr Engineer(LLD) → Planner → *approval* →
  Design → Backend → Frontend → Testing. Auto-triggered on substantial requests.
- Worktree isolation with diff-based reconciliation (`applyDelta`); browser self-verification
  (Testing Executor); per-phase model selection; in-chat approval gate.
- **Pipeline Manager panel** — up to 4 concurrent isolated runs.
- **Long-term memory seed**: `KnowledgeStore` (`save`/`search`/`getRelevantContext`) + the
  OpenSpec mindmap (`.blackIDE/mindmap/project_mindmap.md`) + `features_plan.md` + `overview.md`.
- 15 builtin modes (incl. Manager, Sr Architect, Frontend, Backend, DevOps as personas).
- 156-test core harness; signed packaging.

**Fixed this session (audit Phase 1 — was the release-blocker set):**
- B1 command-approval policy now enforced in pipelines · B2 resource-leak closed ·
  B5 checkpoint isolation · B6 subagent silent-work-loss · B4 pipeline→conversation context.

**Still open (from the audit):** B3 no per-pipeline token/cost visibility · B7 over-trigger ·
B8 minors · no durability across reload · `extension.ts` glue untested · no agent telemetry ·
repo hygiene (vendored `continue/`, committed `dist/`).

**Read:** the foundation is now *correct* but not yet *trustworthy at scale* (unmeasured cost,
unverified reliability, no durability). That is exactly the gap Phase A closes before any
`plan.md` expansion.

---

## 3. Guiding architectural decisions

These are the load-bearing calls. Each is a place you can redirect the whole plan.

**D1 — Capabilities, not org-theater.** `plan.md`'s value is in ~6 capabilities (persistent
memory, smart intake, richer planning, dependency-aware execution, quality loop, docs
regime), not in literally instantiating 30 role-agents. Each extra agent is an LLM turn:
latency + cost + more failure surface. We deliver the *capability* with the *fewest agents
that produce it*, and add roles only where a distinct persona measurably improves output.

**D2 — Foundation before superstructure.** No vision phase starts until Phase A's cost
visibility + durability + integration tests land. Building the agency on an unmeasured,
non-durable runtime just makes outages bigger and pricier.

**D3 — Reuse the machinery that exists.** The mindmap, `KnowledgeStore`, artifact writers,
worktree isolation, approval gate, and event bus already implement slices of `plan.md`.
Most vision work is *extension*, not greenfield. §5 marks reuse-vs-new per feature.

**D4 — Every agent turn must be paid for and visible.** A cost budget and a token meter are
prerequisites (Phase A), not afterthoughts, precisely because `plan.md` multiplies agent
count. A per-run budget cap is the guardrail that makes ambition safe.

**D5 — Artifacts are the interface, not conversation.** `plan.md`'s power is its document
set (`architecture.md`, `risk_analysis.md`, `decision_log.md`…). We standardize on files
under `.blackIDE/` that both agents and the user read/edit — this is also how memory,
review, and durability all get cheaper.

**D6 — Human approval stays a hard gate, and gets richer, not more frequent.** More planning
depth (D-phase) must not mean more modals. One review surface, more content in it.

---

## 4. The unified roadmap

Six phases. Each has a **value gate** — a reason it's worth shipping on its own — so the plan
degrades gracefully if you stop early. Effort is rough order-of-magnitude (S ≤ few days,
M ≈ 1–2 wks, L ≈ 3–6 wks) for one engineer.

### Phase A — Trust the foundation *(finish production-hardening)*
*Absorbs futureplan Phases 2–4 essentials. Nothing from `plan.md` starts until this lands.*

| Item | Reuse | New | Effort |
|---|---|---|---|
| ✅ Per-pipeline token/cost meter + **per-run budget cap** (B3, D4) | chat-flow `TokenTracker`, `loopCallbacks` (already plumbed, never provided) | wire callbacks in `_runPipelineCore`; budget-abort | M |
| ✅ Trigger tuning (B7) — require action∧scope keywords; `/single` bypass | `PlanningEngine.shouldOrchestrate` | heuristic refinement + regression cases | S |
| ✅ B8 minors — overview action column, titles after pipeline, retry budget, mindmap size-cap | existing writers | small fixes | S |
| ✅ Durability — persist run state (globalState); reconcile interrupted runs on activation | Manager panel, `globalState` | `core/pipeline-runs.ts` (pure model + reconcile/merge/cap); persist on every transition | M–L |
| ✅ Agent telemetry sink (opt-in) | typed `EventBus` (`bus.onAny`) | `core/telemetry-sink.ts` (privacy-safe projection + rotating JSONL) + export-diagnostics command | S–M |
| 🟡 Extension-host integration tests (`@vscode/test-electron`) + CI gate | `test/harness.js` mock LLM server | first e2e suite (chat, pipeline, Manager, reload) | M |
| 🟡 Repo hygiene | — | see decision below | S |

*Status (2026-07-19): **Phase A's code is effectively complete.** The observability & safety
cluster (B3/B7/B8), durability, and telemetry are all done and tested (191-test harness green,
both typechecks + webview build clean). Two items remain, both requiring infrastructure/owner
decisions rather than more feature code:*

- ***Integration tests** need `@vscode/test-electron`, which downloads a full VS Code build
  and requires a windowing/CI environment — it can't run in this sandbox. The suite is
  designed (chat, pipeline, Manager, reload-recovery) but must be stood up in real CI.*
- ***Repo hygiene:** `continue/` is **already gitignored** (root `.gitignore` line 4) — it is
  NOT in the repo, so the audit overstated it; no action needed. `.DS_Store` and `VSCode*` are
  also already ignored. The one real item — 455 tracked files under the extension's `dist/` — is
  **deliberately not removed here**: the extension's `main` points at `./dist/extension.js` and
  packaging may depend on committed build output. Removing it safely requires first confirming
  the packaging/CI pipeline rebuilds `dist/`, which is an owner decision, not a blind
  destructive `git rm`.*

*Durability delivers the core reload-survival (interrupted runs reconcile to a clear "failed —
interrupted by reload" state and surface in the Manager panel). The richer
"recover work from the surviving worktree branch" card is a documented follow-up enhancement,
not required to close the durability bug.*

**Value gate:** the product becomes *demonstrably* production-worthy — measured cost, survives
reloads, tested end-to-end. This alone is the difference between "beta" and "shippable."

### Phase B — Long-term project memory *(the `plan.md` keystone)*   🟡 CORE SHIPPED
*The single highest-leverage vision capability: it makes every future task smarter.*

> **Status (2026-07-19):** `core/knowledge-base.ts` shipped — the durable `.blackIDE/knowledge/`
> file set (`decision_log.md` ADRs, `feature_status.md`, `architecture.md`, `technical_debt.md`,
> `glossary.md`, `roadmap.md`), with pure/tested `nextAdrId` / `formatAdr` / `upsertFeatureStatus`
> and a `KnowledgeBase` class. **Write side wired**: a completed pipeline scaffolds the folder and
> upserts a feature-status entry. **Remaining:** the *read* side (agents consulting `knowledge/`
> at the start of every run — the chat flow's `getRelevantContext` is the seed to extend) and a
> per-file compaction policy.

- Formalize `plan.md`'s `knowledge/` folder as the durable project brain under `.blackIDE/knowledge/`:
  `architecture.md`, `decision_log.md` (ADRs), `feature_status.md`, `technical_debt.md`,
  `coding_guidelines.md`, `api_contracts.md`, `glossary.md`, `roadmap.md`, `mindmap.md`,
  `testing_strategy.md`. **Reuse** `KnowledgeStore` + the mindmap as the storage/retrieval
  engine; these files are its human-readable projection.
- Every task (chat *and* pipeline) begins by loading relevant knowledge (already partially
  done via `getRelevantContext`) and ends by updating it — make this a first-class,
  deterministic step, not an agent's optional `remember` call.
- Add a size/compaction policy (the mindmap already needs one — Phase A B8) so the brain
  doesn't bloat away its own token savings.

**Value gate:** cross-session continuity — the agent stops re-learning the codebase every
run. This is `plan.md`'s Principle 9 and the thing neither Cursor nor Antigravity has.

### Phase C — Smart intake *(classification + requirement & repo discovery)*   🟡 CORE SHIPPED

> **Status (2026-07-19):** `PlanningEngine.classifyRequest()` shipped — a pure, tested classifier
> into the `plan.md` taxonomy (question/bug/refactor/performance/security/test/docs/devops/build/
> feature), wired into the dispatch (logged; pure questions skip the plan-first workflow).
> **Remaining:** requirement discovery (asking high-value questions when info is missing) and a
> first-run repository-discovery scan that populates the Phase-B knowledge files.

*Cheap, high-value, reduces waste on every single request.*

- **Request classification** (`plan.md` §"Request Classification"): programming vs not, and
  sub-type (bug/feature/refactor/perf/security/docs/…). Extends `shouldOrchestrate` into a
  small classifier that also *right-sizes* the workflow (a typo ≠ a full-stack build) —
  directly fixes the B7 class of problem at its root.
- **Requirement discovery** (`plan.md` §"Requirement Discovery"): when key info is missing,
  ask a few high-value questions *before* burning a 7-agent run. Reuse the existing chat
  turn; gate the pipeline behind a lightweight "do I have enough to plan?" check.
- **Repository discovery**: a first-run project scan producing the Phase-B knowledge files.
  Reuse `CodebaseIndex` + `codebase_search`.

**Value gate:** fewer wasted expensive runs; better plans from better inputs. Pairs with
Phase A's cost meter to show the savings.

### Phase D — Deeper planning *(dependency / risk / priority / sprint + artifact set)*   🟡 SCHEDULER SHIPPED

> **Status (2026-07-19):** `core/task-scheduler.ts` shipped — a pure, tested dependency-aware
> scheduler (`scheduleTasks` = Kahn topological order with priority tie-break + cycle *reporting*
> not hanging; `toParallelWaves` = parallelizable waves). The pipeline **dogfoods it**:
> `selectExecutionPhases` now resolves phase order from an explicit dependency graph, and
> `selectExecutionWaves` exposes the parallel waves a Phase-E executor will consume.
> The pipeline now also emits **`dependency_graph.md`** (via `formatDependencyGraph`) on
> approval. **Remaining:** the other planning artifacts (risk/api/db docs) and a per-*task*
> dependency graph (not just per-phase).

*Turns the single `features_plan.md` into the `plan.md` planning suite — mostly artifact work.*

- Extend the analysis phases to also emit `architecture.md` (HLD), `risk_analysis.md`,
  `dependency_graph.md`, `api_contract.md`, `database_plan.md` where relevant. **Reuse** the
  artifact-writing + approval-gate machinery; this is largely richer prompts + more output files.
- **Dependency-aware ordering** (`plan.md` Priority Engine + Dependency Graph, Principle 6):
  the genuinely new logic — order execution by prerequisite graph, not just phase tags. A
  real scheduler over tagged tasks. Start small: topological order within a plan.
- **Sprint planning**: group tasks into reviewable increments rather than one long list.

**Value gate:** larger features become tractable and reviewable; the approval gate shows a
real project plan, not just a task list. (Keep D6 — one richer review, not more prompts.)

### Phase E — Execution & quality depth   🔲 NOT BUILT (the one large remaining feature)

> **Status (2026-07-19):** deliberately **not implemented**. True concurrent-worktree
> execution (running a wave's phases in parallel, each in its own worktree, then joining
> disjoint deltas) is the highest-risk item in the whole plan — a bug corrupts user work —
> and it can only be validated with extension-host integration tests that this sandbox
> can't run. The seams are all in place (`selectExecutionWaves`, per-phase worktrees,
> `applyDelta`, `gitMutex` serialization); this needs a dedicated, integration-tested
> effort, not a rushed pass. It is the correct thing to leave for last and do carefully.


- **Parallel specialist execution within a feature**: today phases are sequential; the Manager
  panel already runs *separate* pipelines in parallel. This phase parallelizes *independent
  tasks within one plan* (per the dependency graph from Phase D), each in its own worktree.
  Reuse worktree isolation + `applyDelta`; new = the fan-out/join orchestration. **L, highest risk.**
- **Continuous review loop** (`plan.md` §"Continuous Review"): self-review → static analysis →
  (optional) peer-review agent → QA. Add the cheap, high-value links first (static analysis,
  self-review); make a "peer review" agent optional (D1 — only if it measurably helps).
- **Fuller testing pipeline**: extend Testing Executor toward unit/integration/security/perf
  as the plan warrants — gated by cost, not run blindly every time.

**Value gate:** speed (parallelism) + trust (review) on real features. This is the competitive
frontier vs Cursor/Antigravity.

### Phase F — Documentation & governance   🟡 PARTIAL
*The `plan.md` deliverable regime and ADRs — closes the loop back into memory (Phase B).*

> **Status (2026-07-19):** the **ADR capability** shipped in `core/knowledge-base.ts`
> (`nextAdrId`/`formatAdr`/`recordDecision`, tested), and **PR-output command building**
> shipped in `core/git-pr.ts` (`buildPrCommands`/`compareUrlFallback`/`shellQuote`, tested).
> **Remaining:** wiring PR-output as an orchestrator *mode* (push branch instead of
> reconcile — a small but real flow change), and auto-maintaining the fuller doc set
> (CHANGELOG/RELEASE_NOTES/PROJECT_OVERVIEW) on completion.

- Auto-maintain `CHANGELOG.md`, `RELEASE_NOTES.md`, `PROJECT_OVERVIEW.md`, ADRs
  (`decision_log.md`), `feature_status.md`, `technical_debt.md` on completion. Reuse the
  `overview.md` generator pattern + Phase-B knowledge files.
- **PR-generation output mode** (competitive parity — Cursor background agents): the work is
  already on a git branch pre-reconcile; offer "open PR" instead of apply-to-live. **S–M.**
- Optional: background/CLI runs surviving IDE close (the `black-ide` CLI surface already
  exists) — only if Phase A durability proves demand.

**Value gate:** every delivery leaves the project better-documented and the knowledge base
smarter (Principle 10) — the flywheel `plan.md` is really about.

---

## 5. `plan.md` capability → status & effort map

| `plan.md` capability | Today | Plan phase | Reuse vs New |
|---|---|---|---|
| Plan-before-code + approval gate | ✅ shipped | — | — |
| 7-role pipeline (subset of the "org") | ✅ shipped | — | — |
| Parallel *runs* | ✅ Manager panel | — | — |
| Long-term project memory / knowledge base | 🟡 seed (KnowledgeStore+mindmap) | **B** | Extend |
| Request classification / right-sizing | 🟡 coarse `shouldOrchestrate` | **C** | Extend |
| Requirement discovery (smart questions) | ❌ | **C** | New (cheap) |
| Repository discovery / architecture map | 🟡 CodebaseIndex | **C** | Extend |
| HLD/LLD artifacts | ✅ (as pipeline phases) | D | Extend to files |
| Risk / dependency / priority / DSA analysis | ❌ | **D** | New |
| Sprint planning | ❌ | **D** | New |
| Full planning doc set (~10 files) | 🟡 (3 files) | D | Extend |
| Dependency-aware execution ordering | ❌ (phase-tag order only) | **D→E** | New (scheduler) |
| Parallel specialist execution *within* a feature | ❌ (sequential) | **E** | New (fan-out/join) |
| Continuous review loop | 🟡 (Testing Executor) | **E** | Extend |
| Full testing pipeline (unit→security→perf) | 🟡 (basic) | E | Extend |
| ADRs / decision log | ❌ | **F** | New |
| Changelog / release / deliverable regime | 🟡 (overview.md) | **F** | Extend |
| Cost/latency governance | ❌ (B3) | **A** | New (prereq) |
| Durability / reliability | ❌ | **A** | New (prereq) |

---

## 6. What we deliberately will NOT build (and why)

- **A literal 30-agent org chart.** D1: each role is a paid LLM turn. We collapse departments
  into capabilities and the smallest agent set that produces them. Add roles only on evidence.
- **A "multi-agent architecture meeting"** as literal round-robin agent debate. Expensive,
  slow, low signal-to-cost. The HLD/LLD/risk artifacts (Phase D) capture the same decisions
  deterministically. Revisit only if artifact quality proves insufficient.
- **Running the full testing/documentation pipeline on every request.** Cost-gated and
  right-sized by classification (Phase C) — a typo fix does not trigger load tests.
- **Cloud/remote execution** (`plan.md` implies scale). Out of architecture scope now; the
  CLI/background path (Phase F, optional) is the achievable substitute. Design only if demand.
- **Non-programming "General Manager" department.** The product is a coding IDE; a general
  chat assistant is a distraction from the differentiators. Route non-coding requests to the
  existing single-agent chat and move on.

---

## 7. Cross-cutting budget & constraints

- **Cost:** every phase adds agent turns; the Phase-A per-run token budget + meter is the
  non-negotiable guardrail. Target: show the user projected cost *before* a large run.
- **Latency:** classification (Phase C) must keep trivial requests on the single-agent fast
  path. A 7+-agent pipeline is for substantial multi-domain work only.
- **Safety:** the B1 non-interactive approval policy (shipped) must extend to every new agent
  type and every new tool. New capabilities inherit the gate; they do not bypass it.
- **Testability:** from Phase A on, new orchestration logic ships with harness coverage;
  `extension.ts` glue is covered by the integration suite, not left untested as it is today.

---

## 8. Review decision points (sign-off checklist)

Please confirm or redirect on each — these determine the plan:

1. **Framing (§0/D2):** foundation-before-vision — hardening (Phase A) ships before any
   `plan.md` expansion. Agree?
2. **Ambition scope (D1/§6):** capabilities over a literal agent org; the explicit "won't
   build" list is acceptable?
3. **Keystone priority (Phase B):** long-term memory is the first vision capability, before
   deeper planning/execution. Agree, or do you want richer planning (Phase D) first?
4. **Cost governance (D4/§7):** a per-run budget cap and pre-run cost estimate are mandatory
   guardrails. Acceptable, or too conservative?
5. **Depth vs breadth:** do you want each phase delivered fully before the next, or a thin
   vertical slice of B→F first (a "lighthouse" full-agency run on one small project) to
   validate the whole shape earlier?
6. **Non-programming scope (§6):** dropping the "General Manager" department — agree?

On sign-off I'll expand the approved phases into execution-ready docs (the `phase-1-implementation.md`
level of detail — verified file sites, test specs, file-change maps), one per phase, in
`notes/plans/`.
