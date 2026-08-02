# Black IDE — Feature List

**Generated:** 2026-08-02 · Companion to [`enhancement.md`](./enhancement.md) (rev 14)

A flat inventory of everything this project has or plans, in one place. Where
`enhancement.md` tracks *gaps and phases*, this tracks *capabilities*.

## How to read an entry

```
N. Feature name (maturity) (quality)
   One line saying what it is.
```

**Maturity** — how far along it is.

| Label | Means |
|---|---|
| `production` | Shipped, tested, on by default (or one obvious toggle away), and relied on. |
| `intermediate` | Shipped and useful, with a real limitation that is named. |
| `experiment` | Built but off by default, or built as a core with its wiring unfinished. |
| `planned` | Specified in the roadmap, not built. |

**Quality** — how good the thing actually is, judged against what a competent competitor
ships, not against our own aspirations.

| Label | Means |
|---|---|
| `very good` | Leads the field, or is guarded by a hard gate that would catch a regression. |
| `good` | Solid and at bar. Would not embarrass us in a comparison. |
| `ok` | Works. Has a limitation a user will meet. |
| `—` | Not built, so no judgement. |

> **A note on honesty.** Four rows in `enhancement.md` §1 are stale — D2 (chunking), D3
> (code graph), D6 (output compression) and D11 (git-history search) are graded 🔴/⬜ but
> all shipped in Phase 3. This file reflects the code, not those rows.

---

## 1. Agent core & orchestration

1. **Bounded agent loop** (production) (very good)
   The think→tool→observe loop, bounded by a token budget rather than a message count, with an execution interlock.

2. **Two-phase planning with an approval gate** (production) (very good)
   Plans are proposed and must be approved before execution, and the gate survives a window reload.

3. **Multi-agent SDLC pipeline** (production) (very good)
   HLD → LLD → Planner → Design/Backend/Frontend/Testing as a fixed seven-phase pipeline; no competitor ships this.

4. **Subagent isolation via git worktrees** (production) (very good)
   Subagents work in their own worktree and reconcile by delta, so the live tree is never a scratchpad.

5. **Concurrent pipeline runs with durable history** (production) (good)
   Up to four pipelines at once, each with its own abort controller, and a history that survives reload.

6. **Task agents — N independent user-launched agents** (production) (very good)
   Each has its own worktree, mode, model and workspace root; kill-one isolation and untouched-until-apply are both asserted.

7. **Mid-run steering** (production) (very good)
   A correction reaches the running agent on its next turn without restarting it, and never lands where a provider would reject it.

8. **Concurrency and spend governor** (production) (very good)
   One admission gate across both lanes, where a reservation is claimed atomically so two clicks in a tick cannot both win the last slot.

9. **Agent inbox with parking and notifications** (production) (good)
   Blocked, parked, failed and finished-unreviewed work surfaced with badge counts and a notification fired once per event.

10. **Request classification / auto-orchestrate** (intermediate) (ok)
    Decides when a prompt deserves a plan or a pipeline, using keyword heuristics rather than a model.

11. **Multi-model race** (intermediate) (good)
    The same prompt to N models in N worktrees, ranked on test results then diff size, willing to report no winner.

12. **Background / off-machine agents** (planned) (—)
    A local daemon driving headless runs with results surfaced in the inbox.

---

## 2. The fleet — agents and modes

13. **Nine selectable modes** (production) (very good)
    Ask, Plan, Agent, Frontend, Backend, DevOps, Manager, Sr Architect and Learn — broader than any competitor.

14. **Seven internal pipeline-phase agents** (production) (good)
    The specialised roles the SDLC pipeline runs through, each with its own prompt and allowlist.

15. **Custom modes** (production) (very good)
    YAML frontmatter, three scopes, hot reload and inline diagnostics for a malformed definition.

16. **Per-mode tool allowlist and iteration budget** (production) (very good)
    Enforced at the executor as well as advertised, so a mode cannot execute what it never offered.

17. **Learn mode** (production) (good)
    Explains before editing and cannot write without confirmation — read-only by construction, not by prompt wording.

18. **Reviewer agent** (planned) (—)
    A read-only mode reviewing the working diff and emitting findings as an artifact, with opt-in `gh` PR review.

19. **Domain-vertical fleets** (planned) (—)
    Firmware and legacy-modernisation verticals; deliberately out of our lane unless a real user pulls for them.

---

## 3. Knowledge, rules and memory

20. **Skills framework** (production) (very good)
    Stack + role + trigger resolution picking the right guidance for the repo you are actually in.

21. **Project profiler** (production) (very good)
    Manifest-based stack detection at 100% on a 21-fixture corpus, and the only such thing in the field.

