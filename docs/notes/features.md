# Black IDE — Feature List (Status & Level)

**Generated:** 2026-08-04 · **Canonical.** This file is the single inventory of what Black IDE has.
`enhancement.md` owns *gaps, phases and competitor parity*; `pending-tasks.md` owns *what is open*;
this file owns *capabilities*. Where they disagree, this file wins — it is regenerated against the
code, not against the previous revision.

**Verified against the tree on 2026-08-04 by running it,** not by reading the last revision:
`tsc -b` clean · harness **418/418** · vitest **2 058 / 77 suites** · eval gate green with no
regression vs `eval/baseline.json` (112 tasks / 21 fixtures · stack detection 100% 21/21 ·
skill exact-match 100% · wrong-idiom 0% of 38 guarded tasks · recall@5 91.2 / @10 97.2 / @20 100 ·
compaction 36.9% at realistic path depth) · webview builds · `extension.ts` **698 LOC** (≤700 gate).

Paths are relative to `src/stable/extensions/black-ide-agent/`.

---

## How to read a row

Two axes, the same two `enhancement.md` §1 used, so one vocabulary covers every doc in this folder.

**Status** — delivery state.

| | Means |
|:--:|---|
| ✅ | Shipped and wired. On by default, or one named toggle away. |
| 🟡 | Partially delivered. The row names what is missing. |
| 🧪 | Built but default-off, because it costs something a user should opt into. |
| 📋 | Planned in the roadmap, not built. |
| ⬜ | Deliberately not built — an architectural position, not debt (§8). |

**Level** — engineering maturity of what exists, judged against what a competent competitor ships.

| | Means |
|:--:|---|
| 🟢 | Advanced. Robust, tested, and guarded by a gate that would catch a regression. |
| 🟡 | Mid. Works, with a real limitation a user will meet — named in the row. |
| 🔴 | Beginning. Naive, experimental, or barely wired. |
| — | Nothing built, so no judgement. |

---

## 1. Agent core & orchestration

