import React, { Component, useEffect, useRef, useState, useCallback } from 'react';
import {
    AgentState, ActivityEntry, CheckpointView, ReviewFile,
} from './agent-store';

// === ERROR BOUNDARY ===
// Isolates activity panel crashes so they don't bring down the entire chat UI.
class ActivityErrorBoundary extends Component<
    { children: React.ReactNode },
    { hasError: boolean; error?: Error }
> {
    state = { hasError: false, error: undefined as Error | undefined };
    static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }

    render() {
        if (this.state.hasError) {
            return (
                <div className="p-2 mt-1.5 rounded border border-dangerRed/30 bg-dangerRed/5 text-[9px] text-red-400"
                     role="alert">
                    Activity panel error: {this.state.error?.message}
                </div>
            );
        }
        return this.props.children;
    }
}

export interface PanelProps {
    state: AgentState;
    post: (message: any) => void;
}

const SECTION = 'mb-2 rounded-md border border-border bg-panel/40 p-2';
const LABEL = 'text-[9px] uppercase tracking-wider text-muted/60 font-mono';
const BTN = 'text-[10px] px-2 py-0.5 rounded border border-border text-muted hover:text-foreground hover:bg-panel transition-colors cursor-pointer';
const BTN_DANGER = 'text-[10px] px-2 py-0.5 rounded border border-warningAmber/40 text-warningAmber hover:bg-warningAmber/20 transition-colors cursor-pointer';

/** Live agent status: phase, turn, elapsed time, and the tool timeline. */
// Stopwatch rendering minutes, seconds, and tenths of a second
function Stopwatch({ startedAt, endedAt, phase }: { startedAt: number | undefined; endedAt: number | undefined; phase: string }) {
    const getElapsed = () => {
        if (!startedAt) return 0;
        return (endedAt ?? Date.now()) - startedAt;
    };
    const [ms, setMs] = useState(getElapsed());

    useEffect(() => {
        if (!startedAt || phase === 'idle' || phase === 'completed' || phase === 'failed' || phase === 'cancelled') {
            setMs(getElapsed());
            return;
        }
        const interval = setInterval(() => {
            setMs(Date.now() - startedAt);
        }, 100);
        return () => clearInterval(interval);
    }, [startedAt, endedAt, phase]);

    const totalSecs = Math.floor(ms / 1000);
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    const tenths = Math.floor((ms % 1000) / 100);

    return (
        <span className="font-mono text-[9.5px] text-muted/60 tabular-nums"
              aria-label={`Elapsed time: ${m} minutes ${s} seconds`}
              aria-live="off">
            ⏱ {m.toString().padStart(2, '0')}:{s.toString().padStart(2, '0')}.{tenths}
        </span>
    );
}

