import { useEffect, useReducer } from 'react';
import type { GovernorSnapshot } from '@blackide/agent-core/core/agent-governor';
import type { Affordance, Desk, OfficeSnapshot, WorkItem, WorkStatus } from '@blackide/agent-core/core/office-model';
import { staleness } from '@blackide/agent-core/core/office-narrate';

// ─── The Office tab: what every agent is doing, right now ───────────────────
//
// One desk per live agent, and the sentence in the middle of each desk is the point of
// the surface: `opened apiSlice.tsx` rather than a spinner. Everything here is a render of
// `OfficeSnapshot` — this file computes no state and derives no metric, because a second
// place that decides what a run is doing is a second place that can disagree with the
// first (see `office-model.ts`).
//
// ── R1 in the renderer ───────────────────────────────────────────────────────
// Every cell below asks whether its field is present and renders `—` when it is not. That
// is not defensive coding: a lane that publishes no turn counter and a lane on turn zero
// must not look alike, or the surface quietly asserts a measurement nobody took.
//
// ── R4 in the renderer ───────────────────────────────────────────────────────
// Every colour is a Tailwind token resolving to `var(--vscode-*)`, except the three status
// literals (`successGreen`, `warningAmber`, `dangerRed`) that already exist in the theme
// config and that the other panels already use. The Office inherits their contrast
// decision rather than making a fourth one.

export interface OfficeFile {
    path: string;
    by: string;
    kind: 'created' | 'modified' | 'deleted';
    at: number;
}

interface OfficeViewProps {
    office?: OfficeSnapshot;
    files: OfficeFile[];
    post: (message: any) => void;
    /**
     * Jump to this item's log.
     *
     * A callback rather than a posted message: switching tabs is webview state, and a
     * round trip to the extension host to change which `div` is visible would make the
     * button feel slower than the tab strip beside it.
     */
    onOpenLogs: (runId: string) => void;
}

const STATUS_TONE: Record<WorkStatus, string> = {
    running: 'text-focusBorder border-focusBorder/40 bg-focusBorder/10',
    needs_you: 'text-warningAmber border-warningAmber/40 bg-warningAmber/10',
    queued: 'text-muted border-border/50 bg-panel/40',
    ready: 'text-successGreen border-successGreen/40 bg-successGreen/10',
    failed: 'text-dangerRed border-dangerRed/40 bg-dangerRed/10',
    cancelled: 'text-muted border-border/50 bg-panel/40',
    done: 'text-muted border-border/50 bg-panel/40',
};

const STATUS_LABEL: Record<WorkStatus, string> = {
    running: 'RUNNING',
    needs_you: 'NEEDS YOU',
    queued: 'QUEUED',
    ready: 'READY',
    failed: 'FAILED',
    cancelled: 'CANCELLED',
    done: 'DONE',
};

const LANE_LABEL: Record<WorkItem['lane'], string> = {
    task: 'task', pipeline: 'pipe', chat: 'chat', daemon: 'dmon',
};

/** The message each button sends. R2 put the button here; this decides what it does. */
const ACTIONS: Record<Affordance, { label: string; tone?: 'primary' | 'danger'; type: string }> = {
    steer:      { label: 'Steer',       type: 'officeSteer' },
    stop:       { label: 'Stop',        type: 'cancelTaskAgent', tone: 'danger' },
    diff:       { label: 'Diff',        type: 'officeDiff' },
    worktree:   { label: 'Worktree',    type: 'officeWorktree' },
    // `logs` is handled in the webview — see ActionButton. The type is unused for it.
    logs:       { label: 'Logs',        type: 'officeLogs' },
    apply:      { label: 'Apply',       type: 'applyTaskAgent', tone: 'primary' },
    discard:    { label: 'Discard',     type: 'discardTaskAgent', tone: 'danger' },
    openBranch: { label: 'Open branch', type: 'officeWorktree' },
    retry:      { label: 'Retry',       type: 'officeRetry' },
    readPlan:   { label: 'Read plan',   type: 'officeReadPlan' },
    approve:    { label: 'Approve',     type: 'approvePipelineRun', tone: 'primary' },
    reject:     { label: 'Reject',      type: 'rejectPipelineRun', tone: 'danger' },
    dismiss:    { label: 'Dismiss',     type: 'acknowledgeDaemonResult' },
};

