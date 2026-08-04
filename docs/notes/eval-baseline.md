# Black IDE — Golden-Task Eval Baseline

**Recorded:** 2026-07-27 · **Phase:** 0 (M3), re-recorded after the F1/F2 fixes · **Commit state:** `dev`
**Runner:** `npm run eval` (gate) · `npm run eval:record` (re-record) · raw data in
`src/stable/extensions/black-ide-agent/eval/baseline.json`

This is the number every later phase has to move. From here on, a phase that does not
shift a metric does not ship — see [`enhancement.md`](./enhancement.md) §4.

> **Read this as a baseline, not as a status.** Every figure below is what the harness measured on
> **2026-07-27**, kept as written so the comparison stays honest. The current numbers are in the
> table immediately below, and `npm run eval` prints them.

## Where the metrics stand today (2026-08-04)

| Metric | Baseline (2026-07-27) | Now | Moved by |
|---|:--:|:--:|---|
| Golden tasks / fixtures | 19 / 8 | **112 / 21** | Phase 0 → 74/13, Phase 10 → 112/21 (every pack needs a task) |
| Bundled skill packs | 16 | **47** | Phase 10 (M59) |
| Stack detection accuracy | 100% (8/8) | **100% (21/21)** | held across 13 more fixtures |
| Skill exact-match rate | 100% | **100%** | held as the corpus grew |
| Known library gaps | 4 | **16** | the corpus grew faster than the library; each is a named task with no suitable pack |
| Fail-safe (no stack → no injection) | 1/1 | **1/1** | held by test + gate |
| Wrong-idiom leakage | *(not yet measured)* | **0% of 38 guarded tasks** | Phase 0 added the metric |
| recall@5 / @10 / @20 | 84.7 / 93.1 / 94.4 | **91.2 / 97.2 / 100** | Phase 3 (symbol chunking, graph, rerank) |
| Tool-output compaction | *(not yet measured)* | **36.9%** realistic · 81% repeated diagnostics | Phase 3 (M18) |
| Index build, 5 000 files | *(not yet measured)* | **1 247 ms** against a ≤2 s gate | Phase 3 (M14) |

**Known library gaps went 4 → 16 and that is not a regression.** The number counts tasks with no
suitable pack bundled, so growing the corpus faster than the library raises it by construction. It is
the honest read of the same fact the 100% exact-match rate states: *when* a suitable pack exists the
resolver picks it — which is not the same as the library being adequate.

---

## Why this exists