22. **Bundled skill packs — 47** (production) (very good)
    Frameworks, testing and cross-cutting guidance, each with a golden eval task so a pack cannot rot unnoticed.

23. **Rules engine v2** (production) (very good)
    Glob-scoped rules with four activation modes, three scopes, hot reload and Problems-panel diagnostics.

24. **Team / org shared rules** (production) (good)
    Injected first so they survive truncation, and not user-disableable.

25. **Long-term project memory** (production) (good)
    Durable human-readable markdown under `.blackIDE/knowledge/`, which is a genuine strength.

26. **Memory v2 — decay, dedup, contradiction, consolidation** (intermediate) (very good)
    Typed tiered entries beside a byte-stable markdown projection; contradictions ask rather than overwrite, and decay archives rather than deletes.

27. **Automatic memory extraction** (experiment) (good)
    Confidence bands and a content filter are built and tested; the model call that produces candidates is not wired.

28. **`update_mindmap` tool** (production) (good)
    The agent's own way to record modules, functions and linkages into `project_mindmap.md`, by section append or replace.

29. **Deterministic stack sync to the mindmap** (production) (very good)
    The detected stack is upserted into a stable `Project Stack & Conventions` section by the extension, not the model, so re-syncing never duplicates it.

30. **Per-phase auto-sync** (production) (good)
    Each pipeline phase appends what it touched, so the mindmap records what happened without depending on an executor remembering to write it.

31. **Mindmap size capping** (production) (good)
    At 100 KB the oldest machine-written Auto-Sync sections are dropped first and agent-authored ones never are — the file cannot grow until it costs more than it saves.

32. **Mindmap read-back into the prompt** (production) (very good)
    Its sections are injected as their own budgeted prompt block, excluding auto-sync so a run does not re-read its own history — closing a write-only loop open since plan.md's Phase 5.

33. **Architecture mindmap documents** (production) (good)
    `docs/mindmap/{mind,tech,hld,lld}.md` — the hand-maintained architecture record the pipeline's analysis phases read and write alongside the generated one.

34. **Memory visualization panel** (planned) (—)
    Entries, links, confidence and provenance rendered for a human.

---

## 4. Retrieval and context

35. **Hybrid semantic index** (production) (very good)
    Embeddings and BM25 fused by RRF; recall@5 91.2%, @10 97.2%, @20 100% on a measured corpus.

36. **Symbol-aware chunking** (production) (good)
    Chunks are functions and classes with their doc comments, via a dependency-free lexical backend behind a swappable seam.

37. **Code graph with impact analysis** (production) (very good)
    Symbol table, call and import edges, and `impact_analysis` at 0 false positives and 0 misses across six refactors.

38. **Reranker stage** (production) (good)
    A tuned lexical reranker by default, with a cross-encoder on the `rerank` role; recall@10 95.8 → 97.2.

39. **Context manager with rolling summarization** (production) (very good)
    Token-budgeted compaction, plus a model-written summary above it that refuses to fold a pending approval or an unresolved tool call.

40. **Structured tool-output compression** (production) (good)
    37.4% at realistic path depth and 81% on repeated diagnostics, with the raw form retrievable on demand.

41. **Eleven `@`-mention context providers** (production) (very good)
    `@file`, `@folder`, `@symbol`, `@problems`, `@terminal`, `@git`, `@rules`, `@skills`, `@past-chats`, `@docs`, `@web` — each budgeted and visibly truncated.

42. **External docs indexing** (production) (good)
    A bounded same-origin crawl scoped to the URL's path, so a version-pinned doc set cannot drift into another version.

43. **Web search with keyed providers** (production) (good)
    Brave, Tavily and Google CSE with DuckDuckGo as the no-key default, and every degradation named rather than silent.

44. **Ranged file reads** (production) (good)
    `start_line`/`end_line` pagination so reading a large file does not spend the window.

45. **Git-history intelligence** (production) (good)
    `search_history`, `blame` and `why_was_this_changed`, shelling out to git rather than maintaining a second index.

46. **Notebook awareness** (intermediate) (good)
    Cell-aware read and edit preserving nbformat's `source` array shape, with per-cell snapshot and restore; the edit tool is not yet registered.

---

## 5. Tools and execution

47. **31 native tools** (production) (very good)
    File, grep, list, run_command, subagent, artifact, mindmap, LSP and test tools — ahead of every competitor's count.

48. **Exact SEARCH/REPLACE edit contract** (production) (very good)
    Byte-exact anchors, so a mismatch is detectable rather than a silent wrong edit.

