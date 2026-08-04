import { PipelineRunSummary } from './pipeline-runs';
import { TaskAgentSummary, canApply } from './task-agents';

// ─── Agent inbox (Phase 6, M34) ─────────────────────────────────────────────
//
// F16 is graded 🔴/🟡 with one sentence: `awaiting_approval` exists and there is no
// notification surface, so an unattended run can idle unnoticed. That is the whole defect
// — the *state* was always right, nobody was ever told about it. A user who launches four
// agents and switches to a browser has no way to learn that one of them stopped for a
// question ninety seconds later, and the only thing worse than an agent that needs help is
// an agent that needed help an hour ago.
//
// ── What counts as needing a human ───────────────────────────────────────────
// Deliberately broader than "awaiting approval", because approval is not the only way a
// run ends up waiting:
//
//   - **blocked** — an approval gate is open. Nothing proceeds until answered.
//   - **review** — a task agent finished and its work is sitting in a worktree. This is
//     the one that would otherwise be missed entirely: nothing is wrong, nothing is
//     waiting on a timer, and the work quietly never lands.
//   - **failed** — it stopped and the user does not know.
//   - **parked** — blocked for longer than the idle timeout. Still blocked; the
//     distinction exists so the panel can say "this has been waiting 40 minutes" rather
//     than showing it identically to one that stopped five seconds ago.
//
// Pure: what needs attention is a function of the two lanes' summaries, so it can be
// tested without a webview, a notification, or a clock.

export type InboxReason = 'blocked' | 'review' | 'failed' | 'parked';

export interface InboxItem {
    id: string;
    kind: 'pipeline' | 'task';
    reason: InboxReason;
    title: string;
    detail: string;
    /** When the item entered this state — what the "waiting for N minutes" is measured from. */
    since: number;
    /** Blocked items outrank finished ones: one is holding something up, the other is not. */
    priority: number;
}

export interface InboxOptions {
    now?: number;
    /** How long a blocked item waits before it is called parked. */
    idleTimeoutMs?: number;
}

/** 15 minutes. Long enough not to cry wolf, short enough to catch a forgotten run. */
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;

const PRIORITY: Record<InboxReason, number> = { parked: 0, blocked: 1, failed: 2, review: 3 };

/**
 * Everything that needs a human, most urgent first.
 *
 * Ordering is by reason and then by age *ascending within blocked states* — the oldest
 * blocked run is the most urgent thing on the list, because it is the one that has been
 * wasting the most time. Finished-and-unreviewed items sort newest-first instead, since
 * there the user is looking for what just landed.
 */
export function buildInbox(
    pipelines: PipelineRunSummary[],
    agents: TaskAgentSummary[],
    options: InboxOptions = {},
): InboxItem[] {
    const now = options.now ?? Date.now();
    const idleTimeout = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const items: InboxItem[] = [];

    for (const run of pipelines || []) {
        if (run.status === 'awaiting_approval') {
            const since = run.startedAt;
            const parked = now - since >= idleTimeout;
            items.push({
                id: run.id, kind: 'pipeline',
                reason: parked ? 'parked' : 'blocked',
                title: truncate(run.prompt),
                detail: parked
                    ? `Waiting for plan approval for ${humanize(now - since)}.`
                    : 'Waiting for plan approval.',
                since, priority: PRIORITY[parked ? 'parked' : 'blocked'],
            });
        } else if (run.status === 'failed') {
            items.push({
                id: run.id, kind: 'pipeline', reason: 'failed',
                title: truncate(run.prompt),
                detail: run.error || 'The run failed.',
                since: run.endedAt ?? run.startedAt, priority: PRIORITY.failed,
            });
        }
    }

    for (const agent of agents || []) {
        if (agent.status === 'awaiting_approval') {
            const since = agent.startedAt;
            const parked = now - since >= idleTimeout;
            items.push({
                id: agent.id, kind: 'task',
                reason: parked ? 'parked' : 'blocked',
                title: truncate(agent.prompt),
                detail: parked ? `Waiting for approval for ${humanize(now - since)}.` : 'Waiting for approval.',
                since, priority: PRIORITY[parked ? 'parked' : 'blocked'],
            });
        } else if (agent.status === 'failed') {
            items.push({
                id: agent.id, kind: 'task', reason: 'failed',
                title: truncate(agent.prompt),
                detail: agent.error || 'The agent failed.',
                since: agent.endedAt ?? agent.startedAt, priority: PRIORITY.failed,
            });
        } else if (canApply(agent)) {
            // The quiet one. Nothing is wrong and nothing is waiting on a timer, so
            // without this the work simply never lands and nobody notices it did not.
            items.push({
                id: agent.id, kind: 'task', reason: 'review',
                title: truncate(agent.prompt),
                detail: 'Finished — review and apply, or discard.',
                since: agent.endedAt ?? agent.startedAt, priority: PRIORITY.review,
            });
        }
    }

    return items.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        const blocking = a.reason === 'blocked' || a.reason === 'parked';
        return blocking ? a.since - b.since : b.since - a.since;
    });
}

/** The badge. Blocked and parked runs are counted separately — they are the urgent half. */
export function inboxCounts(items: InboxItem[]): { total: number; blocking: number; review: number; failed: number } {
    return {
        total: items.length,
        blocking: items.filter(i => i.reason === 'blocked' || i.reason === 'parked').length,
        review: items.filter(i => i.reason === 'review').length,
        failed: items.filter(i => i.reason === 'failed').length,
    };
}

/**
 * Which items are new since the last notification, so the surface can fire once per event.
 *
 * A notifier that re-announces the whole inbox on every poll is a notifier the user turns
 * off within the hour, and then the feature is worse than not having it — they have both
 * the missed run *and* a disabled channel. Keyed by id **and reason**, so an agent that
 * goes from blocked to failed is announced again: that is a different thing happening, not
 * a repeat.
 */
export function newlyNotifiable(items: InboxItem[], alreadyNotified: Set<string>): InboxItem[] {
    return items.filter(item => !alreadyNotified.has(notificationKey(item)));
}

export function notificationKey(item: InboxItem): string {
    return `${item.kind}:${item.id}:${item.reason}`;
}

/**
 * Prune notification keys for items that are no longer in the inbox.
 *
 * Without this the set grows for the session and, worse, a run that comes *back* into a
 * state it was already announced in stays silent forever. Approve a plan, have the run
 * block again later, and nothing is said.
 */
export function pruneNotified(alreadyNotified: Set<string>, items: InboxItem[]): Set<string> {
    const live = new Set(items.map(notificationKey));
    return new Set([...alreadyNotified].filter(key => live.has(key)));
}

/** One line for a system notification. */
export function summarizeForNotification(items: InboxItem[]): string {
    if (items.length === 0) return '';
    if (items.length === 1) return `${items[0].title} — ${items[0].detail}`;

    const counts = inboxCounts(items);
    const parts: string[] = [];
    if (counts.blocking) parts.push(`${counts.blocking} waiting for you`);
    if (counts.review) parts.push(`${counts.review} ready to review`);
    if (counts.failed) parts.push(`${counts.failed} failed`);
    return parts.join(' · ');
}

function truncate(text: string, max = 60): string {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat || '(no prompt)';
}

function humanize(ms: number): string {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `${Math.max(1, minutes)} min`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
