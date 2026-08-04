import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskAgentSummary } from '@blackide/agent-core/core/task-agents';
import { Affordance, WorkLane, WorkStatus, affordancesFor } from '@blackide/agent-core/core/office-model';

/**
 * The Office's buttons reach something.
 *
 * R2 — *no affordance without a transition* — is asserted twice, from both ends, because
 * it can break in two unrelated ways and each is invisible to the compiler:
 *
 *   `office-model.test.ts` asserts the **state-machine** half: a button is produced only
 *   where the corresponding `can*` predicate is true.
 *
 *   This asserts the **wiring** half: every button the model can produce has a label, and
 *   every message a button sends is handled somewhere. A rendered button whose message
 *   nobody handles is the same defect as a disabled one, arrived at from the other side —
 *   the user clicks, nothing happens, and no error is raised anywhere.
 *
 * Both halves are source-scanning rather than runtime, for the reason `command-surface.ts`
 * gives: a thing can be fully implemented, correctly wired and silently unreachable, and
 * neither the compiler nor any runtime test notices.
 */

const ROOT = path.join(__dirname, '..');
const officeView = fs.readFileSync(path.join(ROOT, 'webview/src/OfficeView.tsx'), 'utf8');
const managerPanel = fs.readFileSync(path.join(ROOT, 'src/core/manager-panel.ts'), 'utf8');

/** Every affordance the projection can emit, gathered by exercising every state. */
function everyAffordance(): Set<Affordance> {
    const agent = (over: Partial<TaskAgentSummary>): TaskAgentSummary => ({
        id: 'ta_1', prompt: 'p', modelId: 'm', mode: 'Agent', rootPath: '/r',
        branch: 'blackide/agent/ta_1', status: 'running', startedAt: 0, ...over,
    });
    const statuses: WorkStatus[] = ['queued', 'running', 'needs_you', 'ready', 'done', 'failed', 'cancelled'];
    const lanes: WorkLane[] = ['task', 'pipeline', 'chat', 'daemon'];

    const out = new Set<Affordance>();
    for (const lane of lanes) {
        for (const status of statuses) {
            for (const a of affordancesFor(lane, undefined, status)) out.add(a);
        }
    }
    // The task lane's buttons are predicate-driven, so every combination of the flags that
    // drive them has to be walked rather than every status.
    for (const status of ['running', 'completed', 'failed', 'cancelled', 'queued', 'awaiting_approval'] as const) {
        for (const appliedAt of [undefined, 1]) {
            for (const discardedAt of [undefined, 1]) {
                for (const resultSha of [undefined, 'abc']) {
                    for (const a of affordancesFor('task', agent({ status, appliedAt, discardedAt, resultSha }))) out.add(a);
                }
            }
        }
    }
    return out;
}

/** Buttons the webview answers itself, with no round trip. Each needs a stated reason. */
const WEBVIEW_HANDLED: Record<string, string> = {
    officeLogs: 'switches tab and selects the run — webview state, so a round trip would only add latency',
};

describe('every button the Office can render has a label', () => {
    it('ACTIONS covers the whole Affordance union', () => {
        const declared = new Set(
            [...officeView.matchAll(/^\s{4}(\w+):\s*\{ label:/gm)].map(m => m[1]));
        for (const affordance of everyAffordance()) {
            expect(declared, `no ACTIONS entry for "${affordance}"`).toContain(affordance);
        }
    });
});

describe('every message a button sends is handled', () => {
    const sent = [...officeView.matchAll(/type:\s*'(\w+)'\s*(?:,\s*tone:\s*'\w+'\s*)?\}/g)].map(m => m[1]);

    it('finds the messages, so a rename cannot silently empty this test', () => {
        // The scan is a regex over a source file; if it stops matching, every assertion
        // below passes vacuously. This is the canary.
        expect(sent.length).toBeGreaterThanOrEqual(10);
        expect(sent).toContain('applyTaskAgent');
    });

    it('has a case in manager-panel.ts, or a stated reason not to', () => {
        for (const message of new Set(sent)) {
            if (WEBVIEW_HANDLED[message]) continue;
            expect(
                managerPanel.includes(`case '${message}'`),
                `OfficeView sends "${message}" and manager-panel.ts has no case for it`,
            ).toBe(true);
        }
    });

    it('handles every message the Logs tab sends', () => {
        const logsTab = fs.readFileSync(path.join(ROOT, 'webview/src/LogsTab.tsx'), 'utf8');
        const logMessages = [...logsTab.matchAll(/type:\s*'(\w+)'/g)].map(m => m[1]);
        expect(logMessages.length).toBeGreaterThanOrEqual(3);
        for (const message of new Set(logMessages)) {
            expect(
                managerPanel.includes(`case '${message}'`),
                `LogsTab sends "${message}" and manager-panel.ts has no case for it`,
            ).toBe(true);
        }
    });
});

describe('R4 — theme tokens only', () => {
    /*
     * The previous revision of this design hard-coded `#09090b` and `border-zinc-800` into
     * a themed surface, which on a light theme is a black rectangle in the middle of the
     * editor. Every colour must resolve through `var(--vscode-*)` via the Tailwind theme;
     * the three status literals already in `tailwind.config.js` are the only exceptions,
     * and they are referenced by name, never repeated as hex.
     */
    for (const file of ['webview/src/OfficeView.tsx', 'webview/src/LogsTab.tsx']) {
        it(`${file} contains no literal hex colour`, () => {
            const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
            const hex = [...text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]);
            expect(hex, `hard-coded colours: ${hex.join(', ')}`).toEqual([]);
        });

        it(`${file} uses no Tailwind palette colour outside the theme`, () => {
            // `zinc-800`, `slate-500` and friends are Tailwind defaults that do not resolve
            // to a VS Code variable, so they survive a theme switch unchanged.
            const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
            const palette = [...text.matchAll(/\b(?:bg|text|border)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g)]
                .map(m => m[0]);
            expect(palette, `off-theme colours: ${palette.join(', ')}`).toEqual([]);
        });
    }
});

describe('R3 — no topology we do not execute', () => {
    it('the phase strip says the phases run in sequence', () => {
        // Parallel wave execution was deleted on the merits in Phase 6 (M35). The label is
        // part of the component so a later edit cannot drop it and leave a graphic that
        // reads as a parallel scheduler.
        expect(officeView).toContain('runs in sequence');
    });

    it('no surface renders a wave scheduler', () => {
        // Comments are stripped first: this file *discusses* wave execution at length, to
        // record why it is absent. What must not exist is a rendered one.
        const code = officeView
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '')
            .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
        expect(code.toLowerCase()).not.toContain('wave');
    });
});