// Collapsible tool card displaying arguments and truncated results snippet
function ToolActivityCard({ tool }: { tool: ActivityEntry }) {
    const [isExpanded, setIsExpanded] = useState(false);
    const isError = tool.status === 'error';
    const isActive = tool.status === 'running';

    return (
        <div className={`rounded border p-1.5 transition-all duration-150 ${
            isActive ? 'border-focusBorder bg-focusBorder/5 animate-pulse-subtle' :
            isError ? 'border-dangerRed/30 bg-dangerRed/5' :
            'border-border/30 bg-activity-card-bg hover:bg-white/5'
        }`}
             role="listitem"
             aria-label={`${tool.name}: ${tool.summary}, status: ${tool.status}`}>
            <div 
                onClick={() => !isActive && setIsExpanded(!isExpanded)}
                onKeyDown={(e) => { if (!isActive && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setIsExpanded(!isExpanded); } }}
                className="flex items-center justify-between cursor-pointer select-none"
                role={isActive ? undefined : 'button'}
                aria-expanded={isActive ? undefined : isExpanded}
                tabIndex={isActive ? undefined : 0}
            >
                <div className="flex items-center gap-1.5 min-w-0">
                    <span className={`text-[10px] ${isActive ? 'text-focusBorder animate-pulse' : isError ? 'text-red-400' : 'text-emerald-400'}`} aria-hidden="true">
                        {isActive ? '●' : isError ? '✗' : '✓'}
                    </span>
                    <span className="font-mono text-[10px] font-semibold text-foreground truncate max-w-[80px]">
                        {tool.name}
                    </span>
                    <span className="text-[9px] text-muted/60 truncate" title={tool.summary}>
                        {tool.summary}
                    </span>
                </div>
                <div className="flex items-center gap-1 font-mono text-[8px] text-muted/40">
                    {tool.durationMs !== undefined ? `${(tool.durationMs / 1000).toFixed(2)}s` : isActive ? 'running' : ''}
                    {!isActive && <span aria-hidden="true">{isExpanded ? '▼' : '▲'}</span>}
                </div>
            </div>

            {isExpanded && !isActive && (
                <div className="mt-1.5 pt-1.5 border-t border-border/10 font-mono text-[9px] flex flex-col gap-1.5 text-muted/70 overflow-x-hidden"
                     role="region" aria-label={`Details for ${tool.name}`}>
                    {tool.arguments && (
                        <div>
                            <span className="text-foreground/70 font-semibold">Arguments:</span>
                            <pre className="mt-0.5 p-1 rounded bg-black/20 overflow-x-auto text-[8.5px] max-w-full text-muted/80">
                                {typeof tool.arguments === 'string' ? tool.arguments : JSON.stringify(tool.arguments, null, 2)}
                            </pre>
                        </div>
                    )}
                    {tool.output && (
                        <div>
                            <span className="text-foreground/70 font-semibold">Result Snippet:</span>
                            <pre className="mt-0.5 p-1 rounded bg-black/20 overflow-x-auto text-[8.5px] max-w-full max-h-[80px] overflow-y-auto whitespace-pre-wrap text-muted/80">
                                {tool.output.slice(0, 300)}{tool.output.length > 300 ? '\n... (truncated)' : ''}
                            </pre>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/** Live agent status: phase, turn, elapsed time, and the tool timeline. */
export function ActivityPanel({ state }: PanelProps) {
    const listEndRef = useRef<HTMLDivElement>(null);
    const running = state.phase !== 'idle' && !state.endedAt;
    const activeCard = state.activity.find(a => a.status === 'running');
    const completedActivity = state.activity.filter(a => a.status !== 'running');

    useEffect(() => {
        if (running && listEndRef.current) {
            listEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [state.activity.length, running]);

    if (state.phase === 'idle' || (state.activity.length === 0 && !running)) return null;

    return (
        <ActivityErrorBoundary>
        <div className="mb-2 rounded-md glass-panel overflow-hidden shadow-lg animate-fade-in"
             role="region" aria-label="Tool execution timeline">
            {/* Header: Turn Counter & Stopwatch */}
            <div className="flex items-center justify-between px-2.5 py-1.5 bg-panel/60 border-b border-border/30">
                <div className="flex items-center gap-2">
                    <span className="text-[9px] font-bold tracking-wider uppercase text-focusBorder" aria-hidden="true">
                        ✦
                    </span>
                    <span className="text-[9px] font-bold tracking-wider uppercase text-focusBorder">
                        {running ? 'Live Activity' : 'Execution History'}
                    </span>
                    <span className="text-[8.5px] px-1.5 py-0.5 rounded bg-focusBorder/20 text-focusBorder font-semibold">
                        Turn {state.turn}
                    </span>
                </div>
                <Stopwatch startedAt={state.startedAt} endedAt={state.endedAt} phase={state.phase} />
            </div>

            {/* Current Action Hero Callout */}
            {running && activeCard && (
                <div className="px-2.5 py-1.5 bg-focusBorder/8 border-b border-focusBorder/20"
                     role="status" aria-live="polite" aria-label={`Currently executing: ${activeCard.name}`}>
                    <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full bg-focusBorder animate-ping" aria-hidden="true" />
                        <span className="font-mono text-[10px] font-semibold text-focusBorder">{activeCard.name}</span>
                        <span className="text-[9px] text-muted/60 truncate">{activeCard.summary}</span>
                    </div>
                </div>
            )}

            {/* Timeline Cards Container with rolling virtualization */}
            <div className="p-1.5 flex flex-col gap-1 max-h-[180px] overflow-y-auto min-h-[30px] relative scrollbar-thin"
                 role="list" aria-label="Tool list">
                {completedActivity.length === 0 && state.activity.length === 0 ? (
                    <div className="text-center py-2 text-[9px] italic text-muted/50">
                        Initializing agentic loop...
                    </div>
                ) : (
                    completedActivity.map((t, idx) => {
                        // Render only items within a rolling window of the active viewport:
                        // - Render the last 15 items to bound total DOM nodes inside sidebar scroll view
                        const total = completedActivity.length;
                        const isVisible = idx >= total - 15;
                        
                        if (!isVisible) return null;
                        return <ToolActivityCard key={t.id} tool={t} />;
                    })
                )}
                <div ref={listEndRef} />
            </div>

            {/* Token Dashboard & Cost Estimations */}
            {state.tokens && (
                <div className="px-2.5 py-1 bg-panel/30 border-t border-border/20 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[8px] font-medium text-muted/60 justify-between"
                     role="status" aria-label="Token usage summary">
                    <div className="flex gap-2">
                        <span>📥 In: {((state.tokens.inputTokens) / 1000).toFixed(1)}k</span>
                        {state.tokens.cachedInputTokens !== undefined && state.tokens.cachedInputTokens > 0 && (
                            <span className="text-emerald-400">⚡ Cached: {((state.tokens.cachedInputTokens) / 1000).toFixed(1)}k</span>
                        )}
                        <span>📤 Out: {((state.tokens.outputTokens) / 1000).toFixed(1)}k</span>
                    </div>
                    {state.tokens.cost > 0 && (
                        <span className="text-focusBorder font-semibold">
                            Est. Cost: ${state.tokens.cost.toFixed(4)}
                        </span>
                    )}
                </div>
            )}

            {state.error && <div className="p-1.5 text-[9px] text-red-400 border-t border-border/10 bg-red-400/5" role="alert">{state.error}</div>}
        </div>
        </ActivityErrorBoundary>
    );
}

/** Live stdout/stderr. Without this, a long build or test run is a silent wait. */
export function TerminalPanel({ state }: PanelProps) {
    const endRef = useRef<HTMLDivElement>(null);
    const [collapsed, setCollapsed] = useState(false);

    useEffect(() => {
        if (!collapsed) endRef.current?.scrollIntoView({ block: 'end' });
    }, [state.terminal.length, collapsed]);

    if (state.terminal.length === 0) return null;

    return (
        <div className={SECTION}>
            <button className={`${LABEL} mb-1 cursor-pointer hover:text-muted`} onClick={() => setCollapsed(c => !c)}>
                {collapsed ? '▸' : '▾'} Terminal output
            </button>
            {!collapsed && (
                <pre className="max-h-48 overflow-y-auto text-[10px] font-mono whitespace-pre-wrap break-all text-muted">
                    {state.terminal.map((chunk, i) => (
                        <span key={i} className={chunk.stream === 'stderr' ? 'text-red-400' : undefined}>
                            {chunk.text}
                        </span>
                    ))}
                    <div ref={endRef} />
                </pre>
            )}
        </div>
    );
}

const KIND_BADGE: Record<ReviewFile['kind'], { label: string; cls: string }> = {
    created: { label: 'A', cls: 'text-emerald-400' },
    modified: { label: 'M', cls: 'text-warningAmber' },
    deleted: { label: 'D', cls: 'text-red-400' },
};

/**
 * Modified-files review: per file, open the diff and either Keep or Restore it.
 * Restore applies the reverse patch, so an unrelated later edit to the same file
 * survives — which a whole-file snapshot restore would have destroyed.
 */
export function ReviewPanel({ state, post }: PanelProps) {
    const active = state.checkpoints.filter(cp => cp.files.some(f => f.reviewState === 'pending'));
    if (active.length === 0) return null;

    return (
        <>
            {active.map(cp => <CheckpointCard key={cp.id} checkpoint={cp} post={post} />)}
        </>
    );
}

function CheckpointCard({ checkpoint, post }: { checkpoint: CheckpointView; post: (m: any) => void }) {
    const pending = checkpoint.files.filter(f => f.reviewState === 'pending');

    return (
        <div className="mb-2 rounded-md border border-warningAmber/30 bg-warningAmber/5 p-2">
            <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] text-warningAmber">
                    Agent modified {pending.length} file{pending.length === 1 ? '' : 's'}
                </span>
                <div className="flex gap-1">
                    <button
                        className={BTN}
                        onClick={() => pending.forEach(f =>
                            post({ type: 'keepFile', value: { checkpointId: checkpoint.id, path: f.path } }))}
                    >
                        Keep all
                    </button>
                    <button
                        className={BTN_DANGER}
                        onClick={() => post({ type: 'restoreCheckpoint', value: { checkpointId: checkpoint.id } })}
                    >
                        Restore all
                    </button>
                </div>
            </div>

            <ul className="flex flex-col gap-1">
                {pending.map(file => {
                    const badge = KIND_BADGE[file.kind];
                    return (
                        <li key={file.path} className="flex items-center gap-1.5 text-[11px]">
                            <span className={`font-mono font-bold ${badge.cls}`}>{badge.label}</span>
                            <span className="text-foreground truncate flex-1" title={file.relPath}>{file.relPath}</span>
                            <span className="text-muted/50 font-mono text-[10px] tabular-nums">{file.stat}</span>
                            <button className={BTN} onClick={() => post({ type: 'openArtifact', value: file.path })}>Diff</button>
                            <button className={BTN} onClick={() => post({ type: 'keepFile', value: { checkpointId: checkpoint.id, path: file.path } })}>Keep</button>
                            <button
                                className={BTN_DANGER}
                                onClick={() => post({ type: 'restoreFile', value: { checkpointId: checkpoint.id, path: file.path } })}
                            >
                                Restore
                            </button>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

/** Undo every file change made by one agent response. */
export function UndoMessageButton({ messageId, state, post }: { messageId: string } & PanelProps) {
    const cp = state.checkpoints.find(c => c.messageId === messageId);
    const revertible = cp?.files.filter(f => f.reviewState !== 'restored') ?? [];
    if (revertible.length === 0) return null;

    return (
        <button
            className={`${BTN} mt-1`}
            title={revertible.map(f => f.relPath).join('\n')}
            onClick={() => post({ type: 'undoMessage', value: messageId })}
        >
            ↩ Undo {revertible.length} file change{revertible.length === 1 ? '' : 's'}
        </button>
    );}

// === CHECKPOINT TIMELINE ===

class CheckpointErrorBoundary extends Component<
    { children: React.ReactNode },
    { hasError: boolean; error?: Error }
> {
    state = { hasError: false, error: undefined as Error | undefined };

    static getDerivedStateFromError(error: Error) {
        return { hasError: true, error };
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="p-2 rounded border border-dangerRed/30 bg-dangerRed/5 text-[9px] text-red-400"
                     role="alert">
                    Checkpoint timeline error: {this.state.error?.message}
                </div>
            );
        }
        return this.props.children;
    }
}

// ⏱ Relative time calculation utility
function formatRelativeTime(timestamp: number): string {
    const elapsed = Date.now() - timestamp;
    const secs = Math.floor(elapsed / 1000);
    const mins = Math.floor(secs / 60);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);

    if (secs < 60) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return 'Yesterday';
    return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Inline diff preview component
function InlineDiffPreview({ lines }: { lines: string[] }) {
    if (!lines || lines.length === 0) return null;

    return (
        <pre className="mt-1.5 p-1.5 rounded bg-black/30 text-[8px] font-mono overflow-x-auto max-h-[120px] overflow-y-auto"
             aria-label="Diff preview">
            {lines.map((line, i) => (
                <div key={i} className={
                    line.startsWith('+') ? 'text-emerald-400' :
                    line.startsWith('-') ? 'text-rose-400' :
                    'text-muted-foreground'
                }>
                    {line}
                </div>
            ))}
        </pre>
    );
}

export function CheckpointTimelinePanel({ state, post }: PanelProps) {
    const checkpoints = state.checkpoints;
    const isGenerating = state.phase !== 'idle';
    
    const [isExpanded, setIsExpanded] = useState(false);
    const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);
    const [expandedFileDiffs, setExpandedFileDiffs] = useState<Set<string>>(new Set());
    const [, forceUpdate] = useState(0);

    // Refresh times ticker every minute
    useEffect(() => {
        const interval = setInterval(() => forceUpdate(n => n + 1), 60000);
        return () => clearInterval(interval);
    }, []);

    const toggleFileDiff = useCallback((cp: CheckpointView, fileKey: string) => {
        setExpandedFileDiffs(prev => {
            const next = new Set(prev);
            if (next.has(fileKey)) {
                next.delete(fileKey);
            } else {
                next.add(fileKey);
                // Trigger lazy-load if diff is missing
                const f = cp.files.find(f => fileKey.endsWith(f.path));
                if (f && !f.diffPreview) {
                    post({ type: 'getCheckpointDiff', value: { checkpointId: cp.id, path: f.path } });
                }
            }
            return next;
        });
    }, [post]);

    if (!checkpoints || checkpoints.length === 0) return null;

    return (
        <CheckpointErrorBoundary>
            <div className="mb-2 rounded-md border border-border bg-panel/30 overflow-hidden glass-panel"
                 role="region" aria-label="Checkpoint timeline history">
                <div
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="flex items-center justify-between px-2.5 py-1.5 bg-panel/60 border-b border-border/40 cursor-pointer select-none hover:bg-opacity-80 transition-colors"
                    role="button"
                    aria-expanded={isExpanded}
                    aria-controls="checkpoint-list"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setIsExpanded(!isExpanded); }}
                >
                    <div className="flex items-center gap-1.5 text-focusBorder font-semibold text-[10.5px]">
                        <span>⏱ Checkpoints ({checkpoints.length})</span>
                    </div>
                    <span className="text-[9px] text-muted/60 uppercase font-mono">
                        {isExpanded ? 'Hide' : 'Show'}
                    </span>
                </div>

                {isExpanded && (
                    <div id="checkpoint-list"
                         className="p-2 flex flex-col gap-2 max-h-[300px] overflow-y-auto scrollbar-thin"
                         role="list">
                        
                        {checkpoints.map((cp) => {
                            const relativeTime = formatRelativeTime(cp.createdAt);
                            const isSelected = selectedCheckpointId === cp.id;

                            return (
                                <div key={cp.id}
                                     className="border border-border/30 rounded bg-background p-2 text-[10.5px] transition-all"
                                     role="listitem"
                                     aria-label={`Checkpoint: ${cp.label}, ${relativeTime}`}>
                                    <div className="flex justify-between items-center mb-1">
                                        <span className="font-semibold truncate max-w-[70%] text-foreground" title={cp.label}>
                                            {cp.label}
                                        </span>
                                        <span className="text-[8.5px] text-muted/60 font-mono">{relativeTime}</span>
                                    </div>
                                    <div className="text-[9px] text-muted/60 mb-1.5 flex flex-wrap gap-1">
                                        <span>📂 {cp.files.length} file(s) changed</span>
                                    </div>

                                    <div className="flex gap-1.5 mt-1 border-t border-border/10 pt-1.5 justify-end">
                                        <button
                                            onClick={() => post({ type: 'restoreCheckpoint', value: { checkpointId: cp.id } })}
                                            disabled={isGenerating}
                                            className={`text-[9px] font-semibold px-2 py-0.5 rounded border border-warningAmber/40 text-warningAmber hover:bg-warningAmber/10 cursor-pointer transition-colors ${
                                                isGenerating ? 'opacity-50 cursor-default' : ''
                                            }`}
                                            title={isGenerating ? 'Cannot restore while agent is working' : 'Revert entire workspace back to this checkpoint'}
                                            aria-label={`Restore all files to checkpoint: ${cp.label}`}
                                            tabIndex={0}
                                        >
                                            Restore All
                                        </button>
                                        <button
                                            onClick={() => setSelectedCheckpointId(isSelected ? null : cp.id)}
                                            className={BTN}
                                            aria-expanded={isSelected}
                                            tabIndex={0}
                                        >
                                            {isSelected ? 'Hide Details' : 'Details'}
                                        </button>
                                    </div>

                                    {/* Expanded file list with inline diff previews */}
                                    {isSelected && (
                                        <div className="mt-2 pl-2 border-l-2 border-focusBorder/30 flex flex-col gap-1">
                                            {cp.files.map((file) => {
                                                const fileKey = `${cp.id}:${file.path}`;
                                                const isDiffExpanded = expandedFileDiffs.has(fileKey);

                                                return (
                                                    <div key={file.path} className="bg-panel/30 p-1.5 rounded">
                                                        <div className="flex justify-between items-center text-[9px]">
                                                            <span className="truncate max-w-[55%] text-foreground" title={file.path}>
                                                                {file.relPath}
                                                            </span>
                                                            <div className="flex gap-1.5 items-center">
                                                                <span className="font-mono text-muted/60 text-[8px]">{file.stat}</span>
                                                                <button
                                                                    onClick={() => toggleFileDiff(cp, fileKey)}
                                                                    className={BTN}
                                                                    aria-expanded={isDiffExpanded}
                                                                    tabIndex={0}
                                                                >
                                                                    {isDiffExpanded ? 'Hide' : 'Preview'}
                                                                </button>
                                                                <button
                                                                    onClick={() => post({
                                                                        type: 'openArtifact',
                                                                        value: file.path
                                                                    })}
                                                                    className={BTN}
                                                                    aria-label={`Open split diff for ${file.relPath}`}
                                                                    tabIndex={0}
                                                                >
                                                                    Full Diff
                                                                </button>
                                                                <span className={`text-[8px] capitalize px-1 rounded-sm ${
                                                                    file.reviewState === 'pending' ? 'text-warningAmber bg-warningAmber/10' :
                                                                    file.reviewState === 'kept' ? 'text-emerald-400 bg-emerald-400/10' :
                                                                    'text-muted-foreground bg-muted/15'
                                                                }`}>
                                                                    {file.reviewState}
                                                                </span>
                                                            </div>
                                                        </div>

                                                        {/* Inline diff preview */}
                                                        {isDiffExpanded && (
                                                            file.diffPreview ? (
                                                                <InlineDiffPreview lines={file.diffPreview} />
                                                            ) : (
                                                                <div className="mt-1.5 text-[8px] text-muted/60 italic px-1">Loading preview...</div>
                                                            )
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </CheckpointErrorBoundary>
    );
}

export function PipelineLogPanel({ state, post }: PanelProps) {
    if (!state.pipelineLog || state.pipelineLog.length === 0) return null;

    return (
        <div className="mb-2 mt-2 w-full max-w-full" aria-label="Pipeline Log Panel">
            <div className="flex items-center gap-1.5 mb-1.5 px-1">
                <span className="text-[9px] uppercase tracking-wider text-neonPurple font-bold">
                    Multi-Agent Pipeline
                </span>
            </div>
            <div className="flex flex-col gap-1 w-full relative before:absolute before:inset-y-2 before:left-[11px] before:w-[2px] before:bg-border/30 pl-[3px]">
                {state.pipelineLog.map((log, i) => {
                    const isError = log.type === 'error';
                    const isStart = log.type === 'phase_start';
                    const isFile = log.type === 'file_modified' || log.type === 'file_created';
                    
                    return (
                        <div key={log.id || i} className="flex items-start gap-2 text-[10.5px] w-full relative z-10 py-0.5">
                            <div className={`mt-0.5 w-[18px] h-[18px] rounded-full flex items-center justify-center shrink-0 border border-background shadow-sm ${
                                isError ? 'bg-dangerRed/20 text-dangerRed' :
                                isStart ? 'bg-neonPurple/20 text-neonPurple' :
                                'bg-panel text-muted'
                            }`}>
                                {isError ? '✗' : isStart ? '▶' : isFile ? '📝' : '✓'}
                            </div>
                            <div className={`flex flex-col pt-0.5 w-full min-w-0 pr-1 ${
                                isError ? 'text-red-400 font-medium' :
                                isStart ? 'text-foreground font-medium' :
                                'text-muted/80'
                            }`}>
                                <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5">
                                    <span className="break-words whitespace-normal">{log.message}</span>
                                    {isFile && log.filePath && (
                                        <button 
                                            className="px-1.5 py-0.5 text-[9px] font-mono bg-panel/80 hover:bg-panel border border-border/50 rounded flex items-center gap-1 text-muted hover:text-foreground transition-colors max-w-full overflow-hidden"
                                            onClick={() => post({ type: 'openArtifact', value: log.filePath })}
                                            title={log.filePath}
                                        >
                                            <span className="truncate">{log.filePath.split(/[/\\]/).pop()}</span>
                                            <span>→</span>
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
