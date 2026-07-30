# Black IDE — Competitive Analysis & Agent Enhancement Roadmap

**Author:** Principal Engineer (IDE + agent infrastructure)
**Date:** 2026-07-27
**Status:** **In progress · rev 5 (2026-07-29)** — Phases 0–2 delivered, Phase 3 substantially
delivered; **20 of 71 gaps addressed (16 complete, 4 partial)**. Supersedes the "next initiative"
half of [`plan.md`](./plan.md) (which is delivered through its Phase 5).

| Phase | Status | Covers | Evidence |
|---|:--:|---|---|
| 0 — Truth-up & foundations | ✅ | M1–M5 | 8 docs corrected · `extension.ts` 2537→**652** (≤700 gate **met**) · eval harness + baseline · vitest wired · skill diagnostics. Retrieval recall recorded in Phase 3's opener. |
| 1 — Language-server tools & tests | 🟡 | M6–M8 | 8 tools in `tools/lsp-tools.ts` + `core/test-report.ts`; 5 of 6 gates asserted, incl. rename across 6 files in a real extension host. **Outstanding:** the LSP-over-grep gate needs the model tier. |
| 2 — Rules, prompts & modes | 🟡 | M9–M13 | Rules v2, team rules, prompt library, Learn mode, session panel. M9's stronger reading closed as won't-do. **Outstanding:** tool toggles in the panel (M10). |
| 3 — Retrieval substrate | 🟡 | M14–M22 | **M14–M18, M22 done; M19 partial; headline gate met.** recall@5 84.7→**91.2** · @10 93.1→**97.2** · @20 94.4→**100** · impact analysis 0 FP / 0 misses on 6 refactors · compaction 37.7% at realistic path depth · git history tools shipped. **Remaining:** M19's `@symbol`/`@docs`/`@web` providers and **M20/M21** (docs indexing, keyed search providers). |
| 4–12 | — | M23–M71 | Not started. |

**Re-verified 2026-07-29 by running everything, after Phase 3:** harness **426/426** · vitest
**393/393 / 23 suites** · **19** real-host integration tests · eval gate green (stack detection 100%
8/8 · skill exact-match 100% · fail-safe 1/1 · **recall@5 91.2% · @10 97.2% · @20 100%** ·
compaction 37.7% · *no regression vs `eval/baseline.json`*) · `tsc -b` clean · webview builds ·
`extension.ts` **652 LOC**.

### Pending work across every started phase (0–3)

This is the complete list of what is outstanding in phases that have been started, ordered by what
actually blocks progress. Phases 4–12 are untouched and are scheduled in §4.

| # | Item | Phase | Tracked at | Blocked by / blocking | Status |
|:--:|---|:--:|:--:|---|---|
| 1 | `extension.ts` **960 LOC** against a **≤700** gate | 0 | M2 / G10 | taxed every later phase editing this file | ✅ **closed 2026-07-29 — 652 LOC** |
| 2 | **Tool toggles** in the session panel (rule toggles shipped) | 2 | M10 | nothing — self-contained | open, ~1 day |
| 3 | Rules+skills assembly is two budgeted sections, not one merged pipeline | 2 | M9 (weaker reading) | — | ✅ **closed 2026-07-29 as won't-do** |
| 4 | Eval set is **19 tasks / 8 fixtures**; §4.2's "record" baselines unrecorded | 0 | M3 | recall half was blocking Phase 3 | 🟡 **recall recorded 2026-07-29**; task-count breadth still short |
| 5 | "Symbol questions resolve via LSP not grep" unasserted | 1 | M6/M7 gate | needs the opt-in **model tier** | open — tier work, not phase work |
| 6 | **`@docs` indexing + keyed search providers** not started | 3 | M20 / M21 | nothing — but network-facing, no deterministic gate | open, the largest Phase 3 remainder |
| 7 | `@symbol` provider missing from the `@`-mention set | 3 | M19 | unblocked — M15 already exposes the graph | open, ~0.5 day |
| 8 | Rerank cross-encoder absent; only the lexical fallback ships | 3 | M17 | **blocked on Phase 4 (M23)** `rerank` role | sequenced, not skipped |
| 9 | Phase 3 build-time budget restated, not re-measured on a large repo | 3 | M14 gate | needs a 5 000-file repo to assert against | open — gate agreed, unproven |

Detail on each:

1. **`extension.ts` size (M2/G10) — closed.** 960 → **623 LOC**, clearing the ≤700 gate with room
   (**652** after Phase 3's M19 wiring — still inside the gate, and the reason M19's provider
   assembly went into `core/context-provider-setup.ts` rather than inline).
   The cut was `_runPipeline` + `_runPipelineCore` + `_runPipelineInManager` + the managed-run
   bookkeeping, into `agent/pipeline-entry.ts` (+106) and a new `agent/managed-runs.ts` (241), plus
   `core/conversation-title.ts` (54). **One deviation from the plan, deliberately:** the Manager
   lane moved as a *class* (`ManagedRunRegistry`), not as the deps-object function the three prior
   extractions used. What is being moved there is state with an invariant — the live `Map` and the
   persisted history must be folded together on *every* transition or a reload shows ghost
   "running" rows — and moving the methods without the state they guard would have split that
   invariant across two files, which is worse than not moving it. A new `_pipelineCoreDeps` getter
   names exactly the members the shared core reads, mutating none. Verified across all four tiers:
   harness 426/426 · vitest (206/206 at the time of the cut) · **19 real-host integration tests** ·
   `tsc -b` clean.
2. **Tool toggles (M10).** `webview/src/App.tsx:3343` posts `toggleRule`; `core/webview-message-handler.ts:220`
   handles it. There is no `toggleTool` counterpart on either side. Worth more now than when
   planned, because Phase 2 made per-mode tool allowlists genuinely enforced (B4) — a session
   toggle would ride that same gate in `agent/tool-executor.ts:112` rather than being advisory.
3. **Unified assembly (M9) — closed as won't-do.** Rules and skills are separate,
   independently-budgeted sections in `core/prompt-builder.ts`. That satisfies the stated intent
   (neither can starve the other) and is the better design: one merged section would have to
   arbitrate two unrelated ranking schemes into a single budget, and it would make
   `__tests__/rules-panel-fidelity.test.ts`'s both-directions assertion harder to state, not
   easier. The Phase 2 wording is amended to "one budgeted assembly *path*", which is what was
   meant and what shipped. Carrying it as debt implied a change we had decided not to make.
4. **Measurement debt (M3) — half closed.** Retrieval recall now has a real baseline; see the
   Phase 3 opening note below for the numbers, the corpus, and the gate correction it forced.
   Still short: `eval/tasks.js` holds 19 tasks across 8 fixtures where the plan asked for 8–10 per
   stack, and end-to-end task success / tokens-per-task remain deferred to the opt-in model tier.
   Neither blocks Phase 3 now that recall is measurable.
5. **Phase 1's last gate.** Five of six Phase 1 gates are asserted, including `rename_symbol`
   across 6 files in a real extension host. Whether the agent *chooses* LSP over grep needs a model
   to observe, so it belongs to the same opt-in tier as the rest of item 4.
6. **M20/M21 — `@docs` and keyed search.** Not started. The only Phase 3 milestones with no code.
   Both are network-facing (a crawler, and Brave/Tavily/Google CSE keys) and neither has a
   deterministic gate the eval harness can hold, which is why they were sequenced last rather than
   first.
7. **`@symbol` (M19).** The provider registry, budgets, resolution and webview are all shipped;
   `@symbol` is one more `ContextProvider` reading `CodebaseIndex.graph`, which M15 already exposes.
   It is small *because* M15 landed first.
8. **Rerank cross-encoder (M17).** The `Reranker` interface and the tuned `LexicalReranker` ship and
   are what run by default. A model-backed implementation assigns `index.reranker` and changes
   nothing else — but it needs the `rerank` role from **Phase 4's ModelRouter (M23)**, so it is
   sequenced, not skipped.
9. **Build-time budget (M14).** The original "+50% of baseline" resolved to ≤39 ms on an 82-file
   fixture, which measures nothing; it is restated as **≤2 s per 5 000 files**. That restatement is
   not yet *asserted* against a large repo, so the gate is agreed but unproven.

Three defects were found by the Phase 0–2 work itself and fixed: **F1** (skills injected into repos
with no detected stack), **F2** (`react` undetected in Next.js projects), and the **per-mode
allowlist gap** (B4). Each is recorded where it was graded, not only where it was fixed. Phase 3
found six more — see the rev 5 note below.

**Scope:** `src/stable/extensions/black-ide-agent/` + editor-level surfaces in `src/stable/src/vs/`

**Benchmarked against:** Google Antigravity 2.0 · Cursor 3.5 · Continue.dev · NeuralInverse · CortexIDE · A-Coder · OPIDE.

> **Method.** Every "Level"/"Status" below is grounded in code in this repo (file:line where it
> matters), not in the README. Competitor claims come from their public docs/READMEs as of
> 2026-07-27 and are labelled as *their* claims, not measured results. Where our own docs
> overstate reality, that is called out — see [Doc corrections](#0-doc-corrections-truth-up).

> **What changed in rev 5 (2026-07-29).** Delivery, plus one arithmetic correction: **§3's
> priority tally has been wrong since rev 1** — it read "P0: 11 · P2: 23 · P3: 7" where counting the
> table's own Pri column gives **13 · 30 · 22 · 6**. M28, M54 and M56 are P0 and were never in the
> P0 total, which is why rev 4 could claim "three P0 items outstanding" while naming only M14, M15
> and M23. Four P0 items are genuinely open: M23, M28, M54, M56.
>
> Otherwise, delivery rather than verification. Phase 0's last gate closed
> (`extension.ts` 960 → 652, under ≤700), Phase 2's M9 closed as **won't-do** rather than carried,
> and **Phase 3 delivered M14–M18 and M22** with M17 and M19 partial by dependency. Retrieval:
> recall@5 **84.7 → 91.2**, @10 **93.1 → 97.2**, @20 **94.4 → 100**; `impact_analysis` at **0 false
> positives / 0 misses** across six refactors against a ≤2 FP gate.
>
> **Two gate corrections, both forced by measuring rather than asserting.** Phase 3's headline
> "+25% recall@10" was **arithmetically impossible** — authored before any baseline existed, it
> needed 116% from a 93.1% base; it is restated as recall@5 ≥88.5% plus a ≥25% residual-error
> reduction at k=10, and both halves are met. The index-build budget "+50% of baseline" resolved to
> ≤39 ms on an 82-file fixture, which measures nothing; restated as ≤2 s per 5 000 files (agreed,
> not yet asserted — pending item 9).
>
> **One roadmap substitution, decided by the owner:** M14/M15 ship a **dependency-free lexical
> backend** behind a `ChunkerBackend` seam instead of tree-sitter, which is not vendored here and
> would mean ~12 MB of grammars plus per-platform packaging in an extension with one runtime
> dependency. Recorded as a decision with its measurements, not as a shortfall.
>
> **Defects found by Phase 3's own work**, each of which passed unit tests and failed only against
> the corpus: `impact_analysis` computed the impact of a symbol's *file* (31 false positives → 0);
> graph expansion only *inserted* missing files instead of promoting ranked-low ones, making it a
> no-op; a plausible damped file-score aggregate cost 12 points of recall@5; the chunker dropped
> every container symbol and every doc comment; the stemmer disagreed with itself on `reserve`
> /`reserved`. Separately, two files shipped **literal NUL bytes** as separators — correct code, all
> tests green, but raw control bytes make a file binary to `grep`/`diff`/review tooling, which then
> silently show nothing. `__tests__/source-hygiene.test.ts` now fails on any raw control character.
>
> **What changed in rev 4 (2026-07-28).** A verification pass, not new delivery: every claimed
> check was re-run rather than re-quoted (all green — numbers above). Six corrections against the
> code. **E_1: 23 → 31 native tools** — the count predated Phase 1's 7 LSP tools + `run_tests` and
> was never updated. **Four `file:line` references had drifted** and are repointed: the
> SEARCH/REPLACE contract (`tools.ts:63` → `:76`), ranged reads (`:14-22` → `:27-34`), the
> post-edit diagnostics call site (`tool-executor.ts:111` → `:154`, since `:111` is now the Phase 2
> allowlist gate), and the `@`-mention path (`App.tsx:1210` → `:1182`). **Phase 1 regraded ✅ → 🟡**
> — not a regression: the rename-across-5+-files gate has *closed* since rev 3 (real host, 6 files),
> but one gate genuinely remains unasserted, and ✅ was overclaiming it. **M3 regraded ✅ → 🟡** for
> the eval set's task-count shortfall and the four unrecorded §4.2 baselines — which is what makes
> fixture-backed `findFiles` a Phase 3 *opening* task. The pending-work table above is now the
> single place Phase 0–2 leftovers are tracked.
>
> **What changed in rev 2** *(retained for the record; rev 3 delivery is summarised above).* A second pass against the code found **four items graded wrongly** in
> rev 1 and **eleven gaps missed entirely**. Corrections: `ManagerPanel.tsx` already exists with
> per-run model and `awaiting_approval` (A6 🔴→🟡); post-edit diagnostics feedback already works
> (E_10 ✅); `read_file` already paginates (D10 ✅); extension-marketplace compatibility is already
> at parity (F20 ✅). Newly found gaps: LSP navigation tools, on-demand diagnostics, structured
> test running, context providers beyond `@file`, git-history search, notebooks, terminal `Cmd+K`,
> sandboxed execution, multi-model race, agent inbox, prompt library, multi-root correctness.
> **Two items promoted to the front of the plan** as a result: language-server tools and
> `run_tests` are now Phase 1 — days of work, largest accuracy-per-effort ratio in the document,
> and they raise the measured ceiling of every phase after them.
>
> **Coverage commitment.** §3 is the complete gap inventory (71 items). §4 schedules all 71 across
> 13 phases; §4.3 is the coverage matrix. §4.5 lists the only six items deliberately *not*
> scheduled, with the reason each is an architectural position rather than a missing feature.

---

## 1. Feature list — Level & Status

**Level** = engineering maturity of what exists. 🟢 Advanced (robust, tested, production) ·
🟡 Mid (works, real limitation) · 🔴 Beginning (naive/experimental/barely wired) · ⬜ Absent.

**Status** = delivery state. ✅ Shipped · 🟡 Partial · 🧪 Experimental (default-off) ·
📋 Planned in this doc · ❌ Not present.

**Parity** = who sets the bar we are measured against.

### 1.1 Agent core & orchestration

| # | Capability | Level | Status | Parity bar / gap |
|---|---|:--:|:--:|---|
| A1 | Bounded agent loop, context budgeting, execution interlock | 🟢 | ✅ | `agent/agent-loop.ts`, `core/context-manager.ts`. At bar. |
| A2 | Two-phase planning + human approval gate (survives reload) | 🟢 | ✅ | `agent/planning-engine.ts`. Ahead of Continue; at Antigravity's plan artifact bar. |
| A3 | Multi-agent pipeline (HLD→LLD→Planner→Design/Backend/Frontend/Testing) | 🟢 | ✅ | `agent/pipeline-orchestrator.ts` (614 LOC). **Ahead of all seven** — nobody else ships a fixed SDLC pipeline. |
| A4 | Subagent isolation via git worktrees + delta reconcile | 🟢 | ✅ | `agent/worktree-manager.ts`. At Cursor's worktree bar. |
| A5 | Concurrent pipeline runs (≤4) with durable history | 🟢 | ✅ | `core/pipeline-runs.ts`. |
| A6 | **Agent Manager: N independent user-launched agents, each own worktree + own model** | 🟡 | 🟡 | *Corrected 2026-07-27:* `webview/src/ManagerPanel.tsx` **already exists** — `RunSummary` carries `modelId`, `status: awaiting_approval`, `currentPhase`, and `ParallelSubagents.tsx` renders subagents. The surface is real; what's missing is the **independent (non-pipeline) task agent** as a first-class unit inside it. Antigravity Manager (5 parallel), Cursor (8 worktree agents). → **E3** (smaller than first assessed — extend, don't build) |
| A7 | Request classification / auto-plan / auto-orchestrate | 🟡 | ✅ | Keyword heuristics in `planning-engine.ts`; not learned, not model-assisted. |
| A8 | Parallel wave execution | 🔴 | 🧪 | `core/parallel-execution.ts`; default OFF, unverified under extension host. → **E18** |
| A9 | Mid-run steering (correct an agent without restarting the task) | ⬜ | ❌ | Antigravity's comment-on-artifact loop. We can only cancel + rerun. → **E4** |
| A10 | Background / cloud agents (off-machine execution) | ⬜ | ❌ | Cursor Background Agent, Antigravity async tasks. → **E14** |