export function OfficeView({ office, files, post, onOpenLogs }: OfficeViewProps) {
    // Elapsed and staleness are functions of wall-clock time, not of any event — an agent
    // that has been stuck on one tool for thirty seconds emits nothing at all while it is
    // stuck, which is exactly the case the badge exists to catch. So the surface ticks.
    const [, tick] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, []);

    if (!office) {
        return <div className="text-[11px] text-muted/50 text-center py-8">Loading the floor…</div>;
    }

    const now = Date.now();
    const exhausted = office.governor?.exhausted;

    return (
        <div className="flex flex-col gap-3">
            <HeaderTiles snapshot={office} />

            {exhausted && <BudgetSpent governor={office.governor!} post={post} />}

            {office.desks.length === 0 && !exhausted && <EmptyFloor />}

            {/* One column under 520px, two under 900, three above — a width response, not
                a user preference. Desks are fixed-height so one appearing does not reflow
                the one the user is reading. */}
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                {office.desks.map((desk, index) => (
                    <DeskCard
                        key={desk.item?.id ?? `free-${index}`}
                        desk={desk} now={now} post={post} onOpenLogs={onOpenLogs}
                    />
                ))}
            </div>

            {files.length > 0 && <FilesInPlay files={files} now={now} post={post} />}
        </div>
    );
}

// ── Header ──────────────────────────────────────────────────────────────────

function HeaderTiles({ snapshot }: { snapshot: OfficeSnapshot }) {
    const g = snapshot.governor;
    return (
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
            <Tile
                label="desks"
                value={`${snapshot.running} of ${snapshot.capacity}`}
                detail={g ? `${Math.max(0, g.maxConcurrent - g.active)} free` : 'no configured cap'}
            />
            {/*
             * Spend against the *configured* budget, never a derived $/min.
             * A burn rate is a number that changes every second and answers no question;
             * "16% of what you allowed" is the one that changes a decision. A budget of
             * zero means unlimited in the governor, so it renders as a total rather than
             * as a percentage of nothing.
             */}
            <Tile
                label="spend"
                value={g ? (g.costBudget > 0 ? `${Math.round((g.costSpent / g.costBudget) * 100)}%` : `$${g.costSpent.toFixed(2)}`) : '—'}
                detail={g ? (g.costBudget > 0 ? `$${g.costSpent.toFixed(2)} / $${g.costBudget.toFixed(2)}` : 'no budget set') : 'not reported'}
            />
            <Tile
                label="tokens"
                value={g ? formatCount(g.tokensSpent) : '—'}
                detail={g && g.tokenBudget > 0 ? `of ${formatCount(g.tokenBudget)}` : 'this session'}
            />
            <Tile
                label="needs you"
                value={String(snapshot.counts.total)}
                detail={describeCounts(snapshot.counts)}
                tone={snapshot.counts.blocking > 0 ? 'warn' : undefined}
            />
        </div>
    );
}

function Tile({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: 'warn' }) {
    return (
        <div className="rounded-lg border border-border/40 bg-panel/30 px-3 py-2">
            <div className="text-[9px] uppercase tracking-wider text-muted/60">{label}</div>
            <div className={`text-[15px] font-semibold ${tone === 'warn' ? 'text-warningAmber' : 'text-foreground'}`}>{value}</div>
            <div className="text-[9.5px] text-muted/60 truncate">{detail}</div>
        </div>
    );
}

// ── A desk ──────────────────────────────────────────────────────────────────

