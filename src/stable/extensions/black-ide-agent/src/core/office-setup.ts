import * as path from 'path';
import * as vscode from 'vscode';
import { SecretManager } from '@blackide/agent-core/core/secret-manager';
import { JournalStore } from '../agent/journal-store';
import { CodebaseIndex } from '@blackide/agent-core/core/codebase-index';
import { PipelineRunSummary } from '@blackide/agent-core/core/pipeline-runs';
import { ProjectProfile } from '@blackide/agent-core/core/project-profiler';
import { ArtifactStore } from '../agent/artifact-store';
import { TaskAgentLane } from '../agent/task-agent-lane';
import { ModeLoader } from './mode-loader';
import { ManagerPanel, ManagerPanelHost, ManagerTab } from './manager-panel';
import { OfficeHub } from './office-hub';
import { OfficeSidebar } from './office-sidebar';
import { OfficeStatusItem } from './office-status';

// Re-exported so a caller that receives an `Office` can name its halves without a second
// import of the module that happens to define them.
export { OfficeHub };

// ─── Assembling the Agent Office ────────────────────────────────────────────
//
// The task-agent lane and the Office hub are constructed together because they are two
// halves of one thing: the lane produces the events, the hub turns them into desks, and
// wiring them at their use site would mean the lane exists for a moment without a
// telemetry subscriber and would drop whatever a fast-launching agent published first.
//
// This lives in its own module for a duller reason that is nonetheless a real constraint:
// `extension.ts` has a hard 700-line gate (G10, asserted in `source-hygiene.test.ts`) that
// has already fired twice, and it is currently at 698. New wiring goes in a module; the
// entry point gains a call, not a block.

export interface OfficeSetupDeps {
    context: vscode.ExtensionContext;
    secretManager: SecretManager;
    codebaseIndex: CodebaseIndex;
    modeLoader: ModeLoader;
    artifacts: ArtifactStore;
    getProjectProfile(): Promise<ProjectProfile>;
    listPipelineRuns(): PipelineRunSummary[];
    /** Ordered phase names for a run, when the orchestrator has published them. */
    phasesFor?(runId: string): { names: string[]; current?: string } | undefined;
    log(message: string): void;
}

export interface Office {
    lane: TaskAgentLane;
    hub: OfficeHub;
    journal: JournalStore;
}