49. **Checkpoints and rollback** (production) (very good)
    Reverse hunks and per-message undo, ahead of what the field ships.

50. **LSP navigation tools** (production) (very good)
    `go_to_definition`, `find_references`, `workspace_symbols`, `hover`, `rename_symbol`, `code_actions` — reaching the fork's own language servers, which extension-only competitors cannot.

51. **On-demand and post-edit diagnostics** (production) (very good)
    The agent sees the compiler and linter errors it caused, and can ask for more.

52. **Test-runner integration** (production) (very good)
    Framework selected from the detected stack, seven parsers, failures only — 30 KB of output becomes under 2 KB.

53. **Verification contract with bounded self-correction** (intermediate) (very good)
    Four outcomes where an unrunnable suite is *not* a pass, exactly one correction attempt, and a report written on every path; wired for task agents only.

54. **Fast-apply path** (production) (very good)
    A cheap model materialises the edit and five refusal classes escalate to the strong one, so a silently wrong edit is unreachable.

55. **Tool circuit breakers** (production) (good)
    Per tool, per run: three consecutive failures or a blown latency budget disables it with a visible reason.

56. **Typed artifacts** (intermediate) (good)
    Seven kinds including binary, with run association, comments and an index that rebuilds from filenames; the review panel is not rendered.

57. **Browser automation** (intermediate) (ok)
    Playwright driving a real Chromium behind a domain allowlist, installed on demand.

58. **Vision / image input** (production) (good)
    Images on user turns and tool results, in both OpenAI and Anthropic shapes.

59. **MCP client** (intermediate) (ok)
    Works, but stdio only and Agent-mode only; remote transports are not shipped.

60. **Agent hooks** (intermediate) (ok)
    `beforeToolCall`/`afterToolCall`/`beforeResponse`/`onError` exist but are under-documented and unused by first-party features.

61. **Visual verification evidence** (experiment) (ok)
    A screenshot is *required* for UI changes and its absence is reported; nothing captures one yet, so UI work lands as `incomplete` by design.

62. **Sandboxed execution tiers** (planned) (—)
    Restricted (cwd-jailed, env-scrubbed, no-network) and contained (container) tiers above today's policy gate.

---

## 6. Editor integration and platform

63. **Next-edit prediction** (experiment) (very good)
    Predicts the change your last edit implies — usually in another file — and offers a jump; off by default because it spends a model call per typing pause.

64. **Inline completion** (production) (ok)
    FIM-aware single-file completion; one model, no edit history.

65. **Inline chat (`Cmd+I`)** (production) (ok)
    Selection-scoped edit with a diff review and multi-turn refinement.

66. **Terminal `Cmd+K`** (production) (very good)
    Natural language to a shell command, single-line by construction, policy-judged, and typed rather than run.

67. **Per-role model routing** (production) (very good)
    Seven roles resolved in one place, with an explicit override outranking a standing mapping.

68. **Cross-provider failover** (production) (very good)
    Circuit-broken per provider, failing over at the *turn* so context survives, and never after output has streamed.

69. **Sixteen LLM providers** (production) (very good)
    One dispatch and one preset table, so streaming and tool-call parsing cannot drift per provider.

70. **Zero-config first run** (production) (very good)
    Probes Ollama, LM Studio and llama.cpp and *offers* what it finds — never auto-enables, ignores a runtime with no models pulled.

71. **Output modes (`apply` / `pr`)** (production) (good)
    Reconcile onto the working tree, or leave a branch and open a pull request.

72. **Commit-message generation** (intermediate) (ok)
    Works; diff-size handling is naive.

73. **Reusable prompt and workflow library** (production) (very good)
    `.blackide/prompts/*.md` become slash commands with arguments and cycle-safe `steps:` chaining.

74. **Multi-root workspace support** (intermediate) (good)
    Longest-prefix, boundary-aware root attribution and per-root profiles; the codebase index is still a single shard.

75. **Skill distribution with checksums** (intermediate) (good)
    Pinned refs (a moving ref is refused), SHA-256 verified before content is examined, shadowable by a local pack; the fetching command is not wired.

76. **Headless core with an enforced boundary** (intermediate) (very good)
    Nothing reachable from `agent-core` imports `vscode`, checked transitively on every commit, with a Node host proving it.

77. **Headless CLI surface** (experiment) (good)
    JSON-per-line stdout, logs on stderr, six CI exit codes separating *completed but unverified* from *completed*; the runnable binary is not shipped.

78. **SDK entry point** (production) (good)
    The core barrel plus the host interface, with silent-notifier and denying-approval baselines for embedding.