function DeskCard({ desk, now, post, onOpenLogs }: { desk: Desk; now: number; post: (m: any) => void; onOpenLogs: (id: string) => void }) {
    if (desk.kind === 'free' || !desk.item) {
        return (
            <div className="rounded-lg border border-dashed border-border/40 bg-transparent p-3 flex flex-col items-center justify-center gap-1 min-h-[190px]">
                <div className="text-[10.5px] text-muted/50">a free desk</div>
                <div className="text-[9.5px] text-muted/40 text-center px-2">
                    A task here works in its own git worktree — your files are untouched until you apply it.
                </div>
            </div>
        );
    }

    const item = desk.item;
    const activity = item.activity;
    const stale = staleness(activity?.startedAt, now);

    return (
        <div className="rounded-lg border border-border/40 bg-panel/30 p-3 flex flex-col gap-2 min-h-[190px]">
            <div className="flex items-center gap-1.5 flex-wrap">
                <span className={`text-[8.5px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${STATUS_TONE[item.status]}`}>
                    {STATUS_LABEL[item.status]}
                </span>
                <span className="text-[9px] text-muted/50 font-mono">{LANE_LABEL[item.lane]}</span>
                <span className="text-[11px] font-semibold text-foreground truncate">{item.role}</span>
                <span className="text-[9px] text-muted/50 font-mono ml-auto">{item.id}</span>
            </div>

            <div className="text-[10.5px] text-foreground/90 leading-snug line-clamp-2">{item.title}</div>

            {/* The sentence. This is the surface's reason to exist. */}
            <div className="border-t border-border/30 pt-1.5">
                {activity ? (
                    <>
                        <div className="text-[10px] text-muted/70">{activity.verb}</div>
                        <div className="flex items-baseline gap-1.5">
                            <span className="text-[11.5px] text-foreground font-medium truncate">
                                {activity.label ?? activity.target ?? '—'}
                            </span>
                            {stale !== 'ok' && (
                                <span className={`text-[9px] font-semibold ${stale === 'stalled' ? 'text-dangerRed' : 'text-warningAmber'}`}>
                                    {stale === 'stalled' ? '⚠ stalled' : '⚠ slow'}
                                </span>
                            )}
                        </div>
                        <div className="text-[9px] text-muted/50 truncate">
                            {activity.dir ?? ''}
                            {activity.startedAt ? ` · ${formatElapsed(now - activity.startedAt)}` : ''}
                        </div>
                    </>
                ) : (
                    <div className="text-[10px] text-muted/50">{idleLine(item)}</div>
                )}
            </div>

            {item.phase && <PhaseStrip phase={item.phase} />}

            <Meters item={item} />

            {item.error && (
                <div className="text-[9.5px] text-dangerRed/90 line-clamp-2" title={item.error}>{item.error}</div>
            )}

            {/* R5 — the branch is the recovery path, not metadata, so it is always shown. */}
            {item.branch && (
                <div className="text-[9px] text-muted/50 font-mono truncate" title={item.branch}>⎇ {item.branch}</div>
            )}

            <div className="flex flex-wrap gap-1 mt-auto pt-1">
                {item.affordances.map(a => (
                    <ActionButton key={a} affordance={a} item={item} post={post} onOpenLogs={onOpenLogs} />
                ))}
            </div>
        </div>
    );
}

/**
 * The pipeline's position in its own sequence.
 *
 * R3 lives in this component: the label is part of it, so a later edit cannot drop the
 * "in sequence" wording and leave a graphic that reads as a parallel scheduler. Parallel
 * wave execution was deleted on the merits in Phase 6; this is a position indicator.
 */
function PhaseStrip({ phase }: { phase: NonNullable<WorkItem['phase']> }) {
    return (
        <div>
            <div className="flex items-center gap-0.5">
                {Array.from({ length: phase.total }, (_, i) => (
                    <div
                        key={i}
                        className={`h-1 flex-1 rounded-sm ${i < phase.index ? 'bg-focusBorder' : 'bg-border/50'}`}
                    />
                ))}
            </div>
            <div className="text-[9px] text-muted/60 mt-0.5">
                {phase.name} · {phase.index}/{phase.total} · runs in sequence
            </div>
        </div>
    );
}

/**
 * Turn against the cap, context against the limit, and the diff.
 *
 * Deliberately not a token-rate sparkline: token rate is near-constant per model, so a
 * chart of it is decoration that reads as telemetry. These three are things a user can act
 * on — an agent on turn 22 of 25 is about to run out of loop, and one at 90% context is
 * about to compact, which is when runs lose the thread.
 */
