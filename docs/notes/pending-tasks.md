# Black IDE — Pending Tasks

**Derived from:** [`enhancement.md`](./enhancement.md) rev 16 (2026-08-04) · **canonical for open
work** — what exists rather than what is missing is [`features.md`](./features.md); see
[`README.md`](./README.md) for who owns what.
**Audited against the tree:** 2026-08-04 — every row below was re-checked in code, not read off the
previous revision's claims.
**Baseline at audit time:** `tsc -b` clean · vitest **1 956/1 956 / 72 suites** · harness 418/418 ·
eval green, no regression vs `eval/baseline.json` · webview builds · CLI runs · `extension.ts`
**698 LOC** (≤700 gate).

---

## 0. Where the roadmap stands

| Phase | Status | Open | Closed since the last audit |
|:--:|:--:|:--:|---|
| 0 | ✅ | — | |
| **1** | ✅ | **0** | **P1-1** — the LSP-over-grep gate is measured, with a floor |
| 2–10 | ✅ | — | |
| **8** | ✅ | **0** | **P8-1 (M41)** · **P8-2 (M45)** |
| **9** | ✅ | **0** | **all seven** — P9-1 (M57) · P9-2 (M47) · P9-3 (M49) · P9-4 (M50) · P9-5 (M51) · P9-6 (M48) · P9-7 (M58) |
| **11** | ✅ | **0** | P11-1 (M62 boundary) · **P11-2 (M62 package move)** · P11-3 (M65 daemon) |
| **12** | ✅ | **0** | P12-1 (M67) · P12-2 (M68) · P12-3 (M66); P12-4/P12-5 resolved as positions |
| — | — | — | **X-1** — the model tier, named in sixteen revisions and blocking five phases |
| **Office** | 🟡 | **2** | **M72 · M73 · M74 · M76 · M77 · M82 · M83 · M84** — the Agent Office, its entry points and the run journal. **M80 and M81 remain open** — see §1 |

**Two tasks are open**, both P0 defect work rather than features. Eighteen were open at the
previous audit and all eighteen are closed.

Every phase, 0 through 12, is ✅. Nothing claimed as delivered was found missing. Two items
previously carried as ❌ are now recorded as **deliberate positions** rather than debt — see §4.

> §3's corrections and §5's defect list are the parts worth carrying forward, because they record
> what the roadmap got *wrong*, which is the thing a plan cannot learn from its own successes.

---

## 1. Open — the "thinking, but doing nothing" defect

Two tasks, both **P0**, both defect work rather than features. They are open because the Agent
Office wave (`implementation_plan.md` §10) delivered its surfaces first and the runtime fixes
second; the analysis is `implementation_plan.md` §9 and it is specific.

**The symptom.** The user sends a prompt. Within a second the chat shows three bouncing dots and
*"Agent is thinking..."*. It stays there — ten seconds, sometimes minutes — with no tool call, no
text, no progress and no error.

**It is one missing surface and three unbounded waits.** The state was always right: seven
pre-flight steps between `beginTask` (`agent/chat-task.ts:260`) and the first model call each call
`log()`, and every one of those lines reaches the webview and is rendered **only** as
`agentLogs.slice(-2)` inside a panel that is collapsed by default (`webview/src/App.tsx:3343-3349`).

