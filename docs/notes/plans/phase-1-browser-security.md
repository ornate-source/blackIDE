# Phase 1 — Browser Automation Strategy & Settings Enforcement

**Defects:** B1 (browser tools fail out-of-the-box), B2 (Browser settings tab unwired,
incl. the `browserAllowedDomains` false-security control), B8 (viewport/headless/screenshot-on-nav ignored).
**Ship gate:** Required. The `browserAllowedDomains` control claims to restrict navigation and
enforces nothing — a user who scopes the agent to `github.com` is not actually protected. That
makes this the top priority even though the feature is otherwise optional.

---

## Goal

Make the browser feature *honest*: either it works with its advertised controls enforced, or
it is cleanly disabled and its settings hidden. No middle state where the UI promises capability
or security that the runtime does not deliver.

---

## Decision required first — how does Playwright ship?

Blocks everything else in this phase. Two viable strategies:

| Option | What it means | Trade-off | Recommendation |
|---|---|---|---|
| **A — Bundle** | Add `playwright` to `dependencies`; run `npx playwright install chromium` in the build/packaging step so the shipped app has a browser | Correct out-of-box; **+~300 MB** to the distribution and a slower build | Only if browser automation is a headline feature |
| **B — Detect & gate (recommended)** | Keep `require('playwright')` lazy; **remove `browser_*` from `toolsForMode()` when no Playwright runtime is detected**, and add a one-click "Install browser support" command that installs `playwright` + Chromium into the extension dir on demand | Zero distribution bloat; browser is opt-in; never advertises a tool it can't run | Best fit for a hobby/experimental project |

The rest of this plan assumes **Option B**; the tasks note where Option A would differ.

---

## Scope & tasks

### 1.1 — Gate browser tools on a runtime capability check (B1)
- **Files:** `core/tools.ts` (tool registration), `agent/tool-executor.ts:138-150`, a new
  `tools/browser-capability.ts`.
- **How:**
  - Add `browserRuntimeAvailable(): boolean` — resolves `require.resolve('playwright')` in a
    try/catch (no launch, just module presence).
  - In the code that assembles tools for a mode (`toolsForMode` call sites in `extension.ts`
    `_runAgentTask` and `_runPipelineCore`), filter out the six `browser_*` tools when the
    capability is absent. The model then never selects a tool that will fail.
  - `tool-executor.ts` keeps its existing `require('playwright')` error as a defense-in-depth
    fallback, but it should now be unreachable in normal operation.
- **One-click install command (Option B):** register `black-ide.installBrowserSupport` that runs
  `npm install playwright && npx playwright install chromium` inside the extension directory with
  progress UI, then refreshes the tool list. Surface it from the Browser settings tab.

### 1.2 — Enforce `browserAllowedDomains` (B2 — the security item)
- **Files:** `tools/browser-tool.ts` (`launch`, `navigate`), `agent/tool-executor.ts`
  (`browser_open`).
- **How:**
  - Give `BrowserTool` an allowlist: `new BrowserTool({ allowedDomains: string[] })` (empty =
    unrestricted, matching today's behavior).
  - In `launch()` and `navigate()`, parse the target URL's host and **reject** (throw a clear
    error) when an allowlist is set and the host matches none of its entries (support exact and
    subdomain match, e.g. `github.com` allows `api.github.com`).
  - Return the refusal as a normal tool error so the agent sees "navigation to X blocked by
    allowlist" and adapts, rather than crashing.
- **Wiring:** read `general-settings.browserAllowedDomains` (newline-separated) in `_runAgentTask`
  / `_runPipelineCore`, split/trim into an array, pass to the `BrowserTool` constructor.

### 1.3 — Honor `browserPath`, `browserHeadless`, viewport, screenshot-on-nav (B2/B8)
- **Files:** `tools/browser-tool.ts:13-42` (`launch`), the two `BrowserTool` construction sites.
- **How:**
  - Extend `launch()` to accept `executablePath` (→ `playwright.chromium.launch({ executablePath })`),
    honor `headless` from settings (currently hardcoded `true`), and take viewport width/height
    from settings instead of the `1280×720` default.
  - `browserScreenshotOnNav`: after each successful `navigate()`/`launch()`, if set, call
    `screenshot()` and emit it as an artifact/attachment.
  - Thread `general-settings.browserPath`, `browserHeadless`, `browserViewportWidth`,
    `browserViewportHeight`, `browserScreenshotOnNav` through the same construction path as 1.2.

### 1.4 — Honor `browserEnabled` as the master switch (B2)
- If `general-settings.browserEnabled === false`, treat it exactly like "no runtime" in 1.1:
  browser tools are not offered. This gives the user a real off switch.

### 1.5 — Make the settings tab honest either way
- If Playwright is absent **and** no install command is wired yet, the Browser tab should show a
  clear "Browser support not installed" state rather than editable controls that do nothing.
- Remove/relabel the `browserAllowedDomains` helper text until 1.2 lands, so it never claims a
  protection that isn't active mid-rollout.

---

## Test strategy

- **Unit (harness, `vscode`-free):**
  - `browserRuntimeAvailable()` returns false when `playwright` is unresolvable.
  - Allowlist matcher: exact host allowed; subdomain allowed; unlisted host rejected; empty
    allowlist = allow all. This is pure logic — extract the host-match function so it is testable
    without launching a browser.
  - Settings→options mapping: given a settings blob, the constructed launch options carry the
    right `executablePath`/`headless`/viewport.
- **Manual smoke:** with Playwright installed, confirm allowlist blocks an off-list domain and
  `browserPath` selects a custom Chrome; with it uninstalled, confirm `browser_*` tools are not
  offered and the install command works.

---

## Risks & mitigations

- **Bundling bloat (Option A):** ~300 MB Chromium — avoided by choosing Option B.
- **Allowlist false-negatives** breaking legitimate navigation — mitigate with subdomain-aware
  matching and a clear error message; empty allowlist stays permissive so nobody is opted into
  restriction by surprise.
- **Install-command sandbox:** `npx playwright install` needs network + write access to the
  extension dir; fail loudly with the manual command if it can't.

## Acceptance criteria

1. With Playwright absent, the agent is never offered `browser_*` tools and no browser call fails
   mid-run.
2. With an allowlist set, navigation to an off-list host is refused and reported; on-list hosts
   (incl. subdomains) pass.
3. `browserPath` / `browserHeadless` / viewport / `browserEnabled` demonstrably change launch
   behavior.
4. No Browser-tab control is a silent no-op.
5. `../missing-and-broken-features.md` B1/B2/B8 flipped to ✅ (or the tab documented as gated).
