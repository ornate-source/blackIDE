# Black IDE — Pending Tasks

**Derived from:** [`enhancement.md`](./enhancement.md) rev 16 (2026-08-04) · **canonical for open
work** — what exists rather than what is missing is [`features.md`](./features.md); see
[`README.md`](./README.md) for who owns what.
**Audited against the tree:** 2026-08-04 — every row below was re-checked in code, not read off the
previous revision's claims.
**Baseline at audit time:** `tsc -b` clean · vitest **1 946/1 946 / 72 suites** · harness 418/418 ·
eval green, no regression vs `eval/baseline.json` · webview builds · `extension.ts` **698 LOC**
(≤700 gate).

---

## 0. Where the roadmap stands

| Phase | Status | Open | Closed since the last audit |
|:--:|:--:|:--:|---|
| 0 | ✅ | — | |
| **1** | ✅ | **0** | **P1-1** — the LSP-over-grep gate is measured, with a floor |
| 2–10 | ✅ | — | |
| **8** | ✅ | **0** | **P8-1 (M41)** · **P8-2 (M45)** |
| **9** | ✅ | **0** | **all seven** — P9-1 (M57) · P9-2 (M47) · P9-3 (M49) · P9-4 (M50) · P9-5 (M51) · P9-6 (M48) · P9-7 (M58) |
| **11** | 🟡 | **1** | P11-1 (M62 boundary) · P11-3 (M65 daemon) |
| **12** | ✅ | **0** | P12-1 (M67) · P12-2 (M68) · P12-3 (M66); P12-4/P12-5 resolved as positions |
| — | — | — | **X-1** — the model tier, named in sixteen revisions and blocking five phases |

**One task is open.** Eighteen were open at the last audit.

| Pri | Count | Tasks |
|:--:|:--:|---|
| P1 | 1 | **P11-2** (M62 — the physical package move) |

Nothing claimed as delivered was found missing. Two items previously carried as ❌ are now recorded
as **deliberate positions** rather than debt — see §3.

---

## 1. The one open task

### P11-2 — Physical package move to `packages/agent-core/` · **P1 · Phase 11**

| # | Task | M | Pri | Depends on | Acceptance |
|:--:|---|:--:|:--:|---|---|
| **P11-2** | Move the core into a publishable package | M62 | P1 | ~~P11-1~~ **(done)** | The package builds and is consumable on its own; harness green throughout |

**The dependency is cleared.** P11-1 closed on 2026-08-04: the boundary is transitively enforced,
60 modules are reachable from `agent-core/index.ts`, and none of them imports `vscode`. The floor
in `agent-core-boundary.test.ts` rose 45 → 60 rather than falling, which is what the clause asked
for.

**What the previous revisions got wrong about this task, and the correction.** It has been
described as "mechanical, once the boundary is known to hold" and "merely large before it". Now
that the boundary does hold, the cost can be measured instead of estimated, and it is larger than
"mechanical" implies:

- The reachable set is **60 files, 50 of them in `src/core/`** — a directory of about 90. The move
  splits it in half, and the 40 modules left behind would import their moved neighbours across a
  package boundary.
- **45 `path.join(DIST, …)` requires** in `test/harness.js` and `eval/*.js` point at compiled paths
  that move.
- `package.json`'s `main`, `bin/blackide` and the whole `dist/` layout shift, because covering two
  source roots changes `rootDir` and `dist/core/x.js` becomes `dist/src/core/x.js`.

**How it should be done.** As an npm **workspace** — `packages/agent-core` with its own
`package.json` and `tsconfig`, resolved through `node_modules` so a runtime `require` works without
a bundler or a path-alias shim — in **one change**, with the harness green at each step. §4.7 of
`enhancement.md` records this in full.

**What it must not be is a half-move.** A repository with part of `core/` inside a package and part
outside is worse than either end state, and "mechanical" is exactly the estimate that invites
someone to start it and stop.

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
| **P11-3** | M65 | `blackide daemon` / `blackide queue`, file-based, claim-by-rename, results in the inbox |
| **P12-1** | M67 | Three fetchers, reachable only through a `kind` a URL or explicit `#n` supplied |
| **P12-2** | M68 | A Slack forward with no `send` — it builds an action and stops |
| **P12-3** | M66 | BYO runner with **no default endpoint**; a runner that will not say which tier it enforced is refused |

---

## 3. Corrections to the previous revision

Three places where doing the work showed the task description was wrong. Recorded because a
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
