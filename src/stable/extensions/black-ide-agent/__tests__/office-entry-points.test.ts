import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GovernorSnapshot } from '@blackide/agent-core/core/agent-governor';
import { officeStatus } from '@blackide/agent-core/core/office-model';

/**
 * M73 — the Office is reachable.
 *
 * The wave that built the Office shipped the model, the desks, the journal and the log
 * reader, and contributed no command, no view and no status bar entry. Every one of those
 * surfaces worked; none of them could be found. A feature that is fully implemented,
 * correctly wired and silently unreachable is the exact defect `tool-surface.test.ts` and
 * `command-surface.test.ts` were each written for, and this is the third instance — so it
 * gets the same treatment, asserted from the manifest rather than trusted to a reviewer
 * noticing an absent entry.
 *
 * The status bar half is asserted on the projection instead, because that is where the
 * decision lives: what the entry *says* is a pure function of two already-computed values,
 * and it is the one Office surface whose whole purpose is being correct when nobody is
 * watching it.
 */

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const contributed: any[] = manifest.contributes.commands || [];
const views: any[] = Object.values(manifest.contributes.views || {}).flat() as any[];

describe('the Office has entry points', () => {
    it('contributes a command that names the Office', () => {
        const command = contributed.find(c => c.command === 'black-ide.openOffice');
        expect(command, 'no black-ide.openOffice — the Office is palette-invisible').toBeTruthy();
        // The Pipeline Manager's title is the reason this milestone exists: the Office
        // shipped inside a command called "Pipeline Manager" and nobody could find it.
        expect(command.title).toContain('Agent Office');
    });

    it('registers a sidebar view for the Front Desk', () => {
        const view = views.find(v => v.id === 'black-ide-office-view');
        expect(view, 'no black-ide-office-view — nothing for the toast to reveal').toBeTruthy();
        expect(view.type).toBe('webview');
    });

    it('puts the Office in the global activity menu', () => {
        const activity: any[] = manifest.contributes.menus?.['global/activity'] || [];
        expect(activity.map(e => e.command)).toContain('black-ide.openOffice');
    });

    it('the toast reveals the sidebar rather than opening an editor tab', () => {
        /*
         * The acceptance clause, asserted at the source.
         *
         * Opening the Manager panel takes over the editor column the user was reading, so
         * acting on a notification cost them their place — a toll charged to exactly the
         * people who responded promptly. A source scan rather than a runtime check because
         * the failure is a one-word edit to a command id, which no runtime test that stubs
         * `showInformationMessage` would catch.
         */
        const lane = fs.readFileSync(path.join(ROOT, 'src/agent/task-agent-lane.ts'), 'utf8');
        const toast = lane.slice(lane.indexOf('showInformationMessage'));
        expect(toast).toContain('black-ide.openOffice');
        expect(toast, 'the toast still opens an editor tab').not.toContain('black-ide.openPipelineManager');
    });
});

// ── The status bar entry ────────────────────────────────────────────────────

const governor = (over: Partial<GovernorSnapshot> = {}): GovernorSnapshot => ({
    active: 0, maxConcurrent: 4, tokensSpent: 0, tokenBudget: 0,
    costSpent: 0, costBudget: 0, exhausted: false, ...over,
});
const counts = (over: Partial<{ total: number; blocking: number; review: number; failed: number }> = {}) =>
    ({ total: 0, blocking: 0, review: 0, failed: 0, ...over });

describe('the status bar entry', () => {
    it('is four characters of reassurance when nothing is running', () => {
        // The design decision this asserts: `◆ Office 0▸ 0!` on a workspace where nothing
        // has ever run trains the user to stop reading the entry, and the one time it says
        // `1!` they will not notice.
        expect(officeStatus({ governor: governor(), counts: counts() }).text).toBe('◆ Office');
    });

    it('shows the running count and the attention count', () => {
        const status = officeStatus({
            governor: governor({ active: 3 }),
            counts: counts({ total: 4, blocking: 1, review: 3 }),
        });
        expect(status.text).toBe('◆ Office 3▸ 1!');
    });

    it('counts failures as attention and finished work as not', () => {
        // `review` is work that finished and is waiting to be looked at: real, in the Front
        // Desk, and deliberately not in the badge. Nothing is stuck and nothing is on a
        // timer, and a permanently non-zero badge is an ignored badge.
        expect(officeStatus({ governor: governor(), counts: counts({ review: 5 }) }).attention).toBe(0);
        expect(officeStatus({ governor: governor(), counts: counts({ failed: 2 }) }).text).toBe('◆ Office 2!');
        expect(officeStatus({ governor: governor(), counts: counts({ blocking: 1, failed: 2 }) }).text)
            .toBe('◆ Office 3!');
    });

    it('says when the budget is spent', () => {
        const status = officeStatus({ governor: governor({ exhausted: true }), counts: counts() });
        expect(status.text).toBe('◆ Office ⛔ budget');
        expect(status.exhausted).toBe(true);
    });

    it('does not drop live facts to fit the exhausted label', () => {
        // §7.4 is explicit that agents already running finish after the budget is spent,
        // so all three facts can be true at once. A surface that showed only the budget
        // would be deciding which of the user's problems is worth mentioning.
        expect(officeStatus({
            governor: governor({ active: 3, exhausted: true }),
            counts: counts({ failed: 1 }),
        }).text).toBe('◆ Office ⛔ budget 3▸ 1!');
    });

    it('invents no number it cannot source', () => {
        // R1 at its sharpest. With no governor snapshot there is no slot count to show,
        // and a `0▸` would be a measurement nobody took rendered as a measured zero.
        const status = officeStatus({ governor: undefined, counts: counts() });
        expect(status.text).toBe('◆ Office');
        expect(status.tooltip).not.toContain('slots');
    });

    it('names its numbers in the tooltip', () => {
        // `3▸ 1!` is a rebus without this.
        const tooltip = officeStatus({
            governor: governor({ active: 3, costSpent: 0.82, costBudget: 5 }),
            counts: counts({ blocking: 1, review: 2 }),
        }).tooltip;
        expect(tooltip).toContain('3 of 4 slots running');
        expect(tooltip).toContain('$0.82 of $5.00 spent');
        expect(tooltip).toContain('1 waiting on you');
        expect(tooltip).toContain('2 finished, ready to review');
    });

    it('states no budget when there is no ceiling', () => {
        // A budget of zero means "unlimited" in `agent-governor.ts`, so `$0.19 / $0.00`
        // would read as an overrun.
        const tooltip = officeStatus({
            governor: governor({ costSpent: 0.19, costBudget: 0 }), counts: counts(),
        }).tooltip;
        expect(tooltip).not.toContain('spent');
    });
});