export function createOffice(deps: OfficeSetupDeps): Office {
    /*
     * Declared before the lane so the lane's callbacks can close over it.
     *
     * `hub` is assigned on the next statement and the callbacks only fire once an agent is
     * running — several `await`s later at the earliest — so the temporal dead zone is not
     * reachable. Constructing the hub first is not an option: it needs `lane.list()`.
     */
    let hub: OfficeHub;

    /*
     * The one surface that is not gated on anything (M73).
     *
     * Built before the lane so it can be a plain constructor dependency rather than
     * something attached afterwards — and it is fed from the lane's inbox poll rather
     * than from the hub's `post` below, because that gate is precisely what it must not
     * be behind. An entry that goes blank when both panels are closed answers "is
     * anything waiting on me?" only for users who were already looking.
     */
    const status = new OfficeStatusItem();

    /*
     * The durable half of the Office (M82).
     *
     * Constructed here rather than in `extension.ts` so it can be handed to every lane at
     * the moment the lane is built — a journal wired up one statement late is a journal
     * that is missing the start of the first run, which is the part that says what the
     * agent was asked to do.
     */
    const journal = new JournalStore({
        directory: path.join((deps.context.storageUri ?? deps.context.globalStorageUri).fsPath, 'journal'),
        onLine: (line) => {
            // The live tail. Dropped when nothing is open — the file is already written, so
            // a closed panel loses a repaint, not a record. Only the Manager panel has a
            // Logs tab, so this stays a single destination even though the Office now has
            // two surfaces.
            if (ManagerPanel.isOpen()) ManagerPanel.post({ type: 'journalLine', value: line });
        },
    });
    journal.sweep();

    const lane = new TaskAgentLane({
        context: deps.context,
        secretManager: deps.secretManager,
        codebaseIndex: deps.codebaseIndex,
        modeLoader: deps.modeLoader,
        artifacts: deps.artifacts,
        getProjectProfile: deps.getProjectProfile,
        log: deps.log,
        readRunLog: (params) => hub?.readLogForModel(params),
        listPipelineRuns: deps.listPipelineRuns,
        postToSurfaces: (message) => {
            ManagerPanel.post(message);
            OfficeSidebar.post(message);
        },
        onAgentEvent: (agentId, event) => {
            hub?.record(agentId, event);
            hub?.journalEvent(agentId, 'task', event);
        },
        onRosterChanged: () => hub?.sync(),
        // One projection, two always-on surfaces: the label in the status bar, the same
        // count on the activity-bar icon.
        onOfficeStatus: (input) => OfficeSidebar.setBadge(status.update(input).attention),
    });

    hub = new OfficeHub({
        journal,
        listAgents: () => lane.list(),
        listPipelines: deps.listPipelineRuns,
        listInbox: () => lane.inbox(),
        governorSnapshot: () => lane.governor.snapshot(),
        listDaemonResults: () => lane.daemonWork(),
        phasesFor: deps.phasesFor,
        /*
         * The publish gate.
         *
         * `ManagerPanel.post` drops the message when no panel is open, and returns nothing
         * — so the hub cannot tell "delivered" from "dropped" and would keep building
         * snapshots for a surface that does not exist. `isOpen` is checked here instead,
         * which is what makes "nothing is computed when no surface is open" true of the
         * producer rather than only of the consumer.
         */
        post: (message) => {
            /*
             * Two surfaces since M73, and the gate is the *disjunction*.
             *
             * Each destination drops the message itself when it is not there, so the
             * fan-out is unconditional; what this decides is whether the snapshot was
             * worth building at all. Asking "is the panel open" alone would have made the
             * sidebar a surface that renders whatever the editor tab happened to be
             * watching — live only when a second, unrelated window was also open.
             */
            const panel = ManagerPanel.isOpen();
            const sidebar = OfficeSidebar.isOpen();
            if (!panel && !sidebar) return false;
            if (panel) ManagerPanel.post(message);
            if (sidebar) OfficeSidebar.post(message);
            return true;
        },
    });

    hub.start();
    deps.context.subscriptions.push(lane, status, { dispose: () => hub.dispose() });
    return { lane, hub, journal };
}

/**
 * Register the sidebar Front Desk (M73).
 *
 * Separate from `createOffice` because the two run at different moments and need
 * different things. The Office itself is assembled inside the chat provider's
 * constructor, before there is a Manager panel to hand off to; the sidebar needs both the
 * finished provider and that panel, so it is registered from `activate()` once they
 * exist.
 *
 * It lives in this module rather than in `extension.ts` for the reason the header gives:
 * the entry point gains a call, not a block.
 */
export function registerOfficeSidebar(
    context: vscode.ExtensionContext,
    host: ManagerPanelHost,
    openManager: (tab?: ManagerTab) => void,
): void {
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            OfficeSidebar.viewType,
            new OfficeSidebar(context, host, openManager),
            // Deliberately *not* `retainContextWhenHidden`, unlike the chat view directly
            // above it. The Front Desk holds no unsaved input and rebuilds from one
            // `officeSync` on mount, so keeping a collapsed React tree alive would buy a
            // repaint the user cannot perceive at the cost of a webview that never sleeps.
            //
            // The asymmetry with the chat is the point of the two settings, not an
            // oversight: now that both panes live in one container, collapsing either is
            // routine, and the chat *does* hold something a rebuild would destroy — a
            // half-typed prompt and a scrolled conversation.
            { webviewOptions: { retainContextWhenHidden: false } },
        ),
    );
}
