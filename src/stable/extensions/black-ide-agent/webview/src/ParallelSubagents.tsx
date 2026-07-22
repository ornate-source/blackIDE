import React, { Component } from 'react';
import { PanelProps } from './AgentPanels';

// Parallel Subagents List UI component - Feature 22 / MF-22
// Displays and manages background subagent tasks running in isolated worktrees.

export interface SubagentInfo {
    id: string;
    name: string;
    task: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    progress?: string;
}

// Error Boundary specifically to isolate Parallel Subagent card crashes
class SubagentsErrorBoundary extends Component<
    { children: React.ReactNode },
    { hasError: boolean; error?: Error }
> {
    state = { hasError: false, error: undefined as Error | undefined };
    static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }

    render() {
        if (this.state.hasError) {
            return (
                <div className="p-2 border border-dangerRed/30 bg-dangerRed/5 text-[9px] text-red-400 rounded" role="alert">
                    Subagents panel error: {this.state.error?.message}
                </div>
            );
        }
        return this.props.children;
    }
}

export function ParallelSubagentsPanel({ state, post }: PanelProps) {
    // Read subagents from state (custom property we will hook in)
    const subagentsList = (state as any).subagents || [];
    
    if (subagentsList.length === 0) return null;

    const BTN_DANGER = "text-[9.5px] px-2 py-0.5 rounded border border-warningAmber/40 text-warningAmber hover:bg-warningAmber/20 transition-colors cursor-pointer";

    return (
        <SubagentsErrorBoundary>
            <div className="mb-2 rounded-md border border-border bg-panel/30 overflow-hidden glass-panel"
                 role="region" aria-label="Parallel agent executions">
                <div className="px-2.5 py-1.5 bg-panel/60 border-b border-border/40 flex justify-between items-center">
                    <span className="text-focusBorder font-semibold text-[10.5px] flex items-center gap-1.5">
                        <span>🧬 Parallel Subagents ({subagentsList.length})</span>
                    </span>
                    <span className="text-[8px] text-muted/50 font-mono">ISOLATED GIT WORKTREES</span>
                </div>
                
                <div className="p-2 flex flex-col gap-2 max-h-[250px] overflow-y-auto scrollbar-thin"
                     role="list" aria-live="polite">
                    {subagentsList.map((sa: SubagentInfo) => {
                        const isRunning = sa.status === 'running';
                        const isError = sa.status === 'failed';
                        const isCancelled = sa.status === 'cancelled';

                        return (
                            <div key={sa.id} 
                                 className={`border border-border/30 rounded bg-background p-2 flex flex-col gap-1.5 transition-all ${
                                     isRunning ? 'border-focusBorder/50 bg-focusBorder/5 animate-pulse-subtle' :
                                     isError ? 'border-dangerRed/30 bg-dangerRed/5' :
                                     'bg-panel/20'
                                 }`}
                                 role="listitem"
                                 aria-label={`Subagent ${sa.name}, status ${sa.status}`}>
                                <div className="flex justify-between items-center gap-1">
                                    <div className="flex items-center gap-1.5 min-w-0">
                                        <span className={`text-[10px] ${
                                            isRunning ? 'text-focusBorder animate-pulse' : 
                                            isError ? 'text-red-400' : 
                                            isCancelled ? 'text-muted/60' : 'text-emerald-400'
                                        }`}>
                                            {isRunning ? '●' : isError ? '✗' : isCancelled ? '⊘' : '✓'}
                                        </span>
                                        <span className="font-mono text-[10px] font-bold text-foreground truncate max-w-[80px]">
                                            {sa.name}
                                        </span>
                                        <span className="text-[9px] text-muted/60 truncate" title={sa.task}>
                                            {sa.task}
                                        </span>
                                    </div>
                                    
                                    {isRunning && (
                                        <button 
                                            className={BTN_DANGER} 
                                            onClick={() => post({ type: 'cancelSubagent', value: sa.id })}
                                            aria-label={`Cancel subagent ${sa.name}`}
                                        >
                                            Cancel
                                        </button>
                                    )}
                                </div>

                                {sa.progress && (
                                    <div className="font-mono text-[9px] text-muted/70 bg-black/10 px-1.5 py-0.5 rounded truncate">
                                        {sa.progress}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </SubagentsErrorBoundary>
    );
}
