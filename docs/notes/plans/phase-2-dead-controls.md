# Phase 2 — Resolve Dead UI Controls

**Defects:** B3 (Merge-subagent button), B4 (chat "Take screenshot"), B5 (Fast Apply toggle).
**Ship gate:** Required. Each is a visible control with no effect — a user-facing dead end.
**Depends on:** Phase 1 (B4's fate depends on the browser decision).

**Guiding principle:** a control that lies about what it does is worse than its absence. For each
item below the choice is *implement* or *remove* — both are legitimate fixes; pick per whether the
capability is actually wanted.

---

## 2.1 — "Merge subagent" button (B3)

- **Evidence:** `webview/src/ParallelSubagents.tsx:101` posts `{ type: 'mergeSubagent' }`;
  `extension.ts` has no handler.
- **Context:** subagents already auto-reconcile their worktree delta into the live tree on
  success (`extension.ts:1874-1891`). A manual merge is only meaningful for the **failure path**,
  where `preserveWorktree` leaves completed work on a branch (`extension.ts:1878-1883`).
- **Option A — Remove (recommended, small):** delete the Merge button and its `mergeSubagent`
  post. The happy path needs no manual merge; the failure path already prints the exact
  `git merge <branch>` command to run.
- **Option B — Implement (larger):** track preserved-worktree branches per subagent id; add a
  `case 'mergeSubagent'` that runs `worktreeManager.applyDelta`/`git merge` for that branch under
  `gitMutex`, reports restored/conflicted files, then clears the preserved state. Only worth it if
  users are expected to recover failed-subagent work from the panel rather than the terminal.
- **Recommendation:** Option A now; revisit B if failed-subagent recovery becomes a real workflow.

---

## 2.2 — Chat "Take screenshot" (B4)

- **Evidence:** `extension.ts:614-616` returns a hardcoded *"Screenshot capture will be available
  with browser integration."* `BrowserTool.screenshot()` exists (`browser-tool.ts:62`).
- **Decision driver:** Phase 1's browser strategy.
  - **If browser gated/absent (Phase 1 Option B, common case):** **remove** the button — there is
    no live browser session in the chat surface to screenshot, and the affordance is ambiguous.
  - **If browser bundled/available:** wire the handler to capture the current `BrowserTool` page
    (or a fresh launch of a prompted URL) and post the image back as an attachment. Gate the button
    on `browserRuntimeAvailable()` so it only appears when it can work.
- **Recommendation:** remove now (aligns with Phase 1 Option B); re-add as a gated feature only if
  browser automation becomes first-class.

---

## 2.3 — "Fast Apply" toggle (B5)

- **Evidence:** `enableFastApply` is a Settings toggle (`App.tsx:2234`, default `true`) with **zero
  runtime consumers**. No speculative-apply / apply-model path exists.
- **Reality:** a real "fast apply" (à la a dedicated model that applies edit instructions to a file)
  is a **large** feature — its own model config, prompt, and merge strategy. It is out of scope for
  a defect-closing phase.
- **Option A — Remove (recommended):** delete the toggle and its default so the UI stops implying a
  capability that doesn't exist.
- **Option B — Defer with a design doc:** keep the toggle disabled/hidden and open a separate
  proposal (`../fast-apply-design.md`) if the feature is genuinely wanted. Do **not** leave it as an
  active-looking toggle.
- **Recommendation:** Option A now; a fast-apply design is a future feature, not a bug fix.

---

## Test strategy

- Mostly UI/removal changes — verify the webview builds and no orphaned `postMessage` types remain:
  re-run the "webview-sent messages vs extension-handled cases" diff from the audit and confirm no
  message type is sent without a handler.
- If 2.1 Option B is taken: harness test that `applyDelta` on a preserved branch restores its files
  and reports conflicts, mirroring the existing subagent/worktree real-git suites.

## Acceptance criteria

1. Every `postMessage` type the webview sends has a handler (no dead messages).
2. No Settings toggle or chat button is a silent no-op.
3. `tsc -b` clean, webview builds.
4. `../missing-and-broken-features.md` B3/B4/B5 flipped (to ✅ if implemented, or struck as
   removed).