| # | M | Task | Pri | Acceptance |
|:--:|:--:|---|:--:|---|
| O-B1 | **M80** | **The pre-flight speaks.** A `Progress` event, and a status line under the dots carrying `phaseLabel(state)`, the newest log line, and an elapsed counter. The counter is the load-bearing part: it is the difference between "this is slow" and "this is stuck" | **P0** | No gap over **2 s** between webview posts from submit to first token, asserted against a stubbed slow pre-flight. This is R6 as a test |
| O-B2 | **M81** | **Bound every wait, and make Stop stop.** Batch and cap the per-chunk embedding fetches in `CodebaseIndex.build` (`core/codebase-index.ts:233-242` — sequential, one HTTP call per chunk, no signal, no budget); an overall deadline on `MCPClient.connectAll`; a connect timeout and an **idle-stream deadline** in `fetchWithRetry` (`core/llm-client.ts:22-44` — today a provider that returns 200 and then sends nothing hangs forever, and `runWithFailover` cannot help because nothing throws); a visible line per 429 backoff; and `signal` threaded through the pre-flight so Stop is not ignored where it is most likely to be pressed | **P0** | Each bound has a default, a setting and a test. A provider stub that accepts and sends nothing fails over within the idle deadline. Stop during the index build ends the run in ≤ 1 s |

**What is already in place for them.** M82's journal captures every one of those pre-flight lines
at `verbose` depth and writes them whether or not a panel is open — so from now on "it hung and I
closed the window" no longer destroys the evidence, which is what makes the *next* report of this
actionable rather than anecdotal.

A third, smaller item is filed with them: an empty final turn (`agent/agent-loop.ts:226-230` sets
`completed` with `finalText: ''`) renders an empty bubble with no explanation. **M85**, P3.

---

## 1b. Closed: the Agent Office

`implementation_plan.md` is the design record; what landed:

| M | Delivered | Gate |
|:--:|---|---|
| **M72** | `GovernorSnapshot` and `inboxCounts` pushed to the panel — both were computed and discarded before this | Every header number traces to a field that existed beforehand |
| **M74** | `office-model.ts` + `office-narrate.ts` — four lanes onto one ordered roster, and the verb table that turns a tool call into `opened apiSlice.tsx` | Pure, vscode-free, 34 assertions. R1 and R2 asserted rather than conventional |
| **M76** | The task lane onto real telemetry: tool `arguments` forwarded, turn and context reported out of the loop, `FileChanged` emitted, and a coalesced patch channel | ≤ 4 patches per second per item and ≤ 1 git-mutex acquisition per agent per 10 s, both measured |
| **M77** | The Office tab — desks, empty seats, files-in-play, phase strip, budget-spent state | Renders with `—` in every genuinely absent cell |
| **M82** | The run journal — content-bearing, redacted on write, bounded four ways, local only, and complete with no panel open | A killed run's partial file still parses; a live run is never pruned |
| **M83** | The Logs tab — three depths, filter, problems-only, live tail with pause, open-as-file | A page is a page: the webview never receives the whole file |
| **M84** | `read_run_log` — a run can read an earlier run's record | Defaults to the caller's run at summary depth and states its own truncation |
| **M73** | **Entry points** — the `◆ Office` status bar item, the `black-ide.openOffice` command, an activity-bar Front Desk, a `global/activity` entry, and the toast pointed at the sidebar | The attention count is visible with no panel open; no Office verb is handled for the editor tab alone |

**Deviation from the plan, stated:** §6.6 specified `read_run_log` as Agent-mode-only. It ships as
`risk: 'safe'`, so Ask and Plan get it too. *"Why did that run fail?"* is an Ask-mode question, the
tool is read-only, and Ask can already read the files the log quotes — the prompt-budget argument
did not survive contact with the actual use.

**What M73 found, and why it was worth a milestone of its own.** The wave that built the Office
contributed no command, no view and no status bar entry: every surface worked and none could be
found, and the *only* way in was a palette entry titled "Pipeline Manager". That is the third
instance of the defect `tool-surface.test.ts` and `command-surface.test.ts` each exist for — fully
implemented, correctly wired, silently unreachable — so it is now asserted from the manifest in
`office-entry-points.test.ts` rather than left to a reviewer noticing an absent entry.

Two things fell out of giving the Office a second surface. `office-messages.ts` now holds every verb
the floor can render, because a button handled in `manager-panel.ts` alone works on the editor tab
and silently does nothing in the sidebar — worse than a missing button, since the surface has
claimed the operation exists. `office-state.ts` holds the patch merge for the same reason: its one
subtle rule (an explicit `activity: undefined` must actually clear the field) would have been
rewritten by hand in the second surface, looked correct, and been one field-clear behind.