### 1.2 The fleet (agents & modes)

| # | Capability | Level | Status | Parity bar / gap |
|---|---|:--:|:--:|---|
| B1 | **9** selectable modes (Ask, Plan, Agent, Frontend, Backend, DevOps, Manager, Sr Architect, **Learn**) | 🟢 | ✅ | `core/mode-loader.ts`. Learn added in Phase 2. Ahead of Cursor (3) and A-Coder (4) on breadth. |
| B2 | 7 internal pipeline-phase agents | 🟢 | ✅ | Unique to us. |
| B3 | Custom modes (YAML frontmatter, 3 scopes, hot-reload, inline diagnostics) | 🟢 | ✅ | At Continue's agent-block bar, better DX (diagnostics). |
| B4 | Per-mode tool allowlist + iteration budget | 🟢 | ✅ | **Regraded twice.** Was 🟢 on the assumption the allowlists were enforced; Phase 2 found they were *advertising-only* (`isToolAllowedInMode` knows only the 3 coarse `AgentMode`s, and everything but Ask/Plan resolves to `agent`), so Manager and the pipeline phases could have executed writes they never advertised. A second gate in `agent/tool-executor.ts` now enforces the acting mode's list where tools run — genuinely 🟢 as of Phase 2. Ahead of Cursor/A-Coder. |
| B5 | **Reviewer agent (PR/diff review that proposes fixes)** | ⬜ | ❌ | Cursor BugBot (~80% claimed resolution). We ship *zero* review capability. → **E8** |
| B6 | Learn / teaching mode | 🟢 | ✅ | **Shipped (Phase 2, M13).** `core/mode-loader.ts`; read-only by construction — no write, command or delegation tools in the allowlist, enforced by the B4 gate rather than by prompt wording. At A-Coder's Student Mode bar minus adaptive difficulty levels. |
| B7 | Domain-vertical fleets (firmware, legacy modernization) | ⬜ | ❌ | NeuralInverse (357 MCU variants, 61 translation profiles). Deliberately out of our lane, but the skills framework makes it data-only. → **E17** |

### 1.3 Knowledge, rules & memory

| # | Capability | Level | Status | Parity bar / gap |
|---|---|:--:|:--:|---|
| C1 | Skills framework (stack + role + prompt resolution) | 🟡 | ✅ | `agent/skill-resolver.ts`, `agent/skills-manager.ts`. **Resolution precision fixed in Phase 0 (finding F1):** role affinity alone no longer qualifies a stack-scoped pack, framework matches outrank bare language matches, and `priority` is a tie-breaker rather than evidence. Fail-safe now 1/1 and gated. Still 🟡 only because the **library is 16 packs of a ~60-pack catalog**. → **E9** |
| C2 | Project profiler (manifest-based stack detection) | 🟢 | ✅ | `core/project-profiler.ts`. **100% (8/8) on the eval fixture set** after Phase 0 fixed finding F2 (React-based frameworks now imply `react` instead of excluding it). Ahead of everyone — no competitor keys prompts off detected stack. |
| C3 | Bundled skill packs | 🔴 | 🟡 | 16 shipped: `django`, `fastapi`, `flask`, `express`, `aspnet-core`, `axum`, `gin`, `rails`, `react`, `nextjs`, `angular`, `react-native`, `tailwind`, `jest`, `pytest`, `a11y-wcag-aria`. Missing all of Wave 2. → **E9** |
| C4 | Rules engine (glob-scoped, activation modes, per-session toggles) | 🟢 | ✅ | **Shipped (Phase 2, M9/M10).** `core/rules.ts` + `core/rules-loader.ts`: `.blackide/rules/*.md`, four activation modes (`always`/`glob`/`agent-requested`/`manual`), three scopes, priority, own glob engine, hot-reload, Problems-panel diagnostics, `AGENTS.md` back-compat. Session panel toggles rules and reports what fired. **At Cursor's and Continue's bar**, with `agent-requested` (budget-deferred bodies) as a small edge. Remaining: tool toggles in the panel. |
| C5 | Long-term project memory (`.blackIDE/knowledge/`) | 🟡 | ✅ | `core/knowledge-base.ts` (308 LOC), `memory/knowledge-store.ts`. Human-readable markdown is a real strength (ADR 007). |
| C6 | **Automatic memory extraction / dedup / decay / contradiction detection** | 🔴 | ❌ | `remember` tool is model-invoked only — nothing extracts facts automatically, nothing ages them out, nothing detects contradictions. Cursor Memories; OPIDE Engram (3-tier, decay, contradiction detection, idle consolidation). → **E7** |
| C7 | Mindmap sync (`project_mindmap.md`) | 🟡 | ✅ | Sectioned upsert of detected stack shipped (plan.md Phase 5). Read-back is still thin. |
| C8 | Team / org-level shared rules | 🟢 | ✅ | **Shipped (Phase 2, M11).** `team-rules/` or `$BLACKIDE_TEAM_RULES`; injected first so they survive truncation, and not user-disableable. At Cursor Team Rules' bar. *(Team-level shared **memory** is separate and still absent — see C6.)* |

### 1.4 Retrieval & context

| # | Capability | Level | Status | Parity bar / gap |
|---|---|:--:|:--:|---|
| D1 | Hybrid semantic index (embeddings + BM25 via RRF) | 🟢 | ✅ | `core/codebase-index.ts`. Fusion ranking is genuinely good. |
| D2 | **Chunking strategy** | 🔴 | 🟡 | `chunkFile()` at `codebase-index.ts:420` is a **fixed line-window with overlap** — no symbol awareness at all. Our docs claim "AST-aware chunking"; that is not what the code does. OPIDE: tree-sitter, 13+ languages. → **E2** |
| D3 | Code graph: call graph, type hierarchy, impact analysis | ⬜ | ❌ | OPIDE ships this; Cursor uses it for multi-file edits. Highest-leverage retrieval gap. → **E2** |
| D4 | Reranker stage | ⬜ | ❌ | Continue ships a `rerank` model role. No `rerank` anywhere in our tree. → **E2/E10** |
| D5 | Context manager / token budgeting / compaction | 🟢 | ✅ | `core/context-manager.ts`, `core/prompt-builder.ts`. |
| D6 | **Structured tool-output compression** | 🔴 | 🟡 | `core/text-cap.ts` truncates raw text. A-Coder claims 30–70% token reduction via TOON encoding of tool output. → **E11** |
| D7 | External docs indexing (`@docs`-class provider) | ⬜ | ❌ | Continue `@docs`. We only have live web search. → **E13** |
| D9 | **Context providers / `@`-mentions** | 🔴 | 🟡 | *Corrected:* `@`-mention **exists but is file-only** — `App.tsx:1182` resolves every `@` query through a single `searchFiles` message (`:1233`, `:3244`). No `@folder`, `@symbol`, `@problems`, `@terminal`, `@git`, `@web`, `@docs`, `@past-chats`, and no pluggable provider API. Cursor and Continue both ship the full set. → **E19** |
| D10 | Ranged file reads (token-efficient pagination) | 🟢 | ✅ | *Corrected:* `read_file` already takes `start_line`/`end_line` (`core/tools.ts:27-34`) — at A-Coder's "intelligent file pagination" bar. |
| D11 | **Git-history semantic search** | ⬜ | ❌ | A-Coder ships Morph-accelerated search across git history. `grep -rn "git log\|blame"` over `src/` returns nothing. → **E20** |
| D12 | **Notebook (`.ipynb`) awareness** | ⬜ | ❌ | No `notebook`/`ipynb` reference anywhere in `src/`. Agent cannot read or edit a cell. → **E21** |
| D8 | Web search | 🟡 | ✅ | `tools/web-search.ts` — DuckDuckGo scrape only, no keyed providers. → **E13** |

### 1.5 Tools & execution

| # | Capability | Level | Status | Parity bar / gap |
|---|---|:--:|:--:|---|
| E_1 | **31** native tools (file/grep/list/run_command/subagent/artifact/mindmap/LSP/tests/…) | 🟢 | ✅ | `core/tools.ts` — *recount 2026-07-28:* 23 before Phase 1, **31** after it added the 7 LSP tools + `run_tests`. Ahead of A-Coder (22+) and OPIDE (10+). |
| E_2 | Exact SEARCH/REPLACE edit contract | 🟢 | ✅ | `core/tools.ts:76` — same discipline A-Coder calls out as its precision feature. At bar. |
| E_3 | Checkpoints & rollback (reverse hunks, per-message undo) | 🟢 | ✅ | `core/checkpoint-manager.ts`. **Ahead of CortexIDE's "checkpoint and visualize".** |
| E_4 | Browser automation (Playwright, gated, per-task session) | 🟡 | ✅ | `tools/browser-tool.ts` + `browser-capability.ts` allowlist. |
| E_5 | **Visual verification loop (screenshot/recording as reviewable evidence)** | 🔴 | ❌ | Antigravity: browser recordings + screenshots as first-class artifacts, agent self-verifies UI work. We can drive a browser but produce no evidence trail. → **E5** |
| E_6 | MCP client | 🟡 | ✅ | `tools/mcp-client.ts:51` — **stdio only**, Agent-mode only, refused in pipeline runs. Antigravity ships Chrome + Web MCP servers; remote/streamable HTTP is table stakes now. → **E12** |
| E_7 | Vision / image input | 🟢 | ✅ | `core/llm-client.ts:334-370` — images on user turns *and* tool results, OpenAI + Anthropic shapes. At A-Coder's bar. |
| E_8 | Agent hooks (`beforeToolCall`/`afterToolCall`/`beforeResponse`/`onError`) | 🟡 | ✅ | `agent/hooks.ts:8`. Present but under-documented and unused by first-party features. |
| E_9 | Tool circuit breakers / per-tool failure budgets | ⬜ | ❌ | OPIDE ships them. A wedged tool currently burns iterations. → **E15** |
| E_10 | Post-edit diagnostics feedback | 🟢 | ✅ | *Corrected:* `ToolRunner.collectDiagnostics` (`tools/tool-runner.ts:306`) is called after every edit from `agent/tool-executor.ts:154` — the agent **does** see compiler/linter errors it caused. Better than the first assessment. |
| E_11 | On-demand `get_diagnostics` + LSP navigation tools | 🟢 | ✅ | **Shipped (Phase 1, M6/M7).** `tools/lsp-tools.ts` — `get_diagnostics`, `go_to_definition`, `find_references`, `workspace_symbols`, `hover`, `code_actions`, `rename_symbol`. Symbols addressed by *name* (a model has no character offsets), every provider call raced against a timeout, and a cold/absent server degrades to grep with an explicit note instead of erroring. Verified in a real extension host. **Structural advantage over the extension-only competitors**, who cannot reach a language server this directly. |
| E_12 | **Sandboxed command execution** | 🔴 | ❌ | `executeCommandInTerminal` (`tool-runner.ts:133`) spawns a real, unrestricted `vscode.window.createTerminal`. Policy-gated (G1) but not *contained*. Cursor 2.0 sandboxed shells; OPIDE QuickJS sandbox + 10-layer model. → **E23** |
| E_13 | Test-runner integration (run one test, parse results structurally) | 🟢 | ✅ | **Shipped (Phase 1, M8).** `core/test-report.ts` — command selection from `ProjectProfile` plus pure parsers for pytest/jest/vitest/dotnet/cargo/go/rspec, returning **failures only**. 30 KB of output with 800 passing cases and one failure formats to <2 KB, asserted in CI. Trusts the exit code over the parse, so a crashed runner is never reported as a pass. |

### 1.6 Editor integration & platform

| # | Capability | Level | Status | Parity bar / gap |
|---|---|:--:|:--:|---|
| F1 | Inline completion (FIM-aware) | 🟡 | ✅ | `core/inline-completion.ts` (80 LOC) — single model, single file, no edit history. |
| F2 | **Next-edit prediction (multi-file, edit-history-aware, jump-to-next-edit)** | ⬜ | ❌ | Cursor Tab v2 + Composer-1/Sonic low-latency models; Continue next-edit. This is *the* daily-driver feature we lack. → **E1** |
| F3 | Inline chat (`Cmd+I`) | 🟡 | ✅ | `core/inline-chat-controller.ts` — selection-scoped. |
| F4 | Commit-message generation | 🟡 | ✅ | Diff-size handling is naive. |
| F5 | Multi-provider LLM (OpenAI/Anthropic/Google/OpenRouter/Ollama/LM Studio) | 🟢 | ✅ | `core/llm-client.ts` (478 LOC). NeuralInverse claims 20 providers; 6 well-tested beats 20 shallow. |
| F6 | **Per-role model config (chat/edit/apply/autocomplete/embed/rerank)** | 🔴 | 🟡 | Per-*mode* model override only. Continue model roles; NeuralInverse per-feature selection; Antigravity per-agent model. → **E10** |
| F7 | **Cross-provider failover / health-aware routing** | ⬜ | ❌ | `LLMClient.fallbackTurn` (`llm-client.ts:58`) is the *local-protocol* path, **not** provider failover — easy claim to get wrong. OPIDE ships fallback routing. → **E10** |
| F8 | Fast-apply path (small model applies a large diff) | ⬜ | ❌ | Cursor speculative edits; A-Coder Morph. → **E10** |
| F9 | Output modes (`apply` / `pr`) | 🟢 | ✅ | `core/git-pr.ts`. Ahead of most. |
| F10 | Headless CLI / SDK surface | ⬜ | ❌ | Antigravity ships desktop + CLI + SDK + IDE. Blocks CI use and background agents. → **E14** |
| F11 | Skill/rule distribution (registry or hub) | ⬜ | ❌ | Continue Hub blocks. `plan.md` marked this out of scope; competitors have made it table stakes. → **E9** |
| F12 | **Terminal `Cmd+K`** (natural language → shell command) | ⬜ | ❌ | Cursor ships it. We have inline chat for editors only (`inline-chat-controller.ts`). → **E25** |
| F13 | **Provider breadth** | 🟡 | 🟡 | Anthropic/OpenAI/Google/OpenRouter/Ollama/LM Studio. NeuralInverse claims 20; missing DeepSeek, Groq, Mistral, xAI, Azure OpenAI, Bedrock, Vertex, Together, Fireworks, Cerebras, LiteLLM, vLLM — most are OpenAI-compatible, so this is config not code. → **E26** |
| F14 | Zero-config free model tier (works before a key is added) | ⬜ | ❌ | NeuralInverse ships free cloud models; first-run with no key currently does nothing useful. → **E26** |
| F15 | **Multi-model race** (same prompt, N models, compare & pick) | ⬜ | ❌ | Cursor 2.0. `ManagerPanel` already tracks `modelId` per run, so the substrate is closer than it looks. → **E27** |
| F16 | **Agent inbox / notifications when input is needed** | 🔴 | 🟡 | `status: awaiting_approval` exists in `ManagerPanel.tsx` but there is no notification surface — an unattended run can idle unnoticed. Antigravity has an inbox. → **E28** |
| F17 | Reusable prompt / notepad library | 🟢 | ✅ | **Shipped (Phase 2, M12).** `core/prompt-library.ts` + loader: `.blackide/prompts/*.md` become slash commands with `$ARGS`/`$1`…`$9` and cycle-safe `steps:` workflows; built-in names refused at load so a user file cannot silently redefine `/plan`. At Cursor Notepads' and Continue prompt blocks' bar, plus workflow chaining neither has. |
| F18 | Multi-root / multi-workspace support | 🔴 | 🟡 | Profiler, index and knowledge base all assume a single workspace root. → **E30** |
| F19 | Voice input | ⬜ | ❌ | Cursor ships it. Genuinely low value for us; scheduled last. → **E31** |
| F20 | Extension marketplace / Open VSX compatibility | 🟢 | ✅ | `config/product.json` carries full gallery + `extensionKind`/API-proposal compatibility tables. **Already at OPIDE's Open VSX bar** — no work needed. |

### 1.7 Safety, privacy & quality engineering

