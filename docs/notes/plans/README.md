# Implementation Plans

Derived from the engineering audit in [`../futureplan.md`](../futureplan.md)
(2026-07-19). Read that first — every item below traces to a verified bug (B1–B8) or
audit blocker there.

| Phase | File | Theme | Ship gate |
|---|---|---|---|
| 1 | [phase-1-correctness.md](phase-1-correctness.md) (what/why) · [phase-1-implementation.md](phase-1-implementation.md) (execution-ready how) | Security & correctness release blockers (B1, B2, B4, B5, B6) | Required before any public release |
| 2 | [phase-2-observability.md](phase-2-observability.md) | Token/cost visibility, tool-level activity, trigger tuning (B3, B7, B8) | Required before any public release |
| 3 | [phase-3-durability.md](phase-3-durability.md) | Runs survive reloads; approval-gate restart recovery | Strongly recommended |
| 4 | [phase-4-production.md](phase-4-production.md) | Integration tests, telemetry, background runs, PR mode, repo hygiene | Production operations + competitive positioning |

**Ordering:** Phase 1 items are independent of each other; Phases 1–2 can run in
parallel; Phase 3 depends on 1.3 (checkpoint scoping); Phase 4 depends on 1–3.

**Prior work this builds on:** the Phase 0–2.3 hardening pass recorded in
[`../agent_plan.md`](../agent_plan.md)'s changelog (auto-trigger, in-chat approval gate,
worktree isolation + delta reconciliation, browser self-verification, per-phase models,
Pipeline Manager panel) — currently uncommitted in the working tree.