Before Phase 0 there was no way to tell whether a change helped. The README graded the
product, the plan graded itself, and both turned out to be wrong in specific,
checkable ways (see [Findings](#findings--both-now-fixed)). This harness replaces
self-assessment with a measurement.

**Design constraint:** the default tier must cost nothing and need no API key, or it
will not run on every commit and will rot. So the deterministic parts of the system —
stack detection and skill resolution — are measured today, and the model-dependent
parts are explicitly deferred rather than faked.

## What is measured (deterministic, free, CI-able)

| Metric | Baseline | What moves it |
|---|:--:|---|
| Bundled skill packs | 16 | Phase 10 (library breadth) |
| Stack detection accuracy | **100%** (8/8) — was 87.5% before F2 | Phase 3 / profiler work |
| Skill exact-match rate | **100%** (of 14 coverable tasks) | Phase 10 |
| Skill any-hit rate | **100%** | Phase 10 |
| Known library gaps | **4** tasks with no suitable pack bundled | Phase 10 |
| Fail-safe (no stack → no injection) | **1/1** — was 0/1 before F1 | held by test + gate |

19 golden tasks across 8 stack fixtures (Django, FastAPI, Node/Express, React/Next,
.NET, Rust/Axum, Go/Gin, and an empty repo as a fail-safe control).

**Reading the two 100% figures honestly:** they mean that *when* a suitable pack is
bundled, the resolver picks it — the ranking works. They do **not** mean the library is
adequate. Four tasks (.NET, Rust and Go testing; Django frontend) have no suitable pack
at all and are excluded from the denominator as `GAP` rather than silently counted as
passes. Coverage is the weak number here, and inflating it by scoring gaps as successes
would defeat the purpose of the baseline.

## Phase 1 addendum (2026-07-27)

Phase 1 added no new numbers to the table above, because what it shipped is not what this
harness measures — worth stating plainly rather than implying the phase moved a metric it
could not.

| Phase 1 gate | Status | Where |
|---|---|---|
| A failing suite returns <2 KB where raw output was >50 KB | **met, asserted** | `__tests__/test-report.test.ts` — 30 KB / 800 passing cases → <2 KB |
| Every mode that declares a tool allowlist admits the LSP tools | **met, asserted** | `__tests__/tool-surface.test.ts` |
| Symbol resolution picks declarations over imports | **met, asserted** | `__tests__/lsp-tools.test.ts` |
| `rename_symbol` across 5+ files applies and saves correctly | **met, asserted** | `test/integration/suite/lsp-tools.test.ts` — real extension host, 6 files |
| Provider dispatch, hover, diagnostics, grep-degrade paths | **met, asserted** | same suite — 9 tests, 19 passing in-host |
| Symbol questions resolve via LSP rather than grep | **not asserted** | needs the model tier |

The rename gate is now covered in a real extension host (`npm run test:integration` → 19 passing).
The suite registers its own definition/reference/rename/hover providers rather than leaning on the
built-in TypeScript server, for two reasons: `runTest.ts` launches with `--disable-extensions`,
which disables built-ins too, so a TS-dependent suite would be dead or flaky on server warm-up;
and the risky code is *ours* — the `executeDocumentRenameProvider` dispatch, `applyEdit`, and the
explicit save — not Microsoft's rename algorithm. The suite reads results back **from disk**,
because an unsaved edit is invisible to git, to the test runner, and to the next tool call.

The remaining gap needs a model to measure whether the agent *chooses* LSP over grep, which is the
opt-in model tier's job.

## Phase 3 addendum — retrieval recall now has a baseline (2026-07-29)

The recall metric deferred through Phases 0–2 is now recorded. It was deferred for a
real reason: `CodebaseIndex.build()` enumerates through `vscode.workspace.findFiles`,
which the shared stub returned `[]` for, so any recall figure would have been measuring
the stub. `test/vscode-stub.js` now walks the real filesystem from the open workspace
root, and `__tests__/retrieval-harness.test.ts` asserts that enumeration contract —
an empty index throws in `eval/retrieval.js` rather than reporting a plausible 0%.

| Metric | Baseline | What moves it |
|---|:--:|---|
| Retrieval recall@3 | **82.4%** | M14 chunking · M17 rerank |
| Retrieval recall@5 | **84.7%** | M14 · M17 |
| Retrieval recall@10 | **93.1%** | M14 · M15/M16 graph |
| Retrieval recall@20 | **94.4%** | M14 · M15/M16 |
| Corpus | 82 files → 112 chunks | frozen fixture |
| Index build | ~26 ms | M14 must stay within baseline +50% |

Measured over **36 golden queries** against `eval/retrieval-corpus/` — a frozen,
purpose-built three-language service (TypeScript API, Go worker, Python analytics, plus
migrations and runbooks). The corpus is not this repo's own source on purpose: gold sets
name specific files, and a gate that breaks whenever an unrelated file is renamed gets
switched off. Distractors are concentrated where the gold files live — payment,
currency, retry/backoff, token expiry, queue redelivery — because a distractor that
shares no vocabulary with the answer does not make retrieval harder.

**Lexical tier only.** Embeddings need a provider and a network call, so in CI the
semantic list is empty and RRF degrades to BM25 order. That is the right baseline to
move rather than a caveat: symbol chunking and reranking both change what the lexical
tier can reach, and a metric gated on an API key could not run in the gate that has to
catch their regressions.

### The one honest problem this measurement exposed

**Phase 3's headline gate — "recall@10 +25% over the line-window baseline" — is
arithmetically impossible as written.** It was authored before any baseline existed.
From 93.1%, a 25% relative gain would require 116%. The gate has to be restated against
the number rather than the number massaged to fit the gate; see `enhancement.md` §4,
Phase 3, for the replacement (residual-error reduction, plus recall@5 as the headline,
which at 84.7% has genuine headroom).

### The failure mode the baseline points at

Five queries miss at k=10, and they fail the *same way*: the missed file is always the
one where the relevant symbol is **defined**, when the query describes behaviour instead
of naming the symbol.

| Query | Retrieved | Missed |
|---|---|---|
| `q-currency-conversion` | `order-service.ts` (the caller) | `utils/currency.ts` (`convertMinor`) |
| `q-order-status-machine` | `order-service.ts` | `models/order.ts` (`canTransition`) |
| `q-order-created-event` | `worker/handler.go` | `worker/queue.go` (`deadLetter`) |
| `q-daily-rollup` | `analytics/pipeline.py` | `analytics/metrics.py` (`conversion_rate`) |
| `q-masked-email` | `services/audit-service.ts` | `models/user.ts` (`maskEmail`) |

A 50-line window straddling a definition dilutes it with whatever else shares the
window; the caller, which repeats the domain vocabulary in prose and in argument names,
outranks it every time. This is precisely what M14 (symbol chunking) and M15/M16 (the
code graph's def→use edges) exist to fix, which makes these five the phase's real
scoreboard — more informative than the aggregate.

## What is deliberately NOT measured yet

Scheduled with the phase that needs it, because a number we cannot defend is worse than
no number.

- **End-to-end task success / wrong-idiom rate.** Needs real model calls. Belongs to an
  opt-in model tier, not to CI.

## How the gate works

`npm run eval` compares the current run against `eval/baseline.json` and exits non-zero
only on a **regression** in stack detection accuracy, skill exact-match rate, skill
any-hit rate, fail-safe passes, or retrieval recall@5/@10/@20.

Recall is guarded with a **2-point tolerance**; the others are exact. The other metrics
are counts over fixed inputs and cannot move by a hair, but recall is a mean over 36
queries where a single gold file crossing the k boundary shifts it by ~2 points. Failing
on that would make the gate noisy, and a noisy gate is a disabled gate.

It is deliberately not "everything must be green". When a phase improves a metric,
re-record with `npm run eval:record` so the new floor is locked in — which is what
happened after F1 and F2 were fixed.

---

## Findings — both now fixed

The eval found both of these on its first run, which is the clearest argument for
having built it. Both were fixed on 2026-07-27 and the baseline re-recorded; each has
regression cover so neither can come back silently.

### F1 — Skills injected into repos with no detected stack *(correctness)* — ✅ FIXED

**Severity: high.** Fixed 2026-07-27 · `agent/skill-resolver.ts` ·
regression cover in `__tests__/skill-resolver.test.ts`.

**What was wrong.** `plan.md:408` claimed ambiguous cases "inject nothing rather than a wrong
pack (fail safe, like the browser allowlist did)". They did not.

The `empty` fixture — a repo with only `README.md`, `LICENSE` and `notes.txt` — yielded an empty
`ProjectProfile` correctly, but a Backend-mode turn against it received **five conflicting
framework packs**: `aspnet-core, django, fastapi, axum, express`.

The cause was in `agent/skill-resolver.ts`: role affinity alone counted as a positive signal.

```ts
if (role && skill.roles.length) {
    if (skill.roles.includes(role)) score += W_ROLE;   // 4 > 0 → candidate
```

So every pack tagged `roles: [backend]` scored above the `score > 0` filter regardless of stack.
The profiler's own fail-safe contract held (the profile *was* empty); the violation was one layer
up, at resolution.

The same mechanism degraded every stack-typed run: a Django task resolved
`django, fastapi, flask, rails, pytest`, so four of five injected packs were wrong-framework
idioms competing for prompt budget with the one correct pack.

**The fix.** Three rules in `resolveSkills`:
1. A pack that *declares* `stacks` must match one (or be named by a prompt trigger) to be a
   candidate. Role affinity alone is not evidence that a pack applies to **this** repo.
2. Packs declaring **no** `stacks` stay exempt — they are genuinely cross-cutting
   (`rest-api-design`, `a11y-wcag-aria`), and role is the only signal they have. The harness
   pins this: `cross-cutting backend skill is included`.
3. A **framework** match now outranks a bare **language** match (10 vs 5). Several bundled
   packs list the language beside the framework — `angular` declares `[angular, typescript]` —
   so on any TypeScript repo the Angular pack scored as strongly as the React pack did on a
   React repo.

Writing the regression tests surfaced a fourth case: a pack with a positive `priority` and no
matching signal still cleared the `score > 0` filter, so it was injected into every turn — the
exact failure `validateSkill` warns authors about. Priority is now a tie-breaker only, applied
after a pack has already qualified, which makes the warning and the runtime agree.

**Measured effect.** Fail-safe 0/1 → 1/1. Precision on typed repos improved sharply:
`dotnet-be-1` went from `aspnet-core, django, fastapi, axum, express` to `aspnet-core` alone,
and `rust-be-1` from five packs to `axum` alone.

**Still imperfect, and deliberately left for Phase 10.** A Django repo continues to resolve
`django, fastapi, flask` together, because all three packs legitimately declare `python` and the
repo *is* Python. The ranking is now correct (`django` first), but the precision problem is in
the **pack metadata**, not the resolver: a framework pack should not claim the bare language in
its `stacks`. That is library curation.

### F2 — `react` not detected in a Next.js project *(detection)* — ✅ FIXED

**Severity: low.** Fixed 2026-07-27 · `core/project-profiler.ts` ·
regression cover in `__tests__/project-profiler.test.ts`. The `react-next` fixture declares `react: ^18.3.0` and `next: ^14.2.0`
in `package.json`. The profiler reported `[javascript, typescript, nextjs, tailwind]` —
`react` was missing, so detection scored 7/8 rather than 8/8.

Impact was masked: the `react` pack still fired, because it also declares `typescript` in its
`stacks`. So this was a latent gap rather than a live failure — but it would have bitten any
pack keyed on `react` alone.

**The fix.** The React-family detection was an `if / else if` chain, so `next` *excluded*
`react`. React-based frameworks are now detected **in addition to** react. This also applies to
React Native: the bundled `react` pack is renderer-agnostic (hooks, composition, state) with no
DOM assumptions, so it is equally correct there. `expo` is now recorded as a stack token too.
Stack detection went 87.5% → 100%.

---

## Reproducing

```bash
cd src/stable/extensions/black-ide-agent
npm run eval          # run the gate against the recorded baseline
npm run eval:record   # re-record after an intentional improvement
```

Fixtures live in `eval/fixtures.js` (file lists + manifest contents — the profiler is
pure and fs-free, so no real trees are needed) and tasks in `eval/tasks.js`. Adding a
stack means adding one fixture and a few tasks; no code changes.
