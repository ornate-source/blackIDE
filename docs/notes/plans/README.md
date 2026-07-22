# Execution Plans — Missing & Broken Features

Derived from the code audit in [`../missing-and-broken-features.md`](../missing-and-broken-features.md)
(2026-07-22). Read that first — every task below traces to a verified defect (B1–B8) or a
documentation-accuracy item there, each with a file:line citation.

**Baseline at plan time:** `tsc -b` clean, webview builds, harness **352/352 green**. None of
the work below is a bug in tested code — it closes the gap between what the UI/settings/tools
*advertise* and what the runtime actually wires up.

## Phases

| Phase | File | Theme | Defects | Ship gate |
|:-:|---|---|---|---|
| 1 ✅ | [phase-1-browser-security.md](phase-1-browser-security.md) | Browser automation strategy + enforce/hide the Browser settings tab (the `browserAllowedDomains` false-security control) | B1, B2, B8 | **Done (2026-07-22)** — Option B (detect & gate); harness 381/381 |
| 2 ✅ | [phase-2-dead-controls.md](phase-2-dead-controls.md) | Resolve three dead UI controls: implement or remove | B3, B4, B5 | **Done (2026-07-22)** — all three removed; harness 381/381 |
| 3 | [phase-3-noop-toggles.md](phase-3-noop-toggles.md) | Honor the remaining no-op toggle (Reasoning display) | B6 | Recommended |
| 4 | [phase-4-hygiene-docs.md](phase-4-hygiene-docs.md) | Untrack `tmp/` fixtures; fix README doc-accuracy items | B7, doc drift | Recommended |

## Ordering & dependencies

```
Phase 1 ──► Phase 2 (B4 screenshot depends on Phase 1's browser decision)
Phase 3 ──independent
Phase 4 ──independent (can ship anytime)
```

- **Phase 1 is the gate.** B2's `browserAllowedDomains` is a *false security affordance* —
  fix or hide it before anything else. Its outcome (ship-Playwright vs. detect-and-gate)
  decides whether B4 (screenshot) is wired or removed in Phase 2.
- **Phases 3 and 4 are independent** of 1–2 and of each other; either can land first.
- Each phase ends green on the existing harness plus its own new tests, `tsc -b` clean, and
  the webview building.

## Definition of done (every phase)

1. No advertised control is a silent no-op — it either works or is removed.
2. New behavior has a harness test in the `vscode`-free tier where the logic allows.
3. `tsc -b` (both projects) clean; `cd webview && npm run build` clean.
4. The status of each addressed item is flipped in
   [`../missing-and-broken-features.md`](../missing-and-broken-features.md).

All paths below are relative to `src/stable/extensions/black-ide-agent/` unless noted.
