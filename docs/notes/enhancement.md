# Black IDE — Competitive Analysis & Agent Enhancement Roadmap

**Author:** Principal Engineer (IDE + agent infrastructure)
**Date:** 2026-07-27
**Status:** Proposed · **rev 2 (2026-07-27)** — re-examined for completeness; the plan now covers
**all 71 identified gaps**. Supersedes the "next initiative" half of [`plan.md`](./plan.md) (which
is delivered through its Phase 5).
**Scope:** `src/stable/extensions/black-ide-agent/` + editor-level surfaces in `src/stable/src/vs/`

**Benchmarked against:** Google Antigravity 2.0 · Cursor 3.5 · Continue.dev · NeuralInverse · CortexIDE · A-Coder · OPIDE.

> **Method.** Every "Level"/"Status" below is grounded in code in this repo (file:line where it
> matters), not in the README. Competitor claims come from their public docs/READMEs as of
> 2026-07-27 and are labelled as *their* claims, not measured results. Where our own docs
> overstate reality, that is called out — see [Doc corrections](#0-doc-corrections-truth-up).

> **What changed in rev 2.** A second pass against the code found **four items graded wrongly** in
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
| B1 | 8 selectable modes (Ask, Plan, Agent, Frontend, Backend, DevOps, Manager, Sr Architect) | 🟢 | ✅ | `core/mode-loader.ts`. Ahead of Cursor (3) and A-Coder (4) on breadth. |
| B2 | 7 internal pipeline-phase agents | 🟢 | ✅ | Unique to us. |
| B3 | Custom modes (YAML frontmatter, 3 scopes, hot-reload, inline diagnostics) | 🟢 | ✅ | At Continue's agent-block bar, better DX (diagnostics). |
| B4 | Per-mode tool allowlist + iteration budget | 🟢 | ✅ | Ahead of Cursor/A-Coder. |
| B5 | **Reviewer agent (PR/diff review that proposes fixes)** | ⬜ | ❌ | Cursor BugBot (~80% claimed resolution). We ship *zero* review capability. → **E8** |
| B6 | **Learn / teaching mode** | ⬜ | ❌ | A-Coder Student Mode (adaptive difficulty). Cheap differentiator. → **E16** |
| B7 | Domain-vertical fleets (firmware, legacy modernization) | ⬜ | ❌ | NeuralInverse (357 MCU variants, 61 translation profiles). Deliberately out of our lane, but the skills framework makes it data-only. → **E17** |

### 1.3 Knowledge, rules & memory

| # | Capability | Level | Status | Parity bar / gap |
|---|---|:--:|:--:|---|
| C1 | Skills framework (stack + role + prompt resolution) | 🟡 | ✅ | `agent/skill-resolver.ts` (87 LOC), `agent/skills-manager.ts`. Architecture is at/above bar; **library is 16 packs of a ~60-pack catalog**. → **E9** |
| C2 | Project profiler (manifest-based stack detection) | 🟡 | ✅ | `core/project-profiler.ts` (255 LOC). Ahead of everyone — no competitor keys prompts off detected stack. |
| C3 | Bundled skill packs | 🔴 | 🟡 | 16 shipped: `django`, `fastapi`, `flask`, `express`, `aspnet-core`, `axum`, `gin`, `rails`, `react`, `nextjs`, `angular`, `react-native`, `tailwind`, `jest`, `pytest`, `a11y-wcag-aria`. Missing all of Wave 2. → **E9** |
| C4 | **Rules engine (glob-scoped, activation modes, per-session toggles)** | 🔴 | 🟡 | We have one flat `.blackide/AGENTS.md`. Cursor: `.cursor/rules/` with `globs` + `alwaysApply` + agent-requested + manual. Continue: markdown rules + the "notch" toggle panel. → **E6** |
| C5 | Long-term project memory (`.blackIDE/knowledge/`) | 🟡 | ✅ | `core/knowledge-base.ts` (308 LOC), `memory/knowledge-store.ts`. Human-readable markdown is a real strength (ADR 007). |
| C6 | **Automatic memory extraction / dedup / decay / contradiction detection** | 🔴 | ❌ | `remember` tool is model-invoked only — nothing extracts facts automatically, nothing ages them out, nothing detects contradictions. Cursor Memories; OPIDE Engram (3-tier, decay, contradiction detection, idle consolidation). → **E7** |
| C7 | Mindmap sync (`project_mindmap.md`) | 🟡 | ✅ | Sectioned upsert of detected stack shipped (plan.md Phase 5). Read-back is still thin. |
| C8 | Team / org-level shared rules & memory | ⬜ | ❌ | Cursor Team Rules. → **E6** |

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
| D9 | **Context providers / `@`-mentions** | 🔴 | 🟡 | *Corrected:* `@`-mention **exists but is file-only** (`webview/src/App.tsx:1210,3220,3274`). No `@folder`, `@symbol`, `@problems`, `@terminal`, `@git`, `@web`, `@docs`, `@past-chats`, and no pluggable provider API. Cursor and Continue both ship the full set. → **E19** |
| D10 | Ranged file reads (token-efficient pagination) | 🟢 | ✅ | *Corrected:* `read_file` already takes `start_line`/`end_line` (`core/tools.ts:14-22`) — at A-Coder's "intelligent file pagination" bar. |
| D11 | **Git-history semantic search** | ⬜ | ❌ | A-Coder ships Morph-accelerated search across git history. `grep -rn "git log\|blame"` over `src/` returns nothing. → **E20** |
| D12 | **Notebook (`.ipynb`) awareness** | ⬜ | ❌ | No `notebook`/`ipynb` reference anywhere in `src/`. Agent cannot read or edit a cell. → **E21** |
| D8 | Web search | 🟡 | ✅ | `tools/web-search.ts` — DuckDuckGo scrape only, no keyed providers. → **E13** |

### 1.5 Tools & execution

| # | Capability | Level | Status | Parity bar / gap |
|---|---|:--:|:--:|---|
| E_1 | 23 native tools (file/grep/list/run_command/subagent/artifact/mindmap/…) | 🟢 | ✅ | `core/tools.ts`. Comparable to A-Coder (22+), ahead of OPIDE (10+). |
| E_2 | Exact SEARCH/REPLACE edit contract | 🟢 | ✅ | `core/tools.ts:63` — same discipline A-Coder calls out as its precision feature. At bar. |
| E_3 | Checkpoints & rollback (reverse hunks, per-message undo) | 🟢 | ✅ | `core/checkpoint-manager.ts`. **Ahead of CortexIDE's "checkpoint and visualize".** |
| E_4 | Browser automation (Playwright, gated, per-task session) | 🟡 | ✅ | `tools/browser-tool.ts` + `browser-capability.ts` allowlist. |
| E_5 | **Visual verification loop (screenshot/recording as reviewable evidence)** | 🔴 | ❌ | Antigravity: browser recordings + screenshots as first-class artifacts, agent self-verifies UI work. We can drive a browser but produce no evidence trail. → **E5** |
| E_6 | MCP client | 🟡 | ✅ | `tools/mcp-client.ts:51` — **stdio only**, Agent-mode only, refused in pipeline runs. Antigravity ships Chrome + Web MCP servers; remote/streamable HTTP is table stakes now. → **E12** |
| E_7 | Vision / image input | 🟢 | ✅ | `core/llm-client.ts:334-370` — images on user turns *and* tool results, OpenAI + Anthropic shapes. At A-Coder's bar. |
| E_8 | Agent hooks (`beforeToolCall`/`afterToolCall`/`beforeResponse`/`onError`) | 🟡 | ✅ | `agent/hooks.ts:8`. Present but under-documented and unused by first-party features. |
| E_9 | Tool circuit breakers / per-tool failure budgets | ⬜ | ❌ | OPIDE ships them. A wedged tool currently burns iterations. → **E15** |
| E_10 | Post-edit diagnostics feedback | 🟢 | ✅ | *Corrected:* `ToolRunner.collectDiagnostics` (`tools/tool-runner.ts:306`) is called after every edit from `agent/tool-executor.ts:111` — the agent **does** see compiler/linter errors it caused. Better than the first assessment. |
| E_11 | **On-demand `get_diagnostics` + LSP navigation tools** | 🔴 | 🟡 | Diagnostics are *pushed* after edits but the model cannot **ask** for them, and there is no `go_to_definition` / `find_references` / `workspace_symbols` / `rename_symbol` tool. We ship a VS Code fork with every language server already running and don't expose it to the agent. → **E22** |
| E_12 | **Sandboxed command execution** | 🔴 | ❌ | `executeCommandInTerminal` (`tool-runner.ts:133`) spawns a real, unrestricted `vscode.window.createTerminal`. Policy-gated (G1) but not *contained*. Cursor 2.0 sandboxed shells; OPIDE QuickJS sandbox + 10-layer model. → **E23** |
| E_13 | **Test-runner integration** (run one test, parse results structurally) | 🔴 | 🟡 | Only via raw `run_command`; no structured pass/fail parsing even though `ProjectProfile` already knows the test framework. → **E24** |

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
| F17 | **Reusable prompt / notepad library** | ⬜ | ❌ | Cursor Notepads, Continue prompt blocks. We have fixed slash commands, no user-defined ones. → **E29** |
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
| G8 | Skill validation diagnostics + skills-fired telemetry | 🟡 | 🟡 | plan.md Phase 6 remainder. → **E0** |
| G9 | Test architecture | 🟡 | ✅ | 46 suites / 426 assertions in a bespoke `test/harness.js` (1613 LOC) + only **2** vitest files in `__tests__/`. Coverage is real but the harness is non-standard and hard for contributors to extend. → **E0** |
| G11 | At-rest encryption for agent artifacts / memory | ⬜ | ❌ | OPIDE claims AES-256-GCM. Our `.blackIDE/` is plaintext on disk (defensible — it's the user's repo — but not an option we offer). → **E15** |
| G12 | Team analytics / admin policy dashboard | ⬜ | ❌ | Cursor ships admin analytics; NeuralInverse ships audit export for regulated work. Our telemetry is local-only by design (G4) — so this must be **opt-in, self-hosted**, never a phone-home. → **E32** |
| G13 | Issue-tracker / chat integrations (GitHub Issues, Linear, Jira, Slack) | ⬜ | ❌ | Cursor Slack + Linear. Needs the headless core (E14) to be worth building. → **E33** |
| G10 | `extension.ts` maintainability | 🔴 | ❌ | **2537 LOC** — command wiring, chat orchestration, pipeline entry and webview plumbing in one file. Every enhancement below lands here; this is the #1 velocity tax. → **E0** |

### 1.8 Scoreboard

| Area | Us | Best-in-class | Verdict |
|---|:--:|---|---|
| Pipeline / SDLC orchestration | 🟢 | — | **We lead.** No competitor ships this. |
| Safety & command policy | 🟢 | OPIDE | **We lead** on policy; behind on sandboxing/audit. |
| Checkpoints & undo | 🟢 | CortexIDE | **We lead.** |
| Project-aware skills | 🟡 | — | **We lead architecturally**, behind on library breadth. |
| Retrieval & code graph | 🟡 | OPIDE, Cursor | **We are behind.** Chunking is naive; no code graph. |
| Rules & memory | 🟡 | Cursor, OPIDE | **We are behind.** Flat file + manual memory. |
| Daily-driver autocomplete | 🟡 | Cursor | **We are far behind.** No next-edit. |
| Parallel task agents & steering | 🔴 | Antigravity, Cursor | **We are behind.** |
| Verification & artifacts | 🔴 | Antigravity | **We are behind.** |
| Model routing | 🔴 | Continue, OPIDE | **We are behind.** |
| Review automation | ⬜ | Cursor BugBot | **Absent.** |
| Distribution / surfaces | ⬜ | Continue Hub, Antigravity CLI/SDK | **Absent.** |

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
against the exact-match contract (`tools.ts:63`) and fall-back to the strong model on mismatch.
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

**Now:** `@`-mention resolves **files only** (`webview/src/App.tsx:1210`). No provider abstraction.
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

**Now:** diagnostics are auto-collected post-edit (`tool-executor.ts:111`) but the model cannot
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

| ID | Missing capability | Pri | Enh | Phase |
|---|---|:--:|:--:|:--:|
| M1 | Doc claims corrected (AST chunking, provider failover) | P0 | E0 | 0 ✅ |
| M2 | `extension.ts` (2537 LOC) decomposed | P0 | E0 | 0 ✅ |
| M3 | Golden-task eval set + scoring | P0 | E0 | 0 ✅ |
| M4 | Vitest migration off the bespoke harness | P0 | E0 | 0 ✅ |
| M5 | Skill validation diagnostics UI + skills-fired telemetry | P1 | E0 | 0 ✅ |
| M6 | On-demand `get_diagnostics` tool | P0 | E22 | 1 ✅ |
| M7 | LSP navigation tools (definition, references, symbols, hover, rename, code actions) | P0 | E22 | 1 ✅ |
| M8 | Structured `run_tests` with per-framework result parsing | P0 | E24 | 1 ✅ |
| M9 | Rules v2 — `.blackide/rules/*.md`, globs, activation modes, priority | P1 | E6 | 2 |
| M10 | Session control panel ("what fired", toggle rules/tools) | P1 | E6 | 2 |
| M11 | Team / org shared rules | P2 | E6 | 2 |
| M12 | User-defined prompts + workflows library | P2 | E29 | 2 |
| M13 | Learn / teaching mode | P2 | E16 | 2 |
| M14 | Tree-sitter symbol chunking | P0 | E2 | 3 |
| M15 | Code graph (calls, imports, type hierarchy) | P0 | E2 | 3 |
| M16 | `impact_analysis` + graph-backed `find_references` | P1 | E2 | 3 |
| M17 | Reranker stage | P1 | E2 | 3 |
| M18 | Structured tool-output compression | P1 | E11 | 3 |
| M19 | Context provider API + full `@`-mention set | P1 | E19 | 3 |
| M20 | External docs indexing (`@docs`) | P1 | E13 | 3 |
| M21 | Keyed web-search providers | P2 | E13 | 3 |
| M22 | Git-history semantic search + blame/why-changed | P2 | E20 | 3 |
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

**Counts:** 71 gaps — P0: 11 · P1: 30 · P2: 23 · P3: 7. All 71 are scheduled.

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

> ### ✅ Delivered 2026-07-27
> `tools/lsp-tools.ts` (7 tools) · `core/test-report.ts` (pure selection + 7 parsers) ·
> wired into `agent/tool-executor.ts`, both executor construction sites, all 11 mode
> allowlists, the chat system prompt and the Testing Executor prompt.
> **Harness 426/426 · vitest 82/82 (+52) · eval no regression.**
>
> **Gate status.** The output-size gate is **met and asserted in CI**: a 30 KB pytest run with
> 800 passing cases and one failure formats to <2 KB (`__tests__/test-report.test.ts`). The
> other two gates are **partially met**: they need a live extension host, so what is asserted
> today is the wiring and the pure logic (tool surface per mode, symbol-position resolution,
> parser behaviour) rather than end-to-end LSP round-trips. Real-host assertions for
> `rename_symbol` across 5+ files belong in `test/integration`, and "resolves via LSP not grep"
> needs the model tier. Both are noted in `eval-baseline.md` rather than claimed.
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
  `priority`, `scope`; unified rules+skills assembly through `prompt-builder.ts`; `AGENTS.md`
  back-compat preserved.
- Session control panel: toggle rules/tools, show exactly what fired this turn.
- Team rules from a repo-committed or `BLACKIDE_TEAM_RULES` path (tighten-only semantics).
- `.blackide/prompts/*.md` → user-defined slash commands + ordered workflows, hot-reloaded with the
  same diagnostics as custom modes.
- `Learn` mode (read-heavy allowlist, cannot write without explicit confirmation).

**Gate:** editing a `.ts` file activates only TS-glob rules; the panel's "fired" list byte-matches
the assembled prompt; `AGENTS.md`-only projects behave identically to today.

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

**Gate:** recall@10 for "files that must change" +25% over baseline; `impact_analysis` accuracy on
refactor fixtures with ≤2 false positives; ≥30% token reduction from compression with **no** eval-
success regression; index build within baseline +50%; packaged-build smoke test passes with the
native grammars.

### Phase 4 — Model layer
*Covers M23–M27.*

- `ModelRouter` with roles `chat | plan | edit | apply | autocomplete | embed | rerank`, per-role
  provider/model/budget.
- Health-aware cross-provider failover with per-provider circuit breaking; substitution surfaced in
  the UI (never silent).
- Fast-apply path: strong model states intent, cheap model materialises SEARCH/REPLACE blocks,
  verified against the exact-match contract (`core/tools.ts:63`), **fail closed** to the strong
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

| Metric | Baseline (Phase 0) | Target | Proven in |
|---|---|---|---|
| Task success rate, per stack | record | +20 pts | 3, 5, 10 |
| Recall@10 for "files that must change" | record | +25% | 3 |
| Tokens per completed task | record | −40% | 3, 4 |
| Symbol-question accuracy (LSP vs grep) | record | +30% | 1 |
| Test-failure feedback size | record | −95% (50 KB → <2 KB) | 1 |
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
