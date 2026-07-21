# Black IDE — Engineering Audit & Future Plan

**Date:** 2026-07-19
**Scope:** `src/stable/extensions/black-ide-agent` (the agent runtime), audited against the
current working tree (includes the uncommitted Phase 0–2.3 hardening work). Every bug
below was verified by reading the actual code path, with file references — not inferred
from docs.
**Companion docs:** `notes/agent_plan.md` (original spec + implementation changelog),
`notes/plans/` (phase-by-phase implementation plans derived from this audit).

---

## 1. Competitive Position (July 2026)

| Dimension | Black IDE | Cursor 3.5 | Antigravity 2.0 | Continue |
|---|---|---|---|---|
| Base | VS Code fork + built-in `black-ide-agent` | VS Code fork | Standalone (VS Code-based) + CLI/SDK | Extension for VS Code/JetBrains |
| Multi-agent pipeline | ✅ 7-agent sequential (HLD→LLD→Plan→approve→Design/Backend/Frontend/Test), auto-triggered | ✅ Parallel agents (up to 8), worktrees, per-agent model/approval | ✅ Manager view (5 parallel), per-agent workspace/model | ❌ Single-agent chat/edit/autocomplete |
| Parallel runs UI | ✅ Pipeline Manager panel (4 concurrent, worktree-isolated) — **new, unverified in live VS Code** | ✅ Mature | ✅ Mature | ❌ |
| Isolation | ✅ Git worktree + diff-based reconciliation | ✅ Worktrees / cloud VMs | ✅ Per-agent workspace | ❌ Edits live buffer |
| Background/cloud execution | ❌ In-process only, dies with the window | ✅ Cloud VMs, opens PRs unattended | ✅ Scheduled tasks, CLI-native | ❌ |
| Browser self-verification | ✅ Testing Executor (navigate/click/screenshot) | ✅ "Computer Use" full desktop | ✅ Browser subagent | ❌ |
| Shared knowledge doc | ✅ OpenSpec mindmap — **still a genuine differentiator** | ❌ | Artifacts (per-run, not cumulative) | ❌ |
| Plan-first + approval gate | ✅ Default for every substantive message | Opt-in | ✅ Artifact review | ❌ |
| Model-per-agent/phase | ✅ Per-phase (settings) | ✅ | ✅ | ✅ (per-role config) |
| Cost/token visibility | 🔴 Chat flow only — **pipeline runs report zero token usage** (bug B3) | ✅ | ✅ | ✅ |
| Command approval policy | 🔴 Chat flow only — **pipeline bypasses it entirely** (bug B1) | ✅ Per-agent approval policy | ✅ | ✅ |

**Note on Continue:** a full copy of the Continue project is vendored at `continue/`
(its own core, three extensions, docs site) and is referenced by **no build script,
Makefile target, or product.json entry**. It appears to be reference material. It bloats
the repo by an entire second product and carries Apache-2.0 attribution obligations if
any code was derived from it. Decide: extract to a submodule/reference link, or document
why it's in-tree.

**Verdict:** Black IDE has reached *feature-shape* parity with Cursor/Antigravity on
orchestration and now exceeds both on persistent shared knowledge (mindmap) and
plan-first defaults. What separates it from them is not features anymore — it's
**hardening**: the bugs in §2, the missing operational visibility, and the absence of
background/durable execution.

---

## 2. Bugs Found (verified, ranked by severity)