**Deviation from the plan, stated:** §7.2 draws the Front Desk as a `▾ AGENT OFFICE` section, which
implies a view sharing a container. It ships in an activity-bar container of its own. A second view
inside `black-ide-chat` would give the chat view — today a single unnamed view filling its container
— a section header it has never had, which is a visible regression in the extension's primary
surface bought for nothing the Office needs.

**Still open from the plan's §10:** M75 (the Front Desk's inbox rendering — the sidebar registered by
M73 currently shows the floor, not the per-reason action rows), M78 (the Desk drill-in with a
steering textarea and history), M79 (the honesty-gate lint and deleting `ParallelSubagents.tsx`).
None blocks the two P0s.

---

## 1c. Previously closed

The last task before this wave closed on 2026-08-04. **P11-2 — the physical package move** — is
done:
`packages/agent-core/` is a real package with its own manifest, its own `tsconfig`, subpath
exports, and no path back into the extension.

**What it cost, against what the roadmap estimated.** It was called "mechanical, once the
boundary is known to hold". It was mechanical, and the estimate still understated it:

| | |
|---|---|
| Modules moved | 64 |
| Import specifiers rewritten | 160 in 52 extension files · 93 in 52 test files |
| `path.join(DIST, …)` requires repointed | 45, across the harness and the eval |
| `src/core/` after the split | 55 files stay, 51 move — the directory really does split in half |

**Three things the estimate missed**, recorded in `enhancement.md` §4.7 in full:

1. **A type-only import is still a compile-time edge.** M62 made `agent-loop`'s import of
   the editor executor type-only and recorded that as done. The loop still *named* a type
   on the editor side, so the package could not compile without it. The shape turned out
   to be one method; it now lives in `core/types.ts` as `ToolExecutor`, where both
   implementations satisfy it structurally and neither owns it.
2. **An inline `import('./types')` type expression** is not a `from` clause, so no
   import-rewriting regex sees it. One existed. The compiler caught it.
3. **Resolution has to be by looking, not by a list.** The harness, the eval and a dozen
   structural tests hardcoded `../src/…`. All now resolve a source-relative path against
   whichever root has it, so the next module to cross — in either direction — needs no
   change to any of them.

**What the move bought over the logical boundary alone.** "The core does not import
`vscode`" was previously a property of files sitting in the same tree as the editor, one
careless relative import away, asserted by one test. The package is now a separate
compilation unit with no path back, so a stray import is a **compile error**. The walk
stays, because the compiler only catches a *broken* import — not a working one that drags
`vscode` in through a new and reasonable-looking dependency. The reachable floor rose
45 → 60 → **64**, at each step as the clause asked.

---

## 2. Closed since the last audit

Every row the 2026-08-04 audit listed as open, and what closed it. Kept for one revision so the
progress is auditable, then removable.