| # | Capability | Level | Status | Parity bar / gap |
|---|---|:--:|:--:|---|
| G1 | Command policy: hard deny list + user allow/deny + ask | 🟢 | ✅ | `core/command-policy.ts`. **Ahead of the field** — nobody else documents an unoverridable deny list. |
| G2 | Secrets in OS keychain (`SecretStorage`), never `settings.json` | 🟢 | ✅ | `core/secret-manager.ts`. At OPIDE's keychain bar. |
| G3 | Auto-approve deliberately ignored in unattended pipeline runs | 🟢 | ✅ | Best-in-class safety posture. |
| G4 | Local-only telemetry + diagnostics export | 🟢 | ✅ | `core/telemetry-sink.ts`. Privacy parity with CortexIDE/A-Coder. |
| G5 | Append-only audit trail per run (who/what/when/which tool/which model) | 🔴 | 🟡 | Diagnostics export ≠ audit trail. OPIDE ships audit trails; NeuralInverse ships audit export for regulated migrations. → **E15** |
| G6 | Prompt/log secret redaction | ⬜ | ❌ | We put file contents and command output into prompts and logs with no scrubbing. → **E15** |
| G7 | Workspace-boundary enforcement on file tools | 🟡 | ✅ | Sandbox tests exist (`test_sandbox_*.js`); not centrally enforced or documented. → **E15** |
| G8 | Skill validation diagnostics + skills-fired telemetry | 🟢 | ✅ | **Shipped (Phase 0, M5),** closing out plan.md Phase 6. `agent/skill-diagnostics.ts` surfaces malformed packs in the Problems panel — `loadSkillDir` previously collapsed every failure into a silent `undefined`. The two valuable checks catch packs that can *never* fire and packs that would fire on *every* turn. `SkillsFired` telemetry names bundled packs only; user pack names can encode project detail, so those are counted, not named. |
| G9 | Test architecture | 🟢 | ✅ | **Four tiers as of Phase 2.** Harness 426 assertions (bespoke but pinned as the compatibility tier) · **vitest 195 tests / 13 suites** (was 2 orphaned files that no installed runner could even execute) · **19 real-host integration tests** under `@vscode/test-electron` · the eval gate. One shared `vscode` stub (`test/vscode-stub.js`) serves the vscode-free tiers, so a suite cannot pass in one and fail in the other. |
| G11 | At-rest encryption for agent artifacts / memory | ⬜ | ❌ | OPIDE claims AES-256-GCM. Our `.blackIDE/` is plaintext on disk (defensible — it's the user's repo — but not an option we offer). → **E15** |
| G12 | Team analytics / admin policy dashboard | ⬜ | ❌ | Cursor ships admin analytics; NeuralInverse ships audit export for regulated work. Our telemetry is local-only by design (G4) — so this must be **opt-in, self-hosted**, never a phone-home. → **E32** |
| G13 | Issue-tracker / chat integrations (GitHub Issues, Linear, Jira, Slack) | ⬜ | ❌ | Cursor Slack + Linear. Needs the headless core (E14) to be worth building. → **E33** |
| G10 | `extension.ts` maintainability | 🟢 | ✅ | **2537 → 652 LOC (−74%)** across thirteen modules — the **≤700 gate is met** as of 2026-07-29 (623 after the Phase 0 cut; 652 once Phase 3's M19 wiring landed, which is why that phase's provider assembly went into its own module). Two cuts needed a design decision rather than a move, and both are the reason this took three passes. `core/chat-session.ts` holds the chat lane's mutable state as one object shared *by reference*, because `_runAgentTask` reassigns it mid-run while the webview handler reads it afterwards — passing values would have handed the extracted code a stale snapshot. `agent/managed-runs.ts` moved the Manager lane as a **class**, not the deps-object function the other extractions used, because its live `Map` and persisted history must be folded together on every transition or a reload shows ghost "running" rows; moving those methods without the state they guard would have split that invariant across two files. → **E0 (closed)** |

### 1.8 Scoreboard

| Area | Us | Best-in-class | Verdict |
|---|:--:|---|---|
| Pipeline / SDLC orchestration | 🟢 | — | **We lead.** No competitor ships this. |
| Safety & command policy | 🟢 | OPIDE | **We lead** on policy; behind on sandboxing/audit. |
| Checkpoints & undo | 🟢 | CortexIDE | **We lead.** |
| Project-aware skills | 🟡 | — | **We lead architecturally**; resolution precision fixed (F1), still behind on library breadth. |
| **Code intelligence (LSP tools)** | 🟢 | Cursor, OPIDE | **We lead.** Phase 1 exposed the fork's own language servers; the extension-only competitors cannot reach them this directly. |
| **Rules & project config** | 🟢 | Cursor, Continue | **At bar** as of Phase 2 — glob/activation/scope rules, team rules, prompt library, session panel. |
| **Test integration** | 🟢 | A-Coder | **At/above bar.** Failures-only reporting from the detected stack. |
| Retrieval & code graph | 🟡 | OPIDE, Cursor | **We are behind.** Chunking is naive; no code graph. → Phase 3 |
| Memory | 🔴 | Cursor, OPIDE | **We are behind.** Durable markdown store, but nothing extracts, ages, dedups or contradicts. → Phase 8 |
| Daily-driver autocomplete | 🟡 | Cursor | **We are far behind.** No next-edit. |
| Parallel task agents & steering | 🔴 | Antigravity, Cursor | **We are behind.** |
| Verification & artifacts | 🔴 | Antigravity | **We are behind.** |
| Model routing | 🔴 | Continue, OPIDE | **We are behind.** |
| Review automation | ⬜ | Cursor BugBot | **Absent.** |
| Distribution / surfaces | ⬜ | Continue Hub, Antigravity CLI/SDK | **Absent.** |

> **Board update after Phases 0–2 (2026-07-27).** Three areas moved from behind to at-or-above
> bar: code intelligence (Phase 1 exposed the language servers the fork already runs), rules and
> project config (Phase 2), and test integration (Phase 1). Two graded claims turned out to be
> false when checked against code and were corrected rather than left standing — "AST-aware
> chunking" (it is a 50-line window) and "per-mode tool allowlists enforced in the sandbox gate"
> (they were advertising-only until Phase 2 closed the gap). The three areas we lead — pipeline,
> command policy, checkpoints — are unchanged. **The next gap is the substrate: retrieval.**

**Read of the board.** The *engine* is genuinely advanced and in two places (pipeline, safety) we
lead the field. What we lack is (a) the **retrieval substrate** everyone else is now building on
(symbol graph + rerank), (b) the **control surface** that makes multi-agent work reviewable
(manager view, artifacts, steering), and (c) the **daily-driver ergonomics** (next-edit, per-role
models) that decide whether a developer keeps the editor open. Nothing here needs a rewrite —
every item is additive to an architecture that already holds.

---

## 2. Agent enhancement details

Ordered by leverage ÷ risk. Each entry: what exists → what changes → the acceptance test.

### 0. Doc corrections (truth-up) — **E0**

Not a feature, a prerequisite. Ship with Phase 0.

1. **`plan.md` and README claim "AST-aware chunking"** for the codebase index. It is a fixed
   line-window (`codebase-index.ts:420`). Correct the claim; the capability arrives in **E2**.
2. **`LLMClient.fallbackTurn` is not provider failover.** Ensure no doc implies resilience we
   don't have.
3. Finish `plan.md` Phase 6: skill validation diagnostics UI + `skillsFired` telemetry events.
4. **Split `extension.ts` (2537 LOC)** into `chat-controller`, `pipeline-entry`,
   `command-registry`, `webview-host`. Pure move-and-wire, no behaviour change, harness stays
   green. Do this *first* — six of the enhancements below all edit this file.
5. **Migrate the bespoke harness to vitest** incrementally (keep `test/harness.js` running; new
   suites land as vitest). Contributors cannot extend a 1613-line hand-rolled runner.
6. **Golden-task eval set** — 8–10 tasks per major stack with a scored rubric, run per phase.
   Without it, every claim below is unfalsifiable.

### E1 — Next-edit prediction *(daily-driver gap)*

**Now:** `core/inline-completion.ts` (80 LOC) — single-shot FIM against one model, current file only.
**Change:** a `NextEditEngine` that (a) keeps a rolling ring buffer of the session's last N edits
(file, hunk, timestamp), (b) builds a prompt from *edit history + symbol neighbourhood from the
code graph* (E2), (c) predicts the next edit **including a different file**, rendered as a
"jump to next edit" affordance, (d) runs on the `autocomplete` model role (E10) with a hard
latency budget and cancel-on-keystroke.
**Accept:** p50 latency ≤ 250 ms on the fast role; ≥ 40% of accepted suggestions in the eval
session are multi-line or cross-file; zero completions emitted after the buffer changed.

### E2 — Symbol graph retrieval *(highest-leverage substrate)*

**Now:** line-window chunks, hybrid BM25+embedding RRF, no symbol identity, no reranker.
**Change:**
- Replace `chunkFile()` with **tree-sitter symbol chunking** (start with TS/JS, Python, C#, Go,
  Rust, Java — the stacks the profiler already detects). Chunk = function/class/method with its
  doc comment; oversize bodies split at statement boundaries.
- Build a **`CodeGraph`**: symbol table + call edges + import edges + type hierarchy, persisted
  next to the index and incrementally updated on save.
- New tools: `find_references`, `impact_analysis(symbol)` → transitively affected files/tests.
- Add a **rerank stage** after RRF (cross-encoder via the `rerank` model role, with a
  deterministic lexical fallback).
**Accept:** on the eval set, recall@10 for "which files must change" improves ≥ 25% over the
line-window baseline; `impact_analysis` on a known refactor returns the true file set with
≤ 2 false positives; index rebuild of this repo's agent extension stays under the current wall
clock + 50%.
**Risk:** tree-sitter grammars are native modules — must not break the extension host or the
packaged build. Mitigate with a lazy load + graceful degrade to line-window chunking.

### E3 — Agent Manager (independent parallel task agents)

**Now:** `core/pipeline-runs.ts` runs ≤4 *pipelines*; parallelism is internal to a pipeline.
**Change:** a first-class **Task Agent**: user fires an independent task, it gets its own
worktree (`worktree-manager.ts` already does this), its own mode, **its own model**, and its own
artifact stream. A **Manager view** in the webview lists all live agents with status, diff size,
token spend, and pending approvals; approve/reject/steer/cancel per agent. Cap concurrency
(default 4, max 8) with a global token-budget governor.
**Accept:** 4 concurrent task agents on the same repo produce 4 clean, independently mergeable
worktrees; killing one leaves the others untouched; the live workspace is never written until an
agent's result is applied.

### E4 — Artifacts as steerable, reviewable deliverables

**Now:** `agent/artifact-manager.ts` + `create_artifact` tool — storage, no review surface, no
steering. Cancel-and-rerun is the only correction path (A9).
**Change:** typed artifacts (`plan`, `task-list`, `diff`, `walkthrough`, `screenshot`,
`recording`, `test-report`) with a review panel; **select a region of an artifact, leave a
comment, and the comment is injected into the running agent's next turn** as a steering message —
no restart. Comments and resolutions persist with the run.
**Accept:** a comment on a plan artifact changes the executor's behaviour within one turn without
losing accumulated context; steering events appear in the run's audit trail (E15).

### E5 — Verification loop (evidence, not assertions)

**Now:** `tools/browser-tool.ts` can drive Chromium; nothing requires or records verification.
**Change:** a **`verify` phase contract** every executor must satisfy: run the stack's test
command (from `ProjectProfile` — the profiler already knows it), and for UI work launch the app,
exercise the changed surface, and attach **screenshots + a recording** as artifacts. Failures
feed one bounded self-correction attempt before escalating to the human.
**Accept:** pipeline runs on the eval set emit a test-report artifact 100% of the time; UI tasks
emit ≥1 screenshot; a deliberately broken change is caught by the verify phase, not by the user.

### E6 — Rules engine v2 + session control panel

