// Browser capability detection & navigation policy — Phase 1 (B1/B2/B8).
//
// Pure, vscode-free logic so it is unit-testable in the fast harness tier:
//  - whether a Playwright runtime is even present (B1 — gate the tools),
//  - a navigation allowlist (B2 — the `browserAllowedDomains` control that until now
//    claimed to restrict navigation but enforced nothing),
//  - mapping the user's `general-settings` blob into concrete browser options (B8).

/** The six browser_* tools. Kept here so both the registry filter and tests share one list. */
export const BROWSER_TOOL_NAMES = [
    'browser_open',
    'browser_screenshot',
    'browser_click',
    'browser_type',
    'browser_read',
    'browser_close',
];

/** Concrete browser options resolved from settings. Defaults preserve prior behavior. */
export interface BrowserSettings {
    /** Master switch (`browserEnabled`). Off by default — browser is opt-in (Option B). */
    enabled: boolean;
    /** `browserHeadless`. */
    headless: boolean;
    /** `browserPath` — custom Chrome/Chromium executable, or undefined to use Playwright's. */
    executablePath?: string;
    /** `browserViewportWidth`/`Height`. */
    viewportWidth?: number;
    viewportHeight?: number;
    /** `browserScreenshotOnNav` — auto-capture after a successful open/navigate. */
    screenshotOnNav: boolean;
    /** `browserAllowedDomains`, parsed. Empty = unrestricted (matches prior behavior). */
    allowedDomains: string[];
}

/**
 * True when the `playwright` module is resolvable (present in the extension's node_modules).
 * Only resolves the module path — never launches — so it is cheap and side-effect-free. The
 * resolver is injectable so the harness can exercise both branches without installing anything.
 */
export function browserRuntimeAvailable(resolver: (id: string) => string = require.resolve): boolean {
    try {
        resolver('playwright');
        return true;
    } catch {
        return false;
    }
}

/**
 * Parse a user-entered domains blob (newline- or comma-separated, possibly pasted with a
 * scheme or path) into clean lowercase hostnames. `https://github.com/foo` → `github.com`.
 */
export function parseAllowedDomains(raw: unknown): string[] {
    if (typeof raw !== 'string') return [];
    return raw
        .split(/[\n,]/)
        .map(s => s.trim().toLowerCase())
        .map(s => s.replace(/^[a-z]+:\/\//, '')) // strip scheme if present
        .map(s => s.replace(/\/.*$/, ''))        // strip any path
        .map(s => s.replace(/:\d+$/, ''))        // strip port
        .filter(Boolean);
}

/** Lowercased hostname of a URL, or '' when it cannot be parsed. */
export function hostOf(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

/**
 * The navigation gate. An empty allowlist is unrestricted (unchanged behavior). Otherwise a
 * host is allowed only if it exactly matches an entry or is a subdomain of one
 * (`github.com` allows `api.github.com`). A URL whose host cannot be parsed is refused while
 * an allowlist is in force — failing closed is the whole point of the control.
 */
export function isNavigationAllowed(url: string, allowedDomains: string[]): boolean {
    if (!allowedDomains.length) return true;
    const host = hostOf(url);
    if (!host) return false;
    return allowedDomains.some(d => host === d || host.endsWith('.' + d));
}

/**
 * Resolve the persisted `general-settings` blob into a BrowserSettings. Defaults mirror the
 * webview's DEFAULT_SETTINGS: `browserEnabled` off, headless on, 1280×720, no allowlist — so a
 * blob saved before these fields existed behaves predictably (browser stays opt-in).
 */
export function readBrowserSettings(s: any): BrowserSettings {
    s = s || {};
    const num = (v: any) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const execPath = typeof s.browserPath === 'string' ? s.browserPath.trim() : '';
    return {
        enabled: s.browserEnabled === true,
        headless: s.browserHeadless !== false,
        executablePath: execPath || undefined,
        viewportWidth: num(s.browserViewportWidth),
        viewportHeight: num(s.browserViewportHeight),
        screenshotOnNav: s.browserScreenshotOnNav === true,
        allowedDomains: parseAllowedDomains(s.browserAllowedDomains),
    };
}

/** True only when the browser is both enabled by the user AND has a runtime to launch. */
export function isBrowserUsable(settings: BrowserSettings, runtimeAvailable: boolean): boolean {
    return settings.enabled && runtimeAvailable;
}

/**
 * Drop the browser_* tools from a tool list when the browser cannot (or should not) run, so
 * the model is never offered a tool that would fail. Non-browser tools pass through untouched.
 */
export function filterToolsForBrowser<T extends { name: string }>(tools: T[], browserUsable: boolean): T[] {
    if (browserUsable) return tools;
    return tools.filter(t => !BROWSER_TOOL_NAMES.includes(t.name));
}
