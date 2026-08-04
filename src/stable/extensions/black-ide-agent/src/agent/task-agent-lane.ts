import * as vscode from 'vscode';
import { AgentGovernor, GOVERNOR_DEFAULTS } from '../core/agent-governor';
import { TaskAgentSummary } from '../core/task-agents';
import { PipelineRunSummary } from '../core/pipeline-runs';
import {
    InboxItem, buildInbox, inboxCounts, newlyNotifiable, notificationKey, pruneNotified,
    summarizeForNotification,
} from '../core/agent-inbox';
import { RaceCandidate, planRace, pickWinner } from '../core/model-race';
import { TaskAgentRegistry } from './task-agent-registry';
import { TaskAgentEntryDeps, buildTaskRunner, buildWorktreeOps } from './task-agent-entry';
import { SecretManager } from '../core/secret-manager';
import { daemonInboxItems, mergeInbox } from '../core/daemon-protocol';
import { markResultSeen, readResults } from '../agent-core/daemon';

// ─── The task-agent lane, assembled (Phase 6) ───────────────────────────────
//
// One object holding the pieces Phase 6 added — the governor (M33), the registry
// (M31/M32), the inbox (M34) and the race (M37) — so `extension.ts` gains a field rather
// than five, and stays inside the ≤700-line gate that has now fired in two consecutive
// phases.
//
// It is also where the two lanes finally meet: the inbox is a function of *both* the
// pipeline runs and the task agents, and something has to hold both. That something is
// deliberately not `extension.ts`.

const STORAGE_KEY = 'task-agent-history';

/** How often the inbox is recomputed. The gate asks for notification within 5 s. */
const INBOX_POLL_MS = 3_000;

export interface TaskAgentLaneDeps extends TaskAgentEntryDeps {
    context: vscode.ExtensionContext;
    secretManager: SecretManager;
    /** The other lane, so the inbox can see pipeline runs too. */
    listPipelineRuns(): PipelineRunSummary[];
    /** Pushes state to the Manager panel when it is open. */
    postToManager(message: any): void;
}

export class TaskAgentLane implements vscode.Disposable {
    readonly governor = new AgentGovernor();
    private readonly registry: TaskAgentRegistry;
    private notified = new Set<string>();
    private readonly timer: ReturnType<typeof setInterval>;

    constructor(private readonly d: TaskAgentLaneDeps) {
        this.registry = new TaskAgentRegistry({
            governor: this.governor,
            worktree: buildWorktreeOps(),
            runTask: buildTaskRunner(d),
            load: () => d.context.globalState.get<TaskAgentSummary[]>(STORAGE_KEY) || [],
            save: (agents) => { void d.context.globalState.update(STORAGE_KEY, agents); },
            onChanged: (agents) => {
                d.postToManager({ type: 'taskAgentListSync', value: agents });
                this.refreshInbox();
            },
        });

        // Polled rather than purely event-driven, because two of the four inbox reasons
        // are *time*-based: a blocked run becomes parked without anything happening, and
        // an event-only surface would never notice.
        this.timer = setInterval(() => this.refreshInbox(), INBOX_POLL_MS);
    }

    dispose(): void {
        clearInterval(this.timer);
    }

    /** Re-read limits from settings, so a changed cap applies without a reload. */
    async configureFromSettings(): Promise<void> {
        try {
            const raw = await this.d.secretManager.getKey('general-settings');
            const settings = raw ? JSON.parse(raw) : {};
            this.governor.configure({
                maxConcurrent: settings.maxConcurrentAgents ?? GOVERNOR_DEFAULTS.maxConcurrent,
                tokenBudget: Number(settings.sessionTokenBudget) || 0,
                costBudget: Number(settings.sessionCostBudget) || 0,
            });
        } catch { /* defaults stand */ }
    }

    // ── Panel-facing API ────────────────────────────────────────────────────

    launch(prompt: string, modelId: string, mode: string | undefined, rootPath: string) {
        return this.registry.launch({ prompt, modelId, mode, rootPath });
    }

    cancel(id: string): void { this.registry.cancel(id); }

    /** A review comment becomes a correction on the running agent's next turn (M39). */
    steer(id: string, text: string, options: { artifactPath?: string; region?: string } = {}) {
        return this.registry.steer(id, text, options);
    }
    /** Which agents a review comment can still reach (M38). */
    liveIds(): string[] { return this.registry.liveIds(); }
    apply(id: string) { return this.registry.apply(id); }
    discard(id: string) { return this.registry.discard(id); }
    list(): TaskAgentSummary[] { return this.registry.list(); }

