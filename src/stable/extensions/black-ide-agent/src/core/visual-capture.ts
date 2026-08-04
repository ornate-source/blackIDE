import { isNavigationAllowed } from '../tools/browser-capability';

// ─── Deciding whether visual evidence can be produced (Phase 7, M40) ────────
//
// `planVerification` has required a screenshot for UI changes since the phase opened, and
// nothing has ever produced one. Every UI change therefore lands `incomplete`: the tests
// pass, the contract asks for something to look at, and the answer is always "none". A
// requirement that is never satisfiable is not a gate, it is a permanent warning, and the
// thing people do with a permanent warning is stop reading it.
//
// This module is the half of the fix that is a *decision*: given what changed, what the
// user has configured and what the project looks like, is there a URL worth pointing a
// browser at? Launching the browser is `agent/visual-capture.ts`'s job.
//
// ── Why this refuses more often than it guesses ──────────────────────────────
// The failure mode worth designing against is not "no screenshot". It is **a screenshot of
// the wrong thing**: a run that changed a component in one app, captured the unrelated dev
// server that happened to be listening on 3000, and reported `verified` with a picture of
// somebody else's page attached. That is worse than `incomplete`, because `incomplete` is
// honest and the screenshot is a lie with an image attached to it.
//
// So: an explicitly configured URL is used **alone** — if it does not answer, the run stays
// incomplete rather than falling back to a guess — and inference from the stack only ever
// proposes the framework's own documented dev port. Every refusal carries a reason that
// names what to change, because "incomplete" with no explanation is the same permanent
// warning in a different colour.

/** A framework's documented dev-server port. Conservative on purpose — see the header. */
const FRAMEWORK_PORTS: Array<[RegExp, number]> = [
    [/^vite$/i, 5173],
    [/^(vue|svelte|sveltekit|solid|solidjs)$/i, 5173],
    [/^angular$/i, 4200],
    [/^astro$/i, 4321],
    [/^(next|nextjs|nuxt|remix|react|express|rails)$/i, 3000],
    [/^(gatsby|django|laravel)$/i, 8000],
    [/^flask$/i, 5000],
];

/** How many URLs we are willing to try before calling it. */
const MAX_CANDIDATES = 3;

export interface VisualCaptureDecision {
    attempt: boolean;
    /** URLs to try, in order. Empty when `attempt` is false. */
    candidates: string[];
    /**
     * Why we are, or are not, attempting. Written to the verification report verbatim, so
     * it is phrased for the person reading "why is this incomplete" rather than for a log.
     */
    reason: string;
}

export interface VisualCaptureInput {
    /** True when `planVerification` put `screenshot` in `required`. */
    required: boolean;
    /** `isBrowserUsable` — enabled by the user *and* a Playwright runtime present. */
    browserUsable: boolean;
    /** The detected stack, for inference when nothing is configured. */
    frameworks?: string[];
    /** `verificationPreviewUrl` from general settings. Wins outright when set. */
    configuredUrl?: string;
    /** `browserAllowedDomains`, already parsed. Empty means unrestricted. */
    allowedDomains?: string[];
}

/**
 * Where — if anywhere — to point a browser for this run's visual evidence.
 *
 * Ordered so the cheapest refusals come first: a non-UI change never reaches the browser
 * question at all, and a disabled browser is answered without touching the project.
 */
export function planVisualCapture(input: VisualCaptureInput): VisualCaptureDecision {
    const no = (reason: string): VisualCaptureDecision => ({ attempt: false, candidates: [], reason });

    if (!input.required) {
        return no('No user-visible surface changed, so no visual evidence was required.');
    }

    if (!input.browserUsable) {
        return no(
            'Visual evidence was required, but the browser is unavailable: enable it in Settings → '
            + 'Browser and run "Black IDE: Install Browser Support" if Playwright is not installed.',
        );
    }

    const configured = String(input.configuredUrl || '').trim();
    let candidates: string[];

    if (configured) {
        if (!isHttpUrl(configured)) {
            // Deliberately not a fallback to inference. A malformed setting is a mistake
            // the user can fix in ten seconds once they are told; silently capturing some
            // other port instead hides the mistake behind a plausible screenshot.
            return no(`The configured preview URL (${configured}) is not a valid http(s) URL, so nothing was captured.`);
        }
        candidates = [configured];
    } else {
        candidates = inferPreviewUrls(input.frameworks);
        if (!candidates.length) {
            return no(
                'Visual evidence was required, but no preview URL is known: set "Verification Preview URL" '
                + 'in Settings → Browser to the address your dev server runs on.',
            );
        }
    }

    const allowed = candidates.filter(url => isNavigationAllowed(url, input.allowedDomains || []));
    if (!allowed.length) {
        // The allowlist is a security control, and a verification step is not a reason to
        // step around one. Refusing here keeps the control's meaning intact: it says where
        // this extension may navigate, not where it may navigate *unless it has a reason*.
        return no(
            `The browser allowlist does not permit ${candidates.join(', ')}, so no screenshot was captured. `
            + 'Add the host to Settings → Browser → Allowed Domains to allow it.',
        );
    }

    return {
        attempt: true,
        candidates: allowed,
        reason: configured
            ? `Capturing the configured preview URL (${allowed[0]}).`
            : `No preview URL is configured; trying the dev-server address this stack implies (${allowed.join(', ')}).`,
    };
}

/**
 * Dev-server URLs a stack implies.
 *
 * Only loopback, and only the framework's own default. An inferred URL is a guess, and the
 * blast radius of a wrong guess is bounded by keeping it on this machine.
 */
export function inferPreviewUrls(frameworks?: string[]): string[] {
    const ports: number[] = [];
    for (const framework of frameworks || []) {
        for (const [pattern, port] of FRAMEWORK_PORTS) {
            if (pattern.test(String(framework).trim()) && !ports.includes(port)) ports.push(port);
        }
    }
    return ports.slice(0, MAX_CANDIDATES).map(port => `http://localhost:${port}`);
}

function isHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * The line the report shows when capture was attempted and did not work.
 *
 * Separate from the decision's `reason` because "we did not try" and "we tried and it did
 * not answer" send the reader to different places — Settings in the first case, their own
 * terminal in the second.
 */
export function describeCaptureFailure(candidates: string[], detail?: string): string {
    const where = candidates.length === 1 ? candidates[0] : `any of ${candidates.join(', ')}`;
    return `Visual evidence was required, but nothing was serving ${where}`
        + (detail ? ` (${detail}).` : '. Start the dev server and re-run to capture it.');
}
