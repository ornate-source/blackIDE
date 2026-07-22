# Black IDE — Missing & Broken Features Audit

**Author:** Senior Software Engineer (code audit)
**Date:** 2026-07-22
**Scope:** `src/stable/extensions/black-ide-agent/` (the built-in AI agent extension — the
product's core), plus repo packaging/hygiene.
**Baseline verified this pass:** `tsc -b` clean (both projects), webview builds, harness
**352/352 green**. So the defects below are **not** compile or unit-test failures — they are
gaps between what the UI/settings/tools *advertise* and what the runtime actually wires up,
found by tracing message handlers, tool registration, and settings consumption end to end.

> This complements the existing plans (`plans/`, `execution-plan-v2.md`, `futureplan.md`,
> which track P1–P7 as shipped). Nothing here is a re-report of those items; every entry was
> re-derived from the current code with a file:line citation.

---

## Full feature inventory & status

Everything Black IDE advertises (README + `docs/`), mapped to its actual state in code.
**Status legend:** ✅ Working (verified real & wired) · 🟡 Works, with a caveat/bug ·
🔴 Broken (advertised, non-functional) · 🐛 Defect/hygiene · 📐 Planned/experimental.
The `Ref` column points to the broken-feature IDs (B1–B8) detailed below.

### Core agent

| Feature | Status | Notes / Ref |
|---|:--:|---|
| Bounded agent loop (context budgeting, execution interlock) | ✅ | `agent/agent-loop.ts`, `core/context-manager.ts` |
| Two-phase planning + human approval gate | ✅ | plan → `implementation_plan`+`task_list` → Plan Review Card |
| Approval persistence (survives reload/crash via Memento) | ✅ | `extension.ts:507-523` |
| Request classification / auto-plan & auto-orchestrate triggers | ✅ | `PlanningEngine.classifyRequest/shouldPlan/shouldOrchestrate` |
| Slash commands: `/explain /test /fix /commit /refactor /docs /search /plan /orchestrate /single` | ✅ | `extension.ts:624-657` |
| Multi-turn memory, threads, history (save/switch/delete/clear) | ✅ | `memory/history-store.ts` |
| Conversation auto-titling | ✅ | `extension.ts:2136` |

### Agent modes

| Feature | Status | Notes / Ref |
|---|:--:|---|
| Built-in modes: Ask, Plan, Agent, Frontend, Backend, DevOps, Manager, Sr Architect | ✅ | `core/mode-loader.ts:107+` |
| README says "**eight** built-in modes"; code ships **11** | 🟡 | +`Sr Architect HLD`, `Sr Engineer LLD`, `Planner` (internal pipeline phases) — doc undercount |
| Custom modes (Markdown + YAML frontmatter, 3 scopes) | ✅ | `~/.blackide/modes`, `.blackide/modes`, `.agents/modes` |
| Hot-reload + config errors as inline diagnostics | ✅ | `ModeLoader.watchForChanges` |

### Checkpoints & rollback

| Feature | Status | Notes / Ref |
|---|:--:|---|
| Atomic checkpoints via reverse hunks | ✅ | `core/checkpoint-manager.ts` (unit-tested) |
| Durable to `globalStorage`; per-message undo; redo | ✅ | |
| Granular per-file keep / restore; inline diff preview | ✅ | `extension.ts:704-723` |

### Codebase indexing

| Feature | Status | Notes / Ref |
|---|:--:|---|
| Semantic index: embeddings + BM25 fused via RRF, AST-aware chunking | ✅ | `core/codebase-index.ts`, `core/embeddings-client.ts` |
| Embeddings settings (provider/model/key/url) honored | ✅ | OpenAI + Ollama |
| README claims "**SQLite** vector embeddings" | 🟡 | Actually JSON (`codebase-index.json`) + `vectors.bin` — no SQLite anywhere. Doc inaccuracy |

### Subagents & multi-agent pipeline

| Feature | Status | Notes / Ref |
|---|:--:|---|
| Subagent isolation (git worktrees, git mutex, delta reconcile) | ✅ | `agent/worktree-manager.ts` (real-git tests) |
| Subagent cancel | ✅ | `extension.ts:724` |
| Subagent **"Merge" button** | ✅ | **B3 fixed (Phase 2)** — removed; subagents auto-reconcile on success, failure path prints the git command |
| Multi-agent pipeline (HLD → LLD → Planner → execute → overview) | ✅ | `agent/pipeline-orchestrator.ts` |
| Dependency-driven phase selection (`EXECUTION_PHASE_GRAPH`) | ✅ | |
| Per-phase model routing | ✅ | `pipelinePhaseModels` |
| Token-budget interlock | ✅ | `pipelineTokenBudget` |
| Up to 4 concurrent runs (Pipeline Manager panel) | ✅ | `extension.ts:1434+` |
| Durable run history + interrupted-run reconciliation | ✅ | `core/pipeline-runs.ts` |
| Output modes: `apply` (default) / `pr` (push + `gh pr create`) | ✅ | `core/git-pr.ts` |
| Parallel wave execution | 📐 | Experimental, default OFF; "not yet verified under extension host" (`pipeline-orchestrator.ts:489`) |

### Editor integration

| Feature | Status | Notes / Ref |
|---|:--:|---|
| Inline chat (`Cmd+I`) with accept/edit-again/reject | ✅ | `core/inline-chat-controller.ts` |
| Inline completion / autocomplete (FIM-aware) | ✅ | `core/inline-completion.ts` — `enableAutocomplete`/`autocompleteModelId`/`autocompleteDebounce` honored |
| Generate commit message (SCM input box) | ✅ | `extension.ts:2203` |
| Auto-open plan / mindmap / overview artifacts | ✅ | |

### Tools

| Feature | Status | Notes / Ref |
|---|:--:|---|
| File tools: `read_file`, `write_file`, `edit_file`, `list_directory` | ✅ | `tools/tool-runner.ts` |
| `grep_search`, `codebase_search`, `run_command` | ✅ | |
| `web_search` (DuckDuckGo instant-answer + HTML fallback) | ✅ | `tools/web-search.ts` |
| MCP client (`mcp.json`, stdio JSON-RPC, tool registration) | ✅ | `tools/mcp-client.ts` |
| `remember` / knowledge tools, `create_artifact`, `update_plan`, `update_mindmap` | ✅ | |
| `schedule_task` / `cancel_task` (background scheduler) | ✅ | `agent/scheduler.ts` |
| `spawn_subagent` | ✅ | |
| Browser tools: `browser_open/read/screenshot/click/type/close` | ✅ | **B1 fixed (Phase 1)** — opt-in; gated behind a runtime check + one-click "Install Browser Support", so they're only offered when usable |

### Long-term memory

| Feature | Status | Notes / Ref |
|---|:--:|---|
| `.blackIDE/knowledge/` regime (architecture, decision_log/ADRs, feature_status, technical_debt, glossary, roadmap) | ✅ | `core/knowledge-base.ts` |
| First-run architecture scan (once per workspace, never overwrites) | ✅ | `extension.ts:426` |
| Per-file context budgeting + compaction | ✅ | tested |

### Providers & settings

| Feature | Status | Notes / Ref |
|---|:--:|---|
| Multi-provider LLM config (OpenAI, Anthropic, Google, OpenRouter, Ollama, LM Studio, local) | ✅ | `core/llm-client.ts` |
| Model discovery / fetch + Ollama auto-detect | ✅ | `agent/model-fetcher.ts`, `extension.ts:841` |
| Auto-approve toggles (edits / create / terminal) | ✅ | honored in approval gate |
| Command allow/deny policy | ✅ | `core/command-policy.ts` |
| Custom system prompt, max loop iterations | ✅ | |
| Anonymous telemetry toggle (local JSONL only) + Export Diagnostics | ✅ | `core/telemetry-sink.ts` |
| **Fast Apply** toggle | ✅ | **B5 fixed (Phase 2)** — removed; the capability never existed. A real fast-apply is a future feature with its own design |
| **Reasoning display** toggle | ✅ | **B6 fixed (Phase 3)** — `startReasoning`/`streamReasoning` posts gated on `enableReasoningDisplay` |
| Chat **"Take screenshot"** | ✅ | **B4 fixed (Phase 2)** — removed; no persistent chat browser to capture. In-run capture stays available via the `browser_screenshot` tool |
| **Browser settings tab** (path / headless / viewport / screenshot-on-nav) | ✅ | **B2/B8 fixed (Phase 1)** — all read via `readBrowserSettings` and applied in `BrowserTool` |
| **Browser "Allowed Domains"** restriction | ✅ | **B2 fixed (Phase 1)** — enforced in `BrowserTool.launch/navigate` via `isNavigationAllowed` (fails closed) |

### Platform / distribution

| Feature | Status | Notes / Ref |
|---|:--:|---|
| Telemetry-free VS Code distribution (patch set) | ✅ | `config/patches/` |
| Multi-platform build (macOS / Linux / Windows / Alpine) | ✅ | mac artifacts present in `assets/` |
| Open VSX as default marketplace | ✅ | `config/product.json` |
| Command filter + extension security hardening | ✅ | patches |

### Repo hygiene

| Item | Status | Notes / Ref |
|---|:--:|---|
| 125 test-fixture files committed under `.../black-ide-agent/tmp/` | 🐛 | **B7** — `.gitignore` gap |

---

## Summary

| # | Feature | Type | Severity | Evidence |
|:-:|---------|------|:--------:|----------|
| B1 | Browser automation (`browser_*` tools) fails out-of-the-box | ✅ Fixed (Phase 1) | **P0** | `playwright` undeclared/uninstalled |
| B2 | Browser settings tab is entirely unwired (incl. security domain allowlist) | ✅ Fixed (Phase 1) | **P0** | 0 runtime reads of `browser*` keys |
| B3 | "Merge subagent" button does nothing | ✅ Fixed (Phase 2) | **P1** | `ParallelSubagents.tsx:101`, no handler |
| B4 | Chat "Take screenshot" is a hardcoded stub | ✅ Fixed (Phase 2) | **P1** | `extension.ts:614` |
| B5 | "Fast Apply" toggle (`enableFastApply`) is a no-op | ✅ Fixed (Phase 2) | **P1** | 0 runtime reads |
| B6 | "Reasoning display" toggle (`enableReasoningDisplay`) is a no-op | ✅ Fixed (Phase 3) | **P2** | 0 runtime reads |
| B7 | 125 test-fixture files committed under `tmp/`; `.gitignore` gaps | Hygiene | **P2** | `git ls-files …/tmp` |
| B8 | Browser viewport / headless / screenshot-on-nav settings ignored | ✅ Fixed (Phase 1) | **P2** | 0 runtime reads |

Legend — **P0**: advertised feature is non-functional in the shipped build. **P1**: visible
control with no effect (user-facing dead end). **P2**: quality / correctness / hygiene.

---

## Broken features

### B1 — Browser automation fails out-of-the-box (P0)
> **✅ Resolved (Phase 1, Option B — detect & gate).** `browserRuntimeAvailable()`
> (`src/tools/browser-capability.ts`) checks for Playwright without launching; the `browser_*`
> tools are filtered out of the tool list (`filterToolsForBrowser`) unless the browser is both
> enabled in settings and a runtime is present, so the model is never offered a tool that would
> fail. A `black-ide.installBrowserSupport` command + a Settings→Browser button install
> Playwright + Chromium into the extension on demand. Covered by harness suite `[42]`.

All six `browser_*` agent tools (`browser_open`, `browser_read`, `browser_screenshot`,
`browser_click`, `browser_type`, `browser_close`) and the pipeline "Testing Executor"
self-verification depend on Playwright, which is **loaded via `require('playwright')`**
(`src/tools/browser-tool.ts:20`) but is **not a declared dependency** and **not present in
`node_modules`**. `package.json` lists only `js-yaml` as a runtime dependency.

- **Effect:** every browser tool throws *"Playwright is not installed…"* the first time the
  agent uses it. Since the extension is bundled into the packaged IDE, an end user has no
  clean way to install it into the extension's own `node_modules`.
- **Registered but dead:** `src/core/tools.ts` advertises these tools to the model, so the
  agent *will* choose them and then fail — worse than not offering them.
- **Fix options:** (a) add `playwright` to `dependencies` and ship the browser via the build,
  or (b) lazy-gate the tools out of `toolsForMode()` unless a Playwright/Chrome runtime is
  detected, and surface a one-click install. Pair with B2 (below).

### B2 — Browser settings tab is unwired, including a security control (P0)
> **✅ Resolved (Phase 1).** All `browser*` settings are now read via `readBrowserSettings()` and
> applied to `BrowserTool` (`configure()`): `browserPath` → `executablePath`, `browserHeadless`,
> viewport, and `browserEnabled` as a real master switch. **`browserAllowedDomains` is enforced**
> in `launch()`/`navigate()` via `isNavigationAllowed()` (exact + subdomain match, fails closed on
> an unparseable URL) — the false-security affordance is gone. Pure logic covered by harness `[42]`.

The Settings → **Browser** tab (`webview/src/App.tsx:2368+`) exposes `browserEnabled`,
`browserHeadless`, `browserPath`, `browserViewportWidth/Height`, `browserScreenshotOnNav`,
and **`browserAllowedDomains`**. A grep of the runtime (`src/**`) finds **zero reads** of any
of them.

- **`browserAllowedDomains`** is the serious one: its UI copy says *"Restricts browser
  navigation to these domains."* It restricts nothing — `BrowserTool.navigate()`/`launch()`
  never consult an allowlist. This is a **false security affordance**: a user who scopes the
  agent to `github.com` is not actually protected.
- **`browserPath`** ("custom Chrome path") is never passed to
  `playwright.chromium.launch()` (`browser-tool.ts:21`), which takes no `executablePath`.
- **`browserHeadless` / viewport / screenshot-on-nav** likewise never reach `launch()`.
- **Fix:** thread these settings into `ExecutorDeps`/`BrowserTool.launch()`, and enforce
  `browserAllowedDomains` in `navigate()` (reject/deny out-of-allowlist hosts). Until then,
  either hide the tab or label the controls as non-functional.

### B3 — "Merge subagent" button has no backend (P1)
> **✅ Resolved (Phase 2 — removed).** The Merge button and its `mergeSubagent` post are gone
> from `ParallelSubagents.tsx` (along with the now-unused `isDone`/`BTN` locals). Subagents
> already auto-reconcile on success; the failure path still preserves the worktree and prints the
> exact `git merge <branch>` recovery command, so no capability was lost.

`webview/src/ParallelSubagents.tsx:101` posts `{ type: 'mergeSubagent', value: sa.id }`, but
`extension.ts` has **no `case 'mergeSubagent'`** (it handles `cancelSubagent` only). Clicking
Merge silently does nothing.

- **Root cause / decision needed:** subagents already auto-reconcile their worktree delta into
  the live tree on completion (`extension.ts:1874-1891`, `SubagentFinished`), so a manual
  merge step may be conceptually obsolete. Either (a) remove the button, or (b) implement it as
  a real "apply this subagent's preserved worktree" action for the failure path where
  `preserveWorktree` left work on a branch (`extension.ts:1878-1883`).

### B4 — Chat "Take screenshot" is a stub (P1)
> **✅ Resolved (Phase 2 — removed).** The "Attach Screenshot" plus-menu item, its
> `handleAttachScreenshot` handler, and the `takeScreenshot` extension case are gone. Chat browser
> sessions are per-task, so there was no persistent page to capture; in-run capture remains
> available to the agent via the `browser_screenshot` tool (gated by Phase 1).

`extension.ts:614-616` handles `takeScreenshot` by showing *"Screenshot capture will be
available with browser integration."* The capability exists (`BrowserTool.screenshot()`,
`browser-tool.ts:62`) but is not connected. The chat UI presents a screenshot affordance that
never produces one.
- **Fix:** wire the handler to a `BrowserTool` instance (gated on B1), or remove the button.

