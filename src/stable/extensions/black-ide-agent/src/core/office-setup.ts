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
import { ManagerPanel } from './manager-panel';
import { OfficeHub } from './office-hub';

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
            // a closed panel loses a repaint, not a record.
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
        postToManager: (message) => ManagerPanel.post(message),
        onAgentEvent: (agentId, event) => {
            hub?.record(agentId, event);
            hub?.journalEvent(agentId, 'task', event);
        },
        onRosterChanged: () => hub?.sync(),
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
            if (!ManagerPanel.isOpen()) return false;
            ManagerPanel.post(message);
            return true;
        },
    });

    hub.start();
    deps.context.subscriptions.push(lane, { dispose: () => hub.dispose() });
    return { lane, hub, journal };
}
