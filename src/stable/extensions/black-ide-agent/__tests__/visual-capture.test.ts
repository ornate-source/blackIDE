import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inferPreviewUrls, planVisualCapture } from '../src/core/visual-capture';
import { evaluateVerification, planVerification, renderVerificationReport } from '@blackide/agent-core/core/verification';
import { EGRESS_REGISTER } from '../src/core/egress';
import { ProjectProfile } from '@blackide/agent-core/core/project-profiler';
import { readSource } from './source-roots';

/**
 * Visual evidence (Phase 7, M40's third gate clause).
 *
 * `planVerification` has required a screenshot for UI changes since the phase opened, and
 * nothing produced one — so every UI change landed `incomplete` with no way to land
 * anything else. The gate clause is stated in two directions and both are asserted here:
 * a UI change lands **verified** when capture succeeds, and **incomplete** when it does
 * not.
 *
 * The second direction is the one worth having tests for. It is trivially easy to satisfy
 * "UI changes become verified" by treating a missing screenshot as acceptable, which is
 * the exact decay `evaluateVerification`'s fourth outcome exists to prevent.
 */

const profileWith = (over: Partial<ProjectProfile> = {}): ProjectProfile => ({
    languages: ['typescript'], frameworks: [], testFrameworks: ['vitest'],
    packageManagers: ['npm'], stacks: [], confidence: 0.9, evidence: [], ...over,
});

// ─── The decision ───────────────────────────────────────────────────────────

describe('planVisualCapture decides where — if anywhere — to point a browser', () => {
    const base = { required: true, browserUsable: true };

    it('does not attempt anything when no user-visible surface changed', () => {
        const decision = planVisualCapture({ ...base, required: false });
        expect(decision.attempt).toBe(false);
        expect(decision.candidates).toEqual([]);
    });

    it('refuses when the browser is off or has no runtime, and says which', () => {
        const decision = planVisualCapture({ ...base, browserUsable: false });
        expect(decision.attempt).toBe(false);
        // The reason is read by a person deciding what to change, so it has to name the
        // setting and the command rather than say "unavailable".
        expect(decision.reason).toMatch(/Settings/);
        expect(decision.reason).toMatch(/Install Browser Support/);
    });

    it('uses a configured URL alone, without also trying inferred ones', () => {
        // The failure this prevents: an explicit URL that is down, a guessed port that is
        // up, and a screenshot of a different application reported as evidence.
        const decision = planVisualCapture({
            ...base, configuredUrl: 'http://localhost:8080/app', frameworks: ['vite', 'react'],
        });
        expect(decision.candidates).toEqual(['http://localhost:8080/app']);
    });

    it('refuses a malformed configured URL rather than falling back to a guess', () => {
        const decision = planVisualCapture({ ...base, configuredUrl: 'localhost:8080', frameworks: ['vite'] });
        expect(decision.attempt).toBe(false);
        expect(decision.reason).toContain('localhost:8080');
        expect(decision.candidates).toEqual([]);
    });

    it('refuses a non-http scheme, which is where a settings field becomes a capability', () => {
        for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ext::sh -c id']) {
            expect(planVisualCapture({ ...base, configuredUrl: url }).attempt, url).toBe(false);
        }
    });

    it('infers the stack\'s own dev port when nothing is configured', () => {
        expect(inferPreviewUrls(['vite'])).toEqual(['http://localhost:5173']);
        expect(inferPreviewUrls(['next'])).toEqual(['http://localhost:3000']);
        expect(inferPreviewUrls(['angular'])).toEqual(['http://localhost:4200']);
        expect(inferPreviewUrls(['django'])).toEqual(['http://localhost:8000']);
    });

    it('proposes both ports when a stack could be on either, most specific first', () => {
        // vite + react is the common shape, and 5173 is the one that is actually serving.
        expect(inferPreviewUrls(['vite', 'react'])).toEqual(['http://localhost:5173', 'http://localhost:3000']);
    });

    it('only ever infers loopback, so a wrong guess cannot leave the machine', () => {
        for (const url of inferPreviewUrls(['vite', 'next', 'django', 'angular', 'flask'])) {
            expect(new URL(url).hostname).toBe('localhost');
        }
    });

    it('refuses rather than guessing when the stack implies nothing', () => {
        const decision = planVisualCapture({ ...base, frameworks: ['django-rest-framework'] });
        expect(decision.attempt).toBe(false);
        expect(decision.reason).toMatch(/Verification Preview URL/);
    });

    it('honours the navigation allowlist instead of stepping around it', () => {
        // A security control does not get an exemption because the caller has a good
        // reason; that is what every bypass looks like from the inside.
        const decision = planVisualCapture({
            ...base, configuredUrl: 'http://staging.internal/app', allowedDomains: ['example.com'],
        });
        expect(decision.attempt).toBe(false);
        expect(decision.reason).toMatch(/Allowed Domains/);
    });

    it('proceeds when the allowlist does permit the URL', () => {
        const decision = planVisualCapture({
            ...base, configuredUrl: 'http://app.example.com/', allowedDomains: ['example.com'],
        });
        expect(decision.attempt).toBe(true);
        expect(decision.candidates).toEqual(['http://app.example.com/']);
    });
});

