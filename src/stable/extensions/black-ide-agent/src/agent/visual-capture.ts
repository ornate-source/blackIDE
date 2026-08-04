import * as fs from 'fs';
import { BrowserTool } from '../tools/browser-tool';
import { BrowserSettings } from '../tools/browser-capability';
import { ProjectProfile } from '@blackide/agent-core/core/project-profiler';
import { describeCaptureFailure, planVisualCapture } from '../core/visual-capture';
import { ArtifactStore } from './artifact-store';

// ─── Producing visual evidence (Phase 7, M40) ───────────────────────────────
//
// The impure half of `core/visual-capture.ts`: probe, launch, capture, attach. What makes
// this worth its own module rather than twenty lines inside `verify-runner` is that every
// step here can fail in a way that must **not** fail the run — a dev server that is not
// running, a Chromium that will not launch, a page that never settles. A verification step
// that throws because nobody started `npm run dev` would make the whole feature something
// people turn off.
//
// So the contract is: this never throws. It returns evidence or it returns a sentence
// explaining why there is none, and `evaluateVerification` turns the second into
// `incomplete` — which is what that outcome was added for.
//
// ── Why the probe exists ─────────────────────────────────────────────────────
// `page.goto` against a dead port takes its full 30 s timeout after paying ~2 s to launch
// Chromium. On a repo with no dev server running that is half a minute added to every UI
// change, forever, to reach a conclusion a TCP connection reaches in milliseconds. The
// probe is a HEAD request to loopback (or to whatever the user configured), and it is
// registered in `core/egress.ts` like any other outbound call — a request that usually
// goes to 127.0.0.1 is still a request, and the register only means something if it
// contains the boring entries too.

/** How long a preview URL gets to answer the probe before we move on. */
const PROBE_TIMEOUT_MS = 1_500;

export interface VisualCaptureDeps {
    runId: string;
    artifacts: ArtifactStore;
    profile?: ProjectProfile;
    browserSettings: BrowserSettings;
    browserUsable: boolean;
    /** `verificationPreviewUrl` from general settings. */
    configuredUrl?: string;
    log?: (message: string) => void;
    signal?: AbortSignal;
}

export interface VisualCaptureOutcome {
    /** Artifact paths, ready to hand to `Evidence.screenshots`. */
    screenshots: string[];
    /** Set when nothing was captured. Reaches the report and the user, verbatim. */
    unavailable?: string;
}

/**
 * Capture visual evidence for a change that owes some, and attach it to the run.
 *
 * Saved through `ArtifactStore.saveBinary` rather than left in `os.tmpdir()`, because a
 * screenshot that is only reachable by a path in a log is one the review panel cannot show
 * and the OS deletes at its leisure. Attaching it to the run is what makes it evidence
 * rather than a file.
 */
export async function captureVisualEvidence(deps: VisualCaptureDeps): Promise<VisualCaptureOutcome> {
    const decision = planVisualCapture({
        required: true,
        browserUsable: deps.browserUsable,
        frameworks: deps.profile?.frameworks,
        configuredUrl: deps.configuredUrl,
        allowedDomains: deps.browserSettings.allowedDomains,
    });

    if (!decision.attempt) {
        deps.log?.(`[Verify] no visual evidence — ${decision.reason}`);
        return { screenshots: [], unavailable: decision.reason };
    }

    const live = await firstResponding(decision.candidates, deps.signal);
    if (!live) {
        const reason = describeCaptureFailure(decision.candidates);
        deps.log?.(`[Verify] ${reason}`);
        return { screenshots: [], unavailable: reason };
    }

    // Headless regardless of the user's `browserHeadless` preference. That setting is
    // about the agent's *browsing*, which the user asked for and is watching; this runs at
    // the end of an unattended task agent, and a Chromium window stealing focus over the
    // editor while somebody is typing is a bug report, not a feature.
    const browser = new BrowserTool({ ...deps.browserSettings, headless: true });
    try {
        await browser.launch({ url: live, headless: true });
        const tmpPath = await browser.screenshot();
        const record = deps.artifacts.saveBinary(
            deps.runId,
            'screenshot',
            `Verification — ${hostAndPath(live)}`,
            fs.readFileSync(tmpPath),
        );
        try { fs.unlinkSync(tmpPath); } catch { /* the copy that matters is saved */ }

        deps.log?.(`[Verify] captured ${live} → ${record.path}`);
        return { screenshots: [record.path] };
    } catch (err: any) {
        const reason = describeCaptureFailure([live], err?.message || String(err));
        deps.log?.(`[Verify] ${reason}`);
        return { screenshots: [], unavailable: reason };
    } finally {
        // Always. A leaked Chromium per verified UI change is a memory leak the user
        // discovers as "the IDE got slow after an afternoon".
        try { await browser.close(); } catch { /* best effort */ }
    }
}

/**
 * The first candidate that answers, or undefined.
 *
 * Any HTTP response counts, including a 404: something is listening and rendering, which
 * is all the probe is asked to establish. Deciding whether the *page* is right is the
 * screenshot's job, and a dev server that 404s the root while serving `/app` is common
 * enough that treating a non-2xx as dead would refuse to capture working apps.
 */
async function firstResponding(candidates: string[], signal?: AbortSignal): Promise<string | undefined> {
    for (const url of candidates) {
        if (signal?.aborted) return undefined;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        const onAbort = () => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            await fetch(url, { method: 'HEAD', signal: controller.signal });
            return url;
        } catch {
            // Connection refused, DNS failure, timeout — all "not serving", all the same
            // to the caller, none of them worth distinguishing in a report.
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    }
    return undefined;
}

/** A short label for the artifact title — the full URL makes for an unreadable filename. */
function hostAndPath(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    } catch {
        return url;
    }
}