    /**
     * Launch a race (M37): the same prompt to N models, N worktrees.
     *
     * Each candidate is an ordinary task agent, so everything the lane already guarantees
     * — isolation, kill-one, untouched-until-apply — applies unchanged. A race is a
     * *labelling* of agents, not a second execution mechanism.
     */
    startRace(prompt: string, modelIds: string[], rootPath: string): { raceId: string } | { error: string } {
        const planned = planRace(prompt, modelIds);
        if (!planned.ok) return { error: planned.error };

        const started: string[] = [];
        for (const modelId of planned.plan.modelIds) {
            const result = this.registry.launch({ prompt: planned.plan.prompt, modelId, rootPath, raceId: planned.plan.raceId });
            if ('error' in result) {
                // Partial admission is worse than none: two of four candidates is not a
                // comparison, and the user would be choosing from a field the governor
                // truncated rather than one they chose.
                for (const id of started) this.registry.cancel(id);
                return { error: `Could not start the full race — ${result.error}` };
            }
            started.push(result.agent.id);
        }
        return { raceId: planned.plan.raceId };
    }

    /** Rank a race's candidates. Never applies anything — the user picks. */
    raceOutcome(raceId: string) {
        const candidates: RaceCandidate[] = this.registry.inRace(raceId).map(agent => ({
            agentId: agent.id,
            modelId: agent.modelId,
            status: agent.status,
            diff: agent.diff,
            // M37's missing half, closed in Phase 7: the verify step (M40) records what
            // the suite did, so the race ranks on test results rather than falling
            // through to diff size — the fourth tiebreak doing the first one's job.
            evidence: agent.verification
                ? {
                    testsRan: agent.verification.testsRan,
                    passed: agent.verification.passed,
                    failed: agent.verification.failed,
                    durationMs: agent.endedAt && agent.startedAt ? agent.endedAt - agent.startedAt : undefined,
                }
                : { testsRan: false },
        }));
        return pickWinner(candidates);
    }

    // ── Inbox (M34) ─────────────────────────────────────────────────────────

    inbox(): InboxItem[] {
        /*
         * Daemon results join the inbox here — M65's fourth gate clause (P11-3).
         *
         * The clause is "a daemon run's results appear in the inbox", and this is the
         * line that makes it true. A daemon that only logged to a file would have "run"
         * without "reported": the user opens the editor the next morning and nothing
         * tells them the overnight run finished, failed, or has been sitting since 02:00.
         * F16 graded exactly that defect 🔴 for the in-editor lanes, and a daemon
         * reintroduces it in the form where the user is least likely to look.
         *
         * Merged rather than folded into `buildInbox`, which is about the two *live*
         * in-editor lanes and has carefully never had a filesystem dependency.
         */
        const editorItems = buildInbox(this.d.listPipelineRuns(), this.registry.list());
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) return editorItems;
        try {
            return mergeInbox(editorItems, daemonInboxItems(readResults(root)));
        } catch {
            // A missing or unreadable daemon directory is the normal case for anyone who
            // has never run one. The in-editor inbox must not depend on it.
            return editorItems;
        }
    }

    /** The user has seen a daemon result, so it stops appearing. */
    acknowledgeDaemonResult(id: string): void {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root) markResultSeen(root, id.replace(/^daemon:/, ''));
    }

    /**
     * Recompute, push to the panel, and notify about anything new.
     *
     * The notification is a window message rather than an OS one because VS Code has no
     * API for the latter, and it is fired at most once per (item, reason) — a surface that
     * re-announces on every poll gets switched off within the hour, after which the user
     * has both the missed run and a dead channel.
     */
    private refreshInbox(): void {
        const items = this.inbox();
        const counts = inboxCounts(items);
        this.d.postToManager({ type: 'agentInboxSync', value: { items, counts } });

        this.notified = pruneNotified(this.notified, items);
        const fresh = newlyNotifiable(items, this.notified);
        if (!fresh.length) return;
        for (const item of fresh) this.notified.add(notificationKey(item));

        // Only blocking work interrupts. A finished agent waiting to be reviewed is real
        // and belongs in the badge, but a toast for it would train the user to dismiss
        // toasts, and the next one might be the run that is actually stuck.
        const blocking = fresh.filter(i => i.reason === 'blocked' || i.reason === 'parked');
        if (!blocking.length) return;

        vscode.window.showInformationMessage(
            `Black IDE: ${summarizeForNotification(blocking)}`,
            'Open Manager',
        ).then(choice => {
            if (choice === 'Open Manager') void vscode.commands.executeCommand('black-ide.openPipelineManager');
        });
    }
}