| # | Feature | Status | Level | What it is |
|:--:|---|:--:|:--:|---|
| 1 | **Bounded agent loop** | ✅ | 🟢 | Think → tool → observe, bounded by a token budget rather than a message count, with an execution interlock that forces the model to read the real result. `agent/agent-loop.ts` |
| 2 | **Two-phase planning with an approval gate** | ✅ | 🟢 | Non-trivial prompts plan first under read-only tools; the gate persists to `Memento`, so a reload restores the card instead of losing the run. `agent/planning-engine.ts` |
| 3 | **Multi-agent SDLC pipeline** | ✅ | 🟢 | HLD → LLD → Planner → Design/Backend/Frontend/Testing as a fixed seven-phase pipeline. No competitor ships this. `agent/pipeline-orchestrator.ts` |
| 4 | **Subagent isolation via git worktrees** | ✅ | 🟢 | Subagents work in their own worktree and reconcile by delta, so the live tree is never a scratchpad. `agent/worktree-manager.ts` |
| 5 | **Concurrent pipeline runs with durable history** | ✅ | 🟢 | Up to four at once, each with its own abort controller and a history that survives reload. `core/pipeline-runs.ts` |
| 6 | **Task agents — N independent user-launched agents** | ✅ | 🟢 | Each with its own worktree, mode, model and workspace root; kill-one isolation and untouched-until-apply both asserted. `core/task-agents.ts`, `agent/task-agent-registry.ts` |
| 7 | **Mid-run steering** | ✅ | 🟢 | A correction reaches the running agent on its next turn without restarting it, and never lands between a `tool_use` and its result. `core/steering.ts` |
| 8 | **Concurrency and spend governor** | ✅ | 🟢 | One admission gate across both lanes; a reservation is claimed atomically, so two clicks in a tick cannot both win the last slot. `core/agent-governor.ts` |
| 9 | **Agent inbox with parking and notifications** | ✅ | 🟢 | Blocked / parked / failed / finished-unreviewed surfaced with badge counts, notified once per (item, reason). Its surface is the Office's header and desks (#81). `core/agent-inbox.ts` |
| 10 | **Multi-model race** | ✅ | 🟢 | The same prompt to N models in N worktrees, ranked on real verification evidence then diff size, willing to report no winner. Nothing auto-applies. `core/model-race.ts` |
| 11 | **Request classification / auto-orchestrate** | ✅ | 🟡 | Decides when a prompt deserves a plan or a pipeline — **keyword heuristics, not a model**, so an unusually phrased request can be misrouted. `agent/planning-engine.ts` |
| 12 | **Background / off-machine agents** | ✅ | ✅ | `blackide daemon` / `blackide queue` — a file-based queue anything can fill, claim-by-rename so two daemons cannot run one task twice, and results that reach the **inbox** (M65). Off-machine execution is the BYO runner (#13). `agent-core/daemon.ts` |
| 13 | **Remote / BYO-runner execution** | ✅ | ✅ | Commands run on a machine the user operates, as a `HostProcess` swap — the filesystem stays local, so only the slow, isolation-worthy part moves (M66). **No default endpoint and no service of ours.** The sandbox tier travels with each command and a runner that will not say which tier it enforced is refused; an unreachable one never falls back to running locally. `agent-core/remote-runner.ts` |
| 105 | **The Agent Office — graphical floor** | ✅ | 🟢 | One desk per live agent across all four lanes (task · pipeline · chat · daemon), each showing what it is doing as a sentence — `Frontend · opened apiSlice.tsx · 1.4s` — with turn-against-cap, context-against-limit, a stall badge, the branch, and a files-in-play table. Header tiles source from `GovernorSnapshot`, which was computed and discarded before this. Every button derives from a `can*` predicate and every absent measurement renders `—`, both asserted. `core/office-model.ts`, `core/office-narrate.ts`, `webview/src/OfficeView.tsx` |
| 106 | **Run journal and the Logs tab** | ✅ | 🟢 | Every run writes a durable JSONL record as it happens — tools with targets, durations and outcomes; the whole pre-flight; steering; verification — readable at three depths, filterable, live-tailing, and **complete whether or not any panel is open**. Redacted on write, bounded four ways, and never leaves the machine. Distinct from the privacy-scrubbed `TelemetrySink` by design. `core/run-journal.ts`, `agent/journal-store.ts`, `webview/src/LogsTab.tsx` |
| 107 | **Agent-readable run logs** | ✅ | 🟢 | `read_run_log` lets a run read an earlier run's record — what a failed predecessor tried, or its own steps after a compaction. Defaults to the caller's run at summary depth and states its own truncation, so a model cannot mistake 60 lines for the whole run. `core/tools.ts`, `core/office-hub.ts` |
| 108 | **The Office is reachable without opening anything** | ✅ | 🟢 | A `◆ Office` status bar entry that reads `3▸ 1!` — running, and waiting on you — sourced from the governor and `inboxCounts`, fed by the lane's own poll so it is correct when no panel is open. Plus an activity-bar **Front Desk** rendering the same floor beside your work, a `✦ Black IDE: Agent Office` command, and a blocked-run toast that reveals the sidebar rather than taking over an editor column. Each segment appears only when it has a number to show: `◆ Office 0▸ 0!` is how a badge gets ignored. `core/office-status.ts`, `core/office-sidebar.ts`, `webview/src/FrontDesk.tsx` |

## 2. The fleet — agents and modes

| # | Feature | Status | Level | What it is |
|:--:|---|:--:|:--:|---|
| 13 | **Nine selectable modes** | ✅ | 🟢 | Ask, Plan, Agent, Frontend, Backend, DevOps, Manager, Sr Architect, Learn — broader than any competitor. `core/mode-loader.ts` |
| 14 | **Seven internal pipeline-phase agents** | ✅ | 🟢 | Sr Architect HLD, Sr Engineer LLD, Planner and the four executors, each with its own prompt and allowlist. Unique to us. |
| 15 | **Custom modes** | ✅ | 🟢 | YAML frontmatter, three scopes, hot reload, and inline diagnostics for a malformed definition. |
| 16 | **Per-mode tool allowlist and iteration budget** | ✅ | 🟢 | Enforced at the executor as well as advertised, so a mode cannot execute what it never offered. `agent/tool-executor.ts` |
| 17 | **Learn mode** | ✅ | 🟢 | Explains before editing and is read-only *by construction* — no write or exec tool is in the allowlist at all. |
| 18 | **Reviewer agent** | ✅ | ✅ | Reviewer mode + `black-ide.reviewChanges` → a `review` artifact, with `black-ide.postReviewToPr` behind the per-action confirmation (M47/M48). Read-only **at the executor** and confined to the restricted tier; findings without a concrete failure scenario are dropped, which is what the ≤1-FP-in-10 clause costs. `core/code-review.ts` |
| 19 | **Domain-vertical fleets** | 📋 | — | Firmware and legacy-modernisation verticals. Out of our lane unless a real user pulls for them — see §8. |

## 3. Knowledge, rules and memory

| # | Feature | Status | Level | What it is |
|:--:|---|:--:|:--:|---|
| 20 | **Skills framework** | ✅ | 🟢 | Stack + role + trigger resolution picking the right guidance for the repo you are actually in. `agent/skill-resolver.ts` |
| 21 | **Project profiler** | ✅ | 🟢 | Manifest-based stack detection, **100% (21/21)** on the eval fixture corpus. No competitor keys prompts off a detected stack. `core/project-profiler.ts` |
| 22 | **Bundled skill packs — 47** | ✅ | 🟢 | Frameworks, testing and cross-cutting guidance, each with ≥1 golden eval task so a pack cannot rot unnoticed. `resources/skills/` |
| 23 | **Rules engine v2** | ✅ | 🟢 | Glob-scoped rules, four activation modes, three scopes, hot reload, Problems-panel diagnostics, `AGENTS.md` back-compat. `core/rules.ts` |
| 24 | **Team / org shared rules** | ✅ | 🟢 | Injected first so they survive truncation, and not user-disableable. |
| 25 | **Long-term project memory** | ✅ | 🟢 | Durable, human-readable markdown under `.blackIDE/knowledge/`. `core/knowledge-base.ts` |
| 26 | **Memory v2 — decay, dedup, contradiction, consolidation** | ✅ | 🟢 | Typed tiered entries beside a markdown projection that round-trips byte-for-byte; contradictions **ask** rather than overwrite, decay demotes then archives and never deletes. `core/memory-model.ts`, `core/memory-lifecycle.ts` |
| 27 | **Automatic memory extraction** | ✅ | ✅ | The whole loop (M41): inject before a turn, extract after it through the `edit` role, band the candidates, queue the middling ones for a one-click confirm. Extraction is fire-and-forget by signature — it returns nothing and cannot reject, so no lane can make a user wait on it or fail because of it. `core/memory-extract.ts` · `agent/memory-turn.ts` |
| 28 | **`update_mindmap` tool** | ✅ | 🟢 | The agent's own way to record modules, functions and linkages into `project_mindmap.md`, by section append or replace. |
| 29 | **Deterministic stack sync to the mindmap** | ✅ | 🟢 | The detected stack is upserted into a stable section by the extension, not the model, so re-syncing never duplicates it. |
| 30 | **Per-phase auto-sync** | ✅ | 🟢 | Each pipeline phase appends what it touched, so the record does not depend on an executor remembering to write it. |
| 31 | **Mindmap size capping** | ✅ | 🟢 | At 100 KB the oldest machine-written Auto-Sync sections drop first and agent-authored ones never do. |
| 32 | **Mindmap read-back into the prompt** | ✅ | 🟢 | Injected as its own budgeted block, excluding auto-sync so a run does not re-read its own history. Closed a write-only loop open since `plan.md` Phase 5. `core/mindmap-readback.ts` |
| 33 | **Architecture mindmap documents** | ✅ | 🟢 | `docs/mindmap/{mind,tech,hld,lld}.md` — the hand-maintained record the pipeline's analysis phases read and write alongside the generated one. |
| 34 | **Memory visualization panel** | ✅ | ✅ | A Memory tab in the Manager panel (M45): entries grouped by status and ordered by confidence, provenance phrased as an answer to "why do you believe this", and decay stated as what will happen and when. "Edit memory.md" is a primary action, because ADR 007 makes the file the user's. `core/memory-view.ts` |

## 4. Retrieval and context

| # | Feature | Status | Level | What it is |
|:--:|---|:--:|:--:|---|
| 35 | **Hybrid semantic index** | ✅ | 🟢 | Embeddings + BM25 fused by RRF; recall@5 **91.2%**, @10 **97.2%**, @20 **100%** on a measured corpus. 5 000 files index in 1 247 ms against a ≤2 s gate. `core/codebase-index.ts` |
| 36 | **Symbol-aware chunking** | ✅ | 🟢 | Chunks are functions and classes with their doc comments, via a dependency-free lexical backend behind a swappable seam. Seven languages. `core/symbol-chunker.ts` |
| 37 | **Code graph with impact analysis** | ✅ | 🟢 | Symbol table, call and import edges; `impact_analysis` at **0 false positives / 0 misses** across six refactors. `core/code-graph.ts` |
| 38 | **Reranker stage** | ✅ | 🟢 | A tuned lexical reranker by default, with a cross-encoder on the `rerank` role; recall@10 95.8 → 97.2. `core/reranker.ts` |
| 39 | **Context manager with rolling summarization** | ✅ | 🟢 | Token-budgeted compaction as the deterministic floor, plus a model-written summary above it that refuses to fold a pending approval or an unresolved tool call. `core/context-manager.ts`, `core/rolling-summary.ts` |
| 40 | **Structured tool-output compression** | ✅ | 🟢 | **36.9%** at realistic path depth, **81%** on repeated diagnostics, with the raw form retrievable via `expand_output`. `core/output-compact.ts` |
| 41 | **Eleven `@`-mention context providers** | ✅ | 🟢 | `@file`, `@folder`, `@symbol`, `@problems`, `@terminal`, `@git`, `@rules`, `@skills`, `@past-chats`, `@docs`, `@web` — each budgeted and visibly truncated. `core/context-providers.ts` |
| 42 | **External docs indexing** | ✅ | 🟢 | A bounded same-origin crawl scoped to the URL's path, so a version-pinned doc set cannot drift into another version. `core/docs-index.ts` |
| 43 | **Web search with keyed providers** | ✅ | 🟢 | Brave, Tavily and Google CSE with DuckDuckGo as the no-key default; every degradation is named rather than silent. `tools/web-search.ts` |
| 44 | **Ranged file reads** | ✅ | 🟢 | `start_line`/`end_line` pagination, so reading a large file does not spend the window. |
| 45 | **Git-history intelligence** | ✅ | 🟢 | `search_history`, `blame`, `why_was_this_changed` — shelling out to git rather than maintaining a second index. `tools/git-history.ts` |
| 46 | **Notebook awareness** | ✅ | 🟢 | Cell-aware read and edit preserving nbformat's `source` array shape, per-cell snapshot/restore, outputs excluded from prompts by default. `read_file`/`edit_file` **refuse** a `.ipynb` and name the right tool. `core/notebook.ts` |

## 5. Tools and execution

| # | Feature | Status | Level | What it is |
|:--:|---|:--:|:--:|---|
| 47 | **38 native tools** | ✅ | 🟢 | File, grep, list, `run_command`, subagent, artifact, mindmap, LSP, test, notebook and browser tools — ahead of every competitor's count. `core/tools.ts` |
| 48 | **Exact SEARCH/REPLACE edit contract** | ✅ | 🟢 | Byte-exact anchors, so a mismatch is detectable rather than a silent wrong edit. `core/search-replace.ts` |
| 49 | **Checkpoints and rollback** | ✅ | 🟢 | Reverse hunks and per-message undo, ahead of what the field ships. `core/checkpoint-manager.ts` |
| 50 | **LSP navigation tools** | ✅ | 🟢 | `go_to_definition`, `find_references`, `workspace_symbols`, `hover`, `rename_symbol`, `code_actions` — reaching the fork's own language servers, which extension-only competitors cannot. Symbols addressed by name; a cold server degrades to grep with a note. `tools/lsp-tools.ts` |
| 51 | **On-demand and post-edit diagnostics** | ✅ | 🟢 | The agent sees the compiler and linter errors it caused, and can ask for more. |
| 52 | **Test-runner integration** | ✅ | 🟢 | Framework chosen from the detected stack, seven parsers, failures only — 30 KB of output becomes under 2 KB. Trusts the exit code over the parse. `core/test-report.ts` |
| 53 | **Verification contract with bounded self-correction** | ✅ | 🟢 | Four outcomes where an unrunnable suite is *not* a pass, exactly one correction attempt, a `test-report` artifact on every path — wired into **all three lanes** (task agents, pipeline, chat). `core/verification.ts`, `agent/verify-runner.ts` |
| 54 | **Visual verification evidence** | ✅ | 🟡 | A screenshot is captured for UI changes and attached to the report. **Limitation:** it needs a reachable preview URL — an explicitly configured one is used alone rather than falling back to a guessed port, so with no dev server running the run stays `incomplete` **with the reason**. `core/visual-capture.ts`, `agent/visual-capture.ts` |
| 55 | **Typed artifacts with a review panel** | ✅ | 🟢 | Seven kinds including binary, run association, comments, and an index that rebuilds from filenames. The panel browses by run and by type; a comment on a region is **persisted first and steered second**, and it says which happened. `core/artifacts.ts`, `core/artifact-review.ts`, `webview/src/ArtifactReview.tsx` |
| 56 | **Fast-apply path** | ✅ | 🟢 | A cheap model materialises the edit; five refusal classes escalate to the strong one, so a silently wrong edit is unreachable. `core/fast-apply.ts` |
| 57 | **Tool circuit breakers** | ✅ | 🟢 | Per tool, per run: three consecutive failures or a blown latency budget disables it with a visible reason, refused at the executor as well as unadvertised. `core/tool-breaker.ts` |
| 58 | **Vision / image input** | ✅ | 🟢 | Images on user turns *and* tool results, in both OpenAI and Anthropic shapes. |
| 59 | **Browser automation** | ✅ | 🟡 | Playwright driving a real Chromium behind a domain allowlist, installed on demand. **Limitation:** the install is a first-run cost and the allowlist is per-workspace. `tools/browser-tool.ts` |
| 60 | **MCP client** | ✅ | ✅ | Three transports — stdio, streamable HTTP, HTTP+SSE — plus OAuth, resources and prompts (M49–M51). A failure names a cause and a next action rather than timing out identically for a crash, a typo and an expired token. Unattended runs connect only **vetted** servers, identified by command line or origin+path rather than by name. `tools/mcp-transport.ts` |
| 61 | **Agent hooks** | ✅ | 🟡 | `beforeToolCall` / `afterToolCall` / `beforeResponse` / `onError` exist and run, but are **under-documented and unused by first-party features**, so the shape is unproven. `agent/hooks.ts` |
| 62 | **Sandboxed execution tiers** | ✅ | ✅ | policy → restricted → contained (M57), via `sandbox-exec` or bubblewrap. **Refuses rather than degrades**: a confined tier on a machine with no mechanism returns a refusal naming what is missing, because "could not confine, ran anyway" is indistinguishable from confinement — including to the tests. Asserted against a real socket. `core/sandbox.ts` |

## 6. Editor integration and platform

| # | Feature | Status | Level | What it is |
|:--:|---|:--:|:--:|---|
| 63 | **Next-edit prediction** | 🧪 | 🟢 | Predicts the change your last edit implies — usually in another file — and offers a jump; nothing survives a buffer change. **Default-off** because it spends a model call per typing pause. `core/next-edit.ts` |
| 64 | **Inline completion** | ✅ | 🟡 | FIM-aware single-file completion. **One model, no edit history** — #63 is the answer to that, not this. |
| 65 | **Inline chat (`Cmd+I`)** | ✅ | 🟡 | Selection-scoped edit with a diff review and multi-turn refinement; scope is the selection, so cross-file intent has to go to chat. |
| 66 | **Terminal `Cmd+K`** | ✅ | 🟢 | Natural language → shell command, single-line by construction, judged by the same `CommandPolicy` as the agent, and **typed rather than run** even when allow-listed. `core/terminal-command.ts` |
| 67 | **Per-role model routing** | ✅ | 🟢 | Seven roles resolved in one place, with an explicit override outranking a standing mapping. `core/model-router.ts` |
| 68 | **Cross-provider failover** | ✅ | 🟢 | Circuit-broken per provider, failing over at the *turn* so context survives, and never after output has streamed. |
| 69 | **Fifteen LLM providers** | ✅ | 🟢 | One dispatch and one preset table, so streaming and tool-call parsing cannot drift per provider. Twelve OpenAI-compatible plus Anthropic, Gemini and `local` (Ollama / LM Studio / llama.cpp). Bedrock/Vertex deliberately absent — see §8. **Counted 2026-08-04:** `PROVIDER_PRESETS` has 15 entries and `LLMConfigEntry.type` 15 members; the "16" this folder has quoted since Phase 4 is off by one, and the test only asserts ≥15. `core/providers.ts` |
| 70 | **Zero-config first run** | ✅ | 🟢 | Probes Ollama, LM Studio and llama.cpp and *offers* what it finds — never auto-enables, ignores a runtime with no models pulled. `core/local-models.ts` |
| 71 | **Output modes (`apply` / `pr`)** | ✅ | 🟢 | Reconcile onto the working tree, or leave a branch and open a pull request. `core/git-pr.ts` |
| 72 | **Reusable prompt and workflow library** | ✅ | 🟢 | `.blackide/prompts/*.md` become slash commands with arguments and cycle-safe `steps:` chaining; built-in names are refused at load. `core/prompt-library.ts` |
| 73 | **Commit-message generation** | ✅ | 🟡 | Works. **Diff-size handling is naive** — a very large diff is truncated rather than summarised. `core/commit-message.ts` |
| 74 | **Multi-root workspace support** | ✅ | 🟡 | Longest-prefix, boundary-aware root attribution and per-root profiles. **Limitation:** the codebase index is still a single shard. `core/workspace-roots.ts` |
| 75 | **Skill distribution with checksums** | ✅ | 🟢 | Pinned refs (a moving ref is refused), SHA-256 verified before content is examined, an https-only transport check *before* git sees the URL, and a local pack shadows a registry one. `black-ide.addSkillFrom` is wired. `core/skill-registry.ts`, `tools/skill-fetch.ts` |
| 76 | **Headless CLI** | ✅ | 🟢 | `bin/blackide` runs a real task with no editor: JSON-per-line stdout, logs on stderr, six CI exit codes separating *completed but unverified* from *completed*. An `--output pr` that cannot push exits 1, not 0. `agent-core/cli.ts` |
| 77 | **Headless core as a real package** | ✅ | 🟢 | `@blackide/agent-core` — 64 modules, own manifest and `tsconfig`, subpath exports, consumable by name with the extension nowhere in sight (M62). Zero `vscode`, now enforced **by the build as well as** by the transitive walk: a path back into the extension does not resolve. `packages/agent-core/` |
| 78 | **SDK entry point** | ✅ | 🟢 | The core barrel (134 exports) plus the host interface, with silent-notifier and denying-approval baselines for embedding. `packages/agent-core/src/agent-core/index.ts` |
| 79 | **Extension marketplace / Open VSX compatibility** | ✅ | 🟢 | Full gallery and API-proposal compatibility tables in `config/product.json`, already at bar. |
| 80 | **Voice input** | ⏸️ | — | Still scheduled last, deliberately (M71). Relabelled 2026-08-04 from 📋 to ⏸️: E31 calls it "genuinely the lowest-value item in this document", and an ordering choice should not read as an omission. |

## 7. Safety, privacy and quality engineering

| # | Feature | Status | Level | What it is |
|:--:|---|:--:|:--:|---|
| 81 | **Command policy with an unoverridable deny list** | ✅ | 🟢 | A hard deny list plus user allow/deny and ask. Nobody else documents a deny list a user cannot override. `core/command-policy.ts` |
| 82 | **Secrets in the OS keychain** | ✅ | 🟢 | `SecretStorage`, never `settings.json`. `core/secret-manager.ts` |
| 83 | **Auto-approve ignored in unattended runs** | ✅ | 🟢 | A pipeline run cannot inherit a permission a human granted for interactive work. |
| 84 | **Secret redaction into prompts and logs** | ✅ | 🟢 | Thirteen vendor shapes always on; entropy gated behind an assignment context *and* a token-shape check, so real source stays readable. Half its tests assert what must survive. `core/redaction.ts` |
| 85 | **Untrusted-content posture with injection fixtures** | ✅ | 🟢 | Tool output is data — stated in the prompt and *proved* by fixtures asserting the capability gates are unmoved. `core/untrusted-content.ts` |
| 86 | **Central workspace-boundary guard** | ✅ | 🟢 | One chokepoint covering traversal, prefix collision, symlinks and `.git` — where a write escapes every other control. `core/workspace-guard.ts` |
| 87 | **Append-only audit trail** | ✅ | 🟢 | JSONL in the repo, monotonic sequence, no update method by construction, redacted on the way *in*, tolerant of the truncated final line a crash leaves. `core/audit-trail.ts` |
| 88 | **Egress register** | ✅ | 🟢 | Every outbound destination declared with a reason and a trigger, enforced by a source walk that fails the build on an undeclared call. "Phones home to nobody" is a test. `core/egress.ts` |
| 89 | **Tighten-only org policy** | ✅ | 🟢 | An org policy can narrow capability and never widen it, asserted as one capability score over the whole structure rather than field by field. `core/org-policy.ts` |
| 90 | **Per-action outbound confirmation** | ✅ | 🟢 | Nothing is posted externally without confirming *that* post; `OutboundContext` has no field for a remembered answer, so a standing grant is inexpressible. |
| 91 | **Local-only telemetry and diagnostics export** | ✅ | 🟢 | Nothing leaves the machine by default, and as of Phase 12 that is enforced rather than asserted. `core/telemetry-sink.ts` |
| 92 | **Self-hosted team analytics** | 🟡 | 🟡 | Off by default with **no endpoint anywhere in the source**, sending an eight-field allowlist projection — counts, never content. **Missing:** the sink transport and any dashboard (M69). |
| 93 | **Issue-tracker task sources** | ✅ | ✅ | Reference parsing that refuses to guess a tracker from a bare key, plus the three fetchers (M67) and a Slack forward (M68). No try-each-tracker path — that is what sends a user's token to two vendors they do not use. Slack has no `send`: it builds an action the user confirms. `core/task-fetchers.ts` · `core/slack-transport.ts` |
| 94 | **Skill validation diagnostics** | ✅ | 🟢 | Malformed packs surface in the Problems panel instead of collapsing into a silent `undefined`; catches packs that can never fire and packs that would fire every turn. `agent/skill-diagnostics.ts` |
| 95 | **Test architecture — four tiers** | 🟡 | 🟢 | Harness **418** · vitest **1 629 / 62 suites** · an eval gate with a recorded baseline. **One tier is down:** the 19 real-host integration tests have not launched since Phase 5 — `@vscode/test-electron` spawns `Contents/MacOS/Electron` and VS Code 1.131 ships `Contents/MacOS/Code`. |
| 96 | **Golden-task eval harness** | ✅ | 🟢 | 112 tasks over 21 fixtures gating stack detection, skill precision, wrong-idiom leakage, recall and index-build time, with a recorded baseline that fails the build on a regression. `eval/` |
| 97 | **Opt-in model tier for the eval harness** | 📋 | — | `--models` on `run-eval.js` with its own baseline, a budget cap and N-run variance. **The oldest open item** — five metric rows and Phase 1's last gate all wait on it (§4.6 / X-1). |
| 98 | **At-rest encryption for `.blackIDE/`** | ✅ | ✅ | Optional, off by default, scoped per part (M58). Line-level sealing keeps the audit trail append-only — whole-file encryption would make every append a rewrite; exact-bytes decryption keeps the memory markdown's round-trip byte-stable. `core/at-rest.ts` |

## 8. Not scheduled — deliberate positions

Absent on purpose. Each is an architectural decision, not a missing feature.

| # | Position | Status | Level | Why |
|:--:|---|:--:|:--:|---|
| 99 | **Hosted free tier** | ⬜ | — | We do not operate inference. Zero-config points at local models instead. |
| 100 | **Cloud-by-default execution** | ⬜ | — | Remote runs stay opt-in and bring-your-own-runner; we do not become a data processor by default. |
| 101 | **Ambient PR bot** | ⬜ | — | Review is explicit and per-action; nothing posts under your name without you seeing the text. |
| 102 | **Bedrock and Vertex providers** | ⬜ | — | SigV4 signing and a Google OAuth exchange are auth implementations, not base URLs. A half-working entry would accept a key and fail every call. |
| 103 | **Parallel pipeline-wave execution** | ⬜ | — | Deleted in Phase 6 rather than graduated — unverified for six phases, and its role is filled by task agents, where isolation is asserted. |
| 104 | **Domain verticals** | ⬜ | — | E17's own condition was "ship only if a real user pulls for it." Sixteen revisions, no pull. Listed here rather than carried as debt; it returns to the plan the day a user asks. |

---

## Summary

| Status | Count |
|---|---:|
| ✅ Shipped | 83 |
| 🟡 Partial | 6 |
| 🧪 Default-off | 1 |
| 📋 Planned | 8 |
| ⬜ Deliberate non-feature | 6 |
| **Total** | **104** |

| Level | Count |
|---|---:|
| 🟢 Advanced | 78 |
| 🟡 Mid | 12 |
| 🔴 Beginning | 0 |
| — (nothing built) | 14 |
| **Total** | **104** |

**Where we lead:** SDLC pipeline orchestration · command policy and the safety posture · checkpoints ·
code intelligence through the fork's own language servers · project-aware skills · and, uniquely, an
enumerable, test-enforced egress register.

**Where we are behind:** sandboxed execution (#62) · MCP transport parity (#60) · review automation
(#18) · and the daily-driver autocomplete *model* — next-edit is at capability bar, but Cursor trains
a model for it and we route a role.

**The two oldest open items,** unchanged for eight phases and both about measurement rather than
features: the opt-in **model tier** (#97), which five metric rows and Phase 1's last gate depend on,
and the **real-host integration tier** (#95), down since Phase 5 on a `@vscode/test-electron`
binary-name mismatch.