### B6 — "Reasoning display" toggle does nothing (P2)
> **✅ Resolved (Phase 3).** `_runAgentTask` now reads `enableReasoningDisplay` (default on) and
> gates both the `startReasoning` and `streamReasoning` webview posts on it. Off = no reasoning
> bubble; the model still reasons and the final answer is unaffected. Tool/turn activity keeps the
> UI live, so no separate "thinking…" placeholder was needed.

`enableReasoningDisplay` is a Settings checkbox (`App.tsx:2243`, default `true`) but has **zero
runtime reads**. Reasoning tokens always stream to the webview unconditionally via
`onReasoningStart`/`onToken` (`extension.ts:1954-1959`). Turning it off has no effect.
- **Fix:** gate the `startReasoning`/`streamReasoning` posts on the setting (read it alongside
  the other `general-settings` in `_runAgentTask`).

---

## Missing / unimplemented features (control present, capability absent)

### B5 — "Fast Apply" is advertised but not implemented (P1)
> **✅ Resolved (Phase 2 — removed).** The `enableFastApply` toggle, interface field, and default
> are gone from `App.tsx`, so the UI no longer implies a capability that doesn't exist. A real
> fast-apply (a dedicated apply-model path) remains a future feature warranting its own design doc.

`enableFastApply` is a Settings toggle (`App.tsx:2234`, default `true`) with **no runtime
consumer anywhere**. There is no speculative-decoding / fast-apply diff model or code path in
`tool-executor.ts` or `diff.ts` — edits go through the normal `edit_file` write + approval
gate. The feature is named in the UI but does not exist.
- **Fix:** implement a fast-apply path (e.g. a dedicated apply model / merge strategy) or
  remove the toggle so it stops implying a capability.

