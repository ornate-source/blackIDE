import { useEffect, useMemo, useRef, useState } from 'react';
import type { JournalDepth, JournalLine } from '@blackide/agent-core/core/run-journal';

// ─── The Logs tab: what happened, and what happened an hour ago ─────────────
//
// The Office tab renders a projection of *now* and forgets everything else. This renders a
// file. That distinction is the reason the two are separate surfaces rather than two
// densities of one: a roster holds the last value of each field, a log holds every value,
// and the moment you need the second is an hour after the first has moved on.
//
// ── What this component is not allowed to do ─────────────────────────────────
// It never holds the whole file. A verbose run is hundreds of kilobytes and an unlucky one
// is megabytes; the tab asks the extension host for a page, renders it, and asks for the
// next. The host does the filtering, because it has the file and the webview has a
// structured-clone budget.

export interface LogRun {
    id: string;
    bytes: number;
    modifiedAt: number;
}

export interface LogPage {
    lines: JournalLine[];
    nextCursor?: number;
    matched: number;
    total: number;
    summary?: {
        total: number;
        errors: number;
        warnings: number;
        tools: number;
        turns: number;
        startedAt?: number;
        endedAt?: number;
    };
}

interface LogsTabProps {
    runs: LogRun[];
    page?: LogPage;
    /** Lines the live tail pushed since the last page load. */
    tail: JournalLine[];
    /**
     * Spilled bodies, keyed by sequence number.
     *
     * Held by the panel rather than here because the reply arrives on the panel's single
     * message listener — a second listener in this component would miss every payload
     * requested while the tab was hidden, and the row would sit on `…` forever.
     */
    payloads: Record<number, string>;
    selectedRun?: string;
    post: (message: any) => void;
    onSelectRun: (id: string) => void;
}

const DEPTHS: JournalDepth[] = ['summary', 'normal', 'verbose'];

const DEPTH_HELP: Record<JournalDepth, string> = {
    summary: 'run boundaries, turns, errors, steering, verification',
    normal: '+ every tool call with its target, duration and result',
    verbose: '+ arguments, output, terminal, and the pre-flight',
};

const LEVEL_TONE: Record<string, string> = {
    info: 'text-foreground/85',
    warn: 'text-warningAmber',
    error: 'text-dangerRed',
};

const KIND_GLYPH: Record<string, string> = {
    run: '▸', turn: '▸', tool: '·', file: '±', phase: '▸', steer: '↯',
    model: '⇄', context: '◫', verify: '✔', approval: '⏸', artifact: '⧉',
    usage: '∑', terminal: '❯', log: ' ', end: '■',
};