function Meters({ item }: { item: WorkItem }) {
    return (
        <div className="flex flex-col gap-1">
            <Meter
                label="turn"
                value={item.progress ? item.progress.turn / item.progress.maxTurns : undefined}
                text={item.progress ? `${item.progress.turn}/${item.progress.maxTurns}` : '—'}
                warn={!!item.progress && item.progress.turn / item.progress.maxTurns >= 0.8}
            />
            <Meter
                label="ctx"
                value={item.context ? item.context.percent / 100 : undefined}
                text={item.context ? `${item.context.percent}%` : '—'}
                warn={!!item.context && item.context.percent >= 85}
            />
            <div className="text-[9.5px] text-muted/60 flex gap-2">
                <span>
                    {item.delta
                        ? `${item.delta.files} file${item.delta.files === 1 ? '' : 's'} +${item.delta.insertions}/−${item.delta.deletions}`
                        : '— no diff yet'}
                </span>
                {item.evidence && (
                    <span className={item.evidence.outcome === 'verified' ? 'text-successGreen' : 'text-warningAmber'}>
                        {item.evidence.outcome === 'verified' ? '✔' : '·'} {describeEvidence(item.evidence)}
                    </span>
                )}
            </div>
        </div>
    );
}

/**
 * A bar, or an honest blank.
 *
 * `value === undefined` means the lane never published this measurement, and the bar is
 * drawn empty with a `—` beside it rather than at zero. A zero-width bar and a missing one
 * look identical, which is precisely the confusion R1 exists to prevent — so the track
 * itself is dimmed when there is nothing to show.
 */
function Meter({ label, value, text, warn }: { label: string; value?: number; text: string; warn?: boolean }) {
    const known = value !== undefined && Number.isFinite(value);
    return (
        <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-muted/50 w-6">{label}</span>
            <div className={`flex-1 h-1 rounded-sm overflow-hidden ${known ? 'bg-border/50' : 'bg-border/20'}`}>
                {known && (
                    <div
                        className={`h-full rounded-sm ${warn ? 'bg-warningAmber' : 'bg-focusBorder'}`}
                        style={{ width: `${Math.min(100, Math.max(0, value! * 100))}%` }}
                    />
                )}
            </div>
            <span className={`text-[9px] font-mono w-12 text-right ${warn ? 'text-warningAmber' : 'text-muted/60'}`}>{text}</span>
        </div>
    );
}

function ActionButton(
    { affordance, item, post, onOpenLogs }:
    { affordance: Affordance; item: WorkItem; post: (m: any) => void; onOpenLogs: (id: string) => void },
) {
    const action = ACTIONS[affordance];
    if (!action) return null;
    const tone =
        action.tone === 'primary' ? 'bg-successGreen/15 text-successGreen border-successGreen/30 hover:bg-successGreen/25'
        : action.tone === 'danger' ? 'bg-dangerRed/10 text-dangerRed border-dangerRed/30 hover:bg-dangerRed/20'
        : 'bg-panel/60 text-muted border-border/40 hover:text-foreground hover:border-border';
    return (
        <button
            onClick={() => affordance === 'logs'
                ? onOpenLogs(item.id)
                : post({ type: action.type, value: { agentId: item.id, runId: item.id, id: item.id, lane: item.lane } })}
            className={`text-[9.5px] px-2 py-0.5 rounded border cursor-pointer transition-colors ${tone}`}
        >
            {action.label}
        </button>
    );
}

// ── The rest of the floor ───────────────────────────────────────────────────

/**
 * What is being touched, and by whom.
 *
 * A flat table rather than a tree, because the question it answers is "is anything editing
 * the file I have open?" and a tree buries that under expansion state.
 */
