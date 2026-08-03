# Black IDE — Pending Tasks

**Derived from:** [`enhancement.md`](./enhancement.md) rev 14 (2026-08-02)
**Audited against the tree:** 2026-08-03 — every row below was checked in code, not read off the
previous revision's claims.
**Baseline at audit time:** `tsc -b` clean · vitest **1 488/1 488 / 56 suites** · harness 418/418 ·
eval green.

---

## 0. What the audit found

The roadmap's own status is accurate. Twelve of the seventy-one gaps are open, spread across five
phases, plus one cross-cutting capability (§4.6). Nothing claimed as delivered was found missing.

Two rows the rev-14 summary table rounds up deserve naming, because the summary marks **Phase 10 ✅**
while its own inventory (§3, M60/M61) marks both milestones 🟡:

| Claim in §3 | Verified 2026-08-03 |
|---|---|
| M61 — `edit_notebook_cell` not registered in the executor | **confirmed** — `grep notebook src/agent/tool-executor.ts src/core/tools.ts` is empty. `core/notebook.ts` is 100% dead code from the agent's point of view. |
| M60 — `black-ide.addSkillFrom` not wired | **confirmed** — the identifier does not appear anywhere in `src/` or `package.json`. |

So **Phase 10 is 🟡, not ✅**, and the summary table should say so. That correction is task **T0**.

### Open gaps, by priority

| Pri | Count | IDs |
|:--:|:--:|---|
| P1 | 6 | M38 · M40 · M47 · M49 · M57 · M62 · M63 (partial halves) |
| P2 | 6 | M48 · M50 · M51 · M60 · M61 · M65 · M67 · M68 |
| P3 | 4 | M45 · M58 · M66 · M70 · M71 |
| — | 1 | §4.6 model tier (harness capability, not phase work) |

---

## 1. The task list

Ordered by execution wave, not by milestone number. Dependencies are inside the table.

### Wave A — close the cheap partials *(unblocks two phase closes)*

| # | Task | M | Phase | Pri | Depends on | Acceptance |
|:--:|---|:--:|:--:|:--:|---|---|
| **T0** | Correct the rev-14 summary table: Phase 10 → 🟡 | — | 10 | P1 | — | The summary row and §3 agree |
| **T1** | Register `edit_notebook_cell` + `read_notebook` in the executor, gated by the mode allowlist and tool toggles | M61 | 10 | P2 | — | An agent can edit a cell; outputs still excluded from prompts; round-trip stays byte-stable; refused when the mode disallows it |
| **T2** | Wire `black-ide.addSkillFrom` onto `core/skill-registry.ts` — pinned ref, checksum, forbidden-key deny list, declared egress | M60 | 10 | P2 | T1 | A pack installs from a pinned ref; a moving ref is refused; a checksum mismatch refuses **before** content is examined; the fetch is in the egress register |
| **T3** | Ship the CLI `bin` entry so `blackide "…" --output pr` runs a real task | M63 | 11 | P1 | — | Completes on a fixture repo with no editor; JSON-per-line on stdout; exit codes distinguish completed-unverified from completed |

### Wave B — Phase 7's outstanding gate clauses *(the review story)*

| # | Task | M | Phase | Pri | Depends on | Acceptance |
|:--:|---|:--:|:--:|:--:|---|---|
| **T4** | Wire `verify-runner` into the **pipeline** lane | M40 | 7 | P1 | — | 100% of pipeline runs emit a `test-report` artifact, including the `unverifiable` path |
| **T5** | Wire verification into **chat build tasks** | M40 | 7 | P1 | T4 | ≥80% of chat build tasks emit verification evidence; a non-build chat turn does not pay for it |
| **T6** | Visual capture: satisfy `planVerification`'s screenshot requirement for UI changes | M40 | 7 | P1 | T4 | A UI change lands `verified` rather than `incomplete` when capture succeeds, and still `incomplete` when it does not |
| **T7** | Artifact **review panel** — browse by run, by type; comment on a region → `core/steering.ts` | M38 | 7 | P1 | — | A comment on an artifact region reaches the running agent within one turn (the M39 path, driven from a real surface rather than the Steer button) |

### Wave C — Phase 9's larger half

| # | Task | M | Phase | Pri | Depends on | Acceptance |
|:--:|---|:--:|:--:|:--:|---|---|
| **T8** | **Sandboxed execution tiers** — policy → restricted (cwd-jailed, env-scrubbed, no-network, capped) → contained | M57 | 9 | P1 | — | A tier-2 command cannot reach the network (asserted); unattended pipeline runs default to restricted or better |
| **T9** | **Reviewer mode + `black-ide.reviewChanges`** on the working diff → review artifact; high-confidence findings offer a checkpointed fix | M47 | 9 | P1 | T7 | Read-only allowlist enforced at the executor; findings land as a typed artifact; ≥60% TP at ≤1 FP per 10 findings *(needs §4.6 to measure)* |
| **T10** | **MCP streamable HTTP + SSE transports + OAuth** | M49 | 9 | P1 | — | A remote MCP server works; a transport failure degrades with a visible reason rather than hanging |
| **T11** | **MCP resources & prompts primitives** | M50 | 9 | P2 | T10 | Resources readable as context; prompts listed and invocable |
| **T12** | **MCP vetted allowlist for pipeline runs** | M51 | 9 | P2 | T10 | An unvetted server stays refused in an unattended run (G3 default holds); vetting is per server and explicit |
| **T13** | Opt-in `gh` PR review | M48 | 9 | P2 | T9 | Never ambient — posts only through the M67/M68 per-action confirmation, which cannot be granted in advance |
| **T14** | Optional at-rest encryption for `.blackIDE/` | M58 | 9 | P3 | — | Off by default; enabling it does not break the audit trail's append-only property or the memory markdown's byte-stable round-trip |