| # | M | What closed it |
|:--:|:--:|---|
| **X-1** | — | `core/eval-model-tier.ts` + `eval/model-tier.js` + `eval/model-tasks.js`. Budget enforced **before** each call, N-run variance with a noise band, its own baseline. Added beyond the spec: `GATE_FLOORS`, because a no-regression gate is a ratchet that can be created green at any level |
| **P1-1** | M6/M7 | The `lspOverGrep` family — six symbol questions, scored on which tool the model reaches for **first**, with an 80% floor that fails independently of any baseline |
| **P8-1** | M41 | `agent/memory-turn.ts` — inject before a turn, extract after it. The audit said "the producer is missing"; the truth was that **nothing in the editor imported any of Phase 8** |
| **P8-2** | M45 | A Memory tab: entries, confidence, provenance phrased as an answer to "why do you believe this", decay stated as what will happen and when |
| **P9-1** | M57 | Three tiers that **refuse rather than degrade**. Asserted against a real process: a tier-2 command cannot open a socket, write outside its jail, or read the credentials it was started with |
| **P9-2** | M47 | Reviewer mode + `black-ide.reviewChanges`. Read-only at the executor *and* confined; `parseFindings` drops any finding that cannot state a concrete failure |
| **P9-3** | M49 | Streamable HTTP, HTTP+SSE, OAuth. Every failure names a cause and a next action instead of timing out identically |
| **P9-4** | M50 | Resources readable as context, prompts listed and invocable |
| **P9-5** | M51 | Vetting by **identity**, never by name — a renamed entry running a different binary is a different server |
| **P9-6** | M48 | `black-ide.postReviewToPr`, a separate command, through the per-action confirmation |
| **P9-7** | M58 | Line-level sealing so the trail stays append-only; exact-bytes decryption so the markdown round-trip holds |
| **P11-1** | M62 | `codebase-index` and `artifact-manager` crossed; `tool-executor`'s last direct `vscode` reference removed. See §3 for why it is not exported |
| **P11-2** | M62 | `packages/agent-core/` — 64 modules, own manifest and `tsconfig`, subpath exports, consumable by name. The boundary is enforced by the build now, not only by the walk |
| **P11-3** | M65 | `blackide daemon` / `blackide queue`, file-based, claim-by-rename, results in the inbox |
| **P12-1** | M67 | Three fetchers, reachable only through a `kind` a URL or explicit `#n` supplied |
| **P12-2** | M68 | A Slack forward with no `send` — it builds an action and stops |
| **P12-3** | M66 | BYO runner with **no default endpoint**; a runner that will not say which tier it enforced is refused |

---

## 3. Corrections to the previous revision

Four places where doing the work showed the task description was wrong. Recorded because a
roadmap that quietly re-scopes itself is one nobody can audit.

**1. P8-1 was understated.** It read "the producer is missing — `sortCandidates` already bands
candidates". Both halves of that are true and it missed the larger fact: `sortCandidates` banded
candidates nobody produced, `applyDecay` aged entries nobody wrote, and `MemoryStore.forPrompt`
rendered a section no prompt included. Phase 8 was five correct pure modules with **no caller in
the editor at all**. The task was the loop, not the producer.

**2. P11-1 named three modules; two of them were the task.** `codebase-index` and
`artifact-manager` crossed the boundary and are exported. `tool-executor` is deliberately not:
its last *direct* `vscode` reference is gone, but it still reaches the LSP bridge, the browser and
the editor's tool runner — because it is the **editor's** executor, and `host-executor.ts` has been
its boundary-crossing counterpart since M63. Dragging it across would leave the CLI loading five
hundred lines of editor semantics it can never execute. Two implementations of a narrow interface
is the answer M62 already gave for the host itself.

**3. P9-2 said the `review` artifact type "exists".** It did not — `ARTIFACT_TYPES` had seven
entries and none of them was `review`. The *renderer* existed, which is what the note meant. Added.

**4. "Mechanical" was the wrong word for P11-2, twice over.** It was mechanical in the sense that
every step was determined — and it was 64 files, 253 import rewrites and three classes of edge the
word hides entirely (a type-only import that is still a compile-time edge, an inline `import()`
type expression no rewriting regex sees, and every hardcoded `../src/…` in the test tier). The
estimate was not wrong about the *kind* of work; it was wrong about there being nothing to think
about.

---

## 4. Deliberate positions (not open work)

Moved out of the task list on 2026-08-04 and into `enhancement.md` §4.5, where the document's own
convention says deliberate architectural positions belong.