79. **Extension marketplace / Open VSX compatibility** (production) (good)
    Full gallery and API-proposal compatibility tables already at bar.

80. **Voice input** (planned) (—)
    Scheduled last, and honestly low value for this product.

---

## 7. Safety, privacy and quality engineering

81. **Command policy with an unoverridable deny list** (production) (very good)
    A hard deny list plus user allow/deny and ask — nobody else documents a deny list a user cannot override.

82. **Secrets in the OS keychain** (production) (very good)
    `SecretStorage`, never `settings.json`.

83. **Auto-approve ignored in unattended runs** (production) (very good)
    A pipeline run cannot inherit a permission a human granted for interactive work.

84. **Secret redaction into prompts and logs** (production) (very good)
    Thirteen vendor shapes always on, entropy gated behind a token-shape check so real source stays readable.

85. **Untrusted-content posture with injection fixtures** (production) (very good)
    Tool output is data, stated in the prompt and *proved* by fixtures asserting the capability gates are unmoved.

86. **Central workspace-boundary guard** (production) (very good)
    One chokepoint covering traversal, prefix collision, symlinks and `.git` — where a write escapes every other control.

87. **Append-only audit trail** (production) (very good)
    JSONL in the repo, monotonic sequence, no update method by construction, redacted on the way *in*.

88. **Egress register** (production) (very good)
    Every outbound destination declared with a reason and a trigger, enforced by a source walk — "phones home to nobody" is a test.

89. **Tighten-only org policy** (production) (very good)
    An org policy can narrow capability and never widen it, asserted as a capability score over the whole structure.

90. **Per-action outbound confirmation** (production) (very good)
    Nothing is posted externally without confirming *that* post; the type makes a standing grant inexpressible.

91. **Self-hosted team analytics** (intermediate) (good)
    Off by default with no endpoint anywhere in the source, sending an eight-field allowlist projection — counts, never content.

92. **Local-only telemetry and diagnostics export** (production) (very good)
    Nothing leaves the machine by default, and as of Phase 12 that is enforced rather than asserted.

93. **Skill validation diagnostics** (production) (good)
    Malformed packs surface in the Problems panel instead of collapsing into a silent `undefined`.

94. **Test architecture — four tiers** (production) (very good)
    Harness 418, vitest 1 488 across 56 suites, real-host integration, and an eval gate with a recorded baseline.

95. **Golden-task eval harness** (production) (very good)
    112 tasks over 21 fixtures gating stack detection, skill precision, wrong-idiom leakage, recall and index build time.

96. **At-rest encryption for `.blackIDE/`** (planned) (—)
    Optional and off by default; our directory is the user's repo, which is defensible but not currently an option we offer.

---

## 8. Not scheduled — deliberate positions

These are absent on purpose. Each is an architectural decision, not a missing feature.

97. **Hosted free tier** (planned) (—)
    We do not operate inference. Zero-config points at local models instead.

98. **Cloud-by-default execution** (planned) (—)
    Remote runs are opt-in and bring-your-own-runner; we do not become a data processor by default.

99. **Ambient PR bot** (planned) (—)
    Review is explicit and per-action; nothing posts under your name without you seeing the text.

100. **Bedrock and Vertex providers** (planned) (—)
    SigV4 signing and a Google OAuth exchange are auth implementations, not base URLs; a half-working entry would accept a key and fail every call.

101. **Parallel pipeline-wave execution** (planned) (—)
    Deleted in Phase 6 rather than graduated — unverified for six phases, and its role is now filled by task agents where isolation is asserted.

---

## Summary

| Maturity | Count |
|---|---:|
| production | 71 |
| intermediate | 14 |
| experiment | 4 |
| planned | 12 |
| **Total** | **101** |

| Quality | Count |
|---|---:|
| very good | 50 |
| good | 31 |
| ok | 8 |
| — (not built) | 12 |
| **Total** | **101** |

**Where we lead:** SDLC pipeline orchestration, command policy and the safety posture,
checkpoints, code intelligence via the fork's own language servers, project-aware skills,
and — uniquely — an enumerable, test-enforced egress register.

**Where we are behind:** sandboxed execution (M57), MCP transport parity (M49–M51), review
automation (M47), and the daily-driver autocomplete *model* — next-edit is at capability
bar, but Cursor trains a model for it and we route a role.

**The two oldest open items**, unchanged for eight phases: the opt-in **model tier** that
five §4.2 metric rows and Phase 1's last gate all depend on, and the **real-host
integration tier**, which has not launched since Phase 5 because `@vscode/test-electron`
spawns `Contents/MacOS/Electron` while VS Code 1.131 ships `Contents/MacOS/Code`.
