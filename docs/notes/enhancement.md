# Black IDE — Competitive Analysis & Agent Enhancement Roadmap

**Author:** Principal Engineer (IDE + agent infrastructure)
**Date:** 2026-07-27
**Status:** **In progress · rev 15 (2026-08-04)** — **phases 0, 2–8 and 10 delivered; 1, 9, 11 and 12
part-delivered**; **59 of 71 gaps addressed — 55 complete and four partial** (counted from the §3
table's own status column, 2026-08-04). Every **P0** is done.
**Phase 7 closed 2026-08-04** with the artifact review panel (M38) and visual capture (M40); the
outstanding work is now confined to phases 9, 11 and 12, plus the model tier (§4.6).
Phase 12's four privacy/authority gate clauses are **all met and enforced by tests**, including an
egress register that fails the build when an undeclared network call is added. Phase 7 closed Phase 6's partial (M37) by building the evidence it was missing. The only work left in a started phase is the **model tier**
(§4.6), which is harness capability rather than phase work. Supersedes the "next initiative" half of
[`plan.md`](./plan.md) (which is delivered through its Phase 5).

| Phase | Status | Covers | Evidence |
|---|:--:|---|---|
| 0 — Truth-up & foundations | ✅ | M1–M5 | 8 docs corrected · `extension.ts` 2537→**671** (≤700 gate met **and now enforced by a test**) · eval harness at **74 tasks / 13 fixtures** with a wrong-idiom metric · vitest wired · skill diagnostics. |
| 1 — Language-server tools & tests | 🟡 | M6–M8 | 8 tools in `tools/lsp-tools.ts` + `core/test-report.ts`; 5 of 6 gates asserted, incl. rename across 6 files in a real extension host. **Outstanding:** the LSP-over-grep gate needs the model tier (§4.6). |
| 2 — Rules, prompts & modes | ✅ | M9–M13 | Rules v2, team rules, prompt library, Learn mode, session panel with **rule *and* tool toggles** — the tool half enforced at the executor, not advertised. M9's stronger reading closed as won't-do. |
| 3 — Retrieval substrate | ✅ | M14–M22 | **All nine milestones.** recall@5 84.7→**91.2** · @10 93.1→**97.2** · @20 94.4→**100** · impact analysis 0 FP / 0 misses on 6 refactors · compaction 37.5% at realistic path depth · git history tools · **index build 5 000 files in 1 247 ms** against a ≤2 s gate · 11 `@`-mention providers incl. `@symbol`, `@docs`, `@web`. |
| 4 — Model layer | ✅ | M23–M27 | `ModelRouter` with 7 roles · health-aware cross-provider failover in chat **and** the pipeline · fast-apply that fails closed · **16 providers** (Bedrock/Vertex deferred with a reason) · zero-config local first run. |
| 5 — Editor ergonomics | ✅ | M28–M30 | Next-edit prediction over an edit-history buffer + the M15 graph, cross-file via a jump affordance, **nothing survives a buffer change** (asserted) · terminal `Cmd+K`, single-line by construction and never auto-run · rolling summarization above `fit`, refusing while an approval is open · `/compact` implemented, having been a UI suggestion with no handler since Phase 2. |
| 6 — Agent Manager & parallel execution | ✅ | M31–M37 | Task agents as a first-class unit — own worktree, mode, model **and workspace root** · one governor across both lanes · agent inbox with parking and once-per-event notification · **parallel wave execution deleted, not deferred** (M35) · per-root profiles · multi-model race that ranks on evidence and is willing to say "no winner". |
| 7 — Artifacts, steering & verification | ✅ | M38–M40 | Typed artifacts with a real index (the old store accepted a type and reported every artifact as `report`) · **mid-run steering that never lands between a `tool_use` and its result** · a verify contract with four outcomes and exactly one self-correction · verification in all three lanes · **an artifact review panel where a comment on a region reaches the running agent's next turn** — the M39 path finally driven from a surface that knows what the user is looking at · visual capture that refuses to guess rather than attach a screenshot of the wrong app. |
| 8 — Memory v2 | 🟡 | M41–M46 | Typed tiered entries beside a markdown projection that **round-trips byte-for-byte** · extraction in three confidence bands with a content filter · contradiction detection that **asks and never overwrites** · decay that demotes then archives and never deletes · idempotent consolidation · mindmap read-back, closing a write-only loop open since plan.md's Phase 5. **Outstanding:** M45's memory visualization panel, and end-of-turn extraction is not yet driven by a model. |
| 9 — Review automation, MCP parity & hardening | 🟡 | M47–M58 | **Security spine delivered:** secret redaction (P0) · untrusted-content posture with injection fixtures (P0) · one central workspace-boundary guard, replacing four scratch scripts that asserted nothing · per-tool circuit breakers · append-only audit trail, redacted on the way in. **Not started:** the Reviewer agent (M47/M48), MCP transport parity (M49–M51), sandbox tiers (M57), at-rest encryption (M58). |
| 10 — Skill breadth, distribution & notebooks | ✅ | M59–M61 | **16 → 47 bundled packs** with an eval task each · a registry with pinned refs and checksums, and **load-time enforcement that a pack can never widen a capability** · notebook read/edit/checkpointing that preserves nbformat's `source` array shape. |
| 11 — Headless core, CLI & SDK | 🟡 | M62–M65 | The core boundary **declared and transitively enforced** (zero `vscode` reachable), a Node host implementing it with no editor, and a CLI surface with a JSON event stream and CI exit codes. **Outstanding:** the physical package move, the executor's host refactor, and the daemon (M65). |
| 12 — Remote execution, integrations, analytics | 🟡 | M66–M71 | **All four gate clauses met:** the default build phones home to nobody (enforced by a source-walking egress accounting test) · an org policy can only **tighten**, never widen · nothing is posted externally without a per-action confirmation that *cannot* be granted in advance · disabling the analytics sink removes its egress by construction. **Not started:** remote execution (M66), domain verticals (M70), voice (M71). |

**Re-verified 2026-08-02 by running everything:** harness **426/426** · vitest **693/693 / 36
suites** · eval gate green (stack detection 100% 13/13 · skill exact-match 100% · fail-safe 1/1 ·
**wrong-idiom 0% of 33 guarded tasks** · **recall@5 91.2% · @10 97.2% · @20 100%** · compaction
37.4% · *no regression vs `eval/baseline.json`*) · `tsc -b` clean · webview builds · `extension.ts`
**693 LOC**. The **19 real-host integration tests did not run** on 2026-08-02:
`@vscode/test-electron` spawns `Contents/MacOS/Electron` and the VS Code build it downloads (1.131.0)
ships `Contents/MacOS/Code`. A tooling mismatch that predates this phase — recorded rather than
rounded up to "everything green".

## ⇢ Pending tasks — phases 0–4 (re-audited against the code 2026-08-01)

Every row below was checked against the tree today, not against the previous revision's claims.
Phases 0–3 are the started phases; **Phase 4 is included because it is next on the critical path and
because M17's remaining half is blocked on it** — the roadmap's own sequencing makes Phase 4 the
unblocking phase, so its rows belong on the same list rather than in a separate backlog.

**Verified state at audit time (before this pass):** `tsc -b` clean · harness **426/426** · vitest
**393/393 / 23 suites** · eval green, no regression vs `eval/baseline.json` · `extension.ts` **652
LOC**. The "Verified how" column below is what the code showed *then*, kept as written so the audit
stays checkable; the Status column is where it ended up.

| # | Pending task | Phase | Tracked at | Verified how | Blocked by | Status |
|:--:|---|:--:|:--:|---|---|---|
| **1** | **Tool toggles** in the session panel | 2 | M10 | `toggleRule` exists at `App.tsx:3395` → `webview-message-handler.ts:223`; **no `toggleTool` on either side** | nothing | ✅ **done 2026-08-01** — M10 → ✅ |
| **2** | **`@symbol`** provider in the `@`-mention set | 3 | M19 | `context-provider-setup.ts:49-88` registers 8 providers; no symbol entry | nothing — M15 exposes `index.graph` | ✅ **done 2026-08-01** |
| **3** | Index-build budget **≤2 s per 5 000 files** never asserted | 3 | M14 gate | restated in the M14 note; no test measures it | needs a corpus big enough to mean something | ✅ **done 2026-08-01 — 1 247 ms / 5 000 files** |
| **4** | **`ModelRouter`** — roles `chat/plan/edit/apply/autocomplete/embed/rerank` | 4 | M23 | no `model-router.ts`; role resolution is ad-hoc (`inline-completion.ts:44` reads `autocompleteModelId`, everything else reads `selectedModelId`) | nothing | ✅ **done 2026-08-01** |
| **5** | **Cross-provider failover / health-aware routing** | 4 | M24 | `llm-client.ts:58` `fallbackTurn` is the *local-protocol* path, not failover | #4 | ✅ **done 2026-08-01** — chat **and** pipeline |
| **6** | **Rerank cross-encoder** (only the lexical fallback ships) | 3 | M17 | `core/reranker.ts:17` says so in a comment | **#4's `rerank` role** | ✅ **done 2026-08-01** — M17 → ✅ |
| **7** | **Provider breadth** 6 → ~18 | 4 | M26 | `types.ts:4` — `LLMConfigEntry.type` is a 5-member union | nothing | ✅ **done 2026-08-01 — 16**, Bedrock/Vertex deferred with a reason |
| **8** | **Zero-config first run** (usable with no API key) | 4 | M27 | every config path throws "No LLM configurations found" with no key | nothing | ✅ **done 2026-08-01** |
| **9** | **Fast-apply path** (cheap model materialises SEARCH/REPLACE) | 4 | M25 | no apply-role path anywhere | #4 | ✅ **done 2026-08-01** — fails closed |
| **10** | **`@docs` crawl + index** | 3 | M20 | no docs provider, crawler or namespaced shard | nothing (network-facing) | ✅ **done 2026-08-01** |
| **11** | **Keyed search providers** (Brave / Tavily / Google CSE) | 3 | M21 | `tools/web-search.ts` is 108 LOC of DDG scrape | nothing | ✅ **done 2026-08-01** |
| **12** | Eval breadth: **19 tasks / 8 fixtures** vs a planned 8–10 × 6 stacks | 0 | M3 | `eval/tasks.js` is 53 LOC / 19 entries | nothing | ✅ **done 2026-08-01 — 74 tasks / 13 fixtures, and it found F3/F3b** |
| **13** | "Symbol questions resolve via **LSP not grep**" unasserted | 1 | M6/M7 gate | `eval/` has no model-calling tier | **needs the opt-in model tier** | 🔴 blocked — not phase work |
| **14** | §4.2's four ⚠ rows (task success, tokens/task, symbol accuracy, wrong-idiom) | 0 | M3 / §4.2 | `eval/baseline.json` holds only deterministic metrics | **same model tier as #13** | 🔴 blocked — not phase work |

**#13 and #14 are the same blocker twice**, and neither is phase work: both need an **opt-in tier of
the eval harness that spends real model calls**. That is a harness capability with a cost model (keys
in CI, a budget per run, non-determinism to control), and it is the single prerequisite for four of
§4.2's metric rows plus Phase 1's last gate. Making it a Phase 4 task would hang the deterministic
gates of five phases off a non-deterministic runner. It is specified as **§4.6 — the model tier**
below so it is owned rather than perpetually deferred, and it is the one thing on this list that is
**not** attempted in this pass.

**12 of the 14 closed on 2026-08-01**, in dependency order: #1–#3 and #12 (self-contained), then
Phase 4 (#4 → #5, #7, #8, #9), then #6 once #4 existed to unblock it, then #10 → #11. Every delivery
note is filed under its phase in §4.

**What that means for the roadmap: phases 0–4 are delivered, and Phase 3's and Phase 4's milestones
are all ✅.** Closing Phase 4 also closed the last two Phase 3 partials — M17's cross-encoder (it
needed the `rerank` role) and M19 (`@symbol` here, `@docs`/`@web` with M20/M21). The only work
outstanding in phases 0–4 is the model tier, which is not phase work.

**Verified after the pass, by running everything:** `tsc -b` clean · harness **426/426** · vitest
**582/582 / 32 suites** (was 393/23) · eval gate green with a re-recorded baseline (74 tasks /
13 fixtures · stack detection 100% · exact-match 100% · **wrong-idiom 0% of 33 guarded tasks** ·
recall@5 91.2 · @10 97.2 · @20 100) · webview builds · `extension.ts` **671 LOC**, inside the
≤700 gate and now *enforced* by a test rather than by hand.

### Previously-tracked items, now closed (kept for the record)

| # | Item | Phase | Closed |
|:--:|---|:--:|---|
| A | `extension.ts` **960 LOC** against a **≤700** gate | 0 | ✅ 2026-07-29 — **652 LOC** |
| B | Rules+skills assembly as one *merged* pipeline | 2 | ✅ 2026-07-29 — **won't-do**, two budgeted sections is the better design |
| C | Retrieval recall had no recorded baseline | 0/3 | ✅ 2026-07-29 — recall@3/5/10/20 recorded over an 82-file corpus |

Detail on each closed item is its **delivery note, filed under that item's phase in §4** — this list
used to duplicate them and drifted every revision, so it now says only what the table cannot.

**The two `extension.ts` cuts, because both are cited elsewhere.** 2537 → 623 in Phase 0, then 652
once M19's provider assembly landed, then 704 on 2026-08-01 when the `@docs`/`@web` wiring went in
inline — **past the gate**, caught by hand, moved into `core/context-provider-setup.ts`, and now at
**671** with `__tests__/source-hygiene.test.ts` failing the build over 700. Two of the original cuts
needed a design decision rather than a move, and both are recorded at **G10**: `core/chat-session.ts`
holds the chat lane's state as one object shared *by reference* (because `_runAgentTask` reassigns it
mid-run while the webview handler reads it afterwards), and `agent/managed-runs.ts` moved the Manager
lane as a **class** rather than a deps-object function (because its live `Map` and persisted history
must be folded together on every transition, or a reload shows ghost "running" rows).

**Why M9's stronger reading is a won't-do rather than debt.** Rules and skills are separate,
independently-budgeted sections in `core/prompt-builder.ts`. That satisfies the stated intent —
neither can starve the other — and is the better design: one merged section would have to arbitrate
two unrelated ranking schemes into a single budget, and it would make
`__tests__/rules-panel-fidelity.test.ts`'s both-directions assertion harder to state, not easier. The
Phase 2 wording is amended to "one budgeted assembly *path*", which is what was meant and what
shipped.

**Defects found by this work and fixed, in order of when they were found.** **F1** (skills injected
into repos with no detected stack) and **F2** (`react` undetected in Next.js projects) came from the
eval harness's first run; the **per-mode allowlist gap** (B4) came from adding Learn mode; six more
came from Phase 3's own corpus measurements (see the rev 5 note); and **F3**, **F3b** and the
priority-as-signal residue of F1 came from growing the eval set to 74 tasks (rev 6 note). Every one
of them passed the tests that existed at the time and failed only against a measurement — which is
the argument for the eval tier, restated with each finding.

**Scope:** `src/stable/extensions/black-ide-agent/` + editor-level surfaces in `src/stable/src/vs/`

**Benchmarked against:** Google Antigravity 2.0 · Cursor 3.5 · Continue.dev · NeuralInverse · CortexIDE · A-Coder · OPIDE.

