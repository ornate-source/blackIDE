import * as vscode from 'vscode';
import { ManagerPanelHost, ManagerTab } from './manager-panel';
import { handleOfficeMessage } from './office-messages';

// ─── The Front Desk — the Office in the sidebar (M73) ───────────────────────
//
// The same floor as the editor tab, beside the work rather than on top of it. Which is
// the entire point: the Manager panel takes over an editor column, so glancing at what
// the agents are doing costs the user the file they were reading, and the cost falls
// hardest on whoever checks most often.
//
// ── Why it is stacked under the chat, not beside it ──────────────────────────
// This view is the second pane of the `black-ide-chat` container rather than a container
// of its own. Two activity-bar icons made "the agents" a place separate from "the agent",
// which is a distinction the product does not actually draw — the runs on this floor are
// the ones launched from the chat directly above it, and a user who wanted both open paid
// for the split by never having both open. Stacked, the answer to "what are my agents
// doing" is under the conversation that started them, and collapsing it is a click.
//
// The practical consequence is that being hidden is now routine rather than exceptional:
// a collapsed section is the resting state, not an unopened container. Everything below
// that turns on visibility — the publish gate, the re-sync, the badge — was already
// written for it, because a background container had the same property.
//
// ── Why this is a second surface and not a second implementation ─────────────
// It renders `OfficeView`, reads the same `officeSync`/`officePatch` channel, and routes
// every button through `office-messages.ts`. Nothing about the Office is decided here —
// this file owns a webview's lifecycle and two hand-offs to the wider panel, and that is
// all it is allowed to own. A sidebar that recomputed "what is this agent doing" from the
// same events would be the fourth surface to have an opinion about it, which is the drift
// `office-model.ts` was written to end.
//
// ── The hand-offs ────────────────────────────────────────────────────────────
// Two things genuinely do not fit in ~46 columns: the full floor with its files-in-play
// table, and a run's journal. Both are buttons that open the Manager panel on the right
// tab rather than cramped renditions of it.

export class OfficeSidebar implements vscode.WebviewViewProvider {
    public static readonly viewType = 'black-ide-office-view';

    /**
     * The live view, so the hub can push to it without holding a reference — the same
     * arrangement `ManagerPanel` uses, and for the same reason: the producers (the task
     * lane, the journal) outlive any particular surface.
     */
    private static _live?: OfficeSidebar;
    private _view?: vscode.WebviewView;

    static post(message: any): void {
        OfficeSidebar._live?._view?.webview.postMessage(message);
    }

    /**
     * The count on the section header, and on the shared activity-bar icon.
     *
     * `WebviewView.badge` was carried as a risk in the design record — "may not exist in
     * the fork's API version" — and it does, so the attention count lands on the icon as
     * well as in the status bar. Two always-on surfaces rather than one is not redundancy
     * here: the status bar says *what* (`3▸ 1!`), the badge says *where to click*.
     *
     * Since the Front Desk was stacked into the chat container it renders in two places
     * from this one call: on the `Agent Office` section header, and aggregated onto the
     * `Black Agent` activity-bar icon the two views now share. The second is what the
     * number is for — it is legible with the whole sidebar closed.
     *
     * Set on the view rather than posted into the webview, so it survives the section
     * being collapsed — which is the state it will spend most of its life in.
     *
     * Only reaches a view that has been resolved: VS Code does not construct a webview
     * view until it is first expanded. That is why the status bar entry is the surface
     * the acceptance criterion rests on, and this is the improvement on it.
     */
    static setBadge(attention: number): void {
        const view = OfficeSidebar._live?._view;
        if (!view) return;
        // Cleared rather than set to zero: a badge reading `0` is a decoration, and the
        // platform renders `undefined` as no badge at all.
        view.badge = attention > 0
            ? { value: attention, tooltip: `${attention} agent${attention === 1 ? '' : 's'} need${attention === 1 ? 's' : ''} you` }
            : undefined;
    }

    /**
     * Whether the sidebar is both registered *and* visible.
     *
     * Visibility, not just existence, because a collapsed or background view is exactly
     * the case the Office's publish rule cares about: VS Code stops delivering to a hidden
     * webview, so computing a snapshot for one costs the projection and buys nothing. The
     * view re-syncs when it becomes visible again.
     *
     * This carries more weight now that the section sits under the chat: collapsing it is
     * a one-click, in-passing gesture, so `false` here is a state the user enters and
     * leaves many times a session rather than a container they never opened.
     */
    static isOpen(): boolean {
        return !!OfficeSidebar._live?._view?.visible;
    }

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _host: ManagerPanelHost,
        /**
         * The wider panel, injected rather than reached for.
         *
         * `ManagerPanel` is owned by `extension.ts`, not by the provider this view shares
         * a host interface with — so taking it as a parameter is what keeps this file
         * from needing to know how the panel is constructed or who else holds one.
         */
        private readonly _openManager: (tab?: ManagerTab) => void,
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this._view = view;
        OfficeSidebar._live = this;

        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._context.extensionUri, 'dist'),
                vscode.Uri.joinPath(this._context.extensionUri, 'resources'),
            ],
        };
        view.webview.html = this._host.getHtmlForWebview(view.webview, 'office');

        view.webview.onDidReceiveMessage(async (data: any) => {
            switch (data?.type) {
                /*
                 * The two hand-offs, and the only messages this file answers itself.
                 *
                 * Both open the Manager panel on a named tab rather than posting into it
                 * blind, because the panel may not exist yet — `ManagerPanel.open` holds
                 * the request until its webview mounts.
                 */
                case 'openOfficeTab':
                    this._openManager({ lane: 'office' });
                    break;
                case 'openRunLogs':
                    this._openManager({ lane: 'logs', runId: String(data.value?.runId || '') });
                    break;
                default:
                    await handleOfficeMessage(this._host, data, this.sink());
                    break;
            }
        });

        /*
         * Re-sync when the view comes back into view.
         *
         * Patches sent while it was hidden were dropped by the platform, and a patch
         * channel cannot express "this row is gone" — so a view that repainted from stale
         * state would show desks for agents that retired while it was collapsed. Same
         * reasoning as the Manager panel's per-tab re-read.
         */
        view.onDidChangeVisibility(() => {
            if (view.visible) this._host.office?.sync();
        }, null, this._context.subscriptions);

        view.onDidDispose(() => {
            this._view = undefined;
            if (OfficeSidebar._live === this) OfficeSidebar._live = undefined;
        }, null, this._context.subscriptions);
    }

    /**
     * Where replies from the shared handler go.
     *
     * Mostly straight to the webview, with one interception: `officePrefill` is the reply
     * to a `[ Retry ]` click and it fills a launcher this surface does not have. Dropping
     * it would make the button do nothing here while working on the floor — the R2 defect
     * arriving through the back door — so it is carried to the panel that does have one.
     */
    private sink() {
        const webview = this._view?.webview;
        return {
            postMessage: (message: any) => {
                if (message?.type === 'officePrefill') {
                    this._openManager({ lane: 'agent', prefill: message.value });
                    return;
                }
                webview?.postMessage(message);
            },
        };
    }
}
