import * as vscode from 'vscode';
import { GovernorSnapshot } from '@blackide/agent-core/core/agent-governor';
import { OfficeStatus, officeStatus } from '@blackide/agent-core/core/office-model';

// ─── The Office's always-on surface (M73) ───────────────────────────────────
//
// Every other Office surface has to be opened. This one is the answer to the question
// nobody thinks to ask: *is anything waiting on me right now?* — which is precisely the
// question a user who has forgotten they launched an agent will never open a panel to ask.
//
// ── Why this is not a webview ────────────────────────────────────────────────
// The Manager panel drops posts when it is closed, and the hub declines to build a
// snapshot when no surface is open (`office-hub.ts:28-32`). That publish rule is right for
// a dashboard and fatal for an alarm: a monitoring surface whose data stops flowing when
// nobody is watching is a surface that can only ever tell you what you already knew. The
// status bar entry is fed from the lane's own inbox poll instead — six numbers that were
// computed anyway, on a cadence that already exists.
//
// ── What it costs ────────────────────────────────────────────────────────────
// Nothing that was not already spent. `refreshInbox` runs every three seconds regardless,
// computes `inboxCounts` and a `GovernorSnapshot` regardless, and threw both away when no
// panel was open. This class is the consumer that was missing, not a new producer.

/** The two already-computed values the entry is built from. */
export interface OfficeStatusInput {
    counts: { total: number; blocking: number; review: number; failed: number };
    governor?: GovernorSnapshot;
}

export class OfficeStatusItem implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    /** The last rendered label, so an unchanged poll does not touch the DOM. */
    private rendered?: string;

    constructor() {
        /*
         * Left-aligned at a low priority, which puts it at the right-hand end of the left
         * group — after the branch and the problem counts, before the cursor position.
         * That is where §7.1 draws it, and the position is not arbitrary: it sits with the
         * other ambient facts about the workspace rather than with the editor's own state.
         */
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.item.command = 'black-ide.openOffice';
        this.item.name = 'Agent Office';
        // Shown before anything has run, and before the first poll. An entry that appears
        // only once an agent is launched is one the user has to already know about.
        this.update({ counts: { total: 0, blocking: 0, review: 0, failed: 0 } });
        this.item.show();
    }

    /**
     * Fold one recompute into the entry. Called from the lane's inbox poll.
     *
     * Returns the projection so the caller can drive the sidebar's badge from the same
     * one — two always-on surfaces disagreeing about how many things need you is exactly
     * the drift a single projection exists to prevent.
     */
    update(input: OfficeStatusInput): OfficeStatus {
        const status = officeStatus({ governor: input.governor, counts: input.counts });
        if (status.text === this.rendered) {
            // The tooltip still moves — spend rises between polls while the label holds —
            // so it is refreshed even when the label is unchanged.
            this.item.tooltip = status.tooltip;
            return status;
        }
        this.rendered = status.text;
        this.item.text = status.text;
        this.item.tooltip = status.tooltip;
        this.item.backgroundColor = backgroundFor(status);
        return status;
    }

    dispose(): void {
        this.item.dispose();
    }
}

/**
 * Tint only for the two states the user must act on.
 *
 * A status bar background is the loudest thing this API offers — it colours the whole
 * entry — and using it for "three agents are running normally" would leave nothing to
 * escalate to. `warningBackground` is the theme's own token, so it inherits the contrast
 * decision every other extension's warning made rather than picking a fourth colour.
 */
function backgroundFor(status: OfficeStatus): vscode.ThemeColor | undefined {
    if (status.attention > 0 || status.exhausted) {
        return new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    return undefined;
}