> **Method.** Every "Level"/"Status" below is grounded in code in this repo (file:line where it
> matters), not in the README. Competitor claims come from their public docs/READMEs as of
> 2026-07-27 and are labelled as *their* claims, not measured results. Where our own docs
> overstate reality, that is called out — see [Doc corrections](#0-doc-corrections-truth-up).

> **What changed in rev 14 (2026-08-02).** Delivery: **Phase 12's privacy and authority spine —
> M67–M69**, with M66, M70 and M71 not started. Tally **59 of 71**. All four of Phase 12's gate
> clauses are met and enforced by tests, which is the first phase since Phase 5 where every clause
> landed.
>
> **The egress register found two undeclared network callers on its first run** — a model-list fetch
> and a loopback Ollama probe. Both legitimate, both now declared. That is the normal state of such a
> list and the reason it is enforced by a source walk rather than written down: "we don't phone home"
> is a claim about code that does not exist, and you cannot test for absence by looking at the thing.
>
> **A sentinel that would have inverted the org policy.** `sessionTokenBudget: 0` means *unlimited*,
> so `Math.min(0, 50_000)` is 0 — an org imposing a ceiling on a user who had none would have
> removed it. Caught because the tighten-only property is asserted as one capability score over the
> whole structure, not field by field.
>
> **The per-action confirmation is enforced by a type, not a policy.** `OutboundContext` has no field
> for a remembered answer, so a caller cannot express "they allowed this last week"; adding ambient
> posting means changing the type, which a reviewer sees.
>
> **What changed in rev 13 (2026-08-02).** Delivery: **Phase 11's boundary and headless surface —
> M62–M64**, with M65 not started. Tally **56 of 71**.
>
> **The phase's decision is a barrel rather than a `git mv`.** "Zero vscode imports in the core" can
> be reached by moving eighty files in one change — a diff across most of the repository that the
> harness cannot meaningfully verify — or by **naming the boundary and enforcing it transitively**,
> then moving modules when there is a reason to. The second makes the property true, checked on every
> commit, and true incrementally. The first is how a decoupling ships as a directory rename.
>
> **Four dependency edges cut, and the pattern is the finding.** Three of the four were a *single
> line* each holding a whole subsystem hostage: an unused `vscode` import; one type
> (`vscode.SecretStorage`) that made the entire retrieval stack editor-bound because the index takes
> a `SecretManager`; and a value-import of the tool executor where only its shape was needed, which
> pulled the LSP bridge and the codebase index into everything importing the agent loop. The fourth
> was `workspaceFolders[0]` inside the skills manager — also M36 in miniature.
>
> **The boundary checker distinguishes `import type`**, because a type-only import is erased and
> creates no runtime dependency. A checker that cannot tell a contract from a dependency forces
> duplicate type declarations to satisfy it.
>
> **A block comment closed by its own example.** A glob written out in a doc comment in
> `node-host.ts` — doubled star, slash, star — terminates the comment. Same family as this
> codebase's three NUL bytes: invisible as prose, changes what the file means.
>
> **What changed in rev 12 (2026-08-02).** Delivery: **Phase 10 (M59–M61)**. The bundled catalog
> went **16 → 47 packs**, and because `eval-task-coverage` asserts every pack has a golden task, the
> eval corpus grew with it: **74 → 112 tasks, 13 → 21 fixtures**, plus profiler detection for six
> stacks it could not previously see. Tally **54 of 71**.
>
> **The gate's wording was wrong and the eval set caught it.** "≥1 role and ≥1 stack" asserted
> literally broke a golden task — `a11y-wcag-aria` ships `stacks: []` deliberately, meaning *any*
> stack, and `empty-fe-1` pins that it fires on a repo with none. The test now asserts the
> resolver's real contract.
>
> **A resolver defect surfaced and deliberately not fixed here:** a cross-cutting pack with a broad
> `stacks` list displaced a specific pack on a task whose *role it did not match* — a stack match
> should not survive a role mismatch. Worked around in data; named so it is not lost.
>
> **Two of the new packs reproduced F3b**, the documented trigger-substring bug (`it` in `rspec`,
> `orm` in `orm-patterns` — inside f*orm*at and transf*orm*). Both were caught by the short-trigger
> allowlist Phase 6 added for exactly that, which forces a new short trigger to be a decision
> somebody writes down.
>
> **What changed in rev 11 (2026-08-02).** Delivery: **Phase 9's security spine — M52–M56** — and
> with M54 and M56 closed, **every P0 item in the 71-gap inventory is now done**. Tally **51 of 71**.
> Five of Phase 9's twelve milestones; the Reviewer agent, MCP transport parity and sandbox tiers
> are not started and are listed as such rather than sketched.
>
> **The redaction work is mostly about what it refuses to redact.** Over-redaction is not a safe
> failure — an agent whose view of the code is full of `[redacted]` cannot reason about it, and the
> user switches the feature off, after which nothing is protected. Six false positives were caught by
> tests, including an ordinary English sentence: prose clears the entropy threshold, and credentials
> have no spaces.
>
> **The injection fixtures assert the gates, not the filter.** A pattern matcher that blocked
> injections would be theatre; what holds is that `isToolAllowedInMode`, `CommandPolicy` and the
> session toggles have no parameter through which content could reach them.
>
> **Three defects found by tests during the phase.** `sk-ant-…` labelled as `openai-key` (the value
> was scrubbed either way, so a weaker assertion would have passed while mislabelling every Anthropic
> key in the audit trail); `API_KEY=${API_KEY}` redacted because a placeholder branch described a
> prefix inside an anchored alternation; and a **literal NUL byte** in `workspace-guard.ts` — the
> third in this codebase, caught by `source-hygiene` within the same phase, and fixed by removing the
> sentinel rather than escaping it.
>
> **What changed in rev 10 (2026-08-02).** Delivery: **Phase 8 (M41–M46)** — four complete, M41
> partial, M45 not started. Tally **46 of 71**. Three of the phase's four gate clauses are met; the
> fourth is a retrieval-quality measurement with no corpus behind it yet.
>
> **The byte-stable markdown round-trip is the clause worth naming.** ADR 007 makes the markdown the
> authority and the typed index derived, and byte-stability is what stops that inverting: the file is
> in the user's repo and therefore in their diffs, so a projection that churns it on every pass is one
> they stop reading and then delete.
>
> **Two decisions recorded rather than absorbed.** Contradiction similarity is **lexical, not
> embedding-based** — E7 specifies embeddings, and using them would make every memory write a network
> call, so the feature guaranteeing memories are never silently lost would acquire a failure mode
> that silently loses them. And **M41's extractor is not wired**: the bands and the filter exist, but
> the model call that turns a finished turn into candidates belongs in §4.6's opt-in tier rather than
> as a per-turn cost nobody asked for.
>
> **A defect the gate caught in its own implementation:** decay advanced one stage per call, so an
> entry's state depended on how often the consolidation job had run rather than on elapsed time.
> Reopening a project after a gap gave a different answer from leaving the editor open.
>
> **And the suite's only flaky test, fixed rather than tolerated.** Phase 3's index-build budget
> measures wall clock inside a 46-file worker pool, so it had started measuring the other suites
> (~1.2 s alone, over the 2 s gate under contention). Best-of-three now: contention can only make a
> sample slower, and a genuine regression still fails all three.
>
> **What changed in rev 9 (2026-08-02).** Delivery: **Phase 7 (M38–M40)** — one complete, two
> partial — plus the closure of Phase 6's partial, M37. Mid-run steering, the verify contract, and
> typed artifacts. Tally **40 of 71**.
>
> **This is the first phase to close with real work outstanding, and it is graded that way.** M39 is
> complete. M38 ships the typed model, the store and the comment plumbing but **not the review
> panel**. M40 ships the contract, the four-outcome judgement and the report, wired into the
> task-agent lane — but not into pipeline runs, not into chat tasks, and with no visual capture, so
> two of the phase's four gate rows read *not met* rather than met-with-caveats.
>
> **M37 closed as a side effect, which the roadmap implied and never said:** a race ranks on test
> evidence, and until M40 produced evidence there was nothing to rank on. That dependency was the
> real reason M37 shipped partial in Phase 6.
>
> **Two long-standing defects surfaced.** `ArtifactManager` has accepted an artifact type, dropped
> it, and reported every artifact as `report` since Feature 18 — invisible because nothing rendered
> the type. And two test suites shell out to `tsc`/`stylelint`, so running the build and the tests in
> one command makes them contend and fail intermittently; separately, 920/920 is stable.
>
> **What changed in rev 8 (2026-08-02).** Delivery: **Phase 6 (M31–M37)** — six complete, one
> partial — taking the tally to **37 of 71** and clearing the last P1 items in the Manager lane.
> Task agents, one governor across both lanes, the agent inbox, per-root profiles, the multi-model
> race, and **the deletion of parallel wave execution**.
>
> **The no-partials run ended, and it is recorded rather than smoothed.** M37's ranking is built and
> tested; the evidence it ranks on is not wired, so `raceOutcome` reports `testsRan: false` and the
> comparison falls through to diff size — the fourth tiebreak doing the first one's job. A race that
> silently ranks on churn while claiming to rank on tests is exactly what this document exists to
> catch, so it is 🟡.
>
> **M35 is closed by deletion, decided by the owner.** Six revisions of "default-off, unverified"
> ended by removing the path rather than by verifying it, on the argument that E18's reserved role for
> it — E3's execution engine — is now filled by the task-agent lane, where the isolation is asserted
> rather than hoped for. The deletion test then caught what makes deletions leak: `tsc -b` leaves the
> compiled artifact behind, so the "deleted" module was still `require`-able at runtime.
>
> **Four defects found by building it.** A cancelled agent that sat `running` forever if its task
> never observed the abort signal (status is now the user's intent, applied at once; the concurrency
> slot stays held until the run truly ends, because a streaming final turn is still spending).
> Concurrent agents sharing one `BrowserTool` and one `MCPClient` — four agents driving one Chromium
> session. `WorktreeManager` reading `workspaceFolders[0]` in all seven methods, so an agent declared
> against one root would build its worktree from another repo's HEAD. And a leaked concurrency slot
> when worktree creation itself failed, which would have ratcheted the cap down by one, permanently,
> every time git hiccuped.
>
> **The ≤700-line gate fired for the third consecutive phase** (711 lines). This time the extraction
> it forced — `_getProjectProfile` into `core/project-profile-cache.ts` — is where the profile became
> per-root, so the gate produced M36's substance instead of merely surviving it.
>
> **What changed in rev 7 (2026-08-02).** Delivery: **Phase 5 (M28–M30)**, taking the tally to
> **30 of 71, still with no partials**, and clearing the eleventh of thirteen P0 items. Next-edit
> prediction, terminal `Cmd+K`, and rolling summarization; full note under Phase 5 in §4.
>
> **Two of the phase's four gate clauses are asserted and two are not**, and the split is the same
> one every phase since rev 4 has hit. "Zero completions after the buffer changed" and "never drops a
> pending approval or tool result" are invariants, so they are gated. "p50 ≤250 ms" and "≥40% of
> accepted suggestions multi-line or cross-file" are ratios over predictions a model produced, so
> they are §4.6 rows. What shipped for those two is the **instrument** — `NextEditStats` computes all
> three ratios and `black-ide.nextEdit.showStats` reads them — because a gate with nothing behind it
> is an assertion, and this document has spent four revisions establishing what those are worth.
>
> **Four defects found by the work, all by a test or a measurement.** A churn bound inherited from
> fast-apply that refused *every* edit to *every* small file (33% of a three-line module is one line);
> deleted text being unrecoverable after the change event fires, which silently reduced the edit
> history to insertions and hid the rename case it exists for; an OS-keychain read on the typing path;
> and — the one that only appears on a bill — next-edit firing after every file the *agent* wrote,
> because `onDidChangeTextDocument` reports that a document changed and never who changed it.
>
> **Two things that were already broken, found by becoming their second caller.** `/compact` has been
> in the webview's slash-command list since Phase 2 with no handler anywhere, so typing it sent the
> literal string to the model as a task — which is why M30's wording is "*keep* `/compact` as the
> manual override". And `CommandHost.detectedStacks` has been declared optional and never implemented
> since Phase 3, so M20's stack-based doc suggestions have always been computed from an empty list.
> Both fixed. Both type-checked perfectly while doing nothing.
>
> **The ≤700-line gate fired again, on the same kind of change, and this time the test caught it.**
> Wiring next-edit into `activate()` took `extension.ts` to 705. In rev 6 the equivalent was caught by
> reading a line count by hand; the test added then did its job here.
>
> **One tier did not run and is not being rounded up:** the 19 real-host integration tests.
> `@vscode/test-electron` spawns `Contents/MacOS/Electron`; VS Code 1.131.0 ships
> `Contents/MacOS/Code`. Tooling mismatch, predates this phase, no Phase 5 code is covered there.
>
> **What changed in rev 6 (2026-08-01).** Delivery: **12 of the 14 open items in phases 0–4 closed**,
> which completes phases 2, 3 and 4 and takes the tally to **27 of 71, with no partials**. Phase 2's
> tool toggles (M10), Phase 3's `@symbol` + `@docs` + keyed search (M19–M21) and cross-encoder rerank
> (M17), Phase 0's eval breadth (M3: 19 → 74 tasks), the never-measured index-build budget
> (**1 247 ms / 5 000 files** against ≤2 s), and all of **Phase 4** (M23–M27).
>
> **Three defects found by the work, all by measurement rather than reading.** Growing the eval set
> from 19 tasks to 74 immediately exposed **F3**: a NestJS repo asked for a users controller resolved
> to *express + aspnet-core + nextjs + react + angular*, Flask got Django and FastAPI, and a React
> Native screen got Next.js idioms ranked first — packs list the language beside the framework, so on
> any TypeScript repo they matched at language strength. **F3b**: `"req, res"` in the express pack's
> frontmatter was split on the comma into the bare trigger `res`, which as a substring fires on
> "**Res**tyle" and "add**res**s", making a backend pack a candidate on almost any English prompt in
> any language's repo. And a residue of **F1**: `score += priority * 0.1` looked like a tie-break but
> survives the `score > 0` filter unaided, so a language-only match scoped to another role floated
> back on priority alone. All three are fixed with regression cover, and the wrong-idiom metric §4.2
> asked for is now real and gated — 33 guarded tasks, 0 leaks.
>
> **One gate the roadmap set and the code caught.** Wiring the `@docs`/`@web` providers inline took
> `extension.ts` from 652 to **704 lines**, past a ≤700 gate that three revisions discuss and nothing
> enforced. It is now enforced by a test, and the wiring lives in a module (671 lines).
>
> **A finding about this document.** `enhancement.md` itself contained a **literal NUL byte** — inside
> the paragraph describing the Phase 3 defect where a literal NUL byte shipped in source. Writing "the
> escape `'\0'`" as an actual escape produced an actual NUL, so the roadmap was *binary to `grep`*,
> and it was found exactly as the original was: a search that plainly should have matched silently
> returned nothing. Fixed, and `__tests__/source-hygiene.test.ts` now covers `docs/notes/*.md` as well
> as source — these files are the project's shared record and are read with the very tools the byte
> defeats.
>
> **One scope deviation, recorded rather than absorbed:** M26 ships **16** providers, not ~18.
> Bedrock and Vertex need SigV4 signing and a Google OAuth exchange — auth implementations, not base
> URLs — and a half-working entry would accept the user's key and fail every call.
>
> **What is left in phases 0–4 is one thing, named:** the **model tier** (§4.6). Phase 1's
> LSP-over-grep gate and four of §4.2's rows all need real model calls, and folding them into the
> deterministic gate would make the one check that currently blocks bad merges fail intermittently.
>
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
| A6 | **Agent Manager: N independent user-launched agents, each own worktree + own model** | 🟢 | ✅ | *Corrected 2026-07-27:* `webview/src/ManagerPanel.tsx` **already exists** — `RunSummary` carries `modelId`, `status: awaiting_approval`, `currentPhase`, and `ParallelSubagents.tsx` renders subagents. **Shipped (Phase 6, M31/M32).** The missing unit — the independent, non-pipeline task agent — now exists: own worktree, mode, model and workspace root, listed beside pipeline runs. Isolation is structural (the executor is rooted in the worktree, not the repo) and the live workspace is untouched until an explicit apply. At Antigravity Manager's and Cursor's bar on parallelism; ahead on the apply gate, which neither makes explicit. |
| A7 | Request classification / auto-plan / auto-orchestrate | 🟡 | ✅ | Keyword heuristics in `planning-engine.ts`; not learned, not model-assisted. |
| A8 | Parallel wave execution | ⬜ | ❌ | **Deleted in Phase 6 (M35)** rather than graduated. Default-off and unverified for six phases; the role E18 reserved for it — E3's execution engine — is filled by task agents, where the isolation is asserted. Concurrency now lives in the Agent Manager, not in the pipeline. |
| A9 | Mid-run steering (correct an agent without restarting the task) | 🟢 | ✅ | **Shipped (Phase 7, M39).** `core/steering.ts` — a correction is queued per agent and drained at the top of the next turn, keeping every file the run has read and every conclusion it reached. Never lands between a `tool_use` and its `tool_result`, and never produces two consecutive user turns; both are provider rejections rather than degraded answers. At Antigravity's steering bar; the comment-*on-artifact-region* surface is plumbed but not yet rendered (M38). |
| A10 | Background / cloud agents (off-machine execution) | ⬜ | ❌ | Cursor Background Agent, Antigravity async tasks. Unblocked by Phase 11's host seam — a run needs an `AgentHost`, and nothing in the core now assumes that host is an editor — but the daemon itself (M65) is not started. → **E14** |

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
| C3 | Bundled skill packs | 🟢 | ✅ | **16 → 47 (Phase 10, M59).** Wave 2 shipped: frameworks (`nestjs`, `django-rest-framework`, `spring-boot`, `laravel`, `vue`, `svelte-kit`, `remix`, `astro`, `flutter`, `entity-framework-core`, `gorm`), testing (`vitest`, `react-testing-library`, `playwright-e2e`, `cypress-e2e`, `xunit`, `cargo-test`, `go-test`, `rspec`, `junit-mockito`) and cross-cutting (`rest-api-design`, `auth-jwt-oauth`, `db-migrations`, `orm-patterns`, `component-architecture`, `test-strategy`, `coverage-tdd`, `docker`, `kubernetes`, `github-actions-ci`, `terraform`). Every pack has ≥1 golden task, asserted. |
| C4 | Rules engine (glob-scoped, activation modes, per-session toggles) | 🟢 | ✅ | **Shipped (Phase 2, M9/M10).** `core/rules.ts` + `core/rules-loader.ts`: `.blackide/rules/*.md`, four activation modes (`always`/`glob`/`agent-requested`/`manual`), three scopes, priority, own glob engine, hot-reload, Problems-panel diagnostics, `AGENTS.md` back-compat. Session panel toggles rules and reports what fired. **At Cursor's and Continue's bar**, with `agent-requested` (budget-deferred bodies) as a small edge. **Tool toggles landed 2026-08-01 (M10)** — enforced at the executor, not advertised — so the panel is complete. |
| C5 | Long-term project memory (`.blackIDE/knowledge/`) | 🟡 | ✅ | `core/knowledge-base.ts` (308 LOC), `memory/knowledge-store.ts`. Human-readable markdown is a real strength (ADR 007). |
| C6 | **Automatic memory extraction / dedup / decay / contradiction detection** | 🟡 | 🟡 | **Phase 8 (M41–M44).** Typed tiered entries beside a byte-stable markdown projection; identity-based dedup (the old SHA-256 store treated "Use pnpm." and "Use pnpm" as two memories); decay that demotes then archives and never deletes; contradiction detection that **asks and never overwrites**; idempotent consolidation. Two tiers not three — OPIDE's sensory tier is a second name for the transcript `ContextManager` already bounds. **Still 🟡:** the extractor that produces candidates from a turn needs a model call and is not wired, so nothing is yet extracted *automatically*. |
| C7 | Mindmap sync (`project_mindmap.md`) | 🟢 | ✅ | **Read-back shipped (Phase 8, M46),** closing plan.md's Phase 5 follow-up. The file had been write-only since then: the agent recomputed what it had written and never saw a convention a human added to it. Now injected as its own budgeted prompt section, with auto-sync blocks excluded so a run does not re-read its own history. |
| C8 | Team / org-level shared rules | 🟢 | ✅ | **Shipped (Phase 2, M11).** `team-rules/` or `$BLACKIDE_TEAM_RULES`; injected first so they survive truncation, and not user-disableable. At Cursor Team Rules' bar. *(Team-level shared **memory** is separate and still absent — see C6.)* |

### 1.4 Retrieval & context

| # | Capability | Level | Status | Parity bar / gap |
|---|---|:--:|:--:|---|
| D1 | Hybrid semantic index (embeddings + BM25 via RRF) | 🟢 | ✅ | `core/codebase-index.ts`. Fusion ranking is genuinely good. |
| D2 | **Chunking strategy** | 🔴 | 🟡 | `chunkFile()` at `codebase-index.ts:420` is a **fixed line-window with overlap** — no symbol awareness at all. Our docs claim "AST-aware chunking"; that is not what the code does. OPIDE: tree-sitter, 13+ languages. → **E2** |
| D3 | Code graph: call graph, type hierarchy, impact analysis | ⬜ | ❌ | OPIDE ships this; Cursor uses it for multi-file edits. Highest-leverage retrieval gap. → **E2** |
| D4 | Reranker stage | 🟢 | ✅ | **Shipped (Phase 3 M17, completed Phase 4).** `core/reranker.ts` — tuned `LexicalReranker` (the default, and what runs with no rerank model) plus `ModelReranker` on the `rerank` role, scoring the whole candidate set in one call. Recall@10 95.8 → **97.2**. At Continue's bar. |
| D5 | Context manager / token budgeting / compaction | 🟢 | ✅ | `core/context-manager.ts`, `core/prompt-builder.ts`, and **rolling summarization as of Phase 5 (M30)**: `core/rolling-summary.ts` folds the older middle into prose at a threshold, layered *above* `fit` rather than replacing it — `fit` stays the deterministic floor that still holds the window when the summarizer's provider is down. Refuses outright while an approval gate is open, never orphans a tool result, never folds an unresolved call. `/compact` is the same path with the threshold removed. |
| D6 | **Structured tool-output compression** | 🔴 | 🟡 | `core/text-cap.ts` truncates raw text. A-Coder claims 30–70% token reduction via TOON encoding of tool output. → **E11** |
| D7 | External docs indexing (`@docs`-class provider) | 🟢 | ✅ | **Shipped (Phase 3, M20).** `core/docs-index.ts` — bounded same-origin crawl scoped to the root *path* (so a version-pinned URL cannot drift into another version), passage-level search, stack-based suggestions, `black-ide.addDocs`. At Continue's `@docs` bar. |
| D9 | **Context providers / `@`-mentions** | 🟢 | ✅ | **Shipped (Phase 3, M19–M21).** `core/context-providers.ts` — a `ContextProvider` API with budgets and visible truncation, and **11 providers**: `@file`, `@folder`, `@symbol`, `@problems`, `@terminal`, `@git`, `@rules`, `@skills`, `@past-chats`, `@docs`, `@web`. Mentions are resolved server-side into the prompt rather than left as text. **At Cursor's and Continue's bar.** |
| D10 | Ranged file reads (token-efficient pagination) | 🟢 | ✅ | *Corrected:* `read_file` already takes `start_line`/`end_line` (`core/tools.ts:27-34`) — at A-Coder's "intelligent file pagination" bar. |
| D11 | **Git-history semantic search** | ⬜ | ❌ | A-Coder ships Morph-accelerated search across git history. `grep -rn "git log\|blame"` over `src/` returns nothing. → **E20** |
| D12 | **Notebook (`.ipynb`) awareness** | 🟡 | 🟡 | **Phase 10, M61.** `core/notebook.ts` — byte-stable round trip, per-cell edit preserving the `source` array shape Jupyter writes (a plain string is valid nbformat and rewrites every cell), outputs excluded from prompts by default, cell-granular snapshot/restore. **Partial:** `edit_notebook_cell` is not yet registered in the executor's tool surface. |
| D8 | Web search | 🟢 | ✅ | **Keyed providers shipped (Phase 3, M21):** Brave / Tavily / Google CSE with DDG as the no-key default. Every failure degrades to DDG *and names the degradation*, so a configured-but-unused key is visible. |

### 1.5 Tools & execution

| # | Capability | Level | Status | Parity bar / gap |
|---|---|:--:|:--:|---|
| E_1 | **31** native tools (file/grep/list/run_command/subagent/artifact/mindmap/LSP/tests/…) | 🟢 | ✅ | `core/tools.ts` — *recount 2026-07-28:* 23 before Phase 1, **31** after it added the 7 LSP tools + `run_tests`. Ahead of A-Coder (22+) and OPIDE (10+). |
| E_2 | Exact SEARCH/REPLACE edit contract | 🟢 | ✅ | `core/tools.ts:76` — same discipline A-Coder calls out as its precision feature. At bar. |
| E_3 | Checkpoints & rollback (reverse hunks, per-message undo) | 🟢 | ✅ | `core/checkpoint-manager.ts`. **Ahead of CortexIDE's "checkpoint and visualize".** |
| E_4 | Browser automation (Playwright, gated, per-task session) | 🟡 | ✅ | `tools/browser-tool.ts` + `browser-capability.ts` allowlist. |
| E_5 | **Visual verification loop (screenshot/recording as reviewable evidence)** | 🟡 | 🟡 | **Phase 7, M40 (partial).** The contract exists: `planVerification` requires a screenshot when a UI file changes, `evaluateVerification` reports it missing, and a `test-report` artifact is written on every path — so an unverified run is now distinguishable from a clean one, which it was not. **Still missing:** nothing captures the screenshot, so UI work lands as `incomplete` by design; and verification runs for task agents only, not pipeline or chat runs. Behind Antigravity. |
| E_6 | MCP client | 🟡 | ✅ | `tools/mcp-client.ts:51` — **stdio only**, Agent-mode only, refused in pipeline runs. Antigravity ships Chrome + Web MCP servers; remote/streamable HTTP is table stakes now. → **E12** |
| E_7 | Vision / image input | 🟢 | ✅ | `core/llm-client.ts:334-370` — images on user turns *and* tool results, OpenAI + Anthropic shapes. At A-Coder's bar. |
| E_8 | Agent hooks (`beforeToolCall`/`afterToolCall`/`beforeResponse`/`onError`) | 🟡 | ✅ | `agent/hooks.ts:8`. Present but under-documented and unused by first-party features. |
| E_9 | Tool circuit breakers / per-tool failure budgets | 🟢 | ✅ | **Shipped (Phase 9, M52).** `core/tool-breaker.ts` — consecutive failures plus a latency budget, per tool and per *run* (the fix for a wedged server is a restart, so a breaker outliving the run would keep it disabled after the user fixed it). Tripped tools are removed from the advertised list **and** refused at the executor. At OPIDE's bar. |
| E_10 | Post-edit diagnostics feedback | 🟢 | ✅ | *Corrected:* `ToolRunner.collectDiagnostics` (`tools/tool-runner.ts:306`) is called after every edit from `agent/tool-executor.ts:154` — the agent **does** see compiler/linter errors it caused. Better than the first assessment. |
| E_11 | On-demand `get_diagnostics` + LSP navigation tools | 🟢 | ✅ | **Shipped (Phase 1, M6/M7).** `tools/lsp-tools.ts` — `get_diagnostics`, `go_to_definition`, `find_references`, `workspace_symbols`, `hover`, `code_actions`, `rename_symbol`. Symbols addressed by *name* (a model has no character offsets), every provider call raced against a timeout, and a cold/absent server degrades to grep with an explicit note instead of erroring. Verified in a real extension host. **Structural advantage over the extension-only competitors**, who cannot reach a language server this directly. |
| E_12 | **Sandboxed command execution** | 🔴 | ❌ | `executeCommandInTerminal` (`tool-runner.ts:133`) spawns a real, unrestricted `vscode.window.createTerminal`. Policy-gated (G1) but not *contained*. Cursor 2.0 sandboxed shells; OPIDE QuickJS sandbox + 10-layer model. → **E23** |
| E_13 | Test-runner integration (run one test, parse results structurally) | 🟢 | ✅ | **Shipped (Phase 1, M8).** `core/test-report.ts` — command selection from `ProjectProfile` plus pure parsers for pytest/jest/vitest/dotnet/cargo/go/rspec, returning **failures only**. 30 KB of output with 800 passing cases and one failure formats to <2 KB, asserted in CI. Trusts the exit code over the parse, so a crashed runner is never reported as a pass. |

### 1.6 Editor integration & platform

| # | Capability | Level | Status | Parity bar / gap |
|---|---|:--:|:--:|---|
| F1 | Inline completion (FIM-aware) | 🟡 | ✅ | `core/inline-completion.ts` (80 LOC) — single model, single file, no edit history. |
| F2 | **Next-edit prediction (multi-file, edit-history-aware, jump-to-next-edit)** | 🟢 | ✅ | **Shipped (Phase 5, M28).** `core/next-edit.ts` + `core/next-edit-controller.ts` — a coalescing edit-history buffer and the M15 graph produce a SEARCH/REPLACE-anchored prediction that is verified against the live file and discarded if any document it was computed from has moved. Cross-file is the normal case, reached by a jump affordance rather than ghost text, because the stable inline-completion API cannot render away from the cursor. Off by default: it spends a model call per typing pause. Behind Cursor Tab v2 on the model (they train one for it; we route the `autocomplete` role at whatever the user configured) — at bar on the capability. |
| F3 | Inline chat (`Cmd+I`) | 🟡 | ✅ | `core/inline-chat-controller.ts` — selection-scoped. |
| F4 | Commit-message generation | 🟡 | ✅ | Diff-size handling is naive. |
| F5 | Multi-provider LLM (OpenAI/Anthropic/Google/OpenRouter/Ollama/LM Studio) | 🟢 | ✅ | `core/llm-client.ts` (478 LOC). NeuralInverse claims 20 providers; 6 well-tested beats 20 shallow. |
| F6 | **Per-role model config (chat/edit/apply/autocomplete/embed/rerank)** | 🟢 | ✅ | **Shipped (Phase 4, M23).** `core/model-router.ts` — seven roles, resolved in one place, with an explicit override outranking a standing role mapping and the legacy `autocompleteModelId` still honoured. `apply`/`rerank` stay off until named, because falling back to the strong model there costs more than not having the feature. At Continue's model-roles bar. |
| F7 | **Cross-provider failover / health-aware routing** | 🟢 | ✅ | **Shipped (Phase 4, M24).** Per-provider circuit breaker (consecutive failures, cooldown, half-open retry); failover at the *turn* so a run keeps its context; a different provider tried before another of the same one; **never after output has streamed**, since that would append a second answer to half of one. Covers chat *and* unattended pipeline runs. `fallbackTurn` remains the local-protocol path and is no longer the only thing here. |
| F8 | Fast-apply path (small model applies a large diff) | 🟢 | ✅ | **Shipped (Phase 4, M25).** `edit_file`'s `intent` → apply-role model → verified with the *real* applier. Malformed, missing-anchor, ambiguous, no-change and oversized results all escalate to the strong model, so a silently wrong edit is not reachable. |
| F9 | Output modes (`apply` / `pr`) | 🟢 | ✅ | `core/git-pr.ts`. Ahead of most. |
| F10 | Headless CLI / SDK surface | 🟡 | 🟡 | **Phase 11 (M62–M64).** The core boundary is declared and **transitively enforced** — nothing reachable from `agent-core` imports `vscode` — with a Node host that implements it using no editor, and a CLI surface (JSON-per-line stdout, logs on stderr, six CI exit codes distinguishing *completed but unverified* from *completed*). **Partial:** the runnable `bin` entry and the package move are not shipped. |
| F11 | Skill/rule distribution (registry or hub) | 🟡 | 🟡 | **Phase 10, M60.** `core/skill-registry.ts` — registry entries with a **pinned** ref (a moving ref is refused, since it makes the checksum meaningless), SHA-256 verified before the content is examined, installs to `.blackide/skills/` where a same-named local pack shadows it, and a forbidden-key deny list so a pack can never declare `tools`/`autoApprove`/`policy`. **Partial:** the fetching command is not wired. |
| F12 | **Terminal `Cmd+K`** (natural language → shell command) | 🟢 | ✅ | **Shipped (Phase 5, M29).** `core/terminal-command.ts` — single-line by construction, because `sendText(text, false)` suppresses one *trailing* newline and executes every embedded one; judged by the same `CommandPolicy` as the agent's `run_command`, so this surface cannot be more permissive than that one; mandatory preview, and inserted with `shouldExecute: false` even for allow-listed commands. **At Cursor's bar, with a stricter never-run posture.** |
| F13 | **Provider breadth** | 🟢 | ✅ | **6 → 16 (Phase 4, M26).** Added DeepSeek, Groq, Mistral, xAI, Together, Fireworks, Cerebras, LiteLLM, vLLM, Azure OpenAI — one dispatch, one preset table, so the streaming and tool-call parsing cannot drift per provider. **Bedrock and Vertex remain absent by decision:** SigV4 signing and a Google OAuth exchange are auth implementations, not base URLs. |
| F14 | Zero-config first run (works before a key is added) | 🟢 | ✅ | **Shipped (Phase 4, M27), local-first by design.** Probes Ollama / LM Studio / llama.cpp on a 1.2 s timeout and *offers* what it finds; never auto-enables, ignores a runtime with no models pulled, and types the result `local` so tool calls go through the protocol that works on every local model. We still do not operate a hosted free tier (§4.5). |
| F15 | **Multi-model race** (same prompt, N models, compare & pick) | 🟡 | 🟡 | **Phase 6, M37.** `core/model-race.ts` ranks lexicographically — a failing candidate never outranks a passing one, whatever its diff size — caps the field, and returns *no winner* rather than nominating one on weak evidence. Nothing is auto-applied. **Partial:** the test-result half is not wired, so ranking currently falls through to diff size. |
| F16 | **Agent inbox / notifications when input is needed** | 🟢 | ✅ | **Shipped (Phase 6, M34).** `core/agent-inbox.ts` — blocked / parked / failed / **review** across both lanes, badge counts in the Manager header, and a notification fired once per (item, reason) so a poll of an unchanged inbox is silent. At Antigravity's inbox bar; the `review` reason (finished work nobody has applied) is an addition. |
| F17 | Reusable prompt / notepad library | 🟢 | ✅ | **Shipped (Phase 2, M12).** `core/prompt-library.ts` + loader: `.blackide/prompts/*.md` become slash commands with `$ARGS`/`$1`…`$9` and cycle-safe `steps:` workflows; built-in names refused at load so a user file cannot silently redefine `/plan`. At Cursor Notepads' and Continue prompt blocks' bar, plus workflow chaining neither has. |
| F18 | Multi-root / multi-workspace support | 🟡 | ✅ | **Phase 6, M36.** `core/workspace-roots.ts` gives longest-prefix, boundary-aware attribution and `core/project-profile-cache.ts` caches a profile per root, so a Django+React workspace stops injecting Django skills into React files. Worktree operations take the root they act on. Still 🟡 on level: the codebase index remains a single shard. |
| F19 | Voice input | ⬜ | ❌ | Cursor ships it. Genuinely low value for us; scheduled last. → **E31** |
| F20 | Extension marketplace / Open VSX compatibility | 🟢 | ✅ | `config/product.json` carries full gallery + `extensionKind`/API-proposal compatibility tables. **Already at OPIDE's Open VSX bar** — no work needed. |

### 1.7 Safety, privacy & quality engineering

| # | Capability | Level | Status | Parity bar / gap |
|---|---|:--:|:--:|---|
| G1 | Command policy: hard deny list + user allow/deny + ask | 🟢 | ✅ | `core/command-policy.ts`. **Ahead of the field** — nobody else documents an unoverridable deny list. |
| G2 | Secrets in OS keychain (`SecretStorage`), never `settings.json` | 🟢 | ✅ | `core/secret-manager.ts`. At OPIDE's keychain bar. |
| G3 | Auto-approve deliberately ignored in unattended pipeline runs | 🟢 | ✅ | Best-in-class safety posture. |
| G4 | Local-only telemetry + diagnostics export | 🟢 | ✅ | `core/telemetry-sink.ts`, and as of Phase 12 **enforced rather than asserted**: `core/egress.ts` registers every outbound destination with a reason and a trigger, and a source walk fails the build on any undeclared network call. "The default build phones home to nobody" is a test. **Ahead of the field** — nobody else publishes an enumerable egress list. |
| G5 | Append-only audit trail per run (who/what/when/which tool/which model) | 🟢 | ✅ | **Shipped (Phase 9, M53).** `core/audit-trail.ts` — JSONL in the user's repo, monotonic sequence, **no update method by construction**, tolerant of the truncated final line a crash leaves, and redacted on the way *in* rather than at export. At OPIDE's bar. |
| G6 | Prompt/log secret redaction | 🟢 | ✅ | **Shipped (Phase 9, M54 — P0).** `core/redaction.ts` — 13 vendor-shape detectors that fire anywhere, plus entropy gated behind an assignment context *and* a token-shape check, because over-redaction is the failure that gets the feature switched off. Half its tests assert what must survive untouched. |
| G7 | Workspace-boundary enforcement on file tools | 🟢 | ✅ | **Shipped (Phase 9, M55).** `core/workspace-guard.ts` — one chokepoint covering traversal, prefix collision, symlinks and protected paths (`.git`, because `core.fsmonitor` escapes the command policy). The `test_sandbox_*.js` scripts it replaces printed things, asserted nothing, and were run by nothing. |
| G8 | Skill validation diagnostics + skills-fired telemetry | 🟢 | ✅ | **Shipped (Phase 0, M5),** closing out plan.md Phase 6. `agent/skill-diagnostics.ts` surfaces malformed packs in the Problems panel — `loadSkillDir` previously collapsed every failure into a silent `undefined`. The two valuable checks catch packs that can *never* fire and packs that would fire on *every* turn. `SkillsFired` telemetry names bundled packs only; user pack names can encode project detail, so those are counted, not named. |
| G9 | Test architecture | 🟢 | ✅ | **Four tiers as of Phase 2.** Harness 426 assertions (bespoke but pinned as the compatibility tier) · **vitest 195 tests / 13 suites** (was 2 orphaned files that no installed runner could even execute) · **19 real-host integration tests** under `@vscode/test-electron` · the eval gate. One shared `vscode` stub (`test/vscode-stub.js`) serves the vscode-free tiers, so a suite cannot pass in one and fail in the other. |
| G11 | At-rest encryption for agent artifacts / memory | ⬜ | ❌ | OPIDE claims AES-256-GCM. Our `.blackIDE/` is plaintext on disk (defensible — it's the user's repo — but not an option we offer). → **E15** |
| G12 | Team analytics / admin policy dashboard | 🟡 | 🟡 | **Phase 12, M69.** Opt-in, self-hosted, **no default endpoint anywhere in the source** — the sink does nothing without a URL the org supplies, which makes "disabling it removes all egress" true by construction. The payload is an eight-field allowlist projection of the audit trail: counts, never content. Org policy is **tighten-only**, asserted as a capability-score property. **Partial:** no dashboard; the sink transport is not wired. |
| G13 | Issue-tracker / chat integrations (GitHub Issues, Linear, Jira, Slack) | 🟡 | 🟡 | **Phase 12, M67/M68.** Reference parsing that refuses to guess a tracker from a bare key, and an outbound model where **the type makes a standing grant inexpressible** — every post is confirmed individually, with the body shown verbatim. **Partial:** per-tracker fetchers and a Slack transport are not wired. |
| G10 | `extension.ts` maintainability | 🟢 | ✅ | **2537 → 652 LOC (−74%)** across thirteen modules — the **≤700 gate is met** as of 2026-07-29 (623 after the Phase 0 cut; 652 once Phase 3's M19 wiring landed, which is why that phase's provider assembly went into its own module). Two cuts needed a design decision rather than a move, and both are the reason this took three passes. `core/chat-session.ts` holds the chat lane's mutable state as one object shared *by reference*, because `_runAgentTask` reassigns it mid-run while the webview handler reads it afterwards — passing values would have handed the extracted code a stale snapshot. `agent/managed-runs.ts` moved the Manager lane as a **class**, not the deps-object function the other extractions used, because its live `Map` and persisted history must be folded together on every transition or a reload shows ghost "running" rows; moving those methods without the state they guard would have split that invariant across two files. → **E0 (closed)** |

### 1.8 Scoreboard

| Area | Us | Best-in-class | Verdict |
|---|:--:|---|---|
| Pipeline / SDLC orchestration | 🟢 | — | **We lead.** No competitor ships this. |
| Safety & command policy | 🟢 | OPIDE | **We lead** on policy, and level on audit and redaction as of Phase 9. Still behind on **sandboxing** — M57's execution tiers are not started. |
| Checkpoints & undo | 🟢 | CortexIDE | **We lead.** |
| Project-aware skills | 🟢 | — | **We lead.** 47 packs, each with a golden task; resolution precision fixed (F1/F3/F3b); load-time enforcement that a third-party pack cannot widen a capability. |
| **Code intelligence (LSP tools)** | 🟢 | Cursor, OPIDE | **We lead.** Phase 1 exposed the fork's own language servers; the extension-only competitors cannot reach them this directly. |
| **Rules & project config** | 🟢 | Cursor, Continue | **At bar** as of Phase 2 — glob/activation/scope rules, team rules, prompt library, session panel. |
| **Test integration** | 🟢 | A-Coder | **At/above bar.** Failures-only reporting from the detected stack. |
| Retrieval & code graph | 🟢 | OPIDE, Cursor | **At bar as of Phase 3.** Symbol chunking, a code graph with impact analysis, rerank, 11 context providers, `@docs`. recall@5 84.7→91.2 · @10 93.1→97.2 · @20 100. |
| Memory | 🟡 | Cursor, OPIDE | **Closing as of Phase 8.** Ages, dedups, contradicts and consolidates — with a markdown projection that round-trips byte-stable, which neither competitor documents. Behind on the one thing the grade turns on: extraction is not yet automatic. |
| Daily-driver autocomplete | 🟢 | Cursor | **At bar on capability as of Phase 5** — next-edit with cross-file jump, terminal `Cmd+K`. Still behind on the *model*: Cursor trains one for this and we route a role. |
| Parallel task agents | 🟢 | Antigravity, Cursor | **At bar as of Phase 6.** N independent agents, one governor, an inbox, and an apply gate neither competitor makes explicit. *Steering* (mid-run correction) is still absent — Phase 7. |
| Verification & artifacts | 🔴 | Antigravity | **We are behind.** |
| Model routing | 🟢 | Continue, OPIDE | **At bar as of Phase 4.** Seven roles, health-aware cross-provider failover, fast-apply, 16 providers, zero-config local first run. |
| Review automation | ⬜ | Cursor BugBot | **Absent.** |
| Distribution / surfaces | 🟡 | Continue Hub, Antigravity CLI/SDK | **Started.** Skill distribution with pinned refs and checksums (Phase 10); an enforced vscode-free core with a Node host and a CLI surface (Phase 11). Behind on the runnable binary and the daemon. |

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
| M3 | Golden-task eval set + scoring | P0 | E0 | 0 ✅ | **74 tasks / 13 fixtures 2026-08-01** — the planned 8–10 × 6 stacks, plus a task for every bundled pack and every resolver role, plus a **wrong-idiom metric** (33 guarded tasks, 0 leaks). Recall recorded 2026-07-29. Task-success / tokens-per-task belong to the model tier (§4.6), which is tracked there rather than as eval-set debt |
| M4 | Vitest migration off the bespoke harness | P0 | E0 | 0 ✅ |
| M5 | Skill validation diagnostics UI + skills-fired telemetry | P1 | E0 | 0 ✅ |
| M6 | On-demand `get_diagnostics` tool | P0 | E22 | 1 ✅ |
| M7 | LSP navigation tools (definition, references, symbols, hover, rename, code actions) | P0 | E22 | 1 ✅ |
| M8 | Structured `run_tests` with per-framework result parsing | P0 | E24 | 1 ✅ |
| M9 | Rules v2 — `.blackide/rules/*.md`, globs, activation modes, priority | P1 | E6 | 2 ✅ | two independently-budgeted `prompt-builder.ts` sections. The "one merged pipeline" reading was **closed as won't-do** 2026-07-29 — it is the worse design, not unfinished work; wording amended to "one budgeted assembly *path*" |
| M10 | Session control panel ("what fired", toggle rules/tools) | P1 | E6 | 2 ✅ | rule **and** tool toggles 2026-08-01; `core/tool-toggles.ts` + a third executor gate, so a switched-off tool is refused where tools run rather than merely unadvertised, and a subagent inherits the toggles |
| M11 | Team / org shared rules | P2 | E6 | 2 ✅ |
| M12 | User-defined prompts + workflows library | P2 | E29 | 2 ✅ |
| M13 | Learn / teaching mode | P2 | E16 | 2 ✅ |
| M14 | Tree-sitter symbol chunking | P0 | E2 | 3 ✅ | shipped as a **dependency-free lexical backend** behind a `ChunkerBackend` seam (owner's call, 2026-07-29) — 7 languages, +5.6 recall@5 |
| M15 | Code graph (calls, imports, type hierarchy) | P0 | E2 | 3 ✅ | `core/code-graph.ts`; one-hop expansion took recall@10 93.1 → 95.8 |
| M16 | `impact_analysis` + graph-backed `find_references` | P1 | E2 | 3 ✅ | 0 false positives / 0 misses across 6 refactors, against a ≤2 FP gate |
| M17 | Reranker stage | P1 | E2 | 3 ✅ | `LexicalReranker` (the default) + `ModelReranker` on the `rerank` role 2026-08-01; one call for the whole candidate set, the first-stage prior still weighted, and any failure degrades to lexical |
| M18 | Structured tool-output compression | P1 | E11 | 3 ✅ | 37.7% at realistic path depth, 81% on repeated diagnostics, 19.5% on the shallow fixture — all three published |
| M19 | Context provider API + full `@`-mention set | P1 | E19 | 3 ✅ | API + **11 providers** — `@symbol` reads the M15 graph and returns the definition plus its callers; `@docs`/`@web` landed with M20/M21 |
| M20 | External docs indexing (`@docs`) | P1 | E13 | 3 ✅ | `core/docs-index.ts` — bounded same-origin crawler (root-path scoped, so a version-pinned URL cannot wander into another version), passage-level search, `black-ide.addDocs`/`manageDocs`, stack-based suggestions |
| M21 | Keyed web-search providers | P2 | E13 | 3 ✅ | Brave / Tavily / Google CSE with DDG as the no-key default; every failure degrades to DDG **and says so**, since a silently-unused key is invisible |
| M22 | Git-history semantic search + blame/why-changed | P2 | E20 | 3 ✅ | `search_history`, `blame`, `why_was_this_changed`; shells out to git rather than indexing — see the delivery note |
| M23 | Per-role models (chat/plan/edit/apply/autocomplete/embed/rerank) | P0 | E10 | 4 ✅ | `core/model-router.ts`; five ad-hoc `selectedModelId` reads replaced by role resolution, with the legacy `autocompleteModelId` still honoured |
| M24 | Cross-provider failover / health-aware routing | P1 | E10 | 4 ✅ | per-provider circuit breaker; failover at the *turn* so a run keeps its context, a different provider tried before another of the same one, and **never after output has streamed** |
| M25 | Fast-apply path | P1 | E10 | 4 ✅ | `edit_file`'s `intent` → apply-role model → verified with the real applier; malformed, missing-anchor, ambiguous, no-change and oversized results all escalate to the strong model |
| M26 | Provider breadth (6 → ~18) | P2 | E26 | 4 ✅ | **6 → 16.** DeepSeek, Groq, Mistral, xAI, Together, Fireworks, Cerebras, LiteLLM, vLLM, Azure OpenAI. Bedrock/Vertex deliberately not shipped — request signing, not config |
| M27 | Zero-config first run (local model, no key) | P2 | E26 | 4 ✅ | probes Ollama / LM Studio / llama.cpp on a short timeout and **offers** what it finds; never auto-enables |
| M28 | Next-edit prediction (multi-file, edit-history, jump-to) | P0 | E1 | 5 ✅ | coalescing edit-history ring buffer + M15 graph neighbourhood → a SEARCH/REPLACE-anchored prediction, verified against the live file and discarded if any document moved; cross-file is a first-class outcome via a jump affordance, not a special case |
| M29 | Terminal `Cmd+K` | P2 | E25 | 5 ✅ | `core/terminal-command.ts` — single-line by construction (an embedded newline in `sendText` executes), judged by the same `CommandPolicy` as the agent, mandatory preview, inserted with `shouldExecute: false` **always** |
| M30 | Automatic rolling summarization (beyond manual `/compact`) | P2 | E11 | 5 ✅ | threshold-triggered fold of the older middle into prose, layered *above* `ContextManager.fit` rather than replacing it; refuses outright while an approval is open, and `/compact` — a suggestion that did nothing since Phase 2 — now runs the same path |
| M31 | Independent parallel task agents (non-pipeline) in Manager | P1 | E3 | 6 ✅ | `TaskAgentRegistry` + `task-agent-entry.ts`; the executor is rooted in the agent's **worktree**, so isolation is structural rather than promised. Four concurrent agents, four worktrees, kill-one asserted |
| M32 | Per-agent model assignment for task agents | P1 | E3 | 6 ✅ | each agent carries its own `modelId` and mode into its run, resolved through the Phase 4 router with failover |
| M33 | Global concurrency + token governor | P1 | E3 | 6 ✅ | `core/agent-governor.ts` — **one** governor across both lanes; admission is a reservation, not a boolean, so two launches in one tick cannot both win a last slot |
| M34 | Agent inbox + notifications for blocked runs | P1 | E28 | 6 ✅ | `core/agent-inbox.ts` — blocked / parked / failed / **review**, badge counts, notified once per (item, reason); polled at 3 s against a 5 s gate |
| M35 | Parallel wave execution graduated or removed | P1 | E18 | 6 ✅ | **removed.** Unverified for six phases, and the role E18 reserved for it is now filled by the task-agent lane, where the isolation is asserted. Deletion asserted rather than assumed — including the stale compiled artifact |
| M36 | Multi-root / multi-workspace correctness | P1 | E30 | 6 ✅ | `core/workspace-roots.ts` (longest-prefix attribution, boundary-aware) + `core/project-profile-cache.ts` (per-root profiles); worktree ops take the root they act on |
| M37 | Multi-model race (N models, compare, pick) | P2 | E27 | 6 ✅ | `core/model-race.ts` — lexicographic ranking (a failing candidate never outranks a passing one), capped field, refuses to name a winner without evidence. **Closed by Phase 7 (M40)**: each candidate now carries a real verification result, so the ranking uses test evidence as designed |
| M38 | Typed artifacts + review panel | P1 | E4 | 7 ✅ | `core/artifacts.ts` + `agent/artifact-store.ts` — seven types incl. binary, run association, comments, and an index that **rebuilds from filenames** when lost. Panel delivered 2026-08-04: `core/artifact-review.ts` + a third Manager tab, browsing by run and by type, screenshots rendered through a webview URI scoped to the artifact directory alone. A comment is **persisted first and steered second**, and the panel says which happened — a review surface whose comments silently go nowhere is one nobody trusts twice |
| M39 | Mid-run steering (comment-on-artifact → inject) | P1 | E4 | 7 ✅ | `core/steering.ts` + a drain at the top of every loop turn; a per-agent queue so a correction meant for one of four runs cannot reach the other three. Never lands between a `tool_use` and its `tool_result`, never produces two consecutive user turns |
| M40 | Verification loop with evidence (tests + screenshots + recordings) | P1 | E5 | 7 ✅ | `core/verification.ts` + `agent/verify-runner.ts` — four outcomes (an unrunnable suite is **not** a pass), one bounded self-correction, a `test-report` artifact on every path. Wired into the pipeline and chat lanes 2026-08-03; visual capture 2026-08-04 (`core/visual-capture.ts` + `agent/visual-capture.ts`) — a configured preview URL is used alone rather than falling back to a guessed port, the allowlist is honoured, and a failed capture leaves the run `incomplete` **with the reason**, not silently upgraded |
| M41 | Automatic memory extraction | P1 | E7 | 8 🟡 | `sortCandidates` — three bands (auto ≥0.8 / confirm ≥0.5 / drop) plus a content filter that rejects transcript narration, task restatements and questions. **Partial:** the extractor that *produces* candidates from a turn needs a model call and is not wired |
| M42 | Contradiction detection on memory write | P2 | E7 | 8 ✅ | similarity **and** conflict, because either alone is useless; `decideWrite` returns `ask` and `supersede` archives rather than deletes. Lexical rather than embedding-based **by decision** — a memory write that can fail on a rate limit is one that silently does not happen |
| M43 | Memory decay / archive | P2 | E7 | 8 ✅ | demote → archive, never hard-delete; high-confidence and used entries exempt. The stage is a function of elapsed time, not of how often the job ran |
| M44 | Idle consolidation job | P2 | E7 | 8 ✅ | merges near-duplicates by normalised identity; **idempotent and order-independent**, which is what the gate asks and what a max/sum/min merge rule buys |
| M45 | Memory visualization UI | P3 | E7 | 8 ❌ | not started. The data it would render — entries, confidence, provenance, status — all exists |
| M46 | Mindmap read-back by agents | P1 | E7 | 8 ✅ | `core/mindmap-readback.ts`, injected as its own budgeted prompt section; auto-sync blocks excluded so the agent does not re-read its own history |
| M47 | Reviewer agent on the working diff | P1 | E8 | 9 ❌ | not started |
| M48 | Opt-in PR review via `gh` | P2 | E8 | 9 ❌ | not started |
| M49 | MCP streamable HTTP + SSE + OAuth | P1 | E12 | 9 ❌ | not started |
| M50 | MCP resources & prompts primitives | P2 | E12 | 9 ❌ | not started |
| M51 | MCP in pipeline runs via vetted allowlist | P2 | E12 | 9 ❌ | not started |
| M52 | Tool circuit breakers | P1 | E15 | 9 ✅ | `core/tool-breaker.ts` — per tool and per *run*, consecutive failures plus a latency budget; a tripped tool is removed from the advertised list **and** refused at the executor |
| M53 | Append-only audit trail per run | P1 | E15 | 9 ✅ | `core/audit-trail.ts` — JSONL in the user's repo, monotonic sequence, no update method by construction, tolerant of the truncated final line a host crash leaves |
| M54 | Secret redaction into prompts and logs | **P0** | E15 | 9 ✅ | `core/redaction.ts` — 13 vendor-shape detectors always on, entropy gated behind a token-shape check. Half its tests assert what it must **not** redact |
| M55 | Central workspace-boundary guard | P1 | E15 | 9 ✅ | `core/workspace-guard.ts` — traversal, prefix collision and symlinks, plus `.git` (writing `core.fsmonitor` escapes the command policy entirely). Replaces the `test_sandbox_*.js` scripts, which asserted nothing and were run by nothing |
| M56 | Untrusted-content posture + injection fixtures | **P0** | E15 | 9 ✅ | posture in the system prompt, source-labelled fencing, and six fixtures that assert the *capability gates are unmoved* — the detector reports and deliberately does not block |
| M57 | Sandboxed execution tiers (restricted / contained) | P1 | E23 | 9 ❌ | not started |
| M58 | Optional at-rest encryption for `.blackIDE/` | P3 | E15 | 9 ❌ | not started |
| M59 | Skill library Wave 2 (16 → full catalog) | P1 | E9 | 10 ✅ | **16 → 47.** Frameworks, testing and the cross-cutting packs, each with ≥1 golden task; the eval corpus grew 74 → 112 tasks and 13 → 21 fixtures to hold that property |
| M60 | Skill/rule registry + `addSkillFrom` + checksums | P2 | E9 | 10 ✅ | `core/skill-registry.ts` — pinned refs (a moving ref is **refused**, since it makes the checksum meaningless), SHA-256 verification before content is examined, and a forbidden-key deny list so a pack cannot declare `tools`/`autoApprove`/`policy`. `tools/skill-fetch.ts` + the command wired 2026-08-03, with an https-only transport check that runs **before** git sees the URL — `ext::` executes a shell command, and no checksum undoes code that already ran |
| M61 | Notebook (`.ipynb`) read/edit/checkpoint | P2 | E21 | 10 ✅ | `core/notebook.ts` — byte-stable round-trip, per-cell edit preserving the `source` array shape Jupyter writes, outputs excluded from prompts by default, cell-granular snapshot/restore. `read_notebook`/`edit_notebook_cell` registered 2026-08-03 across twelve mode allowlists — and `read_file`/`edit_file` now **refuse** a `.ipynb`, which is where the real defect was |
| M62 | `@blackide/agent-core` extracted (zero `vscode` imports) | P1 | E14 | 11 🟡 | boundary declared (`src/agent-core/index.ts`) and **transitively enforced** by `__tests__/agent-core-boundary.test.ts`; four dependency edges cut to make it hold. **Partial:** the modules are named, not yet physically moved into a package |
| M63 | Headless CLI | P1 | E14 | 11 ✅ | `agent-core/cli.ts` + `agent-core/node-host.ts` — argument parsing, a JSON-per-line stdout protocol, human output on stderr, and six distinct CI exit codes. `agent-core/host-executor.ts` (the second implementation of the executor shape, on `AgentHost`) + `headless-run.ts` + `bin/blackide` 2026-08-03; a fixture-repo run branches, commits and verifies, and `--output pr` that cannot push exits 1 rather than 0 |
| M64 | SDK entry point | P2 | E14 | 11 ✅ | the barrel *is* the SDK surface: `AgentHost` plus the loop, router, retrieval, memory and safety exports, with `silentNotifier`/`denyingApproval` baselines for embedding |
| M65 | Background (local daemon) agents | P2 | E14 | 11 ❌ | not started |
| M66 | Remote/cloud agent execution | P3 | E14 | 12 ❌ | not started; unblocked by Phase 11's host seam but depends on the runner that phase did not finish |
| M67 | Issue-tracker context + task sources (Issues/Linear/Jira) | P2 | E33 | 12 🟡 | `core/task-sources.ts` — reference parsing that **refuses to guess** a tracker from a bare key, plus the outbound model. **Partial:** the per-tracker fetchers are not wired |
| M68 | Slack / chat completion notifications | P3 | E33 | 12 🟡 | notices are rendered for the **inbox**, which is local; forwarding onward is an outbound action like any other and goes through the confirmation gate. **Partial:** no Slack transport |
| M69 | Self-hosted team analytics + tightening-only org policy | P2 | E32 | 12 ✅ | `core/org-policy.ts` (tighten-only, asserted as a **capability-score** property over the whole structure, not field by field) + `core/egress.ts` (no default endpoint anywhere in the source; an allowlist projection that sends counts, never content) |
| M70 | Domain verticals (firmware, modernization pipeline template) | P3 | E17 | 12 ❌ | not started. E17 says "ship only if a real user pulls for it" — no such pull |
| M71 | Voice input | P3 | E31 | 12 ❌ | not started; "genuinely low value for us, scheduled last" |

**Counts:** 71 gaps — **P0: 13 · P1: 30 · P2: 22 · P3: 6**. All 71 are scheduled.

*(Corrected in rev 5: this line read "P0: 11 · P2: 23 · P3: 7" from rev 1 onward. Counting the
table's own Pri column gives 13/30/22/6 — M28, M54 and M56 are P0 and were never included in the
P0 tally, which is why the rev-4 text claimed "3 P0 items outstanding" while listing only M14, M15
and M23.)*

**Delivered so far (Phases 0–12; 1, 9, 11 and 12 partial): 59 of 71 — 55 complete, four partial**
(2026-08-04; M38/M40 closed with Phase 7, M60/M61/M63 with Phase 10 and the CLI). The four
milestones carried as partial in rev 5 (M3, M10, M17, M19) are closed, M20–M27 landed with them, and
M28–M30 closed Phase 5.

That clears **all 13 P0 items.** M54 and M56 — the last two — closed with Phase 9's security spine. M28, the P0 rev 6 named as outstanding, closed with Phase 5;
it depended on Phase 3's graph for its neighbourhood and Phase 4's `autocomplete` role for its model,
which is why it could not have gone earlier.

What is left in the started phases is **two rows of the table at the top, and they are the same
blocker twice**: the opt-in model tier (§4.6) that Phase 1's LSP-over-grep gate and four of §4.2's
metric rows both need — now five, since M28's latency and acceptance-ratio clauses need it too.
Nothing in phases 0–5 is waiting on effort or sequencing.

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

> ### ✅ M10 completed 2026-08-01 — tool toggles, and the phase closes
> `core/tool-toggles.ts` (pure: `applyToggle`, `applyToolToggles`, `advertisedTools`,
> `toolPanelEntries`, `isDeniedByUser`) · `ChatSession.disabledTools` · a third gate in
> `agent/tool-executor.ts` · `toggleTool` / `requestTools` / `toolTogglesChanged` /
> `toolsAvailable` across `webview-message-handler.ts` and `App.tsx` · a Tools section in
> the session panel. **Phase 2 is now ✅.** vitest **412/412 / 24 suites** at the time of
> the cut · harness 426/426 · `tsc -b` clean · webview builds · eval green.
>
> **The toggle is enforced, not advertised — which is the whole point.** The obvious
> implementation removes the tool from the advertised list and stops there. Phase 2 already
> paid for that mistake once: per-mode allowlists were advertising-only, so a mode whose
> prompt forbade writing would still have *executed* a `write_file` the model emitted anyway
> (the B4 finding). Switching off `run_command` is a safety decision, so it rides the same
> executor gate. Both halves are kept and neither is redundant: unadvertising stops the model
> wasting a turn on a call that will be refused, and the gate is what makes the switch true
> when the model calls a tool it saw two turns ago — which models do.
>
> **Three decisions worth recording.**
> - **`complete_task` cannot be switched off.** It is how the loop terminates; disabling it
>   does not make the agent safer, it makes it unable to stop — it would run to the iteration
>   cap and report a failure, which reads as a broken agent rather than as the consequence of
>   a switch the user flipped. A toggle that can wedge the thing it controls is a defect.
> - **A subagent inherits the session's toggles.** Otherwise `spawn_subagent` is a one-line
>   bypass for every switch the user set — the same hole the mode-propagation comment in
>   `chat-task.ts` warns about, and `deniedTools` rides through `baseDeps` for exactly this.
> - **The refusal names the user, not the mode.** To a model "not available in this mode"
>   invites trying a different route; "the user switched this off" is a fact about the world
>   that it should report instead of routing around.
>
> **The panel is built from the turn's own advertised list, not from `BASE_TOOLS`.** Offering a
> switch for a tool the acting mode never had would do nothing when flipped off and appear to
> grant a forbidden capability when flipped on. `advertisedTools()` is now the single
> construction of "what this mode offers", shared by the panel and `chat-task.ts` and asserted
> to be shared — the same drift `rules-panel-fidelity.test.ts` prevents on the rules side.
> A separate `deniedTools` field carries the toggles rather than folding them into
> `allowedTools`, whose empty case already means "this mode declares no restriction": merging
> them would have made an empty toggle list indistinguishable from an empty allowlist and
> silently turned every mode into an allowlisted one.

> ### ✅ M3 completed 2026-08-01 — eval breadth, and it paid for itself immediately
> `eval/tasks.js` **19 → 74 tasks**, `eval/fixtures.js` **8 → 13 fixtures** (NestJS, Flask,
> Rails, Angular, React Native), plus `forbidSkills` and a **wrong-idiom metric** in
> `eval/run-eval.js` and `__tests__/eval-task-coverage.test.ts` (8 structural guards).
> Phase 0's "8–10 tasks × 6 stacks" is met and asserted. Baseline re-recorded: 74 tasks over
> 13 fixtures · stack detection **100% (13/13)** · exact-match **100%** of 57 coverable ·
> wrong-idiom **0%** of 33 guarded tasks · 16 known library gaps.
>
> **A raw task count is the weaker completion test, so it is not the one asserted.** Two
> properties are: **every bundled pack is named by at least one task** — `flask`, `rails`,
> `angular` and `react-native` shipped with *no* eval coverage and could have been broken by
> a resolver change silently — and **every role the resolver understands appears**, including
> `architect` and `devops`, which is how the library's real shape becomes visible: we bundle
> nothing for either.
>
> **Three defects, all invisible at 19 tasks.** This is the argument for the row, and none of
> them was found by reading code.
> - **F3 — wrong-framework injection.** A NestJS repo asked for a users controller resolved
>   to **express + aspnet-core + nextjs + react + angular**: five packs, all wrong, three not
>   even the right language. Flask got django and fastapi; a React Native screen got Next.js
>   App Router idioms *ranked first*. Mechanism: packs list the language beside the framework
>   (`express` declares `[express, nodejs, javascript, typescript]`), so on any TypeScript repo
>   they matched at language strength and role affinity carried them over the threshold. F1
>   closed "role alone is not evidence"; this closes "the language alone is not evidence when
>   the pack names a framework the repo does not use". A pack named after a
>   *mutually-exclusive* framework token now needs that framework detected —
>   `FRAMEWORK_IDENTITY_TOKENS` in `core/project-profiler.ts`, with test runners, additive
>   libraries and infrastructure deliberately excluded because they co-exist rather than
>   compete.
> - **F3 second half — a generic word is not an identity claim.** The prompt-mention
>   exemption ("how would I do this in Flask?" inside a Django repo is a real request) was too
>   weak as a plain trigger hit: `aspnet-core` lists `controller`, so *Nest and Rails* prompts
>   claimed an ASP.NET identity; `react` lists `component`, so an Angular component task
>   pulled in React; `rails` lists `migration`, which Django and EF Core also call a
>   migration. An identity claim now requires the pack's own name or a punctuated/multi-word
>   trigger (`asp.net`, `app router`) — a shape a generic English noun never has.
> - **F3b — quoted commas were split, and short triggers matched inside words.**
>   `triggers: [express, "app.use", middleware, "req, res", router]` parsed to *six* triggers
>   including the bare token **`res`**, which as a substring fires on "**Res**tyle",
>   "**res**ource", "add**res**s". The Express pack was therefore a candidate on almost any
>   English prompt in any language's repo. Both halves are fixed — a quote-aware splitter, and
>   word-boundary matching for bare-word triggers while code fragments (`app.use`,
>   `describe(`, `def test_`) keep substring semantics. Utterly silent: a corrupted trigger
>   list is still a valid trigger list.
>
> **And one piece of F1 that survived its own fix.** `score += priority * 0.1` looked like a
> tie-break and was not one — it survives the `score > 0` filter unaided, so a pack matched
> only on the repo's language and scoped to another role came back with 0.8 points. That is
> how a NestJS *backend* task ended up with the Jest pack as its only skill. Priority now
> orders equal-evidence packs as the second sort key, where a tie-break belongs, and the
> role-mismatch penalty is set to exactly `W_LANGUAGE` so language-only-plus-wrong-role nets
> to zero while a *framework* match still survives a role mismatch — Django idioms genuinely
> help a Testing agent writing Django tests.
>
> **The wrong-idiom metric is now real, and deterministic.** §4.2 listed it as "record". 33 of
> the 74 tasks name packs that must not fire, every entry a leak that was real on 2026-08-01,
> and it is guarded as a **ceiling** rather than a floor, because
> guarding a failure count with the same comparator as a quality score would make a new leak
> read as an improvement. The model-behaviour half of the metric — does the agent then *write*
> raw SQL where the ORM is idiomatic — still needs the model tier (§4.6).

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
nothing; **asserted 2026-08-01 at 1 247 ms**, `__tests__/index-build-budget.test.ts`)*. The packaged-build smoke test for native grammars **no longer applies**: M14 ships a
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
> rather than the escape `'\\0'`. The code was correct — NUL cannot occur in a diagnostic message,
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

> ### ✅ M19 completed 2026-08-01 — `@symbol`, and the build budget finally measured
> **`@symbol`** ships: `CodeGraph.searchSymbols()` + `SymbolProvider` in
> `core/context-providers.ts`, registered in `context-provider-setup.ts`, reading the M15
> graph through a getter off `CodebaseIndex`. Nine providers now. `@docs` and `@web` are
> M20/M21 and tracked there, so **M19 is ✅ on its own scope**.
> `__tests__/symbol-provider.test.ts` — 13 tests, the substantive ones against a real index
> over the 82-file corpus rather than a toy graph.
>
> **It is small because M15 landed first**, which was the sequencing bet: the graph already
> knows every symbol's file and line span, so this is a lookup and a ranged read, not a parse.
>
> **What it contributes over `@file` is the reason to have it.** The definition's *own* lines
> instead of a whole file the budget would truncate, **plus who references it** — "change this
> function" and "change this function and its callers" are different tasks and only the second
> is answerable without a follow-up turn. The reference list is bounded at 30 with the bound
> stated, and it says it is name-matched rather than binding-resolved, pointing at
> `find_references` as authoritative: M15 is name-keyed by design and over-approximates, and a
> model handed an over-approximation without being told treats it as resolved truth.
>
> **Cold-graph wording is a correctness detail, not politeness.** The index builds on the first
> agent turn, so a mention resolved during activation has no graph. "The code index is not
> built yet" and "no definition of X is in the index" have completely different fixes and look
> identical to a model — the same distinction M16's output draws. The item id carries
> `name|file|startLine`, so resolution cannot silently land on a *different* same-named symbol
> than the one the user picked from the dropdown.
>
> ### ✅ Index-build budget asserted 2026-08-01 — 1 247 ms / 5 000 files against a ≤2 s gate
> `__tests__/index-build-budget.test.ts` generates 5 000 files across the seven languages the
> chunker handles, in nested packages, and measures a cold full build: **5 000 files → 24 287
> chunks in 1 247 ms**, with a warm rebuild reusing all 5 000 in **444 ms**. The gate M14
> restated but could not prove is now proven, and the graph is asserted to be built over the
> same files so the figure covers M14 *and* M15 rather than half the cost.
>
> **Two things the test states rather than implies.** The corpus is generated, not vendored:
> the gate is throughput per file, and a 5 000-file real repo would add tens of megabytes to
> measure the same number — but the files are shaped like real ones (imports, nested symbols,
> doc comments, bodies of a dozen-plus lines), because a corpus of one-line files would flatter
> the budget by skipping the work being measured. And **embeddings are excluded**: `build()`
> fetches them sequentially per chunk, so with a provider configured the wall clock measures a
> network round trip 20 000 times over. That exclusion is written at the top of the file, so a
> future reader comparing this against a real embedded build does not read it as a regression.
> ### ✅ M17 completed 2026-08-01 — the cross-encoder, once the role existed
> `ModelReranker` + `LLMRerankScorer` (`core/rerank-setup.ts`). Assigned to `index.reranker` per
> turn, and **only when the user has pointed the `rerank` role at a model** — the router's role
> fallback is deliberately bypassed here, because falling back to the chat model would spend a
> request against the user's strongest model on every `codebase_search`, having never been asked to.
>
> **It scores the whole candidate set in one call, not one call per candidate.** A true cross-encoder
> pass is N requests; at `RERANK_DEPTH` = 20 that is 20 round trips inside a search the agent is
> blocked on. Numbered snippets in one prompt get the same ordering signal at a twentieth of the
> latency, and that trade is what makes the feature usable rather than theoretical.
>
> **M17's own finding is what constrains it.** A reranker given free rein made retrieval *worse* —
> the first draft let a rank-40 chunk with every query word overtake a rank-1 chunk with most of
> them and cost 8 points of recall@5. So the model's judgement enters as a weighted signal beside
> the first-stage prior rather than replacing it: it can move a candidate several places and cannot
> lift the 20th over the 1st alone.
>
> **Every failure is a downgrade, never an error.** This is the component most likely to fail in
> normal use — it needs a key, a network, and parseable output. A throw, a timeout, an unparseable
> response, or a score array of the wrong length all fall back to the lexical ranking with a warning.
> A wrong-length array is treated as a *broken scorer* rather than a partial result, because
> zero-filling would rank real candidates below whatever the model did answer for.

> ### ✅ M20 delivered 2026-08-01 — `@docs`, crawled and searched locally
> `core/docs-index.ts` (crawler, text extraction, `DocsStore`, passage search, stack suggestions) ·
> `DocsProvider` · `black-ide.addDocs` / `black-ide.manageDocs` · 35 tests in
> `__tests__/docs-index.test.ts`.
>
> **Deviation from E13, with a reason.** The plan says to index docs into E2's store. That store is
> built by walking the *workspace*, keys chunks by workspace-relative path, and invalidates on file
> mtime; docs have no workspace path, no meaningful mtime, and a different invalidation story (a site
> is re-crawled on demand). Bending one index around both lifecycles risks the failure that matters
> most here — a stale doc page presented as project source. What *is* shared is the part that affects
> ranking quality: `core/text-tokens.ts`, so a query tokenises identically against code and docs.
>
> **The crawl is bounded, same-origin, and scoped to the root *path* — and that last one is the
> feature, not politeness.** Pointing `@docs` at `docs.djangoproject.com/en/5.0/` must not follow the
> version switcher into `/en/4.2/`, because answering a version question from the wrong version is
> precisely the failure this milestone exists to prevent. BFS rather than DFS for the same reason a
> page cap needs to be spent well: with 60 pages of budget, breadth-first spends them on the overview
> and the top-level guides, where depth-first would spend all 60 inside the first subsection it
> entered.
>
> **Search returns passages, not pages.** A docs page is thousands of words and handing the model all
> of them spends the budget on the 95% that is irrelevant. Pages are split into ~700-character
> windows, scored on distinct-term coverage first (M17's finding, applied again), and the best hits
> are taken **one per page before any page's second** — the same rule M14 had to learn for chunk
> selection, for the same reason.
>
> **A defect the tests caught, and its shape is worth recording.** The link extractor excluded `#`
> from the href pattern, intending to drop fragments. It does not drop the fragment — it drops the
> *whole link*, so every page that a docs site only ever links to with an anchor
> (`ref/models.html#field-options`, which is most of them) was invisible to the crawl. A crawl that
> silently finds fewer pages looks like a site with fewer pages.
>
> **Crawling is user-initiated, always.** The profiler *suggests* doc sets for the detected stack;
> the user confirms. A network fetch triggered by opening a project would be a surprise, and a
> surprise involving egress is exactly the kind G4 commits us not to spring. Doc sets are stored in
> extension storage rather than the user's repo — a crawl is a cache of somebody else's content, and
> committing 60 pages of Django docs into a project is both surprising and a licensing question we
> have no business creating.

> ### ✅ M21 delivered 2026-08-01 — keyed search providers
> `tools/search-providers.ts` (Brave, Tavily, Google CSE + selection) · `WebSearchTool.searchWith`
> with DDG as the default and the fallback · `WebProvider` for `@web` · settings UI for the keys ·
> 16 tests.
>
> **DuckDuckGo stays the default and the fallback**, and every keyed path degrades to it: no key, an
> expired key, a rate limit, a timeout, a network failure. Search is a *supporting* capability —
> losing it mid-task should cost result quality, never the task.
>
> **The degradation is named in the output, and that is the part that matters.** "My Brave key is
> configured and every result is coming from DuckDuckGo" is otherwise invisible, so
> `formatResults` always states which backend answered and a fallback says why it happened.
>
> **`auto` ranks by output quality, not by settings order.** Tavily first because it returns
> extracted page content — the difference between "here are some links" and "here is the answer" —
> then Brave, then Google CSE. A key that is present but *unusable* (a Google key with no engine id)
> is skipped rather than tried, because that request fails with something indistinguishable from a
> bad key. And an explicitly-chosen provider with no key falls to DDG rather than quietly using a
> different key the user happens to have configured, which would contradict the setting they just
> changed.
>
> **`@web` does not search per keystroke.** `suggest` runs on every character typed; a search there
> would be slow and rude to the provider. The query itself is offered as the item and the search
> happens once, at resolve time, when the message is actually sent.

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

> ### ✅ Delivered 2026-08-01 — all five milestones
> `core/model-router.ts` (roles, chain, `ProviderHealth`, `runWithFailover`) ·
> `core/model-router-loader.ts` · `core/providers.ts` (16 presets, auth + endpoint shapes) ·
> `core/local-models.ts` · `core/fast-apply.ts` + `fast-apply-setup.ts` · failover in
> `agent/agent-loop.ts` and `agent/pipeline-orchestrator.ts` · role and search settings in the panel.
> vitest **582/582 / 32 suites** · harness 426/426 · eval green · webview builds · `tsc -b` clean.
>
> **M23 — the router.** A "model" used to mean `settings.selectedModelId`, read directly at five call
> sites. The one exception — `inline-completion.ts` preferring `autocompleteModelId` — was the shape
> of this whole feature, discovered one call site at a time. Roles are now named and resolved in one
> place, and the five call sites ask for a role. Precedence is deliberate: an explicit override (the
> chat dropdown, a Manager run's model) beats a standing role mapping, because it is a decision about
> *this* turn; getting that backwards would make the model dropdown appear not to work. The legacy
> `autocompleteModelId` is still honoured — a config that quietly stops being applied is worse than
> one that errors.
>
> **`apply` and `rerank` deliberately do *not* fall back to the chat model.** Every other role falls
> back, which is right for `plan` or `edit`. For these two it would be actively worse than not having
> the feature: fast-apply on the strong model costs the strong model *plus* an extra round trip, and a
> rerank fallback would spend a request against the user's most expensive model on every
> `codebase_search` without being asked. Both features stay off until a model is named for the role.
>
> **M24 — failover, wired at the *turn*.** A run is minutes long and holds accumulated context, so
> retrying the whole run because turn four got a 529 throws away everything the first three did. Three
> decisions carry the correctness:
> - **Never fail over after output has streamed.** If the primary streamed 400 tokens and then died,
>   retrying elsewhere appends a second answer to the first half of one — the user sees two
>   overlapping replies and the transcript is unusable. A mid-stream failure surfaces as an error, with
>   the partial text still on screen.
> - **A different provider comes before another model from the same one.** When Anthropic returns 529,
>   a second Anthropic model is behind the same outage; an OpenAI model is not. That ordering is what
>   makes the second attempt likely to succeed rather than merely being a second attempt.
> - **The run *stays* on whatever answered.** Putting the user's original choice back at the head of
>   the chain would re-attempt a provider we just watched fail, once per turn, for the rest of the run.
>
> Two smaller ones worth recording: an **abort is never retried** (it is the user's decision, and it
> must not count against the provider's breaker), and the breaker counts *consecutive* failures with
> any success resetting it — a provider failing one request in ten is having a bad day, not an outage,
> and a cumulative count would eventually disable every provider a long session touched. When every
> breaker is open the chain is tried anyway, because refusing to call turns a transient outage into a
> hard stop only time can clear.
>
> **Failover also covers the pipeline, and matters more there.** An unattended seven-phase run used to
> die outright when the provider failed in phase five, discarding four phases of completed work.
>
> **A window-size bug found while wiring it:** failing over from a 200k-context model to an 8k local
> one kept the original token budget, so the *next* turn would overflow the window and look like a
> model failure rather than a routing consequence. The loop now rebuilds its `ContextManager` for the
> substituted model when it owns one.
>
> **M25 — fast-apply, and the only property that matters is failing closed.** A path that is 99%
> correct is worse than none: the 1% is a silently wrong edit in a file the user did not read. So
> `edit_file` gained an `intent` parameter, the apply-role model materialises the blocks, and they are
> verified **with the real applier** — a second implementation of the matching rules would be a second
> set of rules. Malformed blocks, a missing anchor, an ambiguous anchor, an edit that changes nothing,
> and an edit that rewrites most of the file are all refused.
>
> The last of those is the one exact-match verification cannot catch on its own: a cheap model asked
> for a small change sometimes returns the *whole file* as one block, which applies cleanly and
> verifies cleanly — its copy genuinely matches — and quietly reformats everything. A churn bound
> catches it.
>
> **The escalation path is the error return, which is why there is no fallback machinery.** This tool
> is called by the strong model, so "fast apply could not do it exactly — send me the blocks yourself"
> lands in exactly the right place, with the reason, at a cost of one turn. And `intent` is a
> *parameter* rather than a new tool because a new tool name would have to be added to thirteen mode
> allowlists, and the Phase 1 trap is that a tool missing from one is silently never offered.
>
> **M26 — 6 providers to 16, and most of it is data.** That is the finding, not a shortcut: DeepSeek,
> Groq, Mistral, xAI, Together, Fireworks, Cerebras, LiteLLM and vLLM all speak OpenAI's
> `/chat/completions`, so what was missing was a base URL and a name. Writing nine adapters would have
> been nine places for the streaming and tool-call parsing to drift. They are distinct `type` values
> rather than "openai with a custom URL" so the settings UI can offer a working endpoint and the
> router can treat "a different provider" as a real failover target.
>
> Azure is the exception and needed real work: `api-key` instead of `Authorization: Bearer`, and a URL
> built from resource + deployment + api-version. Sending a bearer token to Azure fails with a 401
> that reads exactly like a bad key. **Bedrock and Vertex are deliberately not shipped** — SigV4
> signing and a Google OAuth exchange are auth implementations, not base URLs, and a half-working
> entry would accept the user's key and fail every call. Recorded as scope, not as done.
>
> **M27 — zero-config, local-first.** A fresh install with no key used to throw "No LLM
> configurations found", which is a dead end for exactly the user §4.5 says we serve (no hosted free
> tier, ever). It now probes Ollama, LM Studio and llama.cpp on a **1.2 s** timeout and **offers** what
> it finds. Three details are the whole feature: it is offered, never auto-enabled (silently routing
> prompts to a local server the user forgot was running is a surprise even though nothing leaves the
> machine); a runtime that is up with **no models pulled** is ignored, because a config that cannot
> answer reads as the editor being broken; and a detected model is typed `local` rather than
> OpenAI-compatible, because local models vary wildly in tool-call reliability and the text-JSON
> protocol works on all of them.
>
> **A gate the roadmap set and the code caught.** Wiring the `@docs`/`@web` provider functions inline
> took `extension.ts` from 652 to **704 lines**, past the ≤700 gate that three revisions discuss and
> *nothing enforced*. It was caught by reading a line count by hand — the wrong mechanism, given the
> file reached 2537 lines the first time by growing a few lines per feature. The wiring moved into
> `core/context-provider-setup.ts` (671 lines now), and
> `__tests__/source-hygiene.test.ts` fails the build over 700.

### Phase 5 — Editor ergonomics
*Covers M28–M30. Depends on Phases 3 (graph) and 4 (autocomplete role).*

- `NextEditEngine`: rolling edit-history ring buffer + graph neighbourhood → **cross-file** next-edit
  prediction with a jump-to-next-edit affordance; hard latency budget; cancel-on-keystroke.
- Terminal `Cmd+K`: NL → shell command, policy-gated, mandatory preview, never auto-run.
- Automatic rolling summarization at context thresholds (keep `/compact` as the manual override).

**Gate:** next-edit p50 ≤250 ms on the fast role; ≥40% of accepted suggestions multi-line or
cross-file; zero completions emitted after the buffer changed; auto-summarization never drops a
pending approval or tool result.

> ### ✅ Delivered 2026-08-02 — all three milestones
> `core/edit-history.ts` · `core/next-edit.ts` · `core/next-edit-controller.ts` ·
> `core/edit-origin.ts` · `core/editor-features.ts` · `core/terminal-command.ts` ·
> `core/rolling-summary.ts` · `core/summarizer.ts` · `core/compact-session.ts` · summarizer seam in
> `agent/agent-loop.ts`, wired in `agent/chat-task.ts` · five commands and four keybindings.
> vitest **693/693 / 36 suites** (was 582/32) · harness 426/426 · eval green, no regression ·
> `tsc -b` clean · webview builds · `extension.ts` **693 LOC**.
>
> **Gate status.** Two of the four clauses are deterministic and asserted; two are ratios that need
> real model calls and are §4.6 rows, not phase work:
>
> | Gate clause | Status | Where |
> |---|---|---|
> | Zero completions emitted after the buffer changed | **met** | `__tests__/next-edit.test.ts` — five staleness cases, incl. the *target* file moving while the active one did not |
> | Auto-summarization never drops a pending approval or tool result | **met** | `__tests__/rolling-summary.test.ts` — the orphan-result invariant asserted at *every* recency window, not one |
> | next-edit p50 ≤250 ms on the fast role | **not asserted** | needs the model tier; the instrument exists (`NextEditStats`) |
> | ≥40% of accepted suggestions multi-line or cross-file | **not asserted** | same; `crossFile`/`multiLine` are computed and counted, so the number is producible the day the tier lands |
>
> **M28 — the prediction is a claim about a file, so it is checked against the file.** The design
> decision that carries the correctness is refusing JSON as the carrier. A prediction has to name a
> file, the text it replaces and the replacement; the payload is source code, so in JSON every
> newline, quote and backslash becomes an escaping decision the model must get right, and one bad
> escape turns a good prediction into a parse error. The SEARCH/REPLACE contract at `core/tools.ts:76`
> has no escaping, the models are already prompted with it here, and — the part that matters — it
> makes the anchor **verifiable**: a prediction whose ORIGINAL text is not in the file, or is in it
> twice, is detectably wrong before a human ever sees it. Seven refusal classes, all tested.
>
> **Why it is not an `InlineCompletionItemProvider`.** Ghost text renders where the cursor is, and
> the whole premise of next-edit is that the next change usually is not — two functions down, or in
> the file that imports this one. The stable API cannot render there, so the affordance is a jump:
> the status bar names the target, `Alt+]` goes to it, and the same key applies it once you are
> there. That is also what makes the cross-file case a first-class outcome rather than a special case
> bolted onto a same-file feature.
>
> **Tab was available and was not taken.** Cursor binds jump-to-next-edit to Tab and it is the better
> ergonomic. It is also one leaked context key away from a developer losing indentation and
> completion-accept in every editor, which is a worse failure than an unfamiliar shortcut is an
> inconvenience. `Alt+]` plus a status-bar item that says what is waiting; `__tests__/command-surface.test.ts`
> asserts the binding is gated on `blackIde.nextEditAvailable` and that it is *not* Tab.
>
> **Three defects found by building it, each by a test rather than by reading.**
> - **A churn bound that refused every small file.** The prediction validator inherited fast-apply's
>   percentage cap and tightened it to 25%. Renaming one call in a three-line module changes 33% of
>   it — so the bound rejected every edit to every small file, and small files are most of a repo.
>   Fixed by requiring *both* a large proportion and a large absolute change (>12 lines), because the
>   defect the bound exists to catch — a model returning the whole file as one block — is inherently
>   large. Found by the first test run of `validateProposal`.
> - **Deleted text was unrecoverable.** `onDidChangeTextDocument` fires *after* the document holds
>   the new text, and the change describes its range in pre-change coordinates — so by the time the
>   handler runs, the removed text is gone from the only place it lived. The first implementation
>   recorded `(12 characters replaced)`. That silently reduces the history to insertions only, which
>   makes the single most valuable entry it can hold — `- reserve` / `+ reserveStock` — invisible: a
>   rename is exactly the case where the half that was typed tells you nothing. Fixed with a bounded
>   shadow copy of each open document.
> - **A keychain read on the typing path.** Settings live in `SecretStorage`, which on macOS and
>   Windows is the OS keychain. Reading it once per idle pause is a round trip every 600 ms of typing,
>   all day, and it would not have shown up in a profile of this feature — it would have shown up in
>   the editor. Cached for 5 s.
>
> **And one cost bug that only shows up on somebody's bill.** `onDidChangeTextDocument` reports
> *that* a document changed and never *who* changed it — there is no API for it. So the agent writing
> eleven files during a run looks exactly like a developer typing, and next-edit would have fired a
> prediction after each one: eleven model calls guessing what the developer will do next, while the
> developer is watching an agent work. `core/edit-origin.ts` has the writer say so — a counter, not a
> boolean, because pipeline phases write concurrently and a boolean is cleared by whichever write
> finishes first, plus a short grace window because the change event arrives after the write returns.
> It uses `finally`, so a throwing write cannot leave the counter stuck above zero and silently
> disable the feature for the rest of the session.
>
> **M29 — the milestone is one sentence in the VS Code docs being narrower than it reads.**
> `Terminal.sendText(text, false)` suppresses **one trailing newline**; a newline *inside* `text` is
> an ordinary keypress. So a model that helpfully answers
>
> ```
> rm -rf build
> npm run build
> ```
>
> executes `rm -rf build` the instant it is inserted — no preview, no Enter, nothing to undo. Every
> path out of `terminal-command.ts` therefore returns a single line by construction, multi-line
> answers are chained explicitly and the chaining is *reported* in the preview rather than done
> quietly, and `isSafeToInsert` asserts it once more at the call site. Comment lines are dropped
> rather than chained, because a `#` inside an `&&` sequence comments out everything after it.
>
> The policy question is separate and answered separately: the generated command is judged by the
> **same `CommandPolicy` the agent's `run_command` uses**, because a natural-language shell that is
> more permissive than the agent is a hole straight through G1's deny list. `autoApprove` is passed
> `false` unconditionally whatever the user's setting says — that setting governs the agent running
> commands unattended, and reusing it here would mean auto-typing a destructive command into a
> terminal the user is looking at. An allow-listed `npm test` is still typed, never run.
>
> **M30 — summarization sits above `fit`, not in place of it.** `ContextManager.fit` already bounds
> the window by dropping the oldest turns and folding a bullet list into the task. That is the right
> *floor* — deterministic, free, cannot fail — and it is what still holds the window when the
> summarizer's provider is down. What it cannot do is keep the reasoning: twelve turns in, the agent
> knows it read a file and not what it concluded. So summarization runs first, at a threshold rather
> than at the ceiling, and the two compose — with the summarizer absent or declining, behaviour is
> exactly what it was before this phase.
>
> The gate is three structural rules rather than three runtime checks. **A pending approval stops
> summarization entirely**, because the plan a user is about to approve is live state and a summary
> of it is not something they can approve. **The kept window never begins with tool results**, since
> a `tool_result` whose `tool_use` was folded away is not degraded context but a hard provider
> rejection — the run dies at the next request. **An unresolved tool call is never folded**, because
> the results it is waiting for are about to arrive. `/compact` runs the identical path with only the
> *threshold* removed: a manual override overrides the policy, never the correctness rules.
>
> **`/compact` had been in the UI since Phase 2 and did nothing.** It was in the webview's slash
> suggestions and `planning-engine.ts` knew to skip planning for it — and no code ever handled it, so
> typing it sent the literal string `/compact` to the model as a task. That is why the phase wording
> is "*keep* `/compact` as the manual override": the thing being kept did not exist.
>
> **A second gate the code caught, in the same phase, for the same reason.** Wiring next-edit into
> `activate()` took `extension.ts` from 693 to **705 lines**, past the ≤700 gate — this time caught by
> the test Phase 4 added rather than by hand, which is the entire point of having added it. The editor
> surface moved to `core/editor-features.ts` and the file is back to **693**.
>
> **A dead method found by becoming its second caller.** `CommandHost.detectedStacks` has been
> declared optional and never implemented since Phase 3, so `black-ide.addDocs` has always called it,
> always received `undefined`, and always offered zero suggestions — M20's "stack-based doc
> suggestions" was wired to a method nobody wrote, and it type-checked because the member is optional.
> Terminal Cmd+K wanting the same stacks is what surfaced it. Implemented (three lines); M20's
> suggestions work for the first time.
>
> **Not run in this environment:** the real-host integration tier. `@vscode/test-electron` downloaded
> VS Code 1.131.0 and failed to launch it — it spawns `Contents/MacOS/Electron` and that build ships
> `Contents/MacOS/Code`. A tooling version mismatch, unrelated to this phase's code and reproducible
> before it; none of Phase 5's three milestones has an existing test in that tier.
>
> **Deliberately not done: next-edit is off by default.** It spends a model call every time typing
> pauses, on the user's key. It is exposed in Settings beside autocomplete with its idle delay and
> latency budget, rather than left to a settings file — a default-off feature nobody can find is the
> maintenance liability E18 exists to complain about, and the answer to that is discoverability, not
> switching it on for people who did not ask.

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


> ### ✅ Delivered 2026-08-02 — six of seven complete, M37 partial
> `core/agent-governor.ts` · `core/workspace-roots.ts` · `core/project-profile-cache.ts` ·
> `core/task-agents.ts` · `agent/task-agent-registry.ts` · `agent/task-agent-entry.ts` ·
> `agent/task-agent-lane.ts` · `core/agent-inbox.ts` · `core/model-race.ts` · Manager panel
> gains a task-agent lane, an inbox badge and per-agent apply/discard.
> vitest **841/841 / 41 suites** (was 693/36) · harness **418/418** · eval green, no regression ·
> `tsc -b` clean · webview builds · `extension.ts` **688 LOC**.
>
> **Gate status.** Three of the five clauses are asserted; two need a real repository and a real
> host, which is the same tier that has been unavailable since Phase 5.
>
> | Gate clause | Status | Where |
> |---|---|---|
> | 4 concurrent agents → 4 independently mergeable worktrees | **met** | `__tests__/task-agents.test.ts` — distinct branches, distinct dirs, and `cwd !== rootPath` on every run |
> | Kill-one isolation holds | **met** | one `AbortController` per agent; cancelling one leaves its neighbours running, and a failing one does not disturb them |
> | The live workspace is untouched until an explicit apply | **met** | `apply()` is the only caller of the delta operation, guarded by `canApply`; asserted from six directions including a failed apply |
> | A 2-root workspace yields two profiles and the correct skills per root | **partly** | attribution and per-root caching are asserted pure; the end-to-end injection needs a real 2-root host |
> | Blocked runs notify within 5 s and survive a reload | **partly** | 3 s poll and `reconcileInterruptedAgents` are asserted; the notification itself is `vscode.window` and needs the host |
>
> **M31 — the isolation is one word, and that is the whole risk.** `rootPath: params.cwd` in
> `task-agent-entry.ts` is what makes four concurrent agents unable to see each other: every file
> tool, every `run_command`, every grep resolves against it. Pointing it at the live root instead
> would silently turn four sandboxed agents into four processes editing the user's tree at once, and
> nothing in the type system distinguishes the two — both are strings, both are absolute paths, both
> are plausible. So the registry's tests assert `cwd !== rootPath` on *every* run rather than trusting
> the line to stay correct.
>
> **Admission is a reservation, not a boolean.** `canStart()` then `start()` is a race this codebase
> would lose: runs are launched from webview messages, so two clicks in the same tick both see three
> of four slots used and both proceed. `reserve()` returns a handle or a refusal and holds the slot
> from that moment — there is no window between the check and the claim. Releasing is idempotent for
> the mirror-image reason: `finally` blocks and error paths both release, and a double release would
> hand back a slot somebody else now holds.
>
> **The slot and the status answer to different authorities.** Cancelling flips the status to
> `cancelled` immediately, because the user pressed cancel and the panel should say so — and because
> a task that never observes its signal would otherwise sit `running` forever in a state nothing could
> clear. The *slot* is released only when the run truly ends: a final turn that is still streaming is
> still spending, and freeing it early would let a fifth agent start against a cap of four. Found by a
> test that expected `cancelled` and got `running`.
>
> **A cancelled agent's worktree is kept, and that is a deliberate refusal to be helpful.** It may
> hold real work, and `canApply` still says no — offering to apply a run that stopped halfway is how a
> half-finished refactor reaches a user's tree with nothing indicating it. The branch is on every
> card, so recovering it is a git operation the user performs on purpose. Same reasoning when an apply
> *fails*: the worktree survives, because that is precisely when it holds the only copy.
>
> **M33 — one governor, not one per lane.** Task agents and pipeline runs hit the same repo and the
> same provider account, so two caps of four is a cap of eight discovered at the worst moment.
> Concurrency is clamped rather than validated (the value comes from a hand-editable settings blob, so
> `0`, `-1` and `"eight"` are all reachable, and a garbled setting should behave like an absent one
> rather than like a cap of 1), and the spend ceiling is checked *during* a run as well as at
> admission — a ceiling checked only at the door is one that exactly one unbounded run can exceed.
>
> **M34 — the inbox's fourth reason is the one that was missing.** F16 recorded that
> `awaiting_approval` existed with no notification surface. Blocked, parked and failed are the obvious
> three; **review** — an agent that finished and whose work is sitting in a worktree — is the one that
> would otherwise be missed entirely, because nothing is wrong, nothing is on a timer, and the work
> simply never lands. Notification is keyed by (item, **reason**), so blocked→failed is announced
> again while a poll of an unchanged inbox is silent; a surface that re-announces on every poll gets
> switched off within the hour, after which the user has both the missed run and a dead channel.
>
> **M35 — deleted, on the merits, with the owner's decision recorded.** The path was default-off and
> explicitly unverified for six phases, and it could not be verified in this pass either — the
> real-host tier still does not launch here. What settled it is that E18 reserved it as "E3's
> execution engine", and E3 is the Agent Manager, which now exists with *asserted* isolation. Keeping
> an unverified auto-merge of concurrent worktrees into the live tree — the highest-risk operation in
> this codebase — to serve a role something safer already fills is not a trade worth making. Gone:
> `core/parallel-execution.ts`, `runWavesInParallel`, the orchestrator flag, the
> `pipelineParallelExecution` setting and its UI. The dependency-**wave analysis** stays, because it
> renders `dependency_graph.md`: describing which phases are independent is useful without running
> them that way.
>
> **The deletion test found the thing that makes deletions leak.** `tsc -b` does not remove the
> compiled output of a source file you delete, so `dist/core/parallel-execution.js` was still on disk
> and still `require`-able — the module was "deleted" and the unverified code path was still reachable
> at runtime. The harness now asserts the artifact's absence, not just the source's.
>
> **M36 — the bug was never an error, which is why it survived thirteen call sites.** Everything
> reached for `workspaceFolders[0]`. In a two-root workspace (a Django API and a React app, the
> ordinary shape of a real project) that means the profiler reports `python, django` while the agent
> edits a React component: Django skills injected with full confidence, `run_tests` picking pytest for
> a Jest suite, and nothing anywhere logging a complaint. Two rules carry the fix and both are the
> kind that pass review and fail in production — **longest prefix wins** (nested roots are normal, and
> first-match resolves every file in `repo/packages/api/` to `repo/`), and **boundaries are
> respected** (`startsWith` makes `/repo/app` claim `/repo/application/x.ts`). Profiles are now cached
> per root, and paths are made relative to *their own* root before detection, because
> `asRelativePath` prefixes the folder name in a multi-root workspace and `api/manage.py` never
> matches `manage.py`.
>
> **M37 — ranked lexicographically, and this is the interesting half of the feature.** The tempting
> design is a weighted score: tests 0.6, diff size 0.3, speed 0.1. It is wrong in a way that costs
> real money — *any* weighting admits a trade where a candidate whose **tests fail** outranks one
> whose tests pass because it was tidier or quicker, and a race that recommends broken code because it
> is short has made the user's decision worse than a coin flip. So the comparison is strictly ordered:
> tests pass, then tests actually ran ("no test command here" is not "the suite is green"), then fewer
> failures, then less churn. `pickWinner` will return **no winner** — when nothing is verifiably good,
> and when two candidates genuinely tie — because a recommendation carries an implicit claim of
> confidence, and picking the first of a tie is picking by list order and calling it a judgement.
> Nothing in a race is ever auto-applied.
>
> **Why M37 is 🟡 and not ✅.** The ranking is built and tested; the *evidence* it ranks on is not
> wired. `TaskAgentLane.raceOutcome` currently reports `testsRan: false` for every candidate, so in
> practice ranking falls through to diff size — which is the fourth tiebreak being used as the first.
> Running Phase 1's `run_tests` inside each candidate's worktree and threading the result through is
> the remaining work, and it is named here rather than smoothed over: a race that silently ranks on
> churn while claiming to rank on tests is exactly the kind of thing this document exists to catch.
>
> **Two things fixed on the way past.** Concurrent agents each get their **own** `BrowserTool`,
> `MCPClient`, `ArtifactManager` and `CheckpointManager` — one shared browser would mean agent B
> navigating away from the page agent A is asserting on, and one shared checkpoint store is the
> concurrency bug that already forced pipeline runs to have their own. And `WorktreeManager`'s seven
> hard-coded `workspaceFolders[0]` reads now take an optional root, so an agent declared against the
> React root does not create its worktree from the Django repo's HEAD.
>
> **The ≤700-line gate fired for a third consecutive phase**, at 711 lines. The extraction this time
> was `_getProjectProfile` into `core/project-profile-cache.ts` — which is also where it became
> per-root, so the gate produced the M36 refactor rather than merely surviving it.
>
> **Not run in this environment:** the real-host integration tier, unchanged from Phase 5
> (`@vscode/test-electron` spawns `Contents/MacOS/Electron`; VS Code 1.131.0 ships
> `Contents/MacOS/Code`). Two of Phase 6's five gate clauses are the ones that need it, and they are
> marked "partly" above rather than claimed.

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


> ### 🟡 Delivered 2026-08-02 — M39 complete, M38 and M40 partial
> `core/steering.ts` · `core/verification.ts` · `core/artifacts.ts` · `agent/artifact-store.ts` ·
> `agent/verify-runner.ts` · a steering drain in `agent/agent-loop.ts` · per-agent steering queues
> in the task lane · a Steer control and a verification badge in the Manager panel.
> vitest **920/920 / 44 suites** (was 841/41) · harness **418/418** · eval green, no regression ·
> `tsc -b` clean · webview builds · `extension.ts` **697 LOC**.
>
> **Gate status.** One of four clauses is met, one is not applicable yet, and two are outstanding —
> stated plainly because this is the first phase since rev 4 to close with real work left in it.
>
> | Gate clause | Status | Where |
> |---|---|---|
> | A comment changes executor behaviour within one turn without losing context | **met** | `__tests__/steering.test.ts` — injected on the next turn, every earlier turn preserved, caller's array never mutated |
> | 100% of pipeline runs emit a test-report artifact | **not met** | verification is wired into the *task-agent* lane; the pipeline still finishes without one |
> | ≥80% of chat build tasks emit verification evidence | **not met** | same — chat tasks do not verify yet |
> | A deliberately broken change is caught by verify, not by the user | **met for task agents** | a red suite yields `failed` + one bounded correction; asserted pure, exercised end-to-end only in the task lane |
>
> **M39 — the placement is the feature.** Mid-run, the message list is a protocol rather than a
> transcript, and two placements produce a hard provider rejection rather than a worse answer: a
> steering note between a `tool_use` and its `tool_result` is an unanswered tool call, and a note
> appended after the tool-results message is two `user` turns in a row, which Anthropic refuses. So
> `applySteering` folds the text into the trailing user turn when there is one — the same solution
> `ContextManager.withSummary` reached for the same reason — and **declines** when the last message
> has unanswered tool calls, holding the note for one turn. Declining is the right behaviour there:
> the alternative is breaking the run in order to be prompt.
>
> Deferred notes are **unshifted** back, not pushed. A note held for a turn while the user typed
> another would otherwise become the *last* instruction the model reads, silently reversing the order
> they were written in — which is the kind of bug that presents as "the agent ignored my first
> comment".
>
> Queues are per agent. With four concurrent runs (Phase 6), a single shared queue would deliver a
> correction meant for one of them to all four, and three agents would act on an instruction about
> somebody else's work.
>
> **M40 — four outcomes, and the fourth is the point.** `verified` / `failed` / `unverifiable` /
> `incomplete`. The tempting simplification is three, treating an unrunnable suite as a pass because
> it makes the happy path uniform — and that is the same error M37's ranking refuses to make: it
> converts *we do not know* into *it is fine*, which is precisely what this phase exists to stop
> being claimed. `incomplete` (tests green, required screenshot missing) is separate for the same
> reason: quietly upgrading it to `verified` is how an evidence requirement decays into an optional
> extra over two revisions.
>
> **Exactly one self-correction, and only for `failed`.** A loop that keeps correcting against a red
> suite spends an afternoon and a budget converging on nothing. `unverifiable` gets none at all — no
> edit fixes a missing test runner, so spending an attempt on it is spending it on the wrong problem.
> The correction prompt explicitly forbids deleting, renaming, skipping or weakening a test, because
> those are the first things a model optimising for "make the tests pass" finds, and all of them make
> the report green and the change wrong.
>
> **The report is written on every path, including the one where nothing ran.** A run with no
> artifact and a run that verified clean are indistinguishable from the outside, so "unverifiable"
> has to produce a document that says so. That is what makes "100% of runs emit evidence" a
> measurable claim rather than a wish — and it is why that row can now be reported as *not met*
> rather than assumed.
>
> **M38 — the old store had been lying about types since Feature 18.** `ArtifactManager.save()`
> accepts a `type`, writes it nowhere, and `list()` then hardcodes `type: 'report'` for every entry.
> So the type was accepted, discarded and misreported for three phases, and nothing noticed because
> nothing rendered it. The new store carries the type in the record **and** in the filename, so the
> directory stays legible even if the index is lost — and `rebuildFromDisk` reconstructs the index
> from those filenames, because an index that cannot be rebuilt is a single file whose corruption
> silently empties a review surface.
>
> **What M38 does not have is the review panel**, and that is the milestone's other half. Artifacts
> are typed, stored, grouped by run and commentable through the API; nothing browses them yet. The
> steering path reaches the agent through a Steer control on the agent card rather than through a
> comment on an artifact region, so the plumbing for region comments exists and is tested while the
> surface that would produce them does not.
>
> **Phase 6's M37 is closed here**, which is the sequencing the roadmap implied and did not state:
> the race ranks on test evidence, and until M40 there was no test evidence to rank on. Each
> candidate now carries a real verification result, so the lexicographic comparison uses its first
> term instead of falling through to diff size.
>
> **A test-infrastructure flake worth naming.** Two suites (`source-hygiene`, `css-quality`) shell
> out to `tsc -b` and `stylelint`. Running `npx tsc -b && npx vitest run` in one command makes them
> contend with the build that just started, and one fails intermittently. Run separately, 920/920 is
> stable. Not fixed in this phase — recorded so the next person does not chase it as a real failure.
>
> **What is left in Phase 7, named rather than implied:** the artifact review panel (M38), the
> pipeline and chat verify wiring (M40's first two gate rows), and visual capture — `planVerification`
> *requires* a screenshot when a UI file changes and `evaluateVerification` reports it missing, but
> nothing captures one yet, so UI work currently lands as `incomplete` by design rather than as
> verified.

> ### 🟡 Advanced 2026-08-03 — M40's first two gate clauses met; M38 and visual capture still open
> `verifyRun` on `PipelineCallbacks` · the call in `pipeline-orchestrator.ts` · the runner in
> `pipeline-entry.ts` · the chat-lane call in `chat-task.ts` · two bus events ·
> `__tests__/verification-wiring.test.ts`.
> vitest **1 577/1 577 / 60 suites** (was 1 562/59) · harness **418/418** · eval green, no
> regression · `tsc -b` clean.
>
> | Gate clause | Status | Where |
> |---|---|---|
> | 100% of pipeline runs emit a test-report artifact | **met** | the orchestrator calls `verifyRun` after the last execution phase; `runVerification` writes on every path including `unverifiable` |
> | ≥80% of chat build tasks emit verification evidence | **met** | every chat run that changed a file in `agent` mode verifies |
>
> **Neither was hard, and that is the finding.** Phase 7 read as though the pipeline and chat lanes
> needed verification *built*; what they needed was the artifact store threaded into their deps. It
> had been carried into the task lane in Phase 6 and nowhere else, so two gate clauses sat open for a
> revision over a missing constructor argument. Worth recording because the phase note described the
> gap in terms of the feature rather than the wiring, which is what made it look larger than it was.
>
> **The pipeline verifies in the worktree, before `applyDelta`.** After the delta lands, a red suite
> could equally be the user's own uncommitted work; before it, a red suite is this run's doing.
> Attributability is the entire value of running the suite at all, and the ordering is asserted
> rather than commented.
>
> **"Build task" is defined by what the run did, not by what the prompt looked like.** A chat run
> verifies when it changed a file. Classifying the *prompt* as a build request is a guess that is
> wrong in both directions — "explain this and fix the typo" would skip verification, "how do I add a
> test" would spend a suite run on a question. What a run did is observable; what it was for is not.
> The changed set comes from the checkpoint commit, which already has to know exactly which files
> moved: a parallel tally is a second answer to the same question, and it drifts.
>
> **A failed verification never fails a run, in either lane.** The agent did the work; the report
> says whether it can be trusted. Discarding real edits because a test command was missing is a worse
> outcome than an honest `unverifiable` — and it is `unverifiable` producing a *document* that makes
> "100% of runs emit evidence" measurable rather than aspirational.
>
> **Delivered 2026-08-04 — the last two clauses, and the phase closes.**
>
> | Gate clause | Status | Where |
> |---|---|---|
> | a comment changes executor behaviour within one turn without losing context | **met** | the review panel (M38) → `routeComment` → the live agent's `SteeringQueue` → the loop's drain |
> | a deliberately broken change is caught by verify, not by the user | **met** | `evaluateVerification`'s `failed` path, asserted in `verification.test.ts` |
>
> **The review panel (M38) was the missing *surface*, not the missing model.** The typed store, the
> index, the run association and `addComment`/`undeliveredComments` all shipped with the phase and
> nothing called them. `core/artifact-review.ts` is the decision layer — group by run, filter by
> type, and route a comment — and the panel is a third tab in the Manager beside Pipelines and Task
> Agents, because "what is my machine doing" and "what did it produce" are one question.
>
> **A comment is stored first and steered second, and the two are reported separately.** Most review
> happens after a run ends, so refusing comments on finished runs would gut the feature; accepting
> them while implying delivery would be worse. Every comment persists on the artifact; a comment on a
> *live* run is additionally queued as a steering note, and only then marked delivered. The panel
> says which of the two happened, in the button label and under it.
>
> **This is what M39 was built for.** Until now steering had one entry point: a `window.prompt`
> behind a Steer button, which cannot carry which artifact the user is reading or which lines they
> meant. The queue has accepted `artifactPath` and `region` since the phase opened and nothing ever
> supplied them. A selection in the panel now does, capped at 600 characters on a line boundary —
> quoting a 400-line plan back at the agent would displace the budget the correction needs.
>
> **Visual capture (M40) refuses more often than it guesses, on purpose.** `planVerification` has
> required a screenshot for UI changes since the phase opened and nothing produced one, so *every* UI
> change landed `incomplete` — a requirement that cannot be satisfied is not a gate, it is a
> permanent warning, and people stop reading those. `core/visual-capture.ts` decides where to point a
> browser: a configured `verificationPreviewUrl` is used **alone** (a URL that is down does not fall
> back to a guessed port — a screenshot of a *different* app reported as evidence is worse than no
> screenshot), otherwise the stack's own documented dev port on loopback, and the navigation
> allowlist is honoured rather than stepped around. A HEAD probe answers "is anything serving" in
> milliseconds instead of paying 2 s of Chromium launch plus a 30 s navigation timeout to find out;
> it is registered in the egress accounting like any other outbound call, because a register that
> skips its loopback entries cannot be relied on for the interesting ones.
>
> **Both directions of the clause are asserted.** A UI change lands `verified` when capture succeeds
> and stays `incomplete` when it does not — the second test is the one that matters, since "UI
> changes become verified" is trivially satisfiable by treating a missing screenshot as acceptable,
> which is the decay the fourth outcome exists to prevent. The capture never throws outward and
> always closes its browser: a verification step that can fail a run, or leak a Chromium per UI
> change, is one people switch off.
>
> **Phase 7 is ✅.** vitest **1 629/62** · harness 418/418 · eval green, no regression.

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


> ### 🟡 Delivered 2026-08-02 — four of six complete, M41 partial, M45 not started
> `core/memory-model.ts` · `core/memory-markdown.ts` · `core/memory-lifecycle.ts` ·
> `core/mindmap-readback.ts` · `memory/memory-store.ts` · mindmap injected as its own budgeted
> prompt section in `agent/chat-task.ts`.
> vitest **988/988 / 46 suites** (was 920/44) · harness **418/418** · eval green, no regression ·
> `tsc -b` clean · webview builds.
>
> **Gate status.** Three of four clauses are decidable without a model, and all three are met.
>
> | Gate clause | Status | Where |
> |---|---|---|
> | The markdown stays human-editable and round-trips byte-stable | **met** | `__tests__/memory-v2.test.ts` — stable over repeated passes, preserves the user's own prose above *and* below, survives a missing trailing newline and a malformed metadata comment |
> | Contradicting a fact prompts rather than overwrites | **met** | `decideWrite` returns `ask`; `supersede` archives the old entry and keeps its text |
> | Consolidation is idempotent | **met** | identical output on the second and third run, and independent of input order |
> | A fact from session 1 is retrieved in session 3 (≥70% of eligible) | **not measured** | a retrieval-quality number; needs an eval corpus of multi-session facts, which does not exist yet |
>
> **Byte-stability is the clause that protects a file the user owns.** ADR 007 makes the markdown
> authoritative and the typed index derived, and the property that keeps "derived" from quietly
> becoming "authoritative" is that the projection can be re-rendered without changing a byte. The
> file lives in the user's repo, so it lives in their diffs: a projection that reorders entries or
> rewrites `0.80` as `0.8` produces a spurious diff on every consolidation pass, and a generated file
> that churns without changing meaning is one people stop reading, then stop trusting, then delete.
> Two consequences fall out of that and neither is decoration — confidences are rendered at fixed
> width (`0.6 * 0.9` is `0.5399999999999999`, and decay multiplies confidences), and anything the
> parser does not understand is preserved verbatim, because a projection that drops what it cannot
> model is one that eats the user's notes.
>
> **M42 — two signals, because either alone is useless.** Similarity finds entries about the same
> subject; conflict decides whether they disagree. Similarity alone flags every restatement of a fact
> as a contradiction. Conflict alone flags "never use tabs" against "never use `any`", since both
> contain a negator. Both are asserted.
>
> **The similarity is lexical, not embedding-based, and that is a decision rather than a shortcut.**
> E7 specifies "embedding-near + negation heuristic". Embeddings would make contradiction detection a
> network call on the `embed` role *on every memory write* — and a write that can fail on a rate
> limit is a write that silently does not happen, which turns the one feature guaranteeing memories
> are never silently lost into one that silently loses them. The lexical form catches the case that
> actually occurs (the same subject asserted two ways) with no failure mode; the embedding variant
> stays available for when the store is large enough to need it.
>
> **M43 — a defect the idempotency assertion caught.** The first decay implementation advanced one
> stage per call, so an entry idle for a year was `demoted` if the consolidation job had run once and
> `archived` if it had run twice. The store's contents depended on *job scheduling*: reopening a
> project after a long gap gave a different answer from having left the editor open. Decay is now a
> function of elapsed time, which is both correct and what makes it a fixed point.
>
> **And decay never hard-deletes**, because the markdown is a user file. Archiving keeps the line and
> marks it — visible, reversible, diffable. Deleting a line from a document somebody owns is not
> decay, it is editing.
>
> **M44 — idempotent means order-independent.** The merge picks max confidence, summed uses, earliest
> creation and latest use, all of which are commutative; a rule as ordinary as "keep the first one's
> confidence" would make the result depend on iteration order, and the second run would then differ
> from the first. Identity is the *normalised* text rather than the id, because entries a human typed
> by hand have no id, and two hand-written lines differing only by a full stop are exactly the
> duplicates this exists for. That is also the deduplication the existing SHA-256 store could not do:
> it hashed raw content, so "Use pnpm, not npm." and "Use pnpm, not npm" were two memories.
>
> **M46 closes a loop that has been open since plan.md's Phase 5.** The mindmap's *write* half has
> always worked — every pipeline run syncs the detected stack into `project_mindmap.md` — and nothing
> ever read it, so the file was a write-only log. The agent recomputed what it had already written
> down, and any convention a *human* added to it ("we use the repository pattern, not the ORM
> directly") was invisible to every run, in a file the agent itself maintains and the user therefore
> assumes it reads. It is now its own budgeted prompt section, with auto-sync blocks excluded so the
> agent does not spend its allowance re-reading its own history.
>
> **Why M41 is 🟡.** The bands, the content filter and the store are built and tested; what is not
> wired is the thing that *produces* candidates from a finished turn. That is a model call — "what
> did this conversation establish about the project" — and it belongs in the same opt-in tier as
> §4.6's other model-dependent work rather than as a per-turn cost the user did not ask for. The
> filter that matters most is already in place: automatic extraction fails not by missing a fact but
> by remembering a hundred worthless ones, and a store full of "the user asked me to fix a bug" costs
> context on every turn while burying the three entries that matter.
>
> **A flaky gate, found and fixed rather than tolerated.** `index-build-budget` — Phase 3's ≤2 s per
> 5 000 files — became the suite's only intermittent failure, failing roughly two runs in three. It
> measures **wall clock** while vitest runs 46 files in a worker pool, so as the suite grew from 32
> files to 46 across phases 5–8 it started measuring the other suites rather than the index (~1.2 s
> alone, over 2 s under contention). It now takes the best of up to three samples: contention can only
> make a sample slower, so the minimum is the closest estimate of the code's own cost, and a real
> regression still fails every sample. Raising the budget until the noise fit would have raised the
> gate above the thing it exists to catch — and §4.6's argument applies exactly here, since a gate
> that fails randomly gets switched off, and then nothing is guarded.

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


> ### 🟡 Delivered 2026-08-02 — the security spine (M52–M56); M47–M51, M57, M58 not started
> `core/redaction.ts` · `core/untrusted-content.ts` · `core/workspace-guard.ts` ·
> `core/tool-breaker.ts` · `core/audit-trail.ts` · the posture wired into the chat system prompt.
> vitest **1 112/1 112 / 50 suites** (was 988/46) · harness **418/418** · eval green, no regression ·
> `tsc -b` clean · webview builds.
>
> **Five of twelve milestones, chosen by risk rather than by list order.** M54 and M56 were the last
> two **P0** items in the entire inventory, and M52/M53/M55 are the rest of the hardening that has
> read 🔴 or 🟡 since rev 1. The Reviewer agent, MCP transport parity and sandbox tiers are the larger
> half of the phase and are **not started** — said plainly rather than sketched.
>
> **Gate status.** Four of six clauses are met; two belong to milestones not attempted.
>
> | Gate clause | Status | Where |
> |---|---|---|
> | No secret reaches a log or a provider request | **met** | `__tests__/redaction.test.ts` — 13 vendor shapes, assignment and header contexts, plus `redactDeep` for the audit trail |
> | Injection fixtures cannot escalate privileges or widen an allowlist | **met** | `__tests__/injection-fixtures.test.ts` — six payloads, each asserted against the mode allowlist, the tool toggles and the command policy |
> | A tool failing 3× is disabled rather than retried forever | **met** | `__tests__/hardening.test.ts` — consecutive counting, latency budget, removed from the advertised list *and* refused |
> | (boundary, folded in from G7) file tools cannot escape the workspace | **met** | traversal, prefix collision, symlinks, `.git` |
> | Reviewer ≥60% TP at ≤1 FP per 10 findings | **n/a** | M47 not started |
> | A remote MCP server works while unvetted ones stay refused in pipelines | **n/a** | M49–M51 not started |
>
> **M54 — the interesting half is what it refuses to redact.** Over-redaction is not a safe failure:
> an agent whose view of the code is peppered with `[redacted]` cannot reason about the code, and the
> user's response is to switch redaction off, after which nothing is protected at all. So the two
> detector families are treated completely differently — vendor shapes (`ghp_…`, `AKIA…`, PEM blocks,
> JWTs) are unmistakable and fire anywhere, while **entropy alone never fires**. It must also sit in a
> secret-shaped slot *and* pass a token-shape check.
>
> That shape check is six false positives, each caught by a test and each of which would have made
> real source unreadable: a URL (`const url = "https://api.example.com/v2/users"` scores high), a
> UUID, a git SHA, an integrity hash, a dotted path, and — the one that makes the point — an ordinary
> English sentence. `description = "The quick brown fox jumps over the lazy dog"` has entropy above
> the threshold. Prose is not a credential; credentials have no spaces.
>
> **Two more defects the tests caught.** `sk-ant-…` was being labelled `openai-key`, because the
> broader `sk-…` detector ran first and the first detector to claim a span wins — the value was
> scrubbed either way, so an assertion that only checked "something was redacted" would have passed
> while mislabelling every Anthropic key in the audit trail. And `API_KEY=${API_KEY}` was redacted,
> because the env-reference branch of the placeholder check described a *prefix* inside an anchored
> alternation and therefore never matched — hiding the shape of a config file while protecting
> nothing.
>
> **M56 — the detector is deliberately not a defence.** A pattern matcher that *blocked* injections
> would be security theatre: an attacker rephrases on the first attempt, and a defender who believes
> the filter works stops maintaining the parts that hold. What holds is that the capability gates are
> **not reachable from content** — `isToolAllowedInMode`, `CommandPolicy` and the session tool toggles
> are functions of configuration, with no parameter through which a tool result could reach them. So
> the fixtures assert the *gates are unmoved*, not that the payloads were spotted. The detector's job
> is to put a visible signal in the run log so a user wondering why an agent behaved oddly has
> somewhere to look.
>
> **M55 — the boundary, and what G7 actually had.** "Sandbox tests exist (`test_sandbox_*.js`); not
> centrally enforced or documented" has been the grade since rev 1. Those four files print things,
> assert nothing, and are run by nothing. The guard replaces them with one chokepoint and the three
> escapes a `startsWith(root)` check admits: **traversal** (visible only after normalisation),
> **prefix collision** (`/work/repo-backup` starts with `/work/repo` — the same boundary problem M36
> solved, reusing that answer rather than growing a second subtly different one), and **symlinks**
> (not decidable by string comparison at all, so the guard takes a resolver and reports
> `symlinkChecked: false` when it has none rather than implying a completeness it lacks).
>
> `.git` is denied even inside the workspace, and that one is not hygiene: an agent that can write
> `.git/config` can set `core.fsmonitor` to an arbitrary command, and git will run it — past the
> command policy entirely.
>
> **M53 — a trail, not a log.** G5's complaint is precise: "Diagnostics export ≠ audit trail." JSONL
> so a partial write loses one line rather than the file; monotonic sequence so ordering survives
> equal timestamps; **no update method on the class**, asserted by a test that reads the prototype,
> because an audit trail with an edit path is a log. And it is **redacted on the way in, not on the
> way out** — redacting at export would leave a live credential on disk in the user's repo, under a
> filename that invites them to attach it to a bug report, for the entire window that matters.
>
> **The NUL byte came back, and the guard caught it inside the same phase.** `workspace-guard.ts`
> shipped with a literal NUL as the `**` sentinel in its glob matcher — the third occurrence in this
> codebase (Phase 3 shipped two in source, rev 6 found one in the roadmap). Invisible in an editor,
> and it makes the file binary to `grep`. `__tests__/source-hygiene.test.ts` failed on it. The fix is
> not an escape: the matcher now scans once with no sentinel at all, so the bug class is gone rather
> than spelled correctly.
>
> **What is left in Phase 9, named:** the Reviewer agent and its `gh` PR mode (M47/M48), MCP
> streamable HTTP/SSE/OAuth with resources, prompts and a vetted allowlist (M49–M51), sandboxed
> execution tiers (M57), and optional at-rest encryption (M58). None of them is blocked; they are
> simply larger than the security spine and were not attempted.

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


> ### ✅ Delivered 2026-08-02 — M59 complete; M60 and M61 land their cores, wiring outstanding
> **31 new skill packs** · `core/notebook.ts` · `core/skill-registry.ts` · 7 new eval fixtures and
> 38 new golden tasks · profiler detection for `remix`, `astro`, `docker`, `kubernetes`,
> `terraform`, `github-actions`.
> vitest **1 415/1 415 / 53 suites** (was 1 112/50) · harness **418/418** · eval green with a
> re-recorded baseline (112 tasks / 21 fixtures · stack detection **100% 21/21** · exact-match
> **100% of 95 coverable tasks** · wrong-idiom **0% of 38 guarded tasks**) · `tsc -b` clean.
>
> **Gate status.** Three of four clauses are met; the fourth needs wiring that is not done.
>
> | Gate clause | Status | Where |
> |---|---|---|
> | Every pack parses with ≥1 role and ≥1 stack | **met, with the wording corrected** | see below |
> | A malicious pack attempting to widen tool access is rejected at load | **met** | `__tests__/skill-registry.test.ts` — every forbidden key, every spelling of `autoApprove`, checksum checked *before* content |
> | The agent edits a real `.ipynb` without corrupting JSON, revertibly | **met** | `__tests__/notebook.test.ts` — byte-stable round trip, per-cell edit, cell-granular restore |
> | A remote pack installs and verifies its checksum | **not met** | the admission logic is built and tested; the command that fetches is not wired |
>
> **The gate's own wording was wrong, and the eval set said so.** "Every pack parses with ≥1 role
> and ≥1 stack" reads as a formality. Asserting it literally broke a golden task: `a11y-wcag-aria`
> ships `stacks: []` **deliberately** — an empty list means *any* stack, which is what a genuinely
> cross-cutting pack needs, and `empty-fe-1` exists to pin that it fires on a repo with no detected
> stack at all. Giving it stacks to satisfy the literal reading made it unreachable there. The test
> now asserts the resolver's real contract (a role, plus stacks **or** triggers), with the deviation
> recorded rather than silently adopted.
>
> **A resolver defect the breadth work surfaced, and did not fix.** Given a broad `stacks` list,
> `component-architecture` **displaced a specific pack**: on a design-role task about readability its
> `react` stack match outranked `a11y-wcag-aria` and pushed it out of the top-N — *even though its
> roles did not include `design`*. That is an F1-family bug in the **resolver** (a stack match should
> not survive a role mismatch), and it is worked around here in data by making the pack
> trigger-scoped. The resolver fix is not in this phase, and it is named here so it is not lost.
>
> **Two of my own packs reproduced defects this codebase has already documented.** `rspec` shipped
> the trigger `it` — two characters, a bare English word, and F3b exactly: `res` from the express
> pack fired as a substring on "**Res**tyle" and "add**res**s". And `orm-patterns` shipped `orm`,
> which is inside f**orm**at, transf**orm** and n**orm**alize. Both were caught by the guard Phase 6
> added for precisely this, which allowlists short triggers so that a new one has to be *a decision
> somebody writes down*. Seven were vetted and added; those two were rejected and removed.
>
> **M59 — and why the eval corpus had to grow with the catalog.** `eval-task-coverage.test.ts`
> asserts that every bundled pack is named by at least one golden task, because a pack with no task
> can be broken by a resolver change and nothing fails. Adding 31 packs therefore meant adding 38
> tasks and 7 fixtures, and adding fixtures meant teaching the profiler four stacks it could not
> detect (`remix`, `astro`, plus `docker`/`kubernetes`/`terraform`/`github-actions` by file
> presence). Scoping a pack by its *language* token instead would have been quicker and is finding
> F3: packs that list the language beside the framework match at language strength on any repo in
> that language.
>
> **M61 — the corruption that matters is the quiet one.** A notebook that fails to parse is the loud
> failure and the easy one. `source` is a string **or an array of strings**, and Jupyter writes the
> array — one element per line, newline included, last line without. Writing back a plain string is
> valid nbformat, opens fine, and rewrites every cell in the file: a one-line fix becomes a
> 40 000-line diff and a merge conflict with every colleague. So an edit preserves the shape the cell
> already had, the indent the file already used, and every key the parser does not model.
>
> Outputs and `execution_count` are deliberately **left alone** on edit. Clearing them is tempting
> and destroys results the user may not be able to reproduce; renumbering invents an execution
> history that never happened. And outputs are **excluded from prompts by default** — a plotting
> cell's output is a base64 PNG worth thousands of tokens that say nothing the model can act on.
>
> **M60 — the ref check is the one worth arguing for.** Pinning to `main` is the natural thing to
> write and it means "whatever that repository contains at the moment I install", which makes the
> checksum meaningless because the content it pins is expected to change. A moving ref is refused.
> And the forbidden-key list is a **deny list, not an allowlist of values**, because the failure to
> avoid is a *future* field: somebody adds `permissions:` to the mode loader, forgets that packs
> share the parser, and a pack silently gains it. Bundled packs are held to the same rule — an
> exception for "our own" content is how a rule stops being one.
>
> **What is left in Phase 10, named:** the `black-ide.addSkillFrom`/`updateSkillPacks` commands that
> actually fetch (M60), and registering `edit_notebook_cell` in the executor's tool surface (M61).
> Both are wiring over cores that are built and tested; neither is blocked.

> ### ✅ Closed 2026-08-03 — M60 and M61 wired; Phase 10 complete
> `tools/skill-fetch.ts` · `read_notebook`/`edit_notebook_cell` in `core/tools.ts` and
> `agent/tool-executor.ts` · `NOTEBOOK_READ_TOOLS`/`NOTEBOOK_EDIT_TOOLS` across twelve mode
> allowlists · `black-ide.addSkillFrom` in `core/command-registry.ts` · two new egress register
> entries · `__tests__/notebook-tools.test.ts` · `__tests__/skill-fetch.test.ts`.
> vitest **1 535/1 535 / 58 suites** (was 1 488/56) · harness **418/418** · eval green, no
> regression · `tsc -b` clean.
>
> | Gate clause | Status | Where |
> |---|---|---|
> | A remote pack installs and verifies its checksum, shadowable by a local pack | **met** | `__tests__/skill-fetch.test.ts` — checksum-first admission, install path under `.blackide/skills/`, an edited pack never overwritten |
>
> **M61's wiring turned out to contain the defect, not the feature.** Registering two tools is the
> boring half. The half that mattered is that `read_file` and `edit_file` were *already* reachable for
> a `.ipynb` and are both actively wrong on one. Reading a notebook through the generic tool spends
> most of its tokens on base64 image output; editing one with a SEARCH/REPLACE block either fails to
> match (the good outcome — the model wrote the block against the code it read, not against
> JSON-escaped `source` array elements) or matches something short enough to hit inside the JSON and
> writes a file that is no longer a notebook. Both now refuse and name the notebook tool. So the
> milestone's real content is that `core/notebook.ts` stopped being unreachable **and** the path that
> was reaching notebooks incorrectly stopped doing so.
>
> **Reading one cell renumbers it.** `renderNotebook` labels cells by position in the array it is
> given; handing it a one-element slice labels cell 7 as cell 0, and the model then edits index 0.
> A one-line fix for a bug that would have presented as "the agent edited the wrong cell".
>
> **M60's transport check is a new clause, not a restatement.** `validateEntry` asks whether an entry
> is *meaningful* — pinned, checksummed, named. It never asked whether the source was safe to hand to
> `git`, because until this pass nothing handed anything to git. **Git's `ext::` transport executes a
> shell command:** `ext::sh -c 'curl … | sh'` is remote code execution triggered by a string that
> looks like a URL, and every other gate in the module runs *after* the fetch. A checksum cannot
> protect content that was never the payload. So `validateSource` allowlists exactly one scheme
> rather than denying the bad ones — a deny list here has to enumerate `ext::`, `file://`, `ssh://`,
> `git://`, the scp-like `host:path` form and whatever git adds next, and missing one is the whole
> bug. The fetch also runs with `HOME` and `XDG_CONFIG_HOME` pointed at the temp dir, because an
> `insteadOf` rewrite in the user's own git config could redirect an https URL onto a transport this
> check just refused, which would make the scheme check advisory.
>
> **A Phase 12 gap this work found, and closed.** The egress register claims "the only egress is this
> list", enforced by a source walk for `fetch`, `https.request` and `WebSocket`. It therefore could
> only ever find egress that goes through Node — and `agent/pipeline-entry.ts` has been running
> `git push -u origin` and `gh pr create` since Phase 6. Real egress, to a real remote, invisible to
> the accounting. Both are legitimate (the user's own remote, their own credentials, only in `pr`
> output mode) and both are now registered, and `phase12-gate.test.ts` has a **second walk** that
> looks for network-capable subprocesses. The command list is deliberately short and specific —
> `git log` and `git blame` are local and must not appear, or the check becomes noise, acquires an
> exemption list, and stops holding. The register's own claim was the thing at risk here: a register
> whose enforcement only covers the shapes it already knows about documents its test rather than the
> code.

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


> ### 🟡 Delivered 2026-08-02 — the boundary is enforced; the package move and the daemon are not
> `src/agent-core/index.ts` (the declared surface) · `agent-core/host.ts` (the host interface) ·
> `agent-core/node-host.ts` (a second implementation, with no editor) · `agent-core/cli.ts` ·
> `__tests__/agent-core-boundary.test.ts`.
> vitest **1 452/1 452 / 55 suites** (was 1 415/53) · harness **418/418** · eval green, no
> regression · `tsc -b` clean · webview builds.
>
> **Gate status.**
>
> | Gate clause | Status | Where |
> |---|---|---|
> | `grep -r "vscode"` in the core returns nothing | **met, and stronger than the grep** | transitive import walk from the barrel; a chain of five clean hops into a dirty module fails |
> | The refactored extension is green on the full harness | **met** | 418/418 unchanged through four dependency-edge cuts |
> | `blackide "…" --output pr` completes on a fixture repo | **not met** | parsing, host and exit codes exist and are tested; the `bin` entry that runs a task is not shipped |
> | A daemon run's results appear in the inbox | **not met** | M65 not started |
>
> **The decision this phase turns on: a barrel, not a `git mv`.** There are two ways to reach "zero
> vscode imports in the core". One moves eighty files into `packages/agent-core/` in a single
> change — a diff across most of the repository which the harness cannot meaningfully verify, since
> every import path changes and "still green" then mostly proves the rewrite was mechanical. The
> other **names the boundary and enforces it**, and moves modules across it when there is a reason
> to. The property the gate is really after — *the core does not depend on an editor* — is then true,
> checked on every commit, and true **incrementally**. Doing it the other way round is how a
> decoupling ships as a directory rename.
>
> **The check is transitive, and that is not a detail.** A barrel importing a clean module that
> imports a dirty one passes a one-level grep and fails the actual requirement. The first run
> reported five offenders — and reported the *chains*, which is what made them fixable:
> `agent-core → agent-loop → tool-executor → lsp-tools → vscode` says something a filename does not.
>
> **Four edges cut, and the third one is the interesting one.**
> - `embeddings-client.ts` imported `vscode` and **used it zero times**.
> - `secret-manager.ts` needed one *type*, `vscode.SecretStorage`. It is an interface, so importing
>   the module bought a type and cost the entire editor dependency — and since the codebase index
>   takes a `SecretManager`, that single line is why the whole retrieval stack was editor-bound. It
>   is now a three-method structural type that a real `SecretStorage` satisfies unchanged.
> - `agent-loop.ts` imported `AgentToolExecutor` as a **value** when it only needs the shape. That
>   one import pulled the LSP bridge, the codebase index and the artifact manager into everything
>   that imported the loop. `import type` is erased at compile time, so the boundary checker was
>   taught the difference — a contract is not a dependency, and a checker that cannot tell them apart
>   forces you to duplicate types to satisfy it.
> - `skills-manager.ts` read `workspaceFolders[0]` once, which made skill resolution — which every
>   prompt goes through — editor-bound. It was also M36 in miniature: in a two-root workspace it read
>   folder zero's packs whatever the agent was working on. The root is now a parameter.
>
> **The reachable count *fell* when the loop's import became type-only, and the test says so.** That
> is correct — the loop legitimately stopped dragging half the tool surface with it — but a boundary
> whose size can shrink silently is one that can be satisfied by exporting less. The floor is
> asserted so a shrink has to be deliberate.
>
> **The host interface is deliberately small, and the honest test of it is what is *optional*.**
> Diagnostics, the language server, the Problems panel and "open this file" are all optional
> capabilities the core must work without — because if a missing one broke the agent rather than
> merely informing it less, the dependency was structural and the split would be cosmetic. The
> Node host implements none of them, which is what makes that claim checkable rather than stated.
>
> **The notifier cannot ask a question, and that is a design constraint rather than an omission.** A
> core that can prompt the user cannot run unattended, and every caller awaiting an answer is a place
> a headless run hangs forever. Approval is separate and explicit so that "there is nobody to ask" is
> a first-class answer — which is also how G3's "auto-approve is ignored in unattended runs" becomes
> a property of the *host* rather than a flag somebody must remember to set.
>
> **The CLI's two properties are both about being consumed, not about the agent.** stdout is one JSON
> object per line and nothing else, with logs on stderr, because a tool that interleaves them forces
> every consumer to write a parser that guesses. And the exit codes distinguish **completed but
> unverified** from **completed** — the agent believing it is done while the tests disagree must not
> be a green build. An unknown flag is refused rather than ignored, because a typo silently dropped
> is a CI job running with the wrong settings and reporting success.
>
> **A defect of the kind this codebase keeps finding, in a comment this time.** A doc comment in
> `node-host.ts` contained a glob example — a doubled star, a slash, a star — which *closes a block
> comment*. The comment terminated mid-sentence and the file stopped parsing. Same family as the
> three NUL bytes: a character sequence that is invisible as prose and changes what the file means.
>
> **What is left in Phase 11, named:** the physical package move (mechanical, once the boundary is
> known to hold); refactoring `tool-executor`, `codebase-index` and `artifact-manager` onto the host
> interface so they can cross it; the `bin` entry that turns the CLI surface into a runnable binary;
> and the local daemon (M65).

> ### ✅ Closed 2026-08-03 — M63 complete; the CLI runs a real task
> `agent-core/host-executor.ts` (tool execution against `AgentHost`) · `agent-core/headless-run.ts` ·
> `agent-core/main.ts` · `bin/blackide` + the `bin` entry · `core/search-replace.ts` (extracted) ·
> `__tests__/headless-run.test.ts`.
> vitest **1 562/1 562 / 59 suites** (was 1 535/58) · harness **418/418** · eval green, no
> regression · `tsc -b` clean.
>
> | Gate clause | Status | Where |
> |---|---|---|
> | `blackide "…" --output pr` completes on a fixture repo with no editor | **met** | `__tests__/headless-run.test.ts` — real host, real executor, real files on a temp git repo; branch, commit and PR sequence asserted. The **model** is scripted, for §4.6's reason |
>
> **The blocker was never the `bin` entry.** It was that there was nothing for it to call: the loop
> takes an executor, and the only executor was `agent/tool-executor.ts`, which is 500 lines of editor
> — `WorkspaceEdit`, dirty-document saves, vision attachments, Playwright. M62 had already made the
> loop's import of it *type-only*, which is the whole point: the loop needs a shape. So this is the
> second implementation of that shape, and the second implementation is what proves the first was an
> interface rather than a description of one caller. Threading a host through the editor executor
> would instead have left every editor path in a class the CLI loads, and the boundary test would
> then be satisfied by a module that is mostly unreachable code.
>
> **Absence is answered, not silent.** A headless run has no language server, no index, no browser,
> no MCP. Each of those tools returns an explicit refusal naming the alternative, because an agent
> told "`go_to_definition` is unavailable; use `grep_search`" adapts in one turn while an agent handed
> an empty result concludes the symbol does not exist. They are also filtered out of the advertised
> list, so the refusal is the second line of defence rather than the first.
>
> **One algorithm, not two.** `applySearchReplace` moved to `core/search-replace.ts` and
> `ToolRunner` now delegates to it. Two copies of the code that decides where an agent's edit lands
> is the worst thing in this codebase to duplicate: they drift, and the drift is silent — a CI run
> writing something a local run would have refused is a difference nobody sees until it matters.
>
> **`--test-command`, added because the gate demanded a guess otherwise.** Verification decides the
> exit code, and detection reads the manifest. A monorepo package, a make target or a suite that
> needs a flag all detect as "no framework", which would make every headless run on such a repo exit
> 5 — and a gate that is always red is one people stop reading. An explicit command from the caller
> beats detection, because a CI job is an authority on its own suite.
>
> **A defect found by running the binary rather than by reading it.** `--output pr` against a repo
> with no `origin` wrote the commit, failed the push, printed the error — and **exited 0**. The
> publish sequence returned a branch name and let the exit code be computed from the agent's own
> verdict alone. That is precisely the failure `cli.ts` opens by warning about: a CLI that exits 0
> when it did not do what it was asked turns a red build green. `--output pr` means "leave me a PR";
> without one the run did not complete, whatever the agent thinks. Now exit 1, asserted.
>
> **And a second egress hole, in the check added six hours earlier.** The subprocess walk added with
> M60 looks for command literals in files that spawn — but `core/git-pr.ts` *builds* `git push` and
> spawns nothing, while `pipeline-entry.ts` and `headless-run.ts` spawn it and contain no literal.
> The first caller was caught only because it inlines its own push; the CLI's was registered because
> a human noticed, which is the failure mode a register exists to remove. There is now a third clause
> asserting that every importer of `buildPrCommands` is registered. Worth stating plainly: this is
> the second time in one day that the egress accounting was found not to cover a shape it claimed to,
> and both times the fix was to widen the enforcement rather than the prose.

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


> ### 🟡 Delivered 2026-08-02 — all four gate clauses met; M66, M70, M71 not started
> `core/org-policy.ts` · `core/egress.ts` · `core/task-sources.ts` ·
> `__tests__/phase12-gate.test.ts`.
> vitest **1 488/1 488 / 56 suites** (was 1 452/55) · harness **418/418** · eval green, no
> regression · `tsc -b` clean.
>
> **This phase's gate is four security clauses and nothing else, and all four are now tests.**
>
> | Gate clause | Status |
> |---|---|
> | The default build phones home to nobody | **met** — computed from the egress register, and a source walk fails on any undeclared network call |
> | An org policy cannot widen the deny list | **met** — and the property is asserted over the *whole structure*, not per field |
> | Nothing is posted externally without an explicit per-action confirmation | **met** — and there is no type through which a standing grant could be expressed |
> | Disabling the sink removes all egress | **met** — there is no default endpoint anywhere in the source |
>
> **"We don't phone home" is a claim about code that does not exist**, and you cannot test for the
> absence of a thing by looking at the thing. So `egress.ts` inverts it: every outbound destination
> is registered with a reason and a trigger, and a test walks the source for `fetch`/`https.request`/
> `WebSocket` and fails on anything not in the register. The claim becomes "the only egress is this
> list" — which is checkable, and the list is short enough to read.
>
> **It found two undeclared callers on its first run**, which is the normal state of such a list and
> exactly why it needs enforcing rather than writing down: `agent/model-fetcher.ts` (fetching a
> provider's model list when Settings asks) and `core/webview-message-handler.ts` (probing a local
> Ollama on loopback). Both are legitimate and both are now registered. The register also
> distinguishes egress that **is the feature the user asked for** from egress that happens *because
> we decided it should* — only the second is phoning home, and there is none. Recording both kinds,
> labelled, is what stops the claim being a word game: "we send no telemetry" is easy to say while
> sending everything else.
>
> **M69 — tighten-only, and the sentinel that would have broken it.** An org policy file arrives with
> a `git pull`, from anyone with commit access, and is precisely what a prompt injection (M56) would
> try to write. If merging could widen, then committing `.blackide/policy.json` with
> `autoApprove: true` bypasses G1, G3 and the mode allowlists in one change that looks like
> configuration. So booleans only go false-ward, permission lists only shrink, prohibition lists only
> grow — and a policy that asks to widen is **clamped and reported**, not errored, because a policy
> file that can cause an outage is one an org stops deploying.
>
> The bug this nearly shipped with is `sessionTokenBudget`, where **0 means unlimited**. `Math.min`
> is the obvious merge and it is wrong in the dangerous direction: `min(0, 50_000)` is 0, so an org
> imposing a 50 000-token ceiling on a user who had none would have *removed* the ceiling. A sentinel
> meaning infinity while sorting as the smallest number is exactly the kind of thing that passes
> review, which is why the tighten-only property is asserted as a single **capability score** over
> the whole structure rather than field by field — a per-field test passes forever and cannot catch
> the next field added with the direction reversed.
>
> **M67 — the parser refuses to guess.** A bare `ENG-45` is equally a Linear id, a Jira key and a
> branch name; resolving it means a request to a tracker the user does not use, with their token
> attached. Only a URL or an explicit `#n` counts. `#fff` and `#introduction` are not issues either.
>
> **M67/M68 — the confirmation cannot be granted in advance, and the type is the enforcement.**
> E8 set the rule: "**never** an ambient bot posting without the user asking". The natural product
> request is a "don't ask me again" checkbox, and it is exactly what turns this into an ambient bot —
> the tenth post authorised by a click from three weeks ago on a different repository. So
> `OutboundContext` has no field for a remembered answer. A caller *cannot* express one, and adding
> ambient posting later means changing that type, which is a change a reviewer sees. A test asserts
> the absence of `alwaysAllow`/`remember`/`dontAskAgain` in the type.
>
> The confirmation also carries the body **verbatim** rather than a summary, because a prompt that
> says "post a comment to issue #123?" asks the user to approve something they have not read, and the
> entire value of the gate is that they read it.
>
> **The analytics projection is an allowlist, not a redaction pass.** The payload is derived from the
> Phase 9 audit trail, which is already redacted (M54) — but redaction answers "does this look like a
> secret", and this answers a different question: an org's sink should learn how much the team used
> the agent, not what they were working on. Eight fields, named. That is the only formulation that
> survives somebody adding a field to the audit trail later.
>
> **What is left in Phase 12, named:** remote/BYO-runner execution (M66 — unblocked by Phase 11's
> host seam, blocked by the runner Phase 11 did not finish), the per-tracker fetchers and a Slack
> transport (M67/M68's wiring), domain verticals (M70 — E17 says ship only if a real user pulls for
> them, and none has), and voice (M71, P3, "genuinely low value for us").

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

**Baseline status as of rev 6 (2026-08-01).** Every deterministic metric is recorded in
`eval/baseline.json` and gated. The four rows still marked ⚠ have **no number and cannot get one from
a deterministic harness** — all four need real model calls, which is the model tier specified in
§4.6. They are unfalsifiable *today*, and §4.6 is what changes that; they are no longer filed as
eval-set debt, because the eval set is not what is missing.

| Metric | Baseline (Phase 0) | Target | Proven in |
|---|---|---|---|
| Task success rate, per stack | ⚠ unrecorded — needs the model tier | +20 pts | 3, 5, 10 |
| Recall@10 for "files that must change" | **recorded: 93.1% → 97.2%**, gated (residual error −59%) | +25% → restated, met | 3 |
| Tokens per completed task | ⚠ unrecorded — needs the model tier | −40% | 3, 4 |
| Symbol-question accuracy (LSP vs grep) | ⚠ unrecorded — needs the model tier | +30% | 1 |
| Test-failure feedback size | recorded: 30 KB → <2 KB asserted in CI | −95% (50 KB → <2 KB) | 1 |
| Index build time | **recorded 2026-08-01: 1 247 ms / 5 000 files** (warm rebuild 444 ms) | ≤2 s per 5 000 | 3 |
| Silently-wrong fast-apply edits | **0 by construction** — five refusal classes asserted; the model-call half needs §4.6 | **0** (hard gate) | 4 |
| Stack detection accuracy | **recorded: 100% (13/13)**, gated | hold | 0, 3 |
| Skill exact-match / any-hit rate | **recorded: 100% / 100%**, gated | hold while breadth grows | 0, 10 |
| Fail-safe: no stack → no skill injection | **recorded: 1/1**, gated | hold | 0 |
| Next-edit acceptance rate | ⚠ unrecorded — needs the model tier (§4.6); **the instrument shipped 2026-08-02** (`NextEditStats`, `black-ide.nextEdit.showStats`) | ≥25% of shown | 5 |
| Next-edit p50 latency | ⚠ unrecorded — needs the model tier; budget enforced at 1.5 s and a late prediction is discarded rather than shown | ≤250 ms | 5 |
| Next-edit: share of accepted that is multi-line or cross-file | ⚠ unrecorded — needs the model tier; `crossFile`/`multiLine` are computed per prediction and counted | ≥40% | 5 |
| Predictions surviving a buffer change | **recorded: 0 by construction** — version-stamped at request, re-checked before showing and again before applying; gated | **0** (hard gate) | 5 |
| Summarization dropping a pending approval or tool result | **recorded: 0 by construction** — refuses while an approval is open; orphan-result invariant asserted at every recency window | **0** (hard gate) | 5 |
| Wrong-idiom rate — *skill injection* half | **recorded 2026-08-01: 0 leaks / 33 guarded tasks**, gated as a ceiling | hold at 0 | 0, 10 |
| Wrong-idiom rate — *model behaviour* half (raw SQL where the ORM is idiomatic) | ⚠ unrecorded — needs the model tier (§4.6) | −50% | 10 |
| Reviewer precision | n/a | ≤1 FP per 10 findings | 9 |
| Runs with verification evidence | 0% | 100% pipeline / ≥80% chat builds | 7 |
| Cross-session memory reuse | ~0 | ≥70% of eligible facts | 8 |
| Injection-fixture escalations | untested | **0** (hard gate) | 9 |

### 4.6 The model tier — the one thing phases 0–4 still need

*Added 2026-08-01, when it became the only outstanding item in five delivered phases.*

Four of §4.2's rows and Phase 1's last gate all need the same thing: **an opt-in tier of the eval
harness that spends real model calls.** It is written up here, as a capability with a shape and a
cost, because four revisions of filing it under "M3, still short" have not produced it — and because
it is not phase work. Making it a phase task would hang five phases' deterministic gates off a
non-deterministic runner.

**What it unblocks (and nothing else does):**

| Blocked item | Why a deterministic harness cannot answer it |
|---|---|
| "Symbol questions resolve via **LSP not grep**" (Phase 1's 6th gate) | It is a claim about what the model *chooses* when both tools are offered. |
| Task success rate per stack (+20 pts) | Requires running tasks to completion and scoring the result. |
| Tokens per completed task (−40%) | There are no tokens without a model. |
| Symbol-question accuracy (LSP vs grep, +30%) | Same as the gate above, measured rather than asserted. |
| Wrong-idiom rate, *model-behaviour* half | The injection half is now measured deterministically (0/33); whether the agent then writes raw SQL where the ORM is idiomatic is a model behaviour. |
| Next-edit p50 latency, acceptance rate, and multi-line/cross-file share (added 2026-08-02, Phase 5) | All three are properties of predictions a model produced. The engine's refusals are deterministic and gated; whether a *shown* prediction is any good, and how fast it arrived, is not. `NextEditStats` computes all three — it has no samples to compute them from without the tier. |

**What it needs, concretely.** A `--models` flag on `eval/run-eval.js` that is **off by default and
never runs in CI on a fork**; a key source that is explicitly not the user's own configured key (a
CI secret, or an env var the developer sets deliberately); a per-run **budget cap** in tokens with a
hard stop, because an eval loop that can spend without bound will; N-run repetition with reported
variance rather than a single sample, since one run of a non-deterministic system is an anecdote; and
a results file *separate from* `eval/baseline.json`, so a noisy metric can never fail the
deterministic gate that guards every other phase.

**The judgement call this section exists to record.** The temptation is to fold model metrics into
the existing gate so the roadmap can show numbers for every row. That would make the one gate that
currently blocks bad merges — deterministic, fast, free, green — into one that fails intermittently
for reasons nobody can reproduce. A gate that fails randomly gets switched off, and then nothing is
guarded. Separate tiers, separate baselines, and the honest ⚠ marks stay in §4.2 until the tier
exists.

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