### B8 — Browser viewport / headless / screenshot-on-nav (P2)
> **✅ Resolved (Phase 1).** Viewport and headless flow through `BrowserTool.launch()`;
> `browserScreenshotOnNav` auto-captures the loaded page and attaches it as vision input after
> `browser_open` (`tool-executor.ts`).

Same class as B2: `browserViewportWidth`, `browserViewportHeight`, `browserHeadless`, and
`browserScreenshotOnNav` are collected in the UI but never passed into `BrowserTool.launch()`,
which hardcodes `headless: true` and `1280×720` defaults. Listed separately from B2 because
these are quality/ergonomics, not security.

---

## Repo hygiene / packaging

### B7 — Test-fixture artifacts committed; `.gitignore` gaps (P2)
`git ls-files` shows **125 tracked files under
`src/stable/extensions/black-ide-agent/tmp/`** — leftover harness output (`tmp/ckpt-*/keep.txt`,
`tmp/txn-*/*.txt`). These are transient test scratch files that should never be in version
control. (`test/tmp/`, `node_modules/`, `dist/`, `.npm-cache/`, `.vscode-test/` are correctly
untracked — only `tmp/` slipped through.)
- **Fix:** `git rm -r --cached src/stable/extensions/black-ide-agent/tmp` and add `tmp/` to the
  extension's ignore rules next to the existing `test/tmp/` entry. Point the harness's scratch
  root at `test/tmp/` (already ignored) so this can't recur.