| # | M | Position |
|:--:|:--:|---|
| **P12-4** | M70 | **Domain verticals — ⏸️, condition unmet.** E17 shipped with its own condition: "ship only if a real user pulls for it." Sixteen revisions, no pull. Carrying it as ❌ implied debt and invited someone to clear it; building a vertical for nobody is how a general tool acquires a domain it cannot maintain. It returns to the plan the day a user asks |
| **P12-5** | M71 | **Voice input — ⏸️, still scheduled last.** Not a won't-do. E31 calls it "genuinely the lowest-value item in this document"; the only change is the label. A deliberate ordering choice reads differently from an omission, and the roadmap had been showing the second |

**P9-7 is no longer on this list.** The previous revision flagged it as "the one P3 whose *cost* is
in the invariants it must not break… it should be sized before it is scheduled". That was the right
call and the sizing turned out to be the design: line-level sealing to keep the audit trail
append-only, exact-bytes decryption to keep the memory round-trip byte-stable. Both invariants hold
and are asserted.

---

## 5. Progress log

| Date | Phase | Delivered | Evidence |
|---|:--:|---|---|
| 2026-08-03 | — | Audit; this document | Baseline re-verified: vitest 1 488/56 |
| 2026-08-03 | 10 | **T1 (M61)** — notebook tools | vitest 1 511/57 |
| 2026-08-03 | 10 | **T2 (M60)** — remote skill-pack install | vitest 1 535/58 |
| 2026-08-03 | 11 | **T3 (M63)** — headless executor + `blackide` | vitest 1 562/59 |
| 2026-08-03 | 7 | **T4 + T5 (M40)** — verification in the pipeline and chat lanes | vitest 1 577/60 |
| 2026-08-04 | 7 | **T6 (M40)** — visual capture | vitest 1 604/61 |
| 2026-08-04 | 7 | **T7 (M38)** — the artifact review panel. **Phase 7 → ✅** | vitest 1 629/62 |
| 2026-08-04 | — | **X-1** — the model tier, plus **P9-1 (M57)** sandbox tiers | vitest 1 702/64 · the network-denial assertion runs against a real socket |
| 2026-08-04 | 9 | **P9-2 (M47)** — Reviewer mode; `extension.ts` 699 → 654 by extraction | vitest 1 742/65 |
| 2026-08-04 | 9 | **P9-3/4/5 (M49–M51)** — MCP transports, primitives, vetting | vitest 1 799/67 · tested against a real HTTP server |
| 2026-08-04 | 8 | **P8-1 + P8-2 (M41, M45)** — the memory loop and its panel. **Phase 8 → ✅** | vitest 1 838/68 |
| 2026-08-04 | 9 | **P9-6 + P9-7 (M48, M58)**. **Phase 9 → ✅** | vitest 1 883/70 |
| 2026-08-04 | 11 | **P11-1 (M62)** — the boundary floor rose 45 → 60 | vitest 1 883/70 |
| 2026-08-04 | 11 | **P11-3 (M65)** — the daemon, results in the inbox | vitest 1 907/71 |
| 2026-08-04 | 12 | **P12-1/2/3 (M66–M68)**. **Phase 12 → ✅** | vitest 1 946/72 |
| 2026-08-04 | 1 | **P1-1** — the LSP-over-grep gate, with an absolute floor rather than a ratchet. **Phase 1 → ✅** | vitest 1 952/72 |
| 2026-08-04 | 11 | **P11-2 (M62)** — the package move. **Phase 11 → ✅, and the roadmap with it** | vitest 1 956/72 · harness 418/418 · eval green · the package imports standalone by name |
| 2026-08-04 | Office | **M72 · M74 · M76 · M77** — the Agent Office: the work-item model, the narrator, the telemetry contract, the desks | vitest 2 003/75 · harness 418/418 · webview builds · `extension.ts` 698 (≤700) |
| 2026-08-04 | Office | **M82 · M83 · M84** — the run journal, the Logs tab, and `read_run_log` | vitest 2 058/77 · harness 418/418 · `lint:css` clean |
| 2026-08-05 | Office | **M73** — entry points: the status bar item, the command, the sidebar Front Desk, and the toast off the editor tab | vitest 2 073/78 · harness 418/418 · `lint:css` and `knip` clean · webview builds · `extension.ts` 699 (≤700) |

