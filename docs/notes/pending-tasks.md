# Black IDE — Pending Tasks

**Derived from:** [`enhancement.md`](./enhancement.md) rev 15 (2026-08-04) · **canonical for open
work** — what exists rather than what is missing is [`features.md`](./features.md); see
[`README.md`](./README.md) for who owns what.
**Audited against the tree:** 2026-08-04 — every open row below was re-checked in code, not read off
the previous revision's claims.
**Baseline at audit time:** `tsc -b` clean · vitest **1 629/1 629 / 62 suites** · harness 418/418 ·
eval green, no regression vs `eval/baseline.json` · webview builds · `extension.ts` **699 LOC**
(≤700 gate).

**Organised by phase.** The previous revision ordered this list by execution wave, which was right
while three phases were being closed in parallel and is wrong now: what is left is four phases'
worth of independent work, and the question a reader arrives with is "what is missing from phase N".
The wave a task belongs to is a column.

---

## 0. Where the roadmap stands

| Phase | Status | Open | Closed since the last audit |
|:--:|:--:|:--:|---|
| 0 | ✅ | — | |
| **1** | 🟡 | 1 | — · blocked on the model tier (§4.6), not on effort |
| 2–6 | ✅ | — | |
| **7** | ✅ | **0** | **T6 (M40 visual capture) · T7 (M38 review panel)** — the phase closed 2026-08-04 |
| **8** | 🟡 | 2 | |
| **9** | ❌ | 7 | |
| 10 | ✅ | — | T1 (M61) · T2 (M60) closed 2026-08-03 |
| **11** | 🟡 | 3 | T3 (M63 CLI) closed 2026-08-03 |
| **12** | 🟡 | 5 | |

**Eighteen tasks are open across five phases**, plus one cross-cutting capability (§4.6). Three of
the eighteen are recommended won't-dos rather than work — see §6.

| Pri | Count | Tasks |
|:--:|:--:|---|
| P1 | 7 | P1-1 · P9-1 (M57) · P9-2 (M47) · P9-3 (M49) · P11-1 · P11-2 (M62) · X-1 (§4.6) |
| P2 | 6 | P8-1 (M41) · P9-4 (M50) · P9-5 (M51) · P9-6 (M48) · P11-3 (M65) · P12-1 (M67) |
| P3 | 6 | P8-2 (M45) · P9-7 (M58) · P12-2 (M68) · P12-3 (M66) · P12-4 (M70) · P12-5 (M71) |

Nothing claimed as delivered was found missing.

---

## 1. Phase 1 — Language-server tools & tests *(1 open)*

| # | Task | M | Pri | Depends on | Acceptance |
|:--:|---|:--:|:--:|---|---|
| **P1-1** | Assert the **LSP-over-grep** gate: symbol questions resolve through the language server rather than a text search | M6/M7 gate | P1 | **§4.6** | The gate is measured on the eval set rather than asserted in prose |

The tools themselves shipped — eight of them in `tools/lsp-tools.ts`, with rename across six files
asserted in a real extension host. What is missing is the *measurement*, and it needs a tier of the
eval harness that spends real model calls. This is the same blocker as §4.2's ⚠ rows and is tracked
once, at **X-1**.

---

## 2. Phase 8 — Memory v2 *(2 open)*

| # | Task | M | Pri | Depends on | Acceptance |
|:--:|---|:--:|:--:|---|---|
| **P8-1** | Model-driven **end-of-turn extraction** — produce memory candidates from a finished turn | M41 | P2 | **§4.6** for its accuracy gate | Candidates arrive from a turn; `sortCandidates`' three bands and the content filter already judge them |
| **P8-2** | Memory **visualization panel** | M45 | P3 | — | Entries, confidence, provenance and status are browsable; the data all exists already |

**P8-1 is half-built and the built half is the hard one.** `sortCandidates` already bands candidates
(auto ≥0.8 / confirm ≥0.5 / drop) and filters out transcript narration, task restatements and
questions. What is missing is the producer — a model call at end of turn — which is why the
milestone is 🟡 rather than ❌ and why its *accuracy* clause is blocked on the same tier as P1-1.

---

## 3. Phase 9 — Review automation, MCP parity & hardening *(7 open — the largest remaining phase)*

The security spine of this phase shipped: redaction, untrusted-content posture, the workspace-boundary
guard, circuit breakers, the audit trail. What is left is the Reviewer agent, MCP transport parity
and the sandbox.