export function LogsTab({ runs, page, tail, payloads, selectedRun, post, onSelectRun }: LogsTabProps) {
    const [depth, setDepth] = useState<JournalDepth>('normal');
    const [filter, setFilter] = useState('');
    const [problemsOnly, setProblemsOnly] = useState(false);
    const [expanded, setExpanded] = useState<Record<number, true>>({});
    /*
     * Following is opt-out, and pausing does not stop the writes.
     *
     * Scrolling up in a log that keeps yanking itself to the bottom is the single most
     * common complaint about log viewers, and it is a two-line fix if you build it in
     * rather than bolt it on. Paused only detaches the scroll; the tail keeps arriving so
     * releasing it catches up rather than showing a gap.
     */
    const [following, setFollowing] = useState(true);
    const bottom = useRef<HTMLDivElement>(null);

    const query = useMemo(
        () => ({ depth, filter: filter.trim() || undefined, problemsOnly: problemsOnly || undefined, limit: 300 }),
        [depth, filter, problemsOnly]);

    // Re-query whenever the question changes. The host filters; sending the whole file
    // here and filtering in React would defeat the point of paging it.
    useEffect(() => {
        if (selectedRun) post({ type: 'readRunLog', value: { runId: selectedRun, ...query } });
    }, [selectedRun, query]);

    const lines = useMemo(() => {
        if (!page) return [];
        // The tail is merged rather than appended blindly: a page load that lands after a
        // few tail lines have arrived would otherwise show them twice.
        const seen = new Set(page.lines.map(l => l.seq));
        return [...page.lines, ...tail.filter(l => !seen.has(l.seq))];
    }, [page, tail]);

    useEffect(() => {
        if (following) bottom.current?.scrollIntoView({ block: 'end' });
    }, [lines.length, following]);

    return (
        <div className="flex flex-col h-full gap-2">
            <div className="flex items-center gap-2 flex-wrap shrink-0">
                <select
                    value={selectedRun || ''}
                    onChange={(e) => onSelectRun(e.target.value)}
                    className="bg-inputBg text-foreground border border-border/40 rounded px-2 py-1 text-[10.5px] cursor-pointer max-w-[220px]"
                >
                    <option value="" className="bg-background">select a run…</option>
                    {runs.map(run => (
                        <option key={run.id} value={run.id} className="bg-background text-foreground">
                            {run.id} · {formatBytes(run.bytes)}
                        </option>
                    ))}
                </select>

                <div className="flex items-center gap-0.5" title={DEPTH_HELP[depth]}>
                    {DEPTHS.map(d => (
                        <button
                            key={d}
                            onClick={() => setDepth(d)}
                            title={DEPTH_HELP[d]}
                            className={`text-[9.5px] px-2 py-1 rounded border cursor-pointer transition-colors ${
                                depth === d ? 'bg-focusBorder/20 text-foreground border-focusBorder/40'
                                            : 'bg-panel/60 text-muted border-border/40 hover:text-foreground'}`}
                        >
                            {d}
                        </button>
                    ))}
                </div>

                <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="filter…"
                    className="bg-inputBg text-foreground border border-border/40 rounded px-2 py-1 text-[10.5px] w-[150px] focus:outline-none focus:border-focusBorder"
                />

                <button
                    onClick={() => setProblemsOnly(v => !v)}
                    className={`text-[9.5px] px-2 py-1 rounded border cursor-pointer ${
                        problemsOnly ? 'bg-dangerRed/15 text-dangerRed border-dangerRed/30'
                                     : 'bg-panel/60 text-muted border-border/40 hover:text-foreground'}`}
                >
                    problems only
                </button>

                <button
                    onClick={() => setFollowing(v => !v)}
                    className={`text-[9.5px] px-2 py-1 rounded border cursor-pointer ml-auto ${
                        following ? 'bg-focusBorder/15 text-focusBorder border-focusBorder/30'
                                  : 'bg-panel/60 text-muted border-border/40 hover:text-foreground'}`}
                >
                    {following ? 'following' : 'paused'}
                </button>

                {selectedRun && (
                    <button
                        onClick={() => post({ type: 'openRunLog', value: { runId: selectedRun } })}
                        className="text-[9.5px] px-2 py-1 rounded border bg-panel/60 text-muted border-border/40 hover:text-foreground cursor-pointer"
                    >
                        Open as file
                    </button>
                )}
            </div>

            {!selectedRun && <NoRunSelected hasRuns={runs.length > 0} />}

            {selectedRun && (
                <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border/40 bg-panel/20 font-mono">
                    {lines.length === 0 && (
                        <div className="text-[10.5px] text-muted/50 text-center py-8">
                            Nothing at this depth{filter ? ' matches that filter' : ''}.
                            {depth !== 'verbose' && ' Try a deeper level.'}
                        </div>
                    )}
                    {lines.map(line => (
                        <LogRow
                            key={line.seq}
                            line={line}
                            open={!!expanded[line.seq]}
                            body={payloads[line.seq]}
                            onExpand={() => {
                                if (expanded[line.seq]) {
                                    setExpanded(prev => { const next = { ...prev }; delete next[line.seq]; return next; });
                                } else if (line.payloadRef) {
                                    // Fetched on demand: a spilled body is up to 64 KB and
                                    // most are never opened, so shipping them with the page
                                    // would multiply its size for content nobody reads.
                                    post({ type: 'readRunLogPayload', value: { runId: selectedRun, seq: line.seq, ref: line.payloadRef } });
                                    setExpanded(prev => ({ ...prev, [line.seq]: true }));
                                }
                            }}
                        />
                    ))}
                    <div ref={bottom} />
                </div>
            )}

            {page && selectedRun && <Footer page={page} depth={depth} />}
        </div>
    );
}