**Found while closing this wave, and fixed here rather than filed:**

1. **Seatbelt and bwrap match *resolved* paths.** macOS `os.tmpdir()` is `/var/folders/…` symlinked
   to `/private/var/folders/…`, so a profile granting write access to the unresolved cwd grants it
   to a path the kernel never sees — every write inside the workspace denied, presenting as "the
   build fails under tier 2" rather than as a wrong path.
2. **Under `(deny default)` the macOS loader stats `/`** while resolving APFS firmlinks. Without
   `(literal "/")` every binary aborts before its first instruction, which reads as a broken sandbox
   rather than a missing rule.
3. **`isLoopback` was first written with `/^127\./`,** which matches `127.0.0.1.evil.com`. Its own
   test caught it. Same class of mistake as the `includes('localhost')` it replaced.
4. **`fetch` hides the OS error code one level down, and two on a dual-stack host** (inside an
   `AggregateError` holding one attempt per address family). Reading only `error.code` reports every
   network failure as a protocol error — pointing the reader at the wrong thing, with confidence.
5. **A fresh IV per seal means ciphertext differs on every call even when the document does not.**
   A byte comparison would have rewritten `memory.md` on every idle consolidation pass, defeating
   the mtime guard and filling the user's git status with churn.
6. **An encrypted memory file with the wrong key parses as *empty*,** and the next mutation would
   have rendered that empty document over the user's memories — on the day they change their
   passphrase or open the repo on a second machine. `read` now distinguishes "missing" from
   "unreadable" and `mutate` refuses the second.
7. **The pipeline lane constructed an `MCPClient` and never connected anything to it.** MCP was
   unavailable unattended *by accident* rather than by policy, and the two are indistinguishable
   until somebody "fixes" the missing call.
8. **`REVIEW_TOOLS` was hand-listed and immediately missed two tools** — exactly the failure
   `tools.ts` documents at `CODE_INTEL_READ_TOOLS`. `tool-surface.test.ts` caught it; it now spreads
   the constant.
9. **`extension.ts` hit its 700-line gate, as the last audit predicted.** Answered by extracting
   `architecture-seed.ts` rather than by raising the gate. 698 now — the same warning applies to the
   next feature that needs a field.
10. **The gate fired again during the Office wave, exactly as predicted in (9) — twice.** Answered
    the way the gate's own failure message says to: `core/office-setup.ts` took the lane and hub
    construction, and `core/chat-task-setup.ts` took `runAgentTask`'s eighteen-line dependency
    literal. The second extraction is the better one, and it was not on anyone's list until a
    one-line telemetry addition could not fit. **A size gate is a design prompt, not an obstacle** —
    but note that the first two attempts to satisfy it were comment-trimming, which is the failure
    mode the gate is *most* vulnerable to and which its message anticipates.
11. **The webview had been hand-copying every shape it renders.** `RunSummary`, `TaskAgentSummary`
    and `InboxItem` are all declared a second time in `ManagerPanel.tsx`, tolerable while they were
    four fields each. The Office renders a *projection* whose entire purpose is that one place
    decides what a run is doing, so a second hand-maintained copy of that shape would have been the
    drift it exists to prevent. `webview/` now resolves `@blackide/agent-core/*` to source, the
    same target `vitest.config.ts` uses. Bundle cost, measured: **320.5 KB → 328.1 KB**.
12. **`TelemetrySink` looked like the obvious home for the run journal, and is exactly wrong.** Its
    allow-list drops prompts, tool arguments, output, paths and `Log` lines *by design*, with the
    privacy reasoning written into the file — it is the file that may one day be exported. Widening
    it would have destroyed that property to save writing a second sink. Two sinks, two postures.