function FilesInPlay({ files, now, post }: { files: OfficeFile[]; now: number; post: (m: any) => void }) {
    return (
        <div className="rounded-lg border border-border/40 bg-panel/30 overflow-hidden">
            <div className="px-3 py-1.5 border-b border-border/30 text-[9px] uppercase tracking-wider text-muted/60">
                files in play
            </div>
            <div className="max-h-[180px] overflow-y-auto">
                {files.map(file => (
                    <button
                        key={`${file.by}:${file.path}`}
                        onClick={() => post({ type: 'openArtifact', value: file.path })}
                        className="w-full text-left px-3 py-1 flex items-center gap-2 hover:bg-focusBorder/10 cursor-pointer"
                    >
                        <span className="text-[10px] text-foreground/90 truncate flex-1 font-mono">{file.path}</span>
                        <span className="text-[9px] text-muted/50 font-mono shrink-0">{file.by}</span>
                        <span className="text-[9px] text-muted/50 shrink-0 w-16 text-right">{file.kind}</span>
                        <span className="text-[9px] text-muted/40 shrink-0 w-12 text-right">{formatElapsed(now - file.at)}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}

/**
 * The empty state teaches the one property the whole task-agent design is built around.
 *
 * "Untouched until you apply" is the reason a user can launch four agents and walk away,
 * and the moment they are most able to absorb it is when nothing is running and there is
 * nothing else on the screen competing for the sentence.
 */
function EmptyFloor() {
    return (
        <div className="text-center py-10 px-6">
            <div className="text-[12px] text-foreground/80 mb-1">Nothing is running.</div>
            <div className="text-[10.5px] text-muted/60 max-w-[380px] mx-auto leading-relaxed">
                Launch a task and it works in its own git worktree — your workspace is not touched
                until you apply the result.
            </div>
        </div>
    );
}

/**
 * The budget wall, said before the click rather than after it.
 *
 * `GovernorSnapshot.exhausted` today produces a refusal message at launch time and nothing
 * else, so a user whose launches are being refused learns why only by being refused. The
 * running agents are named explicitly because a spend ceiling stops the *next* run — it
 * does not kill the ones in flight, and a user who thinks it did will go looking for work
 * that is still happening.
 */
function BudgetSpent({ governor, post }: { governor: GovernorSnapshot; post: (m: any) => void }) {
    const limit = governor.costBudget > 0
        ? `The session budget of $${governor.costBudget.toFixed(2)} is spent.`
        : `The session token budget of ${formatCount(governor.tokenBudget)} is spent.`;
    return (
        <div className="rounded-lg border border-warningAmber/40 bg-warningAmber/10 p-3">
            <div className="text-[11px] font-semibold text-warningAmber mb-1">Budget spent</div>
            <div className="text-[10.5px] text-foreground/80 leading-relaxed">
                {limit} Nothing further will start until it is raised or reset in Settings.
                {governor.active > 0 && ` The ${governor.active} already running will finish.`}
            </div>
            <button
                onClick={() => post({ type: 'openSettings' })}
                className="mt-2 text-[9.5px] px-2 py-0.5 rounded border bg-panel/60 text-muted border-border/40 hover:text-foreground cursor-pointer"
            >
                Open settings
            </button>
        </div>
    );
}

// ── Formatting ──────────────────────────────────────────────────────────────

function idleLine(item: WorkItem): string {
    switch (item.status) {
        case 'needs_you': return 'waiting for you';
        case 'ready': return 'finished — review and apply, or discard';
        case 'queued': return 'queued for a free desk';
        case 'failed': return 'stopped';
        case 'cancelled': return 'cancelled';
        case 'done': return 'finished';
        // Running with no activity is a real and important state: the model is thinking,
        // between tools. Saying so beats an empty line that reads as a broken surface.
        default: return 'thinking…';
    }
}

function describeEvidence(evidence: NonNullable<WorkItem['evidence']>): string {
    if (!evidence.testsRan) return evidence.outcome;
    const passed = evidence.passed ?? 0;
    const total = passed + (evidence.failed ?? 0);
    return `${passed}/${total} passing`;
}

function describeCounts(counts: { blocking: number; review: number; failed: number }): string {
    const parts: string[] = [];
    if (counts.blocking) parts.push(`${counts.blocking} waiting`);
    if (counts.review) parts.push(`${counts.review} ready`);
    if (counts.failed) parts.push(`${counts.failed} failed`);
    return parts.join(' · ') || 'all clear';
}

function formatCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

function formatElapsed(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
