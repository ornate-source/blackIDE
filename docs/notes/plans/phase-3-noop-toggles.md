# Phase 3 — Honor the Remaining No-op Toggle

**Defect:** B6 (Reasoning-display toggle does nothing).
**Ship gate:** Recommended. Independent of Phases 1–2 — can land any time.

> Note: the other viewport/headless/screenshot-on-nav no-ops (originally B8) are folded into
> Phase 1's browser wiring, since they only make sense alongside the `BrowserTool` changes. This
> phase is what remains: the one non-browser no-op toggle.

---

## 3.1 — Gate reasoning streaming on `enableReasoningDisplay` (B6)

- **Evidence:** `enableReasoningDisplay` is a Settings checkbox (`App.tsx:2243`, default `true`)
  with **zero runtime reads**. Reasoning tokens always stream via `onReasoningStart`/`onToken`
  (`extension.ts:1954-1959`), so turning it off has no effect.
- **Files:** `extension.ts` (`_runAgentTask`, where `settings` is already read at ~`1652`).
- **How:**
  - Read `enableReasoningDisplay` (default `true`) from the already-parsed `settings` blob.
  - In the `runAgentLoop` callbacks, guard the reasoning posts:
    - `onReasoningStart`: only `postMessage({ type: 'startReasoning' })` when enabled.
    - `onToken`: only `postMessage({ type: 'streamReasoning', ... })` when enabled.
  - Leave the model call itself untouched — this controls *display*, not whether the model reasons.
    (If a provider bills reasoning tokens, that's a separate cost concern, not this toggle.)
  - Optional: when disabled, still show a lightweight "thinking…" state without streaming the text,
    so the UI doesn't look frozen.

---

## Test strategy

- The gating is a thin conditional in `extension.ts` (not `vscode`-free), so cover it by asserting
  the callback wiring reads the setting — or verify manually: toggle off → no `streamReasoning`
  messages reach the webview during a run; toggle on → they do.
- Confirm the default (unset settings) still streams, preserving current behavior.

## Risks

- Low. Purely additive gating around existing `postMessage` calls; the default preserves today's
  behavior so no existing user sees a change unless they opt out.

## Acceptance criteria

1. With `enableReasoningDisplay: false`, no reasoning text streams to the chat during a run.
2. With it `true` or unset, streaming is unchanged from today.
3. `tsc -b` clean.
4. `../missing-and-broken-features.md` B6 flipped to ✅.