---

## What is genuinely working (verified, to bound the audit)

So the list above is not read as "everything is broken" — these were checked and are real,
end-to-end implementations:

- **Agentic loop, checkpoints, undo/redo, per-message revert** — wired and unit-tested.
- **Multi-agent pipeline** (chat + concurrent Manager panel), plan-approval gate, worktree
  isolation + delta reconciliation, PR output mode, per-phase model overrides, token budget.
- **`web_search`** — real DuckDuckGo instant-answer + HTML fallback (`web-search.ts`).
- **MCP client** — real stdio/JSON-RPC transport (`mcp-client.ts:53`).
- **Semantic index** — real embeddings (OpenAI/Ollama) fused with BM25 via RRF; the
  `embeddings*` settings *are* honored (`codebase-index.ts:68-73,218-224`).
- **Inline completion** — real FIM-aware provider; `enableAutocomplete`,
  `autocompleteModelId`, `autocompleteDebounce` all honored (`inline-completion.ts`).
- **Knowledge base**, first-run architecture scan, compaction, telemetry sink, durable run
  history reconciliation.

---

## Suggested remediation order

1. **B1 + B2** together — decide browser strategy (ship Playwright vs. detect-and-gate) and
   enforce/hide the Browser settings tab. The `browserAllowedDomains` false-security issue
   makes this the top priority.
2. **B3, B4, B5** — resolve the three dead UI controls (implement or remove). Each is a small,
   isolated change; removing is acceptable if the capability isn't planned.
3. **B6, B8** — honor the two remaining no-op toggles.
4. **B7** — untrack `tmp/` and fix the ignore rule + harness scratch path.

Every "remove" recommendation is a legitimate fix: a control that lies about what it does is
worse than its absence.