function LogRow({ line, open, body, onExpand }: { line: JournalLine; open: boolean; body?: string; onExpand: () => void }) {
    const inlineBody = (line.detail as any)?.body as string | undefined;
    const expandable = !!line.payloadRef;
    const detail = detailText(line);
    const shown = open ? (body ?? '…') : undefined;

    return (
        <div className="px-2 py-[1px] hover:bg-focusBorder/5 border-l-2 border-transparent">
            <div className="flex items-baseline gap-2 text-[10px] leading-[1.45]">
                <span className="text-muted/40 shrink-0 tabular-nums">{formatTime(line.ts)}</span>
                <span className="text-muted/40 shrink-0 w-2">{KIND_GLYPH[line.kind] ?? '·'}</span>
                <span className={`${LEVEL_TONE[line.level] ?? LEVEL_TONE.info} break-all`}>{line.verb}</span>
                {line.target && <span className="text-neonPurple/80 break-all">{line.target}</span>}
                {detail && <span className="text-muted/50 break-all">{detail}</span>}
                {line.durationMs !== undefined && (
                    <span className="text-muted/40 ml-auto shrink-0 tabular-nums">{(line.durationMs / 1000).toFixed(1)}s</span>
                )}
                {expandable && (
                    <button onClick={onExpand} className="text-muted/40 hover:text-foreground shrink-0 cursor-pointer">
                        {open ? '⌃' : '⌄'}
                    </button>
                )}
            </div>
            {(shown || inlineBody) && (
                <pre className="text-[9.5px] text-muted/70 whitespace-pre-wrap break-all pl-[4.5rem] py-1 max-h-[240px] overflow-y-auto">
                    {shown ?? inlineBody}
                </pre>
            )}
        </div>
    );
}

function Footer({ page, depth }: { page: LogPage; depth: JournalDepth }) {
    const s = page.summary;
    return (
        <div className="shrink-0 flex items-center gap-3 text-[9.5px] text-muted/60 px-1">
            <span>showing {page.lines.length} of {page.matched} at <b>{depth}</b> · {page.total} total</span>
            {s && s.turns > 0 && <span>{s.turns} turns · {s.tools} tool calls</span>}
            {s && s.errors > 0 && <span className="text-dangerRed">{s.errors} errors</span>}
            {s && s.warnings > 0 && <span className="text-warningAmber">{s.warnings} warnings</span>}
            {s?.startedAt && s?.endedAt && <span>{formatDuration(s.endedAt - s.startedAt)}</span>}
        </div>
    );
}

/**
 * The empty state distinguishes "no run picked" from "nothing has ever run".
 *
 * They lead to different next actions and one of them is not the user's fault, so a single
 * "no logs" message would be wrong half the time.
 */
function NoRunSelected({ hasRuns }: { hasRuns: boolean }) {
    return (
        <div className="text-center py-10 px-6">
            <div className="text-[12px] text-foreground/80 mb-1">
                {hasRuns ? 'Pick a run.' : 'No runs have been logged yet.'}
            </div>
            <div className="text-[10.5px] text-muted/60 max-w-[400px] mx-auto leading-relaxed">
                {hasRuns
                    ? 'Every run writes its log as it happens, so closing this panel — or the window — does not lose it.'
                    : 'Logs are written to disk as a run happens and kept for two weeks. They never leave this machine.'}
            </div>
        </div>
    );
}

function detailText(line: JournalLine): string {
    const detail = line.detail as Record<string, unknown> | undefined;
    if (!detail) return '';
    const parts: string[] = [];
    for (const [key, value] of Object.entries(detail)) {
        // `body` is rendered as a block below, and the tool name is already the verb.
        if (key === 'body' || key === 'tool' || key === 'toolCallId') continue;
        if (value === undefined || value === null || value === '') continue;
        parts.push(`${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
    }
    return parts.join(' ').slice(0, 300);
}

function formatTime(ts: number): string {
    return new Date(ts).toTimeString().slice(0, 8) + '.' + String(ts % 1000).padStart(3, '0');
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