### Wave D — Phase 11/12 structure

| # | Task | M | Phase | Pri | Depends on | Acceptance |
|:--:|---|:--:|:--:|:--:|---|---|
| **T15** | Refactor `tool-executor`, `codebase-index`, `artifact-manager` onto the host interface | M62 | 11 | P1 | T3 | Each crosses the boundary; `agent-core-boundary.test.ts` floor rises rather than falls |
| **T16** | Physical package move to `packages/agent-core/` | M62 | 11 | P1 | T15 | Mechanical, once the boundary is known to hold; harness green throughout |
| **T17** | Local **daemon** driving headless runs, results in the inbox | M65 | 11 | P2 | T3 | A daemon run's results appear in the inbox (the phase's 4th gate clause) |
| **T18** | Per-tracker fetchers (GitHub Issues / Linear / Jira) behind `core/task-sources.ts` | M67 | 12 | P2 | — | Still refuses to guess a tracker from a bare key; each fetcher declared in the egress register |
| **T19** | Slack transport for completion notices | M68 | 12 | P3 | T18 | Outbound goes through the per-action confirmation; no `alwaysAllow` field can express a standing grant |
| **T20** | Remote / BYO-runner execution | M66 | 12 | P3 | T17 | Opt-in; we do not become a data processor by default |

### Wave E — deliberately last

| # | Task | M | Phase | Pri | Note |
|:--:|---|:--:|:--:|:--:|---|
| **T21** | Memory visualization panel | M45 | 8 | P3 | The data (entries, confidence, provenance, status) all exists |
| **T22** | Domain verticals | M70 | 12 | P3 | E17: **ship only if a real user pulls for it.** None has. Recommend a formal won't-do until one does |
| **T23** | Voice input | M71 | 12 | P3 | "Genuinely low value for us, scheduled last" |
| **T24** | **§4.6 model tier** — `--models` on `run-eval.js`, off by default, separate baseline, budget cap, N-run variance | — | 0/1 | P1 | Unblocks Phase 1's 6th gate, M41's extractor, and 8 of §4.2's ⚠ rows. Not phase work — a harness capability with a cost model |

---

## 2. Sequencing rationale

**Why Wave A first.** T1–T3 are hours, not days, and each one converts a module that already exists
and is already tested into a capability the agent can actually reach. `core/notebook.ts` is fully
built and unreachable; that is the cheapest value in the document.

**Why Phase 7 before Phase 9.** T7's review panel is the surface T9's Reviewer agent emits into.
Building the Reviewer first means building a second ad-hoc renderer and then deleting it.

**Why T8 before T9.** The Reviewer runs a read-only allowlist; sandbox tiers are the mechanism that
makes "read-only" structural rather than advertised. Same argument as M56's: a gate that content can
reach is not a gate.

**What stays blocked.** T24 blocks Phase 1's LSP-over-grep gate, M41's extractor, and the ⚠ rows in
§4.2. It is the single prerequisite named most often in the roadmap and the one thing four revisions
of "M3, still short" did not produce. It is not a phase task and must not become one — hanging five
phases' deterministic gates off a non-deterministic runner is how a green gate becomes a disabled
gate.

**Recommend a formal won't-do for T22.** E17's own condition ("ship only if a real user pulls for
it") has not been met in fourteen revisions. Carrying it as ❌ implies debt where there is a
deliberate position; §4.5 is where it belongs.

---

## 3. Progress log

| Date | Wave | Delivered | Evidence |
|---|---|---|---|
| 2026-08-03 | — | Audit; this document | Baseline re-verified: vitest 1 488/1 488 / 56, `tsc -b` clean |
| 2026-08-03 | A | **T1 (M61)** — `read_notebook`/`edit_notebook_cell` registered; `read_file`/`edit_file` now refuse a `.ipynb` | vitest 1 511/57 · harness 418/418 · eval green |
| 2026-08-03 | A | **T2 (M60)** — `tools/skill-fetch.ts` + `black-ide.addSkillFrom`, https-only transport check | vitest 1 535/58 · harness 418/418 · eval green |
| 2026-08-03 | A | **T0** — Phase 10 → ✅; M60/M61 inventory rows corrected | §3 and the summary table now agree |

**Found while doing Wave A, and fixed here rather than filed:**

1. **`read_file`/`edit_file` were reachable for notebooks and wrong on them.** The milestone was
   filed as "register a tool"; the actual exposure was that the *generic* tools would corrupt an
   `.ipynb`. Both refuse now.
2. **`git push` and `gh pr create` were undeclared egress.** Phase 12's register claims "the only
   egress is this list" and enforces it with a source walk for `fetch`/`https.request`/`WebSocket` —
   which structurally cannot see a subprocess. `agent/pipeline-entry.ts` has been pushing to a remote
   since Phase 6. Both registered, and `phase12-gate.test.ts` gained a second walk for
   network-capable subprocesses so the gap cannot reopen.
3. **`validateEntry` never checked the transport**, because nothing had ever fetched. `ext::` is RCE.
   `validateSource` now allowlists https alone, and is applied on the registry path too.