// ─── The contract's two directions ──────────────────────────────────────────

describe('a UI change is judged on whether the evidence arrived', () => {
    const plan = planVerification(['src/components/Button.tsx'], { framework: 'vitest', command: 'npx vitest run' });
    const passing = { framework: 'vitest', command: 'npx vitest run', exitCode: 0, failures: [], ok: true, passed: 12 };

    it('requires a screenshot in the first place', () => {
        expect(plan.required).toContain('screenshot');
    });

    it('lands verified when capture succeeded', () => {
        const result = evaluateVerification(plan, { tests: passing as any, screenshots: ['/artifacts/run__screenshot__a.png'] });
        expect(result.outcome).toBe('verified');
        expect(result.missing).toEqual([]);
    });

    it('stays incomplete when capture did not, and carries the why', () => {
        const result = evaluateVerification(plan, {
            tests: passing as any,
            visualUnavailable: 'Nothing was serving http://localhost:5173.',
        });
        expect(result.outcome).toBe('incomplete');
        expect(result.missing).toEqual(['screenshot']);
        // Not "produced none" — the user needs to know it was a dead port rather than a
        // disabled feature, because those send them to different places.
        expect(result.summary).toContain('Nothing was serving');
    });

    it('does not require a screenshot of a change nobody can see', () => {
        const backend = planVerification(['src/core/tokens.ts'], { framework: 'vitest', command: 'npx vitest run' });
        expect(backend.required).not.toContain('screenshot');
        expect(evaluateVerification(backend, { tests: passing as any }).outcome).toBe('verified');
    });

    it('reports the reason in the artifact, under Missing', () => {
        const evidence = { tests: passing as any, visualUnavailable: 'Start the dev server and re-run.' };
        const report = renderVerificationReport(plan, evidence, evaluateVerification(plan, evidence));
        expect(report).toMatch(/## Missing/);
        expect(report).toContain('Start the dev server and re-run.');
    });
});

// ─── The runner ─────────────────────────────────────────────────────────────

vi.mock('../src/tools/tool-runner', () => ({
    ToolRunner: { executeCommand: vi.fn(async () => ({ stdout: 'Tests  4 passed (4)', stderr: '', exitCode: 0 })) },
}));

describe('runVerification captures only when the plan asks for it', () => {
    let saved: Array<{ type: string }> = [];
    const artifacts = {
        save: (_runId: string, type: string, _title: string, _content: string) => {
            saved.push({ type });
            return { path: `/tmp/artifact-${type}.md` };
        },
    } as any;

    const context = (over: any = {}) => ({
        runId: 'run_1', cwd: '/tmp/repo', profile: profileWith(), artifacts, ...over,
    });

    beforeEach(() => { saved = []; });

    it('does not launch anything for a change with no visible surface', async () => {
        const { runVerification } = await import('../src/agent/verify-runner');
        const captureVisual = vi.fn();
        const outcome = await runVerification(context({ changedFiles: ['src/core/tokens.ts'], captureVisual }));

        expect(captureVisual).not.toHaveBeenCalled();
        expect(outcome.result.outcome).toBe('verified');
    });

    it('captures for a UI change, and the run lands verified', async () => {
        const { runVerification } = await import('../src/agent/verify-runner');
        const captureVisual = vi.fn(async () => ({ screenshots: ['/artifacts/shot.png'] }));
        const outcome = await runVerification(context({ changedFiles: ['src/ui/Panel.tsx'], captureVisual }));

        expect(captureVisual).toHaveBeenCalledTimes(1);
        expect(outcome.evidence.screenshots).toEqual(['/artifacts/shot.png']);
        expect(outcome.result.outcome).toBe('verified');
    });

    it('lands incomplete — not verified — when capture came back empty', async () => {
        const { runVerification } = await import('../src/agent/verify-runner');
        const outcome = await runVerification(context({
            changedFiles: ['src/ui/Panel.tsx'],
            captureVisual: async () => ({ screenshots: [], unavailable: 'No dev server was listening.' }),
        }));

        expect(outcome.result.outcome).toBe('incomplete');
        expect(outcome.evidence.visualUnavailable).toBe('No dev server was listening.');
    });

    it('survives a capture that throws, because a screenshot must not fail a run', async () => {
        const { runVerification } = await import('../src/agent/verify-runner');
        const outcome = await runVerification(context({
            changedFiles: ['src/ui/Panel.tsx'],
            captureVisual: async () => { throw new Error('chromium exited'); },
        }));

        expect(outcome.result.outcome).toBe('incomplete');
        expect(outcome.evidence.visualUnavailable).toContain('chromium exited');
        // And the report is still written — the whole point of the contract.
        expect(saved.map(s => s.type)).toContain('test-report');
    });

    it('leaves the agent\'s own screenshot alone rather than capturing a worse one', async () => {
        const { runVerification } = await import('../src/agent/verify-runner');
        const captureVisual = vi.fn();
        const outcome = await runVerification(context({
            changedFiles: ['src/ui/Panel.tsx'],
            visual: { screenshots: ['/artifacts/agent-took-this.png'] },
            captureVisual,
        }));

        expect(captureVisual).not.toHaveBeenCalled();
        expect(outcome.result.outcome).toBe('verified');
    });

    it('emits a test-report on every path, capture or no capture', async () => {
        const { runVerification } = await import('../src/agent/verify-runner');
        await runVerification(context({ changedFiles: ['src/ui/Panel.tsx'], captureVisual: async () => ({ screenshots: [] }) }));
        expect(saved.filter(s => s.type === 'test-report')).toHaveLength(1);
    });
});

// ─── The accounting ─────────────────────────────────────────────────────────

describe('the probe is declared egress like anything else', () => {
    it('is in the register, pointing at the module that makes the call', () => {
        const point = EGRESS_REGISTER.find(p => p.module === 'agent/visual-capture.ts');
        expect(point, 'the preview probe must be registered').toBeTruthy();
        expect(point!.trigger).toBe('agent-run');
        expect(point!.disabledBy).toBeTruthy();
    });

    it('the module it names exists, so the register cannot rot', () => {
        expect(fs.existsSync(path.join(__dirname, '..', 'src', 'agent', 'visual-capture.ts'))).toBe(true);
    });
});

// ─── The wiring ─────────────────────────────────────────────────────────────

describe('every lane that verifies can also capture', () => {
    const src = (...parts: string[]) => readSource(...parts);

    it('all three lanes pass a captureVisual, through the one shared implementation', () => {
        for (const file of [['agent', 'task-agent-entry.ts'], ['agent', 'pipeline-entry.ts'], ['agent', 'chat-task.ts']]) {
            expect(src(...file), file.join('/')).toMatch(/captureVisual:/);
            expect(src(...file), file.join('/')).toMatch(/from '\.\/visual-capture'/);
        }
    });

    it('the capture forces headless, whatever the user set for their own browsing', () => {
        // An unattended run stealing focus with a Chromium window is a bug report.
        expect(src('agent', 'visual-capture.ts')).toMatch(/headless: true/);
    });

    it('always closes the browser it opened', () => {
        expect(src('agent', 'visual-capture.ts')).toMatch(/finally \{[\s\S]*browser\.close\(\)/);
    });
});