### B1 — Pipeline bypasses the user's command-approval policy entirely 🔴 SECURITY
The chat flow builds a real approval gate: `CommandPolicy` with allow/deny lists and the
user's auto-approve settings (`extension.ts` — `commandPolicy` + `approve` closure inside
`_runAgentTask`). The pipeline path hardcodes **`approve: async () => true`**
(`extension.ts:949`, inside `_runPipelineCore`'s `baseDeps`). Every execution agent in a
pipeline can run arbitrary shell commands, edit and create any file, and invoke MCP tools
with zero prompting — regardless of the user's configured deny list or auto-approve
settings. Worktree isolation limits *file* blast radius but `run_command` executes with
the user's full shell privileges either way. **This is the single biggest blocker to
calling the product production-ready.**

### B2 — Resource leak: browser + MCP connections never closed in pipeline runs 🔴
`_runAgentTask` closes them in its `finally` (`extension.ts:1677–1678`). `_runPipelineCore`
creates its own `BrowserTool` and `MCPClient` (`extension.ts:944–945` region) and **never
closes either**. Every pipeline run where the Testing Executor opens a browser leaks a
headless Chromium process until the extension host dies. With the new Manager panel
allowing 4 concurrent runs, this compounds fast.

### B3 — Pipeline runs are observably silent: no tool activity, no token usage 🟠
`PipelineCallbacks.loopCallbacks` exists (`pipeline-orchestrator.ts:71`) and is passed to
`runAgentLoop` (`:130`) — but `extension.ts` **never provides it**. Consequence: every
phase's inner agent loop runs with `callbacks: undefined` → no `ToolStarted`/`ToolFinished`
events (activity panel empty during phases), no `TokenUsage` (the *most expensive
operation in the product* — 7 sequential agent loops — reports zero cost to the user), no
loop-limit warning dialog. The spec's F7 ("every agent action shown in chat") is only
half-true today: phase-level entries appear; tool-level activity does not.

### B4 — Pipeline runs are amnesiac: conversation context never updated 🟠
`this._conversation = result.messages` happens only in `_runAgentTask`
(`extension.ts:1582`). Neither `_runPipeline` nor `_runPipelineCore` touch it. After a
pipeline builds an entire CRM, the user's follow-up chat message ("now add email
notifications") carries **zero context** of what was just built. `agent_plan.md` F14
("Pipeline-Scoped Conversation Context") is marked shipped in the feature catalog — it is
not implemented. The mindmap partially compensates (agents can read it) but the chat
model's conversational memory does not.

### B5 — Checkpoint transaction bleed across task boundaries 🟠
`tool-executor.ts:108,119` calls `checkpoint.snapshot(absPath)` on every write/edit. The
chat flow closes the transaction with `checkpoint.commit()` after its loop
(`extension.ts` — commit near line 1590). The pipeline path **never commits**. So:
(a) snapshots from pipeline analysis-phase writes (Planner writing `features_plan.md` to
the live workspace) sit in the open transaction and get swept into the **next chat
task's** checkpoint under the wrong message id — undoing that later message also reverts
pipeline files; (b) execution-phase snapshots reference **worktree paths that are deleted
after reconciliation** — stale absolute paths in the checkpoint store.

### B6 — Ad-hoc `spawn_subagent` worktree merge is a silent no-op 🟠 (pre-existing, known)
`extension.ts` subagent flow: `createWorktree` → run loop → `mergeWorktree` → remove. But
nothing ever commits inside the worktree, and `git merge` merges *commits* — so the merge
brings in nothing and **every file a subagent writes is silently discarded** when the
worktree is removed. Flagged during the Phase 2.1 work (the pipeline path got the fix:
`commitWorktreeChanges` + `applyDelta`); the subagent path still has the bug. Any user of
Manager-mode delegation is losing work silently. Fix is mechanical: reuse the same
commit+delta sequence.

### B7 — `shouldOrchestrate` over-triggers 🟡
`planning-engine.ts` — keyword list includes `make`, `design`, `app`, `service`, `module`,
`feature` with only a >5-word floor. "make this function faster in the user service"
(8 words, hits `make`+`service`) launches a full 7-agent pipeline for a one-line
optimization. Needs either a stricter multi-domain heuristic (require 2+ domain keywords),
a cheap LLM classification, or an inline "run as pipeline? [yes/just do it]" confirm chip.

### B8 — Minor, collected 🟡
- `overview.md`'s file table hardcodes `Action = "Modified"` even for created files
  (`pipeline-orchestrator.ts` `generateOverview`).
- Conversation **title generation never runs after pipeline runs** (only `_runAgentTask`
  triggers it) — pipeline-initiated threads keep "New Conversation".
- Pipeline pending-approval does not survive an extension-host restart (the resolver is
  in-memory; the chat single-agent flow *does* persist its pending state to Memento —
  asymmetry).
- Manager panel run list is in-memory only; a window reload orphans running pipelines
  with no record they existed (documented v1 limitation, still a gap).
- Ad-hoc subagents get `maxLoops: 6` — too small to do real work, compounding B6.
- `runPhase` retry cap is 1 (`maxRetries = 1`); a second transient failure kills the run.

---

## 3. Feature Audit vs `agent_plan.md` Catalog

| Spec feature | Status | Issue |
|---|---|---|
| F1 pipeline (7-agent) | ✅ Works | — |
| F2 auto-trigger | ✅ Works | B7 over-trigger |
| F3 approval gate (in-chat, editable plan) | ✅ Works | Restart-survival asymmetry (B8) |
| F4 mindmap | ✅ Works | Append-only growth — no compaction; will bloat over many runs |
| F5 features_plan.md | ✅ Works | — |
| F6 overview.md | ✅ Works | B8 action-column |
| F7 real-time pipeline log | 🟡 Partial | Phase-level only; tool-level missing (B3) |
| F8 persistent activity log | ✅ Works | — |
| F9 auto-open files | ✅ (setting-gated) | — |
| F11 LLM titles | 🟡 Partial | Not for pipeline runs (B8) |
| F14 pipeline conversation context | ❌ **Not implemented** | B4 — catalog claims it ships |
| F16 phase tool scoping | ✅ Works | But approval bypass undermines it (B1) |
| F17 error handling | ✅ Works | Retry cap 1 |
| F18 cancellation | ✅ Works | — |
| F19 update_mindmap | ✅ Works | + deterministic auto-sync backstop |
| F20 pipeline events | ✅ Works | + Failed/Cancelled added |

---

## 4. Is Black IDE production-level?

**No — it is a strong beta.** Concretely:

**What's production-grade already:** secrets via VS Code SecretStorage; typed event bus
with correlation IDs; checkpoint/undo system with real reverse-patches; 150-test harness
over the core runtime (LLM parsing for 4 provider protocols, agent loop, context
compaction, diff engine, checkpoints, worktree lifecycle with a real git repo); signed
packaging artifacts (dmg + sha256 in `assets/`); worktree isolation with a
correctness-proven reconciliation strategy.

**What blocks production:**
1. **B1** — a security regression: the flagship feature ignores the user's command policy.
2. **B2/B5** — resource and state leaks that compound with concurrent use.
3. **Zero cost visibility for pipeline runs (B3)** — a 7-agent run against a paid API with
   no token counter is a support-ticket generator.
4. **`extension.ts` glue is untested** — the 150 tests cover the core; the ~2000-line
   provider wiring (approval flows, thread switching, pipeline entry points) has no
   automated coverage, and the Manager panel has never been exercised in a live extension
   host.
5. **No durability** — window reload kills every running pipeline silently.
6. **No operational telemetry** for agent runs (failure rates, phase durations, token
   spend) — the docs describe editor telemetry only.
7. Repo hygiene: vendored `continue/`, committed `dist/` build output, `.DS_Store`,
   `package.json.bak` in-tree.

**Realistic maturity label:** internal-tool / early-adopter beta. The path to production
is the plan below — roughly phases 1–2 are *required* for a credible public release;
phases 3–4 are competitive positioning.

---

## 5. Future Plan (summary — details in `notes/plans/`)

| Phase | Theme | Contents | Effort |
|---|---|---|---|
| **1** | Correctness & security (release blockers) | B1 policy enforcement in pipeline, B2 resource cleanup, B5 checkpoint scoping, B6 subagent merge fix, B4 conversation context | S–M each, all mechanical |
| **2** | Observability & UX | B3 loopCallbacks + token tracking per phase, cost display/cap, B7 trigger tuning, B8 minors (titles, overview actions, retry budget) | M |
| **3** | Durability | Persist pipeline/Manager run state to Memento, resume-or-report after reload, pending-approval restart survival, run history | M–L |
| **4** | Competitive & production ops | Extension-host integration tests, agent telemetry, background runs surviving window close (long-term: remote), PR-generation output mode, repo hygiene (continue/, dist/) | L |

Sequencing rationale: Phase 1 items are independent, small, and each closes a verified
bug — ship first. Phase 2 makes the existing features honest (visible, priced, tuned).
Phase 3 is the largest architectural gap vs Cursor/Antigravity that's achievable without
cloud infrastructure. Phase 4 is where the product goes from "parity" to "positioned."