| # | Task | M | Pri | Depends on | Acceptance |
|:--:|---|:--:|:--:|---|---|
| **P9-1** | **Sandboxed execution tiers** — policy → restricted (cwd-jailed, env-scrubbed, no-network, capped) → contained | M57 | P1 | — | A tier-2 command cannot reach the network, asserted rather than configured; unattended pipeline runs default to restricted or better |
| **P9-2** | **Reviewer mode + `black-ide.reviewChanges`** on the working diff → a review artifact; high-confidence findings offer a checkpointed fix | M47 | P1 | **P9-1** | Read-only allowlist enforced *at the executor*; findings land as a typed artifact in the review panel; ≥60% TP at ≤1 FP per 10 findings *(the rate needs §4.6 to measure)* |
| **P9-3** | **MCP streamable HTTP + SSE transports + OAuth** | M49 | P1 | — | A remote MCP server works; a transport failure degrades with a visible reason rather than hanging |
| **P9-4** | **MCP resources & prompts primitives** | M50 | P2 | P9-3 | Resources readable as context; prompts listed and invocable |
| **P9-5** | **MCP vetted allowlist for pipeline runs** | M51 | P2 | P9-3 | An unvetted server stays refused in an unattended run (G3's default holds); vetting is per server and explicit |
| **P9-6** | Opt-in **`gh` PR review** | M48 | P2 | P9-2 | Never ambient — posts only through the M67/M68 per-action confirmation, which cannot be granted in advance |
| **P9-7** | Optional **at-rest encryption** for `.blackIDE/` | M58 | P3 | — | Off by default; enabling it breaks neither the audit trail's append-only property nor the memory markdown's byte-stable round-trip |

**Sequencing inside the phase: P9-1 before P9-2.** The Reviewer runs under a read-only allowlist, and
sandbox tiers are the mechanism that makes "read-only" structural rather than advertised. Same
argument as M56's: a gate that content can reach is not a gate.

**P9-2 emits into the panel Phase 7 just built.** That ordering was the reason to close Phase 7
first, and it now holds — the Reviewer needs a `review` artifact type and a renderer, and both exist.

---

## 4. Phase 11 — Headless core, CLI & SDK *(3 open)*

| # | Task | M | Pri | Depends on | Acceptance |
|:--:|---|:--:|:--:|---|---|
| **P11-1** | Refactor `tool-executor`, `codebase-index`, `artifact-manager` onto the **host interface** | M62 | P1 | — | Each crosses the boundary; `agent-core-boundary.test.ts`'s floor **rises** rather than falls |
| **P11-2** | Physical package move to **`packages/agent-core/`** | M62 | P1 | P11-1 | Mechanical, once the boundary is known to hold; harness green throughout |
| **P11-3** | Local **daemon** driving headless runs, results in the inbox | M65 | P2 | — | A daemon run's results appear in the inbox — the phase's fourth gate clause |

**P11-1 before P11-2, and not the other way round.** The boundary is declared and transitively
enforced today; moving files before the last three modules cross it turns a compile-time property
into a merge conflict. The move is mechanical *after* the refactor and merely large before it.

---

## 5. Phase 12 — Remote execution, integrations & long tail *(5 open)*

All four of this phase's privacy/authority gate clauses are already met and enforced by tests. What
is open is feature surface, not posture.

| # | Task | M | Pri | Depends on | Acceptance |
|:--:|---|:--:|:--:|---|---|
| **P12-1** | Per-tracker **fetchers** (GitHub Issues / Linear / Jira) behind `core/task-sources.ts` | M67 | P2 | — | Still refuses to guess a tracker from a bare key; each fetcher declared in the egress register |
| **P12-2** | **Slack transport** for completion notices | M68 | P3 | P12-1 | Outbound goes through the per-action confirmation; no `alwaysAllow` field can express a standing grant |
| **P12-3** | **Remote / BYO-runner** execution | M66 | P3 | **P11-3** | Opt-in; we do not become a data processor by default |
| **P12-4** | Domain verticals | M70 | P3 | — | **Recommend won't-do** — see §6 |
| **P12-5** | Voice input | M71 | P3 | — | Scheduled last, deliberately — see §6 |

---

## 6. Cross-cutting, and the three that should not be built

### X-1 — The model tier (§4.6) · **P1 · not phase work**

| # | Task | Pri | Unblocks |
|:--:|---|:--:|---|
| **X-1** | `--models` on `run-eval.js`: off by default, its own baseline, a budget cap, N-run variance | P1 | **P1-1** · **P8-1**'s accuracy clause · **P9-2**'s TP/FP rate · 8 of §4.2's ⚠ rows |

The single prerequisite named most often in the roadmap, and the one thing fifteen revisions of "M3,
still short" have not produced. It is a harness capability with a cost model — keys in CI, a budget
per run, non-determinism to control — and it **must not become a phase task**: hanging five phases'
deterministic gates off a non-deterministic runner is how a green gate becomes a disabled gate.

### Recommended won't-dos

| # | Task | M | Why |
|:--:|---|:--:|---|
| **P12-4** | Domain verticals | M70 | E17's own condition is "ship only if a real user pulls for it." Fifteen revisions, no pull. Carrying it as ❌ implies debt where there is a deliberate position; **§4.5 is where it belongs** |
| **P12-5** | Voice input | M71 | "Genuinely low value for us, scheduled last." Keep it scheduled last rather than promoting it |
| **P9-7** | At-rest encryption | M58 | Not a won't-do — but it is the one P3 whose *cost* is in the invariants it must not break (append-only audit, byte-stable memory round-trip), so it should be sized before it is scheduled |

---

## 7. Progress log

| Date | Phase | Delivered | Evidence |
|---|:--:|---|---|
| 2026-08-03 | — | Audit; this document | Baseline re-verified: vitest 1 488/56 |
| 2026-08-03 | 10 | **T1 (M61)** — `read_notebook`/`edit_notebook_cell` registered; `read_file`/`edit_file` now refuse a `.ipynb` | vitest 1 511/57 · harness 418/418 · eval green |
| 2026-08-03 | 10 | **T2 (M60)** — `tools/skill-fetch.ts` + `black-ide.addSkillFrom`, https-only transport check | vitest 1 535/58 · harness 418/418 · eval green |
| 2026-08-03 | 10 | **T0** — Phase 10 → ✅; M60/M61 inventory rows corrected | §3 and the summary table now agree |
| 2026-08-03 | 11 | **T3 (M63)** — `host-executor.ts` + `headless-run.ts` + `bin/blackide`; the CLI runs a real task | vitest 1 562/59 · harness 418/418 · eval green · fixture-repo run branches, commits, verifies |
| 2026-08-03 | 7 | **T4 + T5 (M40)** — verification wired into the pipeline and chat lanes; two Phase 7 gate clauses met | vitest 1 577/60 · harness 418/418 · eval green |
| 2026-08-04 | 7 | **T6 (M40)** — visual capture: `core/visual-capture.ts` + `agent/visual-capture.ts`, wired into all three lanes; a UI change lands `verified` when capture succeeds and `incomplete` **with a reason** when it does not | vitest 1 604/61 · harness 418/418 · eval green |
| 2026-08-04 | 7 | **T7 (M38)** — the artifact review panel: `core/artifact-review.ts` + a third Manager tab; a region comment reaches the running agent on its next turn. **Phase 7 → ✅** | vitest 1 629/62 · harness 418/418 · eval green · webview builds |

**Found while closing Phase 7, and fixed here rather than filed:**

1. **`evaluateVerification` reported `incomplete` without saying why.** The outcome named what was
   missing (`screenshot`) and never why it was missing, so the same word covered "the browser is
   switched off", "no dev server was listening" and "Playwright is not installed" — three different
   afternoons. `Evidence.visualUnavailable` now carries the reason into the summary and the report.
2. **`SteeringQueue` has accepted `artifactPath` and `region` since Phase 7 and nothing supplied
   them.** The only caller was a `window.prompt` behind the Steer button, which cannot know what the
   user is reading. The fields were designed for the panel that had not been built; both halves now
   exist, and the region is capped on a line boundary so quoting a plan back at the agent cannot
   displace the budget the correction needs.
3. **A comment on a finished run had no defined behaviour.** The registry's `steer` refuses one —
   correctly — but the review surface is used mostly *after* a run ends, so refusing outright would
   have made the panel useless for its main case. Comments now always persist on the artifact and are
   marked delivered only when a queue actually took them, with the panel stating which happened.
4. **`extension.ts` is at 699 of its 700-line gate.** The review panel needed no new lines there
   because the provider already exposed `artifacts` and `taskAgents`, but the next feature that needs
   a field will hit the gate. Worth naming now rather than discovering it inside an unrelated change.