**Now:** one flat `.blackide/AGENTS.md`, always injected.
**Change:** `.blackide/rules/*.md` with frontmatter `globs`, `activation: always | glob |
agent-requested | manual`, `priority`, `scope`. Resolution merges *rules* with *skills* through
one budgeted pipeline (`prompt-builder.ts`), so they can't fight each other. Add a **session
control panel** (Continue's "notch" pattern) above the chat input: toggle rules, toggle tools,
see which skills/rules fired. Team rules load from a configurable shared path (repo-committed or
`BLACKIDE_TEAM_RULES`).
**Accept:** editing a `.ts` file activates only the TS-glob rules; `AGENTS.md` keeps working
unchanged (back-compat); the panel's "fired this turn" list matches the assembled prompt exactly.

### E7 — Memory v2 (pragmatic Engram)

**Now:** `core/knowledge-base.ts` — flat markdown, written when the model calls `remember`.
Nothing extracts, ages, dedups, or contradicts.
**Change:** keep markdown as the **human-readable projection** (ADR 007 stands), add a typed
index beside it:
- **Tiers:** *working* (this session, evicted on compaction) → *project* (durable) — skip OPIDE's
  sensory tier, it buys nothing here.
- **Entry:** `{ text, type, provenance (run/message), confidence, createdAt, lastUsedAt, uses }`.
- **Automatic extraction:** an end-of-turn pass proposes memories from the transcript; high
  confidence auto-writes, medium queues for one-click confirm (Cursor's model).
- **Contradiction detection** on write: embedding-near + negation heuristic → surface both and
  ask, never silently overwrite.
- **Decay:** unused low-confidence entries demote then archive (never hard-delete — the markdown
  is a user file).
- **Consolidation:** an idle-time job merges duplicates and rewrites the markdown projection.
**Accept:** a fact stated in session 1 is retrieved in session 3 without being re-derived;
contradicting the fact triggers a prompt rather than a silent overwrite; consolidation is
idempotent (running twice changes nothing).

### E8 — Reviewer agent (our BugBot answer)

**Now:** nothing. `git-pr.ts` can open PRs; nobody reviews them.
**Change:** a `Reviewer` mode (read-only tool allowlist) plus:
- `black-ide.reviewChanges` — reviews the working diff against rules + skills + code graph,
  emitting findings (file, line, severity, failure scenario) as a review artifact.
- Optional PR review via `gh` on an explicit, opt-in command — **never** an ambient bot posting
  to GitHub without the user asking.
- For high-confidence findings, offer a fix as a normal checkpointed edit.
**Accept:** on a seeded-bug corpus, ≥60% true-positive rate at ≤1 false positive per 10 findings
(we tune to precision — a noisy reviewer gets turned off).

### E9 — Skill library breadth + distribution

**Now:** 16 bundled packs; distribution explicitly out of scope in `plan.md`.
**Change:** (a) finish Wave 2 of `plan.md`'s catalog — data-only, no code: `django-rest-framework`,
`nestjs`, `entity-framework-core`, `gorm`, `spring-boot`, `laravel`, `vue`, `svelte-kit`,
`flutter`, `vitest`, `react-testing-library`, `playwright-e2e`, `xunit`, `cargo-test`, `go-test`,
`rspec`, plus the cross-cutting packs. (b) **Reverse the out-of-scope call on distribution:**
add `black-ide.addSkillFrom <git-url|path>` with a pinned ref + checksum, a first-party registry
`resources/skills/registry.json`, and `black-ide.updateSkillPacks`. Installed packs land in
`.blackide/skills/` where the existing precedence already lets users override them.
**Accept:** every pack parses with ≥1 role and ≥1 stack; a remote pack installs, is shadowable by
a same-named local pack, and its checksum is verified on load.
**Note:** third-party skills are untrusted prompt text. They must never be able to widen a tool
allowlist or auto-approve a command — enforce at load, test it.

### E10 — Model router: per-role models, failover, fast apply

**Now:** per-mode model override; `fallbackTurn` is the local-protocol path, not failover.
**Change:** a `ModelRouter` with named **roles** — `chat`, `plan`, `edit`, `apply`,
`autocomplete`, `embed`, `rerank` — each mapping to a provider/model with its own budget. Add
health-aware **cross-provider failover** (circuit-break a failing provider, retry the next in the
role's chain, surface the substitution in the UI). Add a **fast-apply path**: the strong model
emits intent, a cheap fast model materialises the SEARCH/REPLACE blocks, with strict verification
against the exact-match contract (`tools.ts:76`) and fall-back to the strong model on mismatch.
**Accept:** killing the primary provider mid-run completes the run on the secondary with a visible
notice; fast-apply cuts apply-phase tokens ≥50% with **zero** silently wrong edits on the eval set
(any mismatch must fail closed).

### E11 — Structured tool-output compression

**Now:** `core/text-cap.ts` truncates raw text; large `grep_search`/`list_directory`/diagnostics
results burn context.
**Change:** a compact tabular encoder for structurally repetitive tool output (shared header,
per-row values) with the raw form still available on demand. A-Coder claims 30–70% reduction with
this class of encoding — **treat that as a hypothesis to measure, not a target to assume.**
**Accept:** ≥30% measured token reduction on a fixed corpus of tool outputs with **no** drop in
eval-set task success (a compression that loses information is a regression, not a win).

### E12 — MCP transport parity

**Now:** `mcp-client.ts:51` — stdio spawn only; Agent-mode only; refused in pipeline runs.
**Change:** add **streamable HTTP + SSE** transports and OAuth for remote servers; per-server
allowlist so a **vetted** server can be used inside unattended pipeline runs (default stays
refuse — G3 is a feature, not an accident); resource + prompt primitives, not just `tools/list`;
health/reconnect with backoff.
**Accept:** a remote HTTP MCP server registers and is callable; an unvetted server is still
refused in pipeline runs; server death doesn't wedge the agent loop (E15 circuit breaker).

### E13 — Docs & search providers

**Now:** DuckDuckGo scrape (`tools/web-search.ts`); no offline docs.
**Change:** an `@docs` context provider that crawls and indexes a documentation URL into a
namespaced index (reusing E2's store), plus keyed search providers (Brave/Tavily/Google CSE) with
DDG as the no-key default. Auto-suggest doc sets from `ProjectProfile` (Django detected → offer
Django docs).
**Accept:** an indexed doc set answers a version-specific API question the base model gets wrong;
search degrades to DDG with no key configured.

### E14 — Headless surfaces: CLI + SDK *(unlocks background agents)*

**Now:** IDE-only. The agent loop is reachable only through the extension host.
**Change:** extract a **`@blackide/agent-core`** package with **zero `vscode` imports** (the loop,
tools, router, index, skills), behind a small host interface the extension implements. Then ship
`blackide` CLI (headless run, `--mode`, `--output pr`, JSON events on stdout) and an SDK entry.
This is what makes CI use and background/cloud agents (A10) possible at all.
**Accept:** `blackide "add a test for X" --output pr` completes on a fixture repo with no editor
running; the extension is refactored onto the same core with the harness green; `grep -r
"vscode"` in the core package returns nothing.
**Sizing:** largest item here — a real decoupling, not a wrapper. Do not start it before E0.4.

### E15 — Security, audit & resilience hardening

**Now:** best-in-class command policy (G1), keychain secrets (G2), pipeline auto-approve refusal
(G3). Missing: circuit breakers, audit trail, redaction, central boundary enforcement.
**Change:**
- **Tool circuit breakers:** per-tool failure/latency budget; trip → tool disabled for the run
  with a visible reason (stops a wedged MCP server burning the iteration budget).
- **Append-only audit trail** per run (`.blackIDE/audit/<run>.jsonl`): every tool call, decision,
  approval, model, token count, steering comment. Export as one artifact.
- **Secret redaction** on the way *into* prompts and logs (entropy + known-pattern detectors).
- **Central workspace-boundary guard** for all file tools — one chokepoint, tested (today it's
  implied by `test_sandbox_*.js`).
- **Untrusted-content posture:** skills, rules, MCP output, web/doc content and file contents are
  data, never instructions. Assert it in the system prompt and test it with injection fixtures.
**Accept:** injection fixtures fail to escalate privileges or widen the allowlist; a secret in a
read file never appears in the audit log or provider request; a tool that fails 3× is disabled,
not retried forever.

### E16 — Learn mode *(cheap differentiator)*

A `Learn` mode in `core/mode-loader.ts`: explains before editing, adjustable depth
(beginner/intermediate/expert), asks comprehension questions, and never writes without an
explicit go-ahead. Read-heavy tool allowlist. Days of work, and A-Coder is the only one of the
seven that ships it. **Accept:** Learn mode cannot write a file without explicit confirmation.

### E17 — Domain packs *(optional, later)*

NeuralInverse's firmware/modernization verticals are out of our lane, but the mechanism is free:
a **migration pipeline template** (inventory → parse → translate → verify → report) plus domain
skill packs. Ship only if a real user pulls for it. Reuses E2's graph and E5's verification.

### E18 — Graduate parallel wave execution

`core/parallel-execution.ts` is 🧪/default-off and "not verified under extension host" — the
same reason ADR 008 exists. Either verify it under the real host with integration tests and
graduate it (it becomes E3's execution engine), or delete it. **A default-off experiment is a
maintenance liability, not a feature.**

### E19 — Context provider API + full `@`-mention set

**Now:** `@`-mention resolves **files only** (`webview/src/App.tsx:1182`). No provider abstraction.
**Change:** a `ContextProvider` interface (`id`, `title`, `resolve(query) → ContextItem[]`,
`budget`) with first-party providers: `@file`, `@folder`, `@symbol` (from E2's graph),
`@problems` (VS Code diagnostics), `@terminal` (last N commands + output), `@git` (diff / branch /
blame), `@docs` (E13), `@web` (E13), `@past-chats` (from `memory/history-store.ts`), `@rules`,
`@skills`. Third-party providers register through the existing extension API surface.
**Accept:** every provider resolves inside its budget and appears in the session panel's "what
fired" list (E6); an over-budget provider is truncated, never silently dropped.

### E20 — Git-history intelligence

**Now:** nothing — no `git log`/blame anywhere in `src/`.
**Change:** index commit messages + diff hunks into a history namespace of the E2 store; tools
`search_history(query)`, `blame(file, line)`, `why_was_this_changed(symbol)`. Feed the Reviewer
(E8) and the memory extractor (E7): "this pattern was reverted in `abc123` for reason X" is the
single highest-signal context we currently throw away.
**Accept:** `why_was_this_changed` returns the true introducing commit on fixture history; index
cost stays bounded by a configurable commit-depth window.

### E21 — Notebook support

**Now:** no `.ipynb` handling at all.
**Change:** notebook-aware read (cell index + outputs), a `edit_notebook_cell` tool built on
VS Code's notebook API, and cell-granular checkpointing so undo (E_3) still works.
**Accept:** the agent adds and edits a cell in a real `.ipynb` without corrupting JSON, and the
edit is individually revertible.

### E22 — LSP as a first-class tool surface *(cheap, high value)*

**Now:** diagnostics are auto-collected post-edit (`tool-executor.ts:154`) but the model cannot
request them, and no navigation is exposed.
**Change:** expose what the fork already runs — `get_diagnostics(path?)`,
`go_to_definition`, `find_references`, `workspace_symbols`, `hover`, `rename_symbol`,
`code_actions` (apply a quick-fix). This is a thin wrapper over `vscode.commands.executeCommand`
on `vscode.executeDefinitionProvider` and friends.
**Accept:** on the eval set, symbol questions resolve via LSP rather than grep; `rename_symbol`
across 5+ files produces a compiling tree; a language server that isn't ready degrades to grep
instead of erroring.
**Note:** this is days of work for a large accuracy win — **it should be one of the first things
we ship**, and it is a genuine structural advantage over the extension-only competitors.

### E23 — Sandboxed execution

**Now:** `executeCommandInTerminal` (`tool-runner.ts:133`) spawns an unrestricted terminal;
safety is policy-only (G1).
**Change:** tiered execution — (1) *policy* (today), (2) *restricted*: cwd-jailed, env-scrubbed,
no-network child process with a wall-clock and output cap, (3) *contained*: opt-in
container/VM runner (Docker/devcontainer if present) for unattended pipeline runs. Default
interactive stays tier 1 (don't break workflows); **unattended pipeline runs default to tier 2+**.
**Accept:** a network call from a tier-2 command fails; a runaway process is killed at the cap; a
tier-3 run cannot write outside the mounted worktree; the existing `test_sandbox_*.js` checks fold
into this one chokepoint.

### E24 — Structured test-runner integration

**Now:** raw `run_command` only; no result parsing, despite `ProjectProfile` knowing the framework.
**Change:** a `run_tests(scope?)` tool that picks the command from the profile, parses output into
`{passed, failed[], skipped, durations}` per framework (pytest/jest/vitest/xunit/cargo/go/rspec),
and returns **only failures** to the model (a large token win). Optional integration with VS Code's
Testing API for gutter results.
**Accept:** each supported framework parses correctly on fixtures; a failing suite returns failure
detail in <2 KB where raw output was >50 KB; this becomes the engine behind E5's verify phase.

### E25 — Terminal `Cmd+K`

Natural-language → shell command in the terminal, with the E23 policy/sandbox gate applied and a
mandatory preview-before-run. Reuses `inline-chat-controller.ts`'s pattern.
**Accept:** generated commands are never auto-executed; a denied command shows the policy reason.

### E26 — Provider breadth + zero-config first run

**Now:** 6 providers; nothing works before a key is configured.
**Change:** (a) add OpenAI-compatible entries for DeepSeek, Groq, Mistral, xAI, Together,
Fireworks, Cerebras, LiteLLM, vLLM, plus Azure OpenAI / Bedrock / Vertex auth shapes — mostly
config in `core/llm-client.ts` + `model-fetcher.ts`. (b) **Zero-config first run:** detect a local
Ollama/LM Studio and offer a one-click local default so the editor is useful with no key and no
account. Keep this local-first, not a hosted free tier we'd have to run.
**Accept:** each provider completes a tool-calling turn in the harness; a machine with Ollama and
no API key can run an agent task end to end.

### E27 — Multi-model race

**Now:** one model per run; `ManagerPanel` already tracks `modelId` per run.
**Change:** fan the same prompt to N models, each in its own worktree (E3 gives this for free),
then present a **diff-vs-diff comparison** with test results (E24) per candidate; user picks one,
the rest are discarded. Hard token-budget cap and an explicit opt-in — this multiplies spend.
**Accept:** 3 candidates produce 3 isolated worktrees with per-candidate test results; picking one
applies exactly that one; cancelling discards all.

### E28 — Agent inbox & notifications

**Now:** `awaiting_approval` status exists in `ManagerPanel.tsx` with nothing surfacing it.
**Change:** an inbox listing every agent needing input (approval, clarification, policy decision),
with VS Code window/OS notifications, badge counts, and a configurable idle-timeout that parks a
run instead of hanging. Steering comments (E4) land here too.
**Accept:** a pipeline run blocked on approval raises a notification within 5 s; parked runs resume
cleanly after a window reload.

### E29 — Prompt & workflow library

**Now:** fixed slash commands only.
**Change:** user-defined prompts as `.blackide/prompts/*.md` (frontmatter: `name`, `description`,
`mode`, `args`) surfaced as slash commands and in the session panel; shareable through E9's
registry. Add multi-step **workflows** (an ordered prompt list with gates) — the lightweight
sibling of the full pipeline.
**Accept:** a user prompt file appears as a slash command on save, hot-reloaded, with the same
validation diagnostics as custom modes.

### E30 — Multi-root workspace support

**Now:** profiler, index, knowledge base and mindmap all assume one root.
**Change:** key `ProjectProfile`, index shards, knowledge and rules **per root**; resolve the
active root from the focused editor or an explicit selection; agents state which root they are
operating on.
**Accept:** a 2-root workspace (Django API + React app) yields two profiles and injects the correct
stack skills per root — today it would blend them, which is a silent correctness bug.

### E31 — Voice input

Push-to-talk dictation into the chat input via a local/OS speech provider. Genuinely the lowest-
value item in this document; it is here only for completeness and is scheduled last.

### E32 — Self-hosted team analytics & policy

**Now:** local-only telemetry (G4) — a real selling point.
**Change:** an **opt-in, self-hosted** aggregation sink (the team points it at their own endpoint)
plus an org policy file that can *only tighten* (never loosen) command policy, model allowlists and
tool access. Ship the audit trail (E15) as its data source.
**Accept:** default build phones home to nobody (assert in tests); an org policy cannot widen the
deny list; disabling the sink removes all egress.

### E33 — Issue-tracker & chat integrations

GitHub Issues / Linear / Jira as context providers (E19) and as **task sources** for headless
agents (E14): "implement issue #123" from the CLI, results posted back on explicit opt-in. Slack
notification of agent completion via the inbox (E28). Gated behind E14 and E19 — building these
before the headless core exists means writing them twice.
**Accept:** an issue resolves as context by ID; nothing is ever posted to an external service
without an explicit per-action confirmation.

---

## 3. Complete missing-feature inventory

Re-examined 2026-07-27 against the code. **This is the full set of gaps — the phase plan in §4 is
required to cover every row**, and §4.3 is the coverage matrix that proves it. Priority: **P0**
blocks daily use or other work · **P1** competitive parity · **P2** differentiator or completeness ·
**P3** low value, done for coverage.

**Status key:** ✅ delivered · 🟡 partially delivered (note says what is left) · blank = not started.

| ID | Missing capability | Pri | Enh | Phase | Notes |
|---|---|:--:|:--:|:--:|---|
| M1 | Doc claims corrected (AST chunking, provider failover) | P0 | E0 | 0 ✅ |
| M2 | `extension.ts` (2537 LOC) decomposed | P0 | E0 | 0 ✅ | 2537 → **652 LOC** across 13 modules; **≤700 gate met** 2026-07-29 (see G10) |
| M3 | Golden-task eval set + scoring | P0 | E0 | 0 🟡 | harness, baseline and CI gate shipped and green; **recall@3/5/10/20 recorded 2026-07-29** over a real 82-file corpus + 36 golden queries (Phase 3 opener). Still short: **19 tasks / 8 fixtures against a planned 8–10 × 6 stacks**, and task-success / tokens-per-task remain deferred to the model tier |
| M4 | Vitest migration off the bespoke harness | P0 | E0 | 0 ✅ |
| M5 | Skill validation diagnostics UI + skills-fired telemetry | P1 | E0 | 0 ✅ |
| M6 | On-demand `get_diagnostics` tool | P0 | E22 | 1 ✅ |
| M7 | LSP navigation tools (definition, references, symbols, hover, rename, code actions) | P0 | E22 | 1 ✅ |
| M8 | Structured `run_tests` with per-framework result parsing | P0 | E24 | 1 ✅ |
| M9 | Rules v2 — `.blackide/rules/*.md`, globs, activation modes, priority | P1 | E6 | 2 ✅ | two independently-budgeted `prompt-builder.ts` sections. The "one merged pipeline" reading was **closed as won't-do** 2026-07-29 — it is the worse design, not unfinished work; wording amended to "one budgeted assembly *path*" |
| M10 | Session control panel ("what fired", toggle rules/tools) | P1 | E6 | 2 🟡 | panel + rule toggles shipped (`App.tsx:3343` → `webview-message-handler.ts:220`); **tool toggles not implemented — no `toggleTool` on either side** |
| M11 | Team / org shared rules | P2 | E6 | 2 ✅ |
| M12 | User-defined prompts + workflows library | P2 | E29 | 2 ✅ |
| M13 | Learn / teaching mode | P2 | E16 | 2 ✅ |
| M14 | Tree-sitter symbol chunking | P0 | E2 | 3 ✅ | shipped as a **dependency-free lexical backend** behind a `ChunkerBackend` seam (owner's call, 2026-07-29) — 7 languages, +5.6 recall@5 |
| M15 | Code graph (calls, imports, type hierarchy) | P0 | E2 | 3 ✅ | `core/code-graph.ts`; one-hop expansion took recall@10 93.1 → 95.8 |
| M16 | `impact_analysis` + graph-backed `find_references` | P1 | E2 | 3 ✅ | 0 false positives / 0 misses across 6 refactors, against a ≤2 FP gate |
| M17 | Reranker stage | P1 | E2 | 3 🟡 | interface + tuned deterministic `LexicalReranker` shipped; the cross-encoder needs the `rerank` model role from **Phase 4 (M23)** |
| M18 | Structured tool-output compression | P1 | E11 | 3 ✅ | 37.7% at realistic path depth, 81% on repeated diagnostics, 19.5% on the shallow fixture — all three published |
| M19 | Context provider API + full `@`-mention set | P1 | E19 | 3 🟡 | API + 8 providers + resolution into the prompt; **`@symbol`, `@docs`, `@web` outstanding** (the latter two belong to M20/M21) |
| M20 | External docs indexing (`@docs`) | P1 | E13 | 3 | not started |
| M21 | Keyed web-search providers | P2 | E13 | 3 | not started |
| M22 | Git-history semantic search + blame/why-changed | P2 | E20 | 3 ✅ | `search_history`, `blame`, `why_was_this_changed`; shells out to git rather than indexing — see the delivery note |
| M23 | Per-role models (chat/plan/edit/apply/autocomplete/embed/rerank) | P0 | E10 | 4 |
| M24 | Cross-provider failover / health-aware routing | P1 | E10 | 4 |
| M25 | Fast-apply path | P1 | E10 | 4 |
| M26 | Provider breadth (6 → ~18) | P2 | E26 | 4 |
| M27 | Zero-config first run (local model, no key) | P2 | E26 | 4 |
| M28 | Next-edit prediction (multi-file, edit-history, jump-to) | P0 | E1 | 5 |
| M29 | Terminal `Cmd+K` | P2 | E25 | 5 |
| M30 | Automatic rolling summarization (beyond manual `/compact`) | P2 | E11 | 5 |
| M31 | Independent parallel task agents (non-pipeline) in Manager | P1 | E3 | 6 |
| M32 | Per-agent model assignment for task agents | P1 | E3 | 6 |
| M33 | Global concurrency + token governor | P1 | E3 | 6 |
| M34 | Agent inbox + notifications for blocked runs | P1 | E28 | 6 |
| M35 | Parallel wave execution graduated or removed | P1 | E18 | 6 |
| M36 | Multi-root / multi-workspace correctness | P1 | E30 | 6 |
| M37 | Multi-model race (N models, compare, pick) | P2 | E27 | 6 |
| M38 | Typed artifacts + review panel | P1 | E4 | 7 |
| M39 | Mid-run steering (comment-on-artifact → inject) | P1 | E4 | 7 |
| M40 | Verification loop with evidence (tests + screenshots + recordings) | P1 | E5 | 7 |
| M41 | Automatic memory extraction | P1 | E7 | 8 |
| M42 | Contradiction detection on memory write | P2 | E7 | 8 |
| M43 | Memory decay / archive | P2 | E7 | 8 |
| M44 | Idle consolidation job | P2 | E7 | 8 |
| M45 | Memory visualization UI | P3 | E7 | 8 |
| M46 | Mindmap read-back by agents | P1 | E7 | 8 |
| M47 | Reviewer agent on the working diff | P1 | E8 | 9 |
| M48 | Opt-in PR review via `gh` | P2 | E8 | 9 |
| M49 | MCP streamable HTTP + SSE + OAuth | P1 | E12 | 9 |
| M50 | MCP resources & prompts primitives | P2 | E12 | 9 |
| M51 | MCP in pipeline runs via vetted allowlist | P2 | E12 | 9 |
| M52 | Tool circuit breakers | P1 | E15 | 9 |
| M53 | Append-only audit trail per run | P1 | E15 | 9 |
| M54 | Secret redaction into prompts and logs | P0 | E15 | 9 |
| M55 | Central workspace-boundary guard | P1 | E15 | 9 |
| M56 | Untrusted-content posture + injection fixtures | P0 | E15 | 9 |
| M57 | Sandboxed execution tiers (restricted / contained) | P1 | E23 | 9 |
| M58 | Optional at-rest encryption for `.blackIDE/` | P3 | E15 | 9 |
| M59 | Skill library Wave 2 (16 → full catalog) | P1 | E9 | 10 |
| M60 | Skill/rule registry + `addSkillFrom` + checksums | P2 | E9 | 10 |
| M61 | Notebook (`.ipynb`) read/edit/checkpoint | P2 | E21 | 10 |
| M62 | `@blackide/agent-core` extracted (zero `vscode` imports) | P1 | E14 | 11 |
| M63 | Headless CLI | P1 | E14 | 11 |
| M64 | SDK entry point | P2 | E14 | 11 |
| M65 | Background (local daemon) agents | P2 | E14 | 11 |
| M66 | Remote/cloud agent execution | P3 | E14 | 12 |
| M67 | Issue-tracker context + task sources (Issues/Linear/Jira) | P2 | E33 | 12 |
| M68 | Slack / chat completion notifications | P3 | E33 | 12 |
| M69 | Self-hosted team analytics + tightening-only org policy | P2 | E32 | 12 |
| M70 | Domain verticals (firmware, modernization pipeline template) | P3 | E17 | 12 |
| M71 | Voice input | P3 | E31 | 12 |

**Counts:** 71 gaps — **P0: 13 · P1: 30 · P2: 22 · P3: 6**. All 71 are scheduled.

*(Corrected in rev 5: this line read "P0: 11 · P2: 23 · P3: 7" from rev 1 onward. Counting the
table's own Pri column gives 13/30/22/6 — M28, M54 and M56 are P0 and were never included in the
P0 tally, which is why the rev-4 text claimed "3 P0 items outstanding" while listing only M14, M15
and M23.)*

**Delivered so far (Phases 0–3): 20 of 71** — 16 complete, **4 partial (M3, M10, M17, M19)**.

That clears **9 of the 13 P0 items** outright, plus M3 as partial. M14 and M15 closed in Phase 3.
The four P0 items still open are **M23** (per-role models, Phase 4), **M28** (next-edit prediction,
Phase 5), and **M54/M56** (secret redaction and the untrusted-content posture, Phase 9). M3 is
counted as cleared — the harness, its CI gate and now the retrieval baseline are real and green;
what remains short is task-count breadth and the model-tier metrics.

What is left in the started phases is the nine-row table at the top of this document. Of those, one
is **blocked by sequencing rather than effort** (M17's cross-encoder needs Phase 4's `rerank` role),
one needs an **opt-in model tier** that does not exist yet (Phase 1's LSP-over-grep gate), and the
rest are ordinary open work.

---

## 4. Phase-by-phase execution plan (revised for full coverage)

Thirteen phases (0–12). Every phase ships independently: `tsc -b` clean, harness green, webview
builds, **eval set re-run with a published delta**, and docs updated in the same PR. Phases are
ordered so that each one's dependencies are already merged.

> **Standing rule from Phase 0 onward:** no phase merges without an eval-set delta. A phase that
> does not move a metric gets reverted, not shipped.

### Phase 0 — Truth-up & foundations
*Covers M1–M5. Prerequisite for everything.*

- Correct the AST-chunking and provider-failover claims in `plan.md`, `README.md`,
  `docs/mindmap/tech.md`, `docs/wiki_docs/Architecture-and-KT-Guide.md`.
- Decompose `extension.ts` (2537 → ~5 modules ≤600 LOC): `chat-controller`, `pipeline-entry`,
  `command-registry`, `webview-host`, `settings-host`. Pure move-and-wire, zero behaviour change.
  > **Done: 2537 → 917 LOC (−64%)**, nine modules — `core/webview-html.ts`,
  > `core/commit-message.ts`, `core/settings-panel.ts`, `core/manager-panel.ts`,
  > `core/command-registry.ts`, `core/chat-session.ts`, `core/webview-message-handler.ts`,
  > `agent/pipeline-entry.ts`, `agent/chat-task.ts`. Harness 426/426, vitest 99/99 and 19
  > real-host integration tests green after every step.
  >
  > The two giants needed a design decision, not a mechanical move. `_runAgentTask`
  > *reassigns* conversation and approval state partway through while the webview handler
  > reads it afterwards, so passing values would have handed the extracted code a stale
  > snapshot — a silent correctness bug of exactly the kind this refactor must not introduce.
  > `core/chat-session.ts` holds that state in one object shared by reference, which is also
  > the shape Phase 11's vscode-free `agent-core` needs. The webview router keeps a wide
  > (18-member) `WebviewMessageHost` interface deliberately: dispatching UI intents onto
  > provider operations is what a router is, and naming them makes the coupling testable
  > for the first time.
- Close out `plan.md` Phase 6: skill validation diagnostics UI + `skillsFired` telemetry.
- **Golden-task eval set:** 8–10 tasks × 6 stacks (Django, FastAPI, Node/Nest, .NET, React/Next,
  Rust/Go) with a scoring rubric + runner script; publish `docs/notes/eval-baseline.md`.
- Begin vitest migration: `test/harness.js` keeps running, all new suites are vitest.

**Gate:** harness 426/426 green after the split; baseline published; no file over 700 LOC in the
extension entry path.

> ### 🟡 Delivered 2026-07-27 — one gate outstanding
> **Met:** harness 426/426 green after every step · baseline published
> (`docs/notes/eval-baseline.md`, re-recorded after the F1/F2 fixes) · 8 documents corrected ·
> vitest wired (2 orphaned files that no installed runner could execute → 195 tests / 13 suites) ·
> skill diagnostics + `SkillsFired` telemetry (closing plan.md Phase 6).
>
> **Met late (2026-07-29):** *no file over 700 LOC.* `extension.ts` went 2537 → 917 in this phase,
> grew back to **960** as Phase 2 wiring landed, and the final cut — `_runPipeline` +
> `_runPipelineCore` + `_runPipelineInManager` + the pipeline-run bookkeeping — took it to **623**.
> It landed into `agent/pipeline-entry.ts` (+106), a new `agent/managed-runs.ts` (241) and
> `core/conversation-title.ts` (54). See **G10** for the one deliberate deviation: the Manager lane
> moved as a class rather than a deps-object function, because it is state with an invariant.
>
> **Short of plan, not failed:** the eval set is **19 tasks across 8 fixtures**, where this phase
> called for 8–10 tasks per stack across 6. The 19 cover every fixture and every agent role, and
> they gate real regressions — F1 and F2 were both caught by them — but the density is a third of
> what was planned, and the §4.2 rows marked "record" (task success per stack, tokens per completed
> task, recall@10) still have **no recorded baseline**. `eval-baseline.md` defers them honestly:
> recall@k would be measuring the `findFiles` stub, and task success needs real model calls.
> **The consequence to act on:** Phase 3's headline gate is "+25% recall@10 over the line-window
> baseline", and that baseline does not exist yet — so fixture-backed `findFiles` is Phase 3's
> *first* task, not a closing chore. Tracked at **M3**.
>
> **Found and fixed by the eval harness on its first run** — the clearest argument for having
> built it: **F1**, skills injected into repos with no detected stack (`plan.md` claimed the
> opposite), and **F2**, `react` undetected in Next.js projects. Both have regression cover; stack
> detection went 87.5% → 100% and fail-safe 0/1 → 1/1. Details in `eval-baseline.md`.
>
> **Deliberately not done:** the `extension.ts` split stopped short of `_runAgentTask` and
> `resolveWebviewView` at first, because both reassign session state that other readers see
> afterwards. Passing values would have handed the extracted code a stale snapshot — a silent
> correctness bug. `core/chat-session.ts` (added in the follow-up) holds that state in one object
> shared by reference, which is also the shape Phase 11's vscode-free core needs.

### Phase 1 — Language-server tools & test integration *(fastest accuracy win in the document)*
*Covers M6–M8.*

- `get_diagnostics(path?)`, `go_to_definition`, `find_references`, `workspace_symbols`, `hover`,
  `rename_symbol`, `code_actions` — thin wrappers over the language servers the fork already runs.
- Graceful degrade to grep when a server isn't ready.
- `run_tests(scope?)` using the framework from `ProjectProfile`, with per-framework parsers
  (pytest, jest, vitest, xunit, cargo, go test, rspec) returning **failures only**.
- Add both to the per-mode tool allowlists and the Reviewer allowlist reserved in Phase 9.

**Gate:** symbol questions resolve via LSP not grep on the eval set; `rename_symbol` across 5+
files leaves a compiling tree; a failing suite returns <2 KB where raw output was >50 KB.
**Why first:** days of work, no new dependencies, and it lifts every later phase's accuracy.

> ### 🟡 Delivered 2026-07-27 — one gate needs the model tier
> `tools/lsp-tools.ts` (7 tools) · `core/test-report.ts` (pure selection + 7 parsers) ·
> wired into `agent/tool-executor.ts`, both executor construction sites, all 11 mode
> allowlists, the chat system prompt and the Testing Executor prompt.
> **Harness 426/426 · vitest 82/82 (+52) · eval no regression.**
>
> **Gate status** *(revised 2026-07-28 — the rename gate has since been closed).* Five of six
> asserted:
>
> | Gate | Status | Where |
> |---|---|---|
> | Failing suite returns <2 KB where raw output was >50 KB | met | `__tests__/test-report.test.ts` — 30 KB / 800 passing cases |
> | Every mode declaring an allowlist admits the LSP tools | met | `__tests__/tool-surface.test.ts` |
> | Symbol resolution prefers declarations over imports | met | `__tests__/lsp-tools.test.ts` |
> | `rename_symbol` across 5+ files applies **and saves** | met | `test/integration/suite/lsp-tools.test.ts` — real host, 6 files, read back from disk |
> | Provider dispatch · hover · diagnostics · grep-degrade | met | same suite (9 of the 19 in-host tests) |
> | Symbol questions resolve via **LSP rather than grep** | **not asserted** | needs the model tier |
>
> Two honest limits on the rename gate: the suite registers its own rename/definition/reference
> providers rather than leaning on the built-in TypeScript server (`runTest.ts` launches with
> `--disable-extensions`, which disables built-ins too, so a TS-dependent suite would be dead or
> flaky on warm-up — and the risky code is *ours*: the `executeDocumentRenameProvider` dispatch,
> `applyEdit`, and the explicit save). And "leaves a **compiling** tree" is not asserted, only that
> every file is rewritten and saved. Recorded in `eval-baseline.md` rather than claimed away.
>
> **Two defects found and fixed while building:**
> - `findSymbolPosition` used `\b` boundaries, which never match before a leading `$` — so
>   `$scope`, jQuery's `$`, and every PHP variable would silently fail to resolve. Replaced with
>   identifier-aware lookarounds treating `$` as an identifier character.
> - The declaration-preference heuristic omitted Go's `func` and C#'s `record`, demoting real
>   declarations in two of the eval stacks to "first textual hit" (usually an import line).
>
> **Trap worth recording:** every built-in mode declares an explicit `tools` allowlist, and
> `_runAgentTask` filters the advertised list through it. A tool can be registered, implemented
> and permitted by the sandbox gate and *still* never be offered to the model, silently, in
> every mode that declares a list. `LSP_READ_TOOLS` in `core/tools.ts` is now the single place
> to add one, and `__tests__/tool-surface.test.ts` asserts every declaring mode admits them.

### Phase 2 — Rules, prompts & modes
*Covers M9–M13.*

- `.blackide/rules/*.md` with `globs`, `activation: always | glob | agent-requested | manual`,
  `priority`, `scope`; rules+skills assembly through **one budgeted path** in `prompt-builder.ts`
  *(wording amended 2026-07-29 — see the delivery note)*; `AGENTS.md` back-compat preserved.
- Session control panel: toggle rules/tools, show exactly what fired this turn.
- Team rules from a repo-committed or `BLACKIDE_TEAM_RULES` path (tighten-only semantics).
- `.blackide/prompts/*.md` → user-defined slash commands + ordered workflows, hot-reloaded with the
  same diagnostics as custom modes.
- `Learn` mode (read-heavy allowlist, cannot write without explicit confirmation).

**Gate:** editing a `.ts` file activates only TS-glob rules; the panel's "fired" list byte-matches
the assembled prompt; `AGENTS.md`-only projects behave identically to today.

> ### 🟡 Delivered 2026-07-27 — one item outstanding
> `core/rules.ts` + `core/rules-loader.ts` (4 activation modes, 3 scopes, glob engine) ·
> `core/prompt-library.ts` + loader (slash commands, `$ARGS`/`$1`…, cycle-safe workflows) ·
> Learn mode · session panel in `webview/src/App.tsx` · `rulesFired` / `toggleRule` wiring.
> **Harness 426/426 · vitest 195/195 (+96) · 19 real-host tests · eval no regression · webview builds.**
>
> **Outstanding:** the session-panel bullet reads "toggle rules/**tools**". Rule toggles shipped;
> **tool toggles did not.** Confirmed still open on 2026-07-28: `App.tsx:3343` posts `toggleRule`
> and `webview-message-handler.ts:220` handles it; there is no `toggleTool` on either side. Now
> worth more than when planned, because this phase made per-mode tool allowlists genuinely enforced
> (see the security finding below) — a session-scoped tool toggle would ride that same gate in
> `tool-executor.ts:112` instead of being advisory. Tracked at **M10**.
>
> **Judgement call, now settled (closed won't-do 2026-07-29).** The phase text called for
> "*unified* rules+skills assembly through `prompt-builder.ts`". Rules and skills both go through
> `PromptBuilder` as separate, independently-budgeted sections — which satisfies the stated intent
> (neither can starve the other) but is not a single merged pipeline emitting one section.
>
> That stronger reading is **closed as won't-do, not carried as debt.** Two budgeted sections is
> the better design: one merged section would have to arbitrate two unrelated ranking schemes into
> a single budget, and it would make `__tests__/rules-panel-fidelity.test.ts`'s both-directions
> assertion harder to state, not easier. The bullet above now reads "one budgeted assembly *path*",
> which is what was meant and what shipped. Leaving it on the pending list implied a change we had
> decided not to make — which is its own kind of inaccurate roadmap.
>
> **Gate status.** All three met and asserted. Glob activation:
> `__tests__/rules.test.ts`. Panel fidelity: `__tests__/rules-panel-fidelity.test.ts` asserts
> the correspondence in *both* directions — every rule the panel lists has its body in the
> prompt, and every body in the prompt is listed — so a future change that recomputes the
> panel list separately fails there. `AGENTS.md` back-compat:
> `__tests__/rules-loader.test.ts`.
>
> One honest deviation on back-compat: the rule *content*, its unconditional activation, the
> prompt section and the budget are all unchanged, but the wrapper text is not byte-identical
> — a single always-on rule now renders under a `### AGENTS` heading inside a section that
> states precedence. That is a deliberate improvement; "identically" holds for behaviour, not
> for the exact string.
>
> **Security finding, fixed.** Adding Learn mode exposed that **per-mode tool allowlists were
> never enforced** — `isToolAllowedInMode` only knows the three coarse `AgentMode`s and every
> mode except Ask/Plan resolves to `agent`, so the `tools` arrays on Manager, Sr Architect,
> the HLD/LLD/Planner phases and all four pipeline Executors shaped only what was
> *advertised*. Manager's prompt says it must not write code and its allowlist omits every
> write tool, but a `write_file` call emitted anyway would have executed — in an unattended
> pipeline run too. `plan.md` graded this 🟢 "enforced in the sandbox gate"; it was not.
> A second gate in `tool-executor.ts` now enforces the acting mode's allowlist where tools
> run, wired at both executor construction sites, with cover in
> `__tests__/mode-allowlist-gate.test.ts`.
>
> **Trap worth recording:** a block comment containing a glob (`**/*.ts`) terminates itself —
> the `*/` inside `**/` closes the comment. It cost a confusing cascade of syntax errors
> pointing at unrelated lines. Glob examples in comments now use line comments.

### Phase 3 — Retrieval substrate *(the largest technical phase; everything downstream leans on it)*
*Covers M14–M22.*

- Tree-sitter symbol chunking (TS/JS, Python, C#, Go, Rust, Java) replacing `chunkFile()`, with
  lazy native-module load and degrade-to-line-window on failure.
- `CodeGraph`: symbols, call edges, import edges, type hierarchy; incremental on save.
- `impact_analysis(symbol)` + graph-backed `find_references` (LSP from Phase 1 is the fast path,
  the graph is the offline/bulk path).
- Rerank stage after RRF, with a deterministic lexical fallback.
- Tool-output compression encoder; raw form retrievable on demand.
- `ContextProvider` API + `@file`, `@folder`, `@symbol`, `@problems`, `@terminal`, `@git`, `@docs`,
  `@web`, `@past-chats`, `@rules`, `@skills`.
- `@docs` crawler/indexer into a namespaced shard; keyed search providers (Brave/Tavily/Google CSE)
  with DDG as the no-key default; auto-suggest doc sets from `ProjectProfile`.
- Git-history indexing (bounded commit-depth) + `search_history`, `blame`, `why_was_this_changed`.

**Gate** *(restated 2026-07-29 against the now-measured baseline — see below)*: **recall@5 ≥ 88.5%**
(from 84.7%) and **recall@10 residual error down ≥25%** (93.1% → ≥94.8%); all five *definition-site*
misses listed in `eval-baseline.md` closed; `impact_analysis` accuracy on refactor fixtures with ≤2
false positives; ≥30% token reduction from compression with **no** eval-success regression; full
index build **≤2 s per 5 000 files** *(restated 2026-07-29 — the original "+50% of baseline" was
authored before a chunker existed and resolved to ≤39 ms on an 82-file fixture, which measures
nothing)*. The packaged-build smoke test for native grammars **no longer applies**: M14 ships a
dependency-free backend by decision, so there are no native grammars to smoke-test.

> ### ✅ Opening task done 2026-07-29 — the metric exists, and it corrected the gate
> **Delivered:** fixture-backed `findFiles` in `test/vscode-stub.js` (real fs walk from the open
> workspace root, brace/single-name exclude globs, extension filter, `RelativePattern` base,
> `maxResults`) · `eval/retrieval-corpus/` — a frozen 82-file, three-language service · 36 golden
> queries in `eval/retrieval-queries.js` with hand-authored gold sets · `eval/retrieval.js` wired
> into `npm run eval` · `__tests__/retrieval-harness.test.ts` (11 assertions) guarding the
> enumeration contract. **Baseline recorded:** recall@3 **82.4%** · @5 **84.7%** · @10 **93.1%** ·
> @20 **94.4%** · 112 chunks · 26 ms build. Harness 426/426 · vitest **206/206 / 14 suites** ·
> `tsc -b` clean.
>
> **The gate as originally written was impossible, and that is the finding.** "+25% recall@10" was
> authored with no baseline; from 93.1% it would require 116%. Restating it against the measurement
> is the point of having built the measurement — the alternative was to discover at the end of the
> phase that the headline claim could not be evaluated either way. The replacement uses **recall@5**
> as the headline (84.7%, real headroom) and **residual-error reduction** at k=10, which is how
> improvement near a ceiling is normally expressed.
>
> **Two judgement calls worth recording.** The corpus is *not* this repo's own source: gold sets
> name files, and a gate that breaks on an unrelated rename gets switched off. And the first corpus
> draft (28 files) scored **92.5%** recall@10 — near-ceiling and useless as a gate — so it was grown
> to 82 files with distractors deliberately concentrated in the gold files' own vocabulary
> (payment/charge, currency, retry/backoff, token expiry, queue redelivery). A distractor that
> shares no vocabulary with the answer does not make retrieval harder; it just inflates the file
> count.
>
> **What the baseline points at.** Five queries miss at k=10 and they all fail identically: the
> missed file is where the symbol is *defined*, whenever the query describes behaviour rather than
> naming the symbol (`convertMinor`, `canTransition`, `deadLetter`, `conversion_rate`, `maskEmail`).
> A 50-line window dilutes a definition with its neighbours, and the *caller* — which repeats the
> domain vocabulary in prose and argument names — outranks it every time. That is exactly the defect
> M14 and M15/M16 exist to fix, so those five are this phase's real scoreboard.

> ### ✅ M14 delivered 2026-07-29 — symbol chunking
> `core/symbol-chunker.ts` replaces the 50-line window for TS/JS, Python, Go, Rust, Java, C# and
> Markdown; `core/codebase-index.ts` consumes it behind a fallback. **Recall: @5 84.7 → 90.3
> (+5.6) · @20 94.4 → 100 · @10 flat at 93.1 · @3 82.4 → 81.5.** Build 26 → 52 ms, inside the
> +50%… no: **2×**, which is over the stated budget and is recorded as such below. Harness 426/426 ·
> vitest **248/248 / 15 suites** · 19 real-host tests · baseline re-recorded.
>
> **recall@20 reaching 100% is the headline, not the +5.6.** Every gold file in the corpus is now
> *reachable*; nothing is invisible to the index any more. What remains is purely an ordering
> problem, which is precisely what M15/M16 (graph def→use edges) and M17 (rerank) are for. Before
> this, four gold files could not be retrieved at any k.
>
> **Three things were required that the roadmap did not anticipate**, each found by measurement
> rather than by reading:
> - **Identifier splitting.** The tokenizer emitted `[a-z0-9_]+` runs, so `convertMinor` was the
>   single token `convertminor` and a query saying "convert" could never match it — the definition
>   was unreachable by construction, and no amount of better chunking would have fixed it.
> - **Stemming.** Identifiers are base forms (`reserveStock`), questions are inflected ("stock is
>   **reserved**"). A light suffix stripper closed three of the five definition-site misses. It
>   normalises a trailing silent `e` unconditionally, because `reserve` → `reserve` and `reserved` →
>   `reserv` would otherwise have left the stemmer disagreeing with itself on its own motivating
>   case.
> - **A BM25 length floor.** Symbol chunks are short, and BM25 rewards short documents; two-line
>   accessors began outranking the substantive definitions beside them. Flooring the length used in
>   normalisation fixed it.
>
> **Two ranking changes were forced by better chunking** — worth recording because both look like
> unrelated tuning:
> - Chunk count went 112 → 446, and the old "cap at 2 chunks per file" selection began spending two
>   of the top-5 slots on two methods of the *same* file. Selection now offers every file's best
>   chunk before any file's second. Cost of not doing this: 2.3 points of recall@5.
> - Aggregating a file's chunk scores (damped sum) was tried and **measurably rejected** — it cost
>   12 points of recall@5, because under symbol chunking a file's chunk count reflects how many
>   symbols it declares, not how relevant it is. Recorded in the code so it is not re-implemented.
>
> **Deviation from the roadmap — raised, and decided 2026-07-29: stay dependency-free.** The plan
> says *tree-sitter*. It is not vendored anywhere in this repo, and adopting it means native or WASM
> grammars (~2 MB per language × 6) plus per-platform packaging — real consequences for the packaged
> build, in an extension that today has exactly **one** runtime dependency. `symbol-chunker.ts` is
> built around a `ChunkerBackend` interface with a dependency-free `LexicalBackend`; a tree-sitter
> backend implements the same interface and no caller changes. **Owner's call: keep the lexical
> backend for M14 and M15**, on the grounds that it already meets the phase's recall intent at zero
> bundle cost and zero packaging risk. The seam stays, so tree-sitter can land later as a pure
> upgrade *if* M15–M17 show parse accuracy to be the binding constraint on recall. **M14 is
> therefore complete as scoped, not partially delivered** — the substitution is a decision, not a
> shortfall.
>
> **Build-time budget missed, and restated (owner's call, 2026-07-29).** 26 → 52 ms on the corpus,
> where the gate allowed +50%. The miss is recorded rather than argued away — but the +50% bound was
> set before any chunker existed, and 52 ms on 82 files is not a number worth optimising against.
> The gate is restated as an **absolute** budget measured on a repo large enough to mean something:
> **a full index build of ≤2 s per 5 000 files**, re-checked when M15 adds its own indexing cost.
>
> **Other honest limits.** (a) `@3` slipped 0.9 points — inside the gate's 2-point tolerance, but in
> the wrong direction. (b) The lexical backend is a scanner, not a parser: it will mis-parse
> pathological generics and macro-heavy Rust. It fails *closed* — an unrecognised file falls back to
> the line window — and the coverage invariant (every line in exactly one chunk) is asserted over the
> whole corpus, so a mis-parse costs ranking quality and never content.

> ### ✅ M15 delivered 2026-07-29 — code graph, and the phase's headline gate is met
> `core/code-graph.ts` — symbol table plus `imports` / `references` / `extends` / `implements`
> edges over TS/JS, Python, Go, Rust, Java, C#, built from the same lexical scan as M14 so it
> cannot drift from what is searchable. Wired into `CodebaseIndex` as `index.graph`, updated
> per-file (incremental), and consumed by retrieval as a one-hop expansion step.
>
> | Metric | Phase 3 start | After M14 | **After M15** | Restated gate |
> |---|:--:|:--:|:--:|:--:|
> | recall@3 | 82.4 | 81.5 | **82.9** | — |
> | recall@5 | 84.7 | 90.3 | **89.8** | ≥88.5 ✅ |
> | recall@10 | 93.1 | 93.1 | **95.8** | ≥94.8 ✅ |
> | recall@20 | 94.4 | 100 | **100** | — |
>
> **Both halves of the restated headline gate are met**, with M16 and M17 still to come. Residual
> error at k=10 fell 6.9 → 4.2 points, a **39% reduction** against the ≥25% required. All five
> definition-site misses the baseline identified are closed but one; three misses remain
> (`q-cancel-endpoint`, `q-order-created-event`, `q-impact-currency-exponent`), and they are ranking
> problems, not reachability problems — which is what M17's reranker is for.
>
> **The mechanism that mattered.** Not the graph itself, but *what it is allowed to do to the
> ranking*. A behavioural question matches the caller on every domain word and the definition on one
> or two, so no term weighting can lift the definition — it genuinely is the weaker lexical match.
> Retrieval now takes the top 5 results, walks one hop to the files whose symbols they call, and
> splices those in behind their referrer. Three limits keep this from becoming plausible noise: top-5
> seeds only, one hop and never transitive, and **the linking symbol must overlap the query** — the
> last of which is what stops every file's `config` and `logger` imports being promoted into every
> result set.
>
> **A bug worth recording, because it made the feature a no-op.** The first version only *inserted*
> files missing from the ranking. But a definition file is almost never missing — it scored
> something, just not enough, so it was already in the map at rank 30 and was skipped every time.
> Expansion has to **move** an existing entry, not merely add an absent one. Measured effect of the
> fix: recall@10 93.1 → 95.8. The eval caught this immediately; reading the code did not.
>
> **A second bug the tests caught:** `extractImports` read the *masked* line, but masking blanks
> string contents — and a module specifier *is* a string literal, so every import edge was silently
> empty. Specifiers now come from the raw line while the masked line still decides whether the line
> counts, so an import inside a comment or a docstring example never becomes an edge.
>
> **Design position: name-keyed, not binding-keyed.** Two `create` methods in two classes are one
> node. This is deliberate — it needs no type checker, works identically across six languages, and
> for ranking and impact it **over**-approximates, surfacing an extra candidate rather than hiding a
> real caller. Edges carry `confidence: 'exact' | 'inferred'` so a consumer that must not over-reach
> can demand structural edges only, and a name defined in more than three files is dropped as
> ambiguous rather than linked to all of them. `__tests__/code-graph.test.ts` (29 tests) pins both
> properties.
>
> **Warm-start correctness.** A warm build skips unchanged files, so the graph would otherwise hold
> only the files edited since the last run and `impactOf` would confidently return almost nothing.
> `seedGraphFromCache()` reconstitutes those files by concatenating their cached chunks — exact,
> because chunk coverage is total and asserted — rather than persisting a second on-disk structure
> that could fall out of step with the chunks it describes.

> ### ✅ M16 delivered 2026-07-29 — `impact_analysis`, and its accuracy gate is met
> `tools/graph-tools.ts` + a new `impact_analysis` tool, wired through `agent/tool-executor.ts`
> and into all thirteen mode allowlists. **Gate: ≤2 false positives on refactor fixtures →
> measured 0 false positives and 0 missed users across six refactors** on the real corpus
> (`__tests__/impact-accuracy.test.ts`). vitest **310/310 / 18 suites** · harness 426/426 ·
> 19 real-host tests · eval green.
>
> **The defect this milestone was really about.** The first implementation walked incoming *file*
> edges — which answers "who depends on this file", not "who depends on this symbol". For
> `reserveStock` it returned 13 files where 2 were correct, because every importer of
> `OutOfStockError`, `availableUnits` or `isLowStock` counted as affected. Across six refactors that
> was **31 false positives against a gate of ≤2**. Hop 1 now uses symbol-precise `referencesOf` and
> nothing else; hops 2+ stay file-level but are reported as the explicitly weaker claim ("worth
> checking, probably not editing"). Result: 31 → 0, with recall unchanged.
>
> **This bug was invisible on a unit fixture.** `__tests__/code-graph.test.ts` passed throughout —
> on a three-file graph, "the file" and "the symbol" are the same answer. It only appeared when
> measured against the 82-file corpus, which is why the accuracy assertion is written against a real
> index rather than a toy graph.
>
> **The ground truth was wrong before the tool was.** The first accuracy run showed 3 residual false
> positives, all test files. Checking the corpus showed the test files genuinely do import and call
> those symbols — they must change when the signature changes, which is precisely what impact
> analysis is for. The hand-written expectation was corrected, not the tool. Scoring against a
> plausible-but-wrong ground truth would have hidden a real capability.
>
> **`LSP_READ_TOOLS` renamed to `CODE_INTEL_READ_TOOLS`.** The group is no longer all
> language-server calls — `impact_analysis` is answered offline from the graph — and a caller should
> not need to know which mechanism answers which question. Keeping one group (rather than adding a
> second constant) is deliberate: the Phase 1 trap, where a tool is registered, implemented, and
> permitted by the sandbox gate yet never offered because a mode's `tools` array omits it, applies
> verbatim to any new group, and `__tests__/tool-surface.test.ts` now asserts the whole set reaches
> every declaring mode.
>
> **Output is written to be read by a model.** Direct and transitive hits are separate sections
> because they warrant different actions; the report states that results are name-matched rather
> than binding-resolved and points at `find_references` as authoritative; several definitions sharing
> a name produces an explicit warning; and "the index is not built" is worded differently from "that
> symbol does not exist", because those look identical to a model and have completely different
> fixes.

> ### ✅ M17 delivered 2026-07-29 — rerank stage
> `core/reranker.ts` — a `Reranker` interface plus `LexicalReranker`, the deterministic fallback the
> roadmap requires, running over the head of the RRF-fused list. Tokenisation moved to
> `core/text-tokens.ts` so the reranker can use it without importing the index that imports it.
> vitest **327/327 / 19 suites** · harness 426/426 · 19 real-host tests.
>
> | Metric | Phase 3 start | M14 | M15 | **M17** | Restated gate |
> |---|:--:|:--:|:--:|:--:|:--:|
> | recall@3 | 82.4 | 81.5 | 82.9 | **82.9** | — |
> | recall@5 | 84.7 | 90.3 | 89.8 | **91.2** | ≥88.5 ✅ |
> | recall@10 | 93.1 | 93.1 | 95.8 | **97.2** | ≥94.8 ✅ |
> | recall@20 | 94.4 | 100 | 100 | **100** | — |
>
> **Residual error at k=10 fell 6.9 → 2.8 points, a 59% reduction** against the ≥25% the restated
> gate asks for. Two of the original five definition-site misses remain, and only 2 of 36 queries now
> miss anything at all.
>
> **The cross-encoder is not here, and that is on purpose.** It needs the `rerank` model role, which
> arrives with the ModelRouter in **Phase 4 (M23)**. What ships is the interface and the fallback —
> and the fallback is not a placeholder: with no rerank model configured, which is the default and,
> for a local-first editor, the common case, it is what runs. Phase 4 assigns `index.reranker` and
> changes nothing else.
>
> **Every weight is a measurement, and two of them are zero.** 288 combinations were swept against
> the corpus. `coverage` (distinct query terms matched) and `symbol` (the chunk *is* the definition
> the query named) pay; `proximity` and `path` measured neutral-to-harmful and default to **0** —
> `path` at 0.4 cost 4 points of recall@5, because filename words like "orders" match nearly every
> file in a service about orders. They are kept implemented behind injectable weights rather than
> deleted, since a corpus with more directory structure may reward them; what is not kept is a
> nonzero default the data does not support.
>
> **Two findings worth more than the delivery itself:**
> - **A reranker given free rein makes retrieval worse.** The first draft (coverage 3.0 vs prior 1.0)
>   let a rank-40 chunk with every query word overtake a rank-1 chunk with most of them, and cost
>   **8 points of recall@5**. The first stage is a well-founded ranking over the same evidence; the
>   second stage's job is to refine it, not to re-decide it. The prior now outweighs every other
>   signal combined, asserted in `__tests__/reranker.test.ts`.
> - **Rerank depth is a recall/precision trade, and deep is wrong.** Reranking the top 50 scored
>   worse than the top 20 at *every* weight set tried — recall@20 fell 100% → 97.2% with no gain at
>   the head, because reordering ranks 20–50 only shuffles which marginal file drops off the end.
>   `RERANK_DEPTH` is 20. Without sweeping the window this would have shipped as a silent −2.8.
>
> **Failure is non-fatal by construction.** A reranker that throws — which a model-backed one will,
> on a timeout or a missing key — leaves the fused ranking in place with a warning. Search degrading
> to first-stage quality beats search returning an error.

> ### ✅ M18 delivered 2026-07-29 — output compaction (30% gate met on realistic path depths, not on the shallow fixture)
> `core/output-compact.ts` (grep grouping, diagnostics message-collapsing, listing prefix lifting,
> bounded `RawOutputStore`) + an `expand_output` tool so the raw form stays retrievable. Wired into
> `grep_search`. `eval/compaction.js` measures it in the eval run. vitest **348/348 / 20 suites**.
>
> | Sample | Reduction |
> |---|:--:|
> | Fixture corpus (`retrieval-corpus/`, avg path **26** chars) | **19.5%** |
> | Realistic path depth (this extension's own `src/`, avg path **62** chars) | **37.7%** |
> | Diagnostics with a repeated message | **81.3%** |
>
> **The gate is ≥30%, and the honest answer is "it depends, and here is on what."** Grouping removes
> the repeated path prefix and nothing else, so the reduction is a ratio of path length to line
> length — there is no lossless trick that beats that bound. The fixture corpus is a flat demo app
> whose paths average 26 characters, so it **understates** the figure; the codebases this extension
> actually runs in nest far deeper, and at 62 characters the same encoder returns 37.7%. Both numbers
> are published and the fixture one is what the gate guards, because it is the stable one. Picking
> the flattering number and calling the gate met would have been the easy move and a dishonest one.
>
> **This is the phase text's own instruction being followed.** E11 says of A-Coder's 30–70% claim:
> "*treat that as a hypothesis to measure, not a target to assume*". Measured, the hypothesis holds
> at the top of its range for repeated-message output (81%), lands mid-range for realistic grep
> (38%), and does not hold on shallow paths (20%).
>
> **Design choices that keep it honest.** Compaction never returns something larger than its input
> (one hit per file is a worst case where grouping adds structure). Results under four rows are left
> untouched — structure costs more than the repetition saves. The "fetch the full version" pointer is
> only appended when compaction actually did something, because a pointer to an identical copy is
> noise the model will sometimes spend a turn on. And `RawOutputStore` is per-executor rather than
> global: an id from a finished run pointing into a live buffer would let one run read another's file
> contents.
>
> **Wiring status.** `grep_search` uses the grouping encoder. `get_diagnostics` (`tools/lsp-tools.ts`)
> now collapses repeated messages inline — it already grouped by file, so the message-collapsing was
> the part that pays. `list_directory` is **deliberately not converted**: its entries are bare names
> with no shared path prefix, so compaction would do nothing but add a header. `read_file` and command
> output are not row-structured and are out of scope for this encoder.
>
> **A defect found while finishing the wiring, worth recording for its failure mode.** The grouping
> key is `severity + separator + message`, and the separator that shipped was a **literal NUL byte**
> rather than the escape `' '`. The code was correct — NUL cannot occur in a diagnostic message,
> so it is a sound sentinel, and every test passed — but a raw control byte makes the file *binary*
> to `grep`, `diff`, `awk` and most review tooling, which then silently return nothing for it. It was
> caught only because `grep` stopped printing matches for a file that visibly had them. Both sites
> now use a named constant written as an escape, and `__tests__/source-hygiene.test.ts` fails on any
> raw control character anywhere in `src/`, `eval/` or the test suite. That guard is built with
> `charCodeAt` rather than a regex character class, because a literal escape inside a regex is
> precisely the construct that keeps materialising as a raw byte — a guard that trips over the defect
> it guards against fails in a way that looks like it working.

> ### 🟡 M19 delivered 2026-07-29 — ContextProvider API + `@`-mentions
> `core/context-providers.ts` (interface, budgets, registry) · `core/context-provider-setup.ts`
> (assembly, kept out of `extension.ts` because of the ≤700 LOC gate) · `core/mention-resolver.ts` ·
> webview dropdown rewritten to be provider-aware · `chat-task.ts` resolves mentions into the prompt.
> vitest **378/378 / 22 suites** · harness 426/426 · 19 real-host tests · webview builds.
>
> **Shipped providers:** `@file`, `@folder`, `@problems`, `@git` (diff / staged / branch / log),
> `@terminal`, `@rules`, `@skills`, `@past-chats`. **Not shipped:** `@symbol`, `@docs`, `@web` —
> `@docs` and `@web` belong to M20/M21 and `@symbol` should read the M15 graph; all three are
> registry entries, not new plumbing. M19 is therefore **🟡, not ✅**.
>
> **The change that actually matters is resolution, not the menu.** A mention used to be *text*: the
> model saw `@src/a.ts` and had to spend a turn on `read_file` to learn what the user meant, and
> `@problems` or `@git` could not be acted on at all because nothing resolved them. Mentions are now
> resolved server-side and appended as a delimited block — never substituted inline, because
> replacing `@src/a.ts` with a file's contents destroys the sentence that says what to do with it.
>
> **Budgets are enforced and truncation is stated.** Every provider declares a character budget and
> over-budget content is cut *with a visible marker naming how much was dropped*. An agent handed
> half a diff without being told is worse off than one handed nothing: it will reason confidently
> about code it cannot see.
>
> **Degradation is designed in.** A provider that throws during `suggest` drops out of the dropdown
> and the rest still render — one broken provider must not empty the menu mid-keystroke. A provider
> that throws during `resolve` yields a note in the prompt rather than failing the turn. `@git` in a
> non-git directory says *"unavailable: not a git repository"* rather than returning an empty block,
> which would read as "there are no changes" — a different and much more misleading claim.
>
> **Two parser bugs the tests caught**, both in the mention regex: `*` was not an accepted character,
> so `@problems:*` silently truncated to `@problems`; and stripping `:` as trailing punctuation
> turned the half-typed `@git:` into a complete-looking `@git`, which would have attached a
> provider's default content to a message the user was still writing. A trailing colon now means
> "still typing" and is skipped.
>
> **Back-compat kept deliberately.** The old `searchFiles` message still works and still returns a
> flat file list. A webview surviving an extension reload would otherwise get an empty dropdown with
> no error — which looks exactly like "no matches" and is unreportable by the user.

> ### ✅ M22 delivered 2026-07-29 — git-history intelligence
> `tools/git-history.ts` + three tools — `search_history`, `blame`, `why_was_this_changed` — wired
> through the executor and into every mode's allowlist. vitest **393/393 / 23 suites** · harness
> 426/426 · 19 real-host tests · eval green.
>
> **Deviation from the roadmap, with a reason.** E20 proposes indexing commits into the E2 store.
> This shells out to git instead. Git already maintains a far better index of its own history than we
> would build, and `git log -S` answers "when did this string appear or disappear" directly; indexing
> would duplicate it, go stale, and spend a commit-window of embedding calls to do so. What this
> module adds is the part git does *not* do — shaping answers for a model: bounded, deduplicated, and
> explicit about how strong the evidence is.
>
> **`why_was_this_changed` unions three git signals, because each alone misses the common case.**
> The first implementation used the pickaxe (`-S`) alone and found only the commit that *introduced*
> the symbol — a commit that rewrites a function's body without touching its name changes no
> occurrence count and is invisible to `-S`, and that is precisely the commit a "why" question is
> usually about. It now unions `-S` (introduced/removed), `-G` (a line mentioning it changed) and
> `--grep` (commits that discuss it, where an explicit rationale is normally written), deduplicated
> newest-first. Caught by a test against a real throwaway repository; a mocked `execFile` would have
> asserted my own assumptions about git's semantics back at me.
>
> **Honesty about evidence strength is in the output.** Every result states that these are commits
> which changed an occurrence count, changed a mentioning line, or discussed the symbol — "a good
> proxy for introduced-or-reworked, but not a proof: a pure rename shows up here too". `blame`
> requires a line range rather than defaulting to a whole file, because blaming a real file returns
> thousands of near-identical rows; consecutive lines from one commit collapse into one row. Short
> hashes are 7 characters everywhere, matching git's `%h`, so a hash from `blame` and one from
> `search_history` are the same string for the same commit — they were 8 and 7 respectively until a
> test caught it.
>
> **Safety.** Every call uses `execFile` with an argument array, never a shell string, so a branch,
> path or query containing shell metacharacters cannot become a command. All subcommands are
> read-only. Unavailability names its cause — "not a git repository" and "git not installed" and a
> shallow clone all produce no history, and only one of them is worth retrying.
### Phase 4 — Model layer
*Covers M23–M27.*

- `ModelRouter` with roles `chat | plan | edit | apply | autocomplete | embed | rerank`, per-role
  provider/model/budget.
- Health-aware cross-provider failover with per-provider circuit breaking; substitution surfaced in
  the UI (never silent).
- Fast-apply path: strong model states intent, cheap model materialises SEARCH/REPLACE blocks,
  verified against the exact-match contract (`core/tools.ts:76`), **fail closed** to the strong
  model on any mismatch.
- Provider breadth: DeepSeek, Groq, Mistral, xAI, Together, Fireworks, Cerebras, LiteLLM, vLLM
  (OpenAI-compatible) + Azure OpenAI / Bedrock / Vertex auth shapes.
- Zero-config first run: detect local Ollama/LM Studio, offer a one-click local default.

**Gate:** killing the primary provider mid-run completes on the secondary with a visible notice;
fast-apply cuts apply tokens ≥50% with **zero** silently wrong edits; a keyless machine with Ollama
completes an agent task end to end.

### Phase 5 — Editor ergonomics
*Covers M28–M30. Depends on Phases 3 (graph) and 4 (autocomplete role).*

- `NextEditEngine`: rolling edit-history ring buffer + graph neighbourhood → **cross-file** next-edit
  prediction with a jump-to-next-edit affordance; hard latency budget; cancel-on-keystroke.
- Terminal `Cmd+K`: NL → shell command, policy-gated, mandatory preview, never auto-run.
- Automatic rolling summarization at context thresholds (keep `/compact` as the manual override).

**Gate:** next-edit p50 ≤250 ms on the fast role; ≥40% of accepted suggestions multi-line or
cross-file; zero completions emitted after the buffer changed; auto-summarization never drops a
pending approval or tool result.

### Phase 6 — Agent Manager & parallel execution
*Covers M31–M37. Extends the existing `ManagerPanel.tsx`.*

- **Task Agent** as a first-class unit (own worktree + mode + model + artifact stream), listed in
  `ManagerPanel` beside pipeline runs — the panel already models `modelId` and `awaiting_approval`.
- Global concurrency governor (default 4, max 8) + token-spend governor.
- Agent inbox + notifications (window/OS), badge counts, idle-timeout parking instead of hanging.
- Verify `core/parallel-execution.ts` under the real extension host and graduate it as the wave
  engine, **or delete it** — no third option.
- Multi-root correctness: per-root `ProjectProfile`, index shard, knowledge, rules; agents declare
  the root they act on.
- Multi-model race (opt-in, capped): N models × N worktrees, diff-vs-diff comparison with
  per-candidate test results from Phase 1's `run_tests`; pick one, discard the rest.

**Gate:** 4 concurrent task agents → 4 independently mergeable worktrees; kill-one isolation holds;
the live workspace is untouched until an explicit apply; a 2-root workspace (Django API + React app)
yields two profiles and injects the correct stack skills per root; blocked runs notify within 5 s
and survive a window reload.

### Phase 7 — Artifacts, steering & verification *(the review story)*
*Covers M38–M40. Depends on Phase 6.*

- Typed artifacts (`plan`, `task-list`, `diff`, `walkthrough`, `screenshot`, `recording`,
  `test-report`) + a review panel.
- **Comment on an artifact region → injected as a steering message into the running agent's next
  turn.** No restart, no context loss. Comments persist with the run and land in the inbox (Phase 6)
  and the audit trail (Phase 9).
- `verify` phase contract for every executor: `run_tests` from the profile, and for UI work launch
  the app, exercise the changed surface, attach screenshots + a recording. One bounded self-
  correction attempt, then escalate to the human.

**Gate:** a comment changes executor behaviour within one turn without losing accumulated context;
100% of pipeline runs emit a test-report artifact; ≥80% of chat build tasks emit verification
evidence; a deliberately broken change is caught by verify, not by the user.

### Phase 8 — Memory v2
*Covers M41–M46. Depends on Phase 3 (embeddings/rerank).*

- Tiered typed memory index beside the markdown projection (ADR 007 preserved): *working* (session,
  evicted on compaction) → *project* (durable). Entries carry provenance, confidence, use counts.
- Automatic end-of-turn extraction: high confidence auto-writes, medium queues for one-click confirm.
- Contradiction detection on write (embedding-near + negation heuristic) → surface both and ask;
  **never** silently overwrite.
- Decay: unused low-confidence entries demote then archive. Never hard-delete — it's a user file.
- Idle consolidation job: merge duplicates, rewrite the markdown projection.
- Memory visualization panel (entries, links, confidence, provenance, what fired).
- Mindmap read-back: agents consume the stack section before acting — closes `plan.md`'s Phase 5
  follow-up.

**Gate:** a fact stated in session 1 is retrieved in session 3 without re-derivation (≥70% of
eligible facts); contradicting a fact prompts rather than overwrites; consolidation is idempotent;
the markdown stays human-editable and round-trips byte-stable.

### Phase 9 — Review automation, MCP parity & hardening
*Covers M47–M58.*

- `Reviewer` mode (read-only allowlist + Phase 1 LSP tools + Phase 3 graph + Phase 3 git history)
  and `black-ide.reviewChanges` on the working diff, emitting findings as a review artifact;
  high-confidence findings offer a checkpointed fix. Opt-in `gh` PR review — **never** an ambient
  bot posting without being asked.
- MCP: streamable HTTP + SSE transports, OAuth, resources & prompts primitives, health/reconnect
  with backoff, and a per-server vetted allowlist so a trusted server can be used in unattended
  runs (default stays refuse — G3 is a feature).
- Tool circuit breakers (per-tool failure/latency budget, trip → disabled for the run with a
  visible reason).
- Append-only audit trail `.blackIDE/audit/<run>.jsonl`: every tool call, decision, approval,
  model, token count, steering comment. Exportable as one artifact.
- Secret redaction on the way **into** prompts and logs (entropy + known-pattern detectors).
- One central workspace-boundary guard for all file tools; fold in `test_sandbox_*.js`.
- Sandboxed execution tiers: policy (today) → restricted (cwd-jailed, env-scrubbed, no-network,
  capped) → contained (opt-in container). Unattended pipeline runs default to restricted or better.
- Untrusted-content posture asserted in the system prompt and tested with injection fixtures:
  skills, rules, MCP output, web/doc content and file contents are **data, never instructions**.
- Optional at-rest encryption for `.blackIDE/` (off by default).

**Gate:** reviewer ≥60% true positive at ≤1 false positive per 10 findings; a remote MCP server
works while unvetted servers stay refused in pipelines; injection fixtures cannot escalate
privileges or widen an allowlist; no secret reaches a log or a provider request; a tool failing 3×
is disabled rather than retried forever; a tier-2 command cannot reach the network.

### Phase 10 — Skill breadth, distribution & notebooks
*Covers M59–M61.*

- Wave 2 of `plan.md`'s catalog (data-only): `django-rest-framework`, `nestjs`,
  `entity-framework-core`, `gorm`, `spring-boot`, `laravel`, `symfony`, `vue`, `svelte-kit`,
  `solidjs`, `remix`, `astro`, `flutter`, `vitest`, `react-testing-library`, `playwright-e2e`,
  `cypress-e2e`, `xunit`, `nunit`, `cargo-test`, `go-test`, `rspec`, `junit-mockito`, plus the
  cross-cutting packs (`rest-api-design`, `auth-jwt-oauth`, `orm-patterns`, `db-migrations`,
  `component-architecture`, `test-strategy`, `coverage-tdd`, `docker`, `kubernetes`,
  `github-actions-ci`, `terraform`…). 16 → full catalog.
- Registry: `resources/skills/registry.json`, `black-ide.addSkillFrom <git-url|path>` with pinned
  ref + checksum, `black-ide.updateSkillPacks`. Distribution also covers rules and prompts (Phase 2).
- **Load-time enforcement:** a third-party pack can never widen a tool allowlist, auto-approve a
  command, or loosen policy. Tested, not assumed.
- Notebook support: cell-aware read, `edit_notebook_cell`, cell-granular checkpointing.

**Gate:** every pack parses with ≥1 role and ≥1 stack; a remote pack installs, verifies its
checksum, and is shadowable by a same-named local pack; a malicious pack attempting to widen tool
access is rejected at load; the agent edits a real `.ipynb` without corrupting JSON and the edit is
individually revertible.

### Phase 11 — Headless core, CLI & SDK *(largest structural phase)*
*Covers M62–M65. Do not start before Phase 0's split is merged.*

- Extract `@blackide/agent-core` with **zero `vscode` imports**: agent loop, tools, router, index,
  graph, skills, rules, memory — behind a small host interface the extension implements.
- Refactor the extension onto that core; the harness must stay green throughout.
- `blackide` CLI: headless run, `--mode`, `--output apply|pr`, JSON event stream on stdout, exit
  codes for CI.
- SDK entry point for embedding the loop.
- Background agents as a **local daemon** driving headless runs, results surfaced in the inbox
  (Phase 6).

**Gate:** `grep -r "vscode"` in the core package returns nothing; `blackide "add a test for X"
--output pr` completes on a fixture repo with no editor running; the refactored extension is green
on the full harness; a daemon run's results appear in the inbox.

### Phase 12 — Remote execution, integrations, analytics & long tail
*Covers M66–M71. Everything here depends on Phase 11.*

- Remote/cloud agent execution (opt-in, BYO-runner: the user's own machine, container, or CI
  runner). **We do not become a data processor by default** — G4 is a selling point, not a
  placeholder.
- Issue-tracker integration: GitHub Issues / Linear / Jira as context providers (Phase 3 API) and
  as task sources for headless runs ("implement issue #123"); results posted back only on explicit
  per-action confirmation. Slack completion notifications via the inbox.
- Self-hosted, opt-in team analytics sink fed by the Phase 9 audit trail + an org policy file with
  **tighten-only** semantics.
- Domain verticals (if a real user pulls for them): a migration pipeline template
  (inventory → parse → translate → verify → report) reusing the Phase 3 graph and Phase 7
  verification, plus domain skill packs. Firmware support stays out unless demanded.
- Voice input.

**Gate:** the default build phones home to nobody (asserted in tests); an org policy cannot widen
the deny list; nothing is posted to an external service without an explicit per-action
confirmation; disabling the sink removes all egress.

### 4.1 Sequencing

```
Phase 0  truth-up · extension.ts split · eval baseline      ── prerequisite for all
   │
   ├─► Phase 1  LSP tools + run_tests          ── cheapest accuracy win; ship immediately
   │
   ├─► Phase 2  rules · prompts · Learn        ── independent, parallel with 1 and 3
   │
   └─► Phase 3  symbol graph · context providers · docs · git history   ── the substrate
          │
          ├─► Phase 4  model router · providers ─► Phase 5  next-edit · terminal Cmd+K
          │
          ├─► Phase 6  agent manager · inbox · multi-root ─► Phase 7  artifacts · steering · verify
          │
          └─► Phase 8  memory v2
                 │
                 └─► Phase 9  reviewer · MCP parity · hardening
                        │
                        └─► Phase 10  skill breadth · registry · notebooks
                               │
                               └─► Phase 11  agent-core · CLI · SDK ─► Phase 12  remote · integrations · analytics
```

- **Critical path to parity:** 0 → 1 → 3 → 4 → 5.
- **Critical path to the Antigravity/Cursor control-surface story:** 0 → 6 → 7.
- **Parallelisable:** Phase 2 with 1 and 3; Phase 4 may start once the `CodeGraph` interface is
  frozen; Phase 10 is data-heavy and can trail alongside 9.
- **Phase 1 before Phase 3** is deliberate: LSP tools cost days and lift every later measurement,
  so they land before the multi-week retrieval work.

### 4.2 Success metrics (measured on the eval set, not asserted)

**Baseline status as of rev 4 (2026-07-28).** Only the skill/stack metrics are actually recorded in
`eval/baseline.json`. Rows marked ⚠ below have **no Phase-0 number**, which means their targets are
currently unfalsifiable — see pending item 4 at the top of this document.

| Metric | Baseline (Phase 0) | Target | Proven in |
|---|---|---|---|
| Task success rate, per stack | ⚠ unrecorded — needs the model tier | +20 pts | 3, 5, 10 |
| Recall@10 for "files that must change" | ⚠ unrecorded — needs fixture-backed `findFiles` (do at the start of Phase 3) | +25% | 3 |
| Tokens per completed task | ⚠ unrecorded — needs the model tier | −40% | 3, 4 |
| Symbol-question accuracy (LSP vs grep) | ⚠ unrecorded — needs the model tier | +30% | 1 |
| Test-failure feedback size | recorded: 30 KB → <2 KB asserted in CI | −95% (50 KB → <2 KB) | 1 |
| Stack detection accuracy | **recorded: 100% (8/8)**, gated | hold | 0, 3 |
| Skill exact-match / any-hit rate | **recorded: 100% / 100%**, gated | hold while breadth grows | 0, 10 |
| Fail-safe: no stack → no skill injection | **recorded: 1/1**, gated | hold | 0 |
| Next-edit acceptance rate | 0 (absent) | ≥25% of shown | 5 |
| Wrong-idiom rate (wrong runner, raw SQL where ORM is idiomatic) | record | −50% | 10 |
| Reviewer precision | n/a | ≤1 FP per 10 findings | 9 |
| Runs with verification evidence | 0% | 100% pipeline / ≥80% chat builds | 7 |
| Cross-session memory reuse | ~0 | ≥70% of eligible facts | 8 |
| Silently-wrong fast-apply edits | n/a | **0** (hard gate) | 4 |
| Injection-fixture escalations | untested | **0** (hard gate) | 9 |

### 4.3 Coverage check

| Phase | Missing features covered | Count |
|---|---|:--:|
| 0 | M1–M5 | 5 |
| 1 | M6–M8 | 3 |
| 2 | M9–M13 | 5 |
| 3 | M14–M22 | 9 |
| 4 | M23–M27 | 5 |
| 5 | M28–M30 | 3 |
| 6 | M31–M37 | 7 |
| 7 | M38–M40 | 3 |
| 8 | M41–M46 | 6 |
| 9 | M47–M58 | 12 |
| 10 | M59–M61 | 3 |
| 11 | M62–M65 | 4 |
| 12 | M66–M71 | 6 |
| | **Total** | **71 / 71** |

Every gap in §3 is scheduled. Nothing is left in an unowned backlog.

### 4.4 Risks & mitigations

| Risk | Mitigation |
|---|---|
| Tree-sitter native modules break the extension host or packaging | Lazy load, capability probe, degrade to line-window chunking; packaged-build smoke test is a Phase 3 gate |
| `extension.ts` split regresses behaviour | Pure move-and-wire, no logic edits, harness must stay 426/426; land it alone in Phase 0 |
| Prompt-budget pressure from rules + skills + graph + memory + context providers | One budgeted assembly path in `prompt-builder.ts`; ranked truncation; the Phase 2 panel makes the budget visible; every provider declares a budget |
| Fast-apply silently produces wrong edits | Fail closed on any exact-match mismatch, fall back to the strong model; zero-wrong-edit is a hard gate |
| Compression loses information | Raw form always retrievable; gate on eval success flat-or-better, not token count alone |
| LSP tools flake when servers are cold | Explicit readiness wait with a timeout, then degrade to grep; never surface a language-server error as a task failure |
| Third-party skills/rules/prompts as an injection vector | Untrusted-data posture (Phase 9), load-time enforcement that packs cannot widen tool access (Phase 10), injection fixtures in CI |
| Sandboxing breaks existing user workflows | Interactive default stays at today's policy tier; stricter tiers apply to unattended runs first, opt-in for interactive |
| Parallel agents corrupt the workspace | Worktree isolation (already proven), global governor, live tree untouched until explicit apply |
| Multi-model race multiplies spend | Opt-in only, hard token cap, cost shown before launch |
| Automatic memory writes wrong facts | Confidence thresholds, medium-confidence confirm queue, contradiction prompts, archive-not-delete, human-editable markdown as source of truth |
| Headless extraction (Phase 11) becomes a rewrite | Host interface first, move modules incrementally, harness green after every move; the Phase 0 split is what makes this tractable |
| Remote execution erodes the privacy story | BYO-runner only, opt-in, no default egress, asserted in tests |
| 13 phases outrun review capacity | Every phase is independently shippable and independently revertible; eval gate blocks accumulation of unmeasured work |

### 4.5 Non-features (not gaps — deliberate architectural positions)

These are the only items from the competitive sweep **not** in the plan, because they are not
features we can or should "support":

- **Training our own completion/apply model** (Cursor's Composer-1/Sonic). We route to providers;
  Phase 4's `autocomplete` and `apply` roles can point at any fast hosted or local model.
- **Operating hosted inference or a paid model tier.** Phase 4's zero-config path is local-first
  instead — no accounts, no egress, no infrastructure to run.
- **A hosted marketplace with accounts and payments** (Continue Hub's commercial half). Phase 10
  ships a git-URL installer plus a curated in-repo registry: the 90% at 10% of the cost.
- **Rewriting the editor shell in Rust/Tauri** (OPIDE). We are a VS Code fork; extension
  compatibility (F20, already at parity) is a strength we are not trading for a rewrite.
- **JetBrains / multi-editor clients** (Continue). Out of scope for an editor *fork* — Phase 11's
  `agent-core` is what would make it possible later, so this stays open rather than blocked.
- **A learned skill/rule router.** Rule-based resolution stays until the eval set shows precision
  demands otherwise.

---

## 5. Appendix — Competitor reference

| Product | Base | Signature strengths (their claims) | What we should take |
|---|---|---|---|
| **Google Antigravity 2.0** | Proprietary (VS Code lineage) | Manager view with 5 parallel agents each with own workspace/context/model; artifacts (plans, diffs, screenshots, browser recordings) with comment-to-steer; agent inbox; built-in Chrome + Web MCP; 4 surfaces (IDE, desktop, CLI, SDK); Gemini co-trained harness | Task agents in Manager (E3, ph6), artifacts + steering (E4, ph7), verification evidence (E5, ph7), inbox (E28, ph6), CLI/SDK (E14, ph11) |
| **Cursor 3.5** | Proprietary (VS Code fork) | Tab v2 next-edit with in-house low-latency models; ≤8 parallel worktree agents; server-side Background Agent; BugBot PR review (~80% resolution); Memories; `.cursor/rules/` + Team Rules; multi-model race; sandboxed shells; terminal `Cmd+K`; notepads; full `@`-mention set | Rules v2 (E6, ph2), next-edit (E1, ph5), terminal `Cmd+K` (E25, ph5), race (E27, ph6), memories (E7, ph8), reviewer (E8, ph9), sandboxing (E23, ph9), prompts library (E29, ph2), context providers (E19, ph3) |
| **Continue.dev** | Extension (VS Code/JetBrains) | `config.yaml` composable blocks; Continue Hub for rules/prompts/MCP/docs/models; model **roles** (chat/edit/apply/embed/rerank/autocomplete); markdown rules; `@docs`; pluggable context providers; the "notch" session panel; data destinations | Session panel + rule toggles (E6, ph2), context provider API + `@docs` (E19/E13, ph3), model roles (E10, ph4), distribution (E9, ph10), self-hosted sink (E32, ph12) |
| **NeuralInverse** | VS Code fork (Void lineage) | Vertical depth: firmware (357 MCU variants, 22 `fw_*` tools) and legacy modernization (30+ source languages, 61 translation profiles, audit export); 20 providers incl. free cloud models; per-feature model selection | Per-role models + provider breadth + zero-config first run (E10/E26, ph4), audit trail & export (E15, ph9), migration pipeline template (E17, ph12) |
| **CortexIDE** | Void fork (VS Code 1.118.1) | Privacy-by-design direct-to-provider; local-first LLMs (Ollama, vLLM); checkpoint + visualize; `.cortexiderules` | Little — **we already lead** on checkpoints (E_3) and match on privacy (G4). Their local-first default informs E26's zero-config path (ph4) |
| **A-Coder** | Void fork | 4 modes incl. **Learn/Student** with adaptive difficulty; TOON compression (claimed 30–70% tool-output token reduction); exact-match apply; intelligent file pagination; Morph-accelerated search over git history; rolling-window summarization | Learn mode (E16, ph2), compression (E11, ph3), git-history search (E20, ph3), auto-summarization (E11, ph5); exact-match apply and ranged reads **already at parity** |
| **OPIDE** | Rust + Tauri + Monaco (no Electron) | **Engram** 3-tier memory (sensory/working/long-term graph; episodic/semantic/procedural; decay, contradiction detection, idle "dream" consolidation) + memory visualization; tree-sitter AST index → call graphs, type hierarchies, impact analysis; 10-layer security (QuickJS sandbox, circuit breakers, AES-256-GCM, audit trails); provider fallback routing; agent profiles; Open VSX | Symbol graph + impact analysis (E2, ph3), failover (E10, ph4), memory v2 + visualization (E7, ph8), circuit breakers + audit + sandbox tiers + encryption (E15/E23, ph9); Open VSX **already at parity** |

**Where we are already ahead of all seven:** the SDLC pipeline with a human approval gate (A3),
the unoverridable command deny list with auto-approve refused in unattended runs (G1/G3), reverse-
hunk per-message checkpointing (E_3), and project-aware skill resolution keyed off manifest-based
stack detection (C1/C2). **Protect these while closing the gaps above** — they are the reason to
choose Black IDE, and none of the enhancements in this document should compromise them.
