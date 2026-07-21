import { useEffect, useReducer, useState } from 'react';
import { agentReducer, initialAgentState, AgentState } from './agent-store';
import { PipelineLogPanel } from './AgentPanels';
import { rawVscode } from './webview-bridge';

const vscode = rawVscode || {
  postMessage: (msg: any) => console.log('VSCode PostMessage (mock):', msg),
  getState: () => undefined,
  setState: () => {},
};

interface LLMConfigEntry {
  id: string;
  name: string;
  type: string;
  model?: string;
}

type RunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

interface RunSummary {
  id: string;
  prompt: string;
  modelId: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  currentPhase?: string;
  error?: string;
}

const MAX_CONCURRENT_RUNS = 4; // mirrors BlackIdeChatProvider.MAX_CONCURRENT_PIPELINE_RUNS

const STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  awaiting_approval: 'Awaiting Approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_CLASS: Record<RunStatus, string> = {
  running: 'text-accentBlue bg-accentBlue/10 border-accentBlue/30',
  awaiting_approval: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/30',
  completed: 'text-green-400 bg-green-400/10 border-green-400/30',
  failed: 'text-red-400 bg-red-400/10 border-red-400/30',
  cancelled: 'text-muted bg-muted/10 border-muted/30',
};

function formatElapsed(run: RunSummary): string {
  const end = run.endedAt ?? Date.now();
  const totalSeconds = Math.max(0, Math.floor((end - run.startedAt) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${totalSeconds % 60}s`;
}

export default function ManagerPanel() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runStates, setRunStates] = useState<Record<string, AgentState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [prompt, setPrompt] = useState('');
  const [modelId, setModelId] = useState('');
  const [models, setModels] = useState<LLMConfigEntry[]>([]);
  const [startError, setStartError] = useState('');
  const [, forceTick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    vscode.postMessage({ type: 'listPipelineRuns' });
    vscode.postMessage({ type: 'loadLlmConfig' });

    // Keeps elapsed-time labels on running rows live without a per-event trigger.
    const interval = setInterval(forceTick, 1000);

    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      switch (message.type) {
        case 'pipelineRunListSync':
          setRuns(message.value || []);
          break;
        case 'pipelineRunStartFailed':
          setStartError(message.value || 'Failed to start pipeline run.');
          break;
        case 'pipelineRunEvent': {
          const { runId, value } = message;
          setRunStates(prev => ({ ...prev, [runId]: agentReducer(prev[runId] || initialAgentState, value) }));
          // The extension host's PipelineRunRecord is the source of truth for
          // status/currentPhase/error — re-sync the summary list on anything that
          // could have changed it, rather than trying to derive it client-side too.
          const resyncOn = ['PipelinePhaseStarted', 'PipelinePhaseCompleted', 'PipelinePhaseError',
            'TaskCompleted', 'TaskFailed', 'TaskCancelled', 'PlanApprovalRequested'];
          if (resyncOn.includes(value.type)) {
            vscode.postMessage({ type: 'listPipelineRuns' });
          }
          break;
        }
        case 'setLlmConfig':
          try {
            const parsed: LLMConfigEntry[] = JSON.parse(message.value || '[]');
            setModels(parsed);
            setModelId(prev => prev || parsed[0]?.id || '');
          } catch {}
          break;
      }
    };
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      clearInterval(interval);
    };
  }, []);

  const activeCount = runs.filter(r => r.status === 'running' || r.status === 'awaiting_approval').length;

  const startRun = () => {
    if (!prompt.trim() || !modelId) return;
    setStartError('');
    vscode.postMessage({ type: 'startPipelineRun', value: { prompt: prompt.trim(), modelId } });
    setPrompt('');
  };

  const toggleExpanded = (runId: string) => setExpanded(prev => ({ ...prev, [runId]: !prev[runId] }));

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground overflow-hidden">
      <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold">✦ Pipeline Manager</span>
          <span className="text-[10px] text-muted/60 font-mono">{activeCount}/{MAX_CONCURRENT_RUNS} running</span>
        </div>
      </div>

      <div className="p-3 border-b border-border/40 shrink-0">
        <div className="flex gap-2">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startRun(); } }}
            placeholder="Describe what to build — this runs as its own isolated pipeline, in parallel with any others…"
            className="flex-1 bg-[rgba(255,255,255,0.04)] text-foreground border border-border/40 rounded px-3 py-2 text-[12px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)]"
          />
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className="bg-[rgba(255,255,255,0.04)] text-foreground border border-border/40 rounded px-2 py-2 text-[11px] cursor-pointer max-w-[180px]"
          >
            {models.map(m => <option key={m.id} value={m.id} className="bg-background text-foreground">{m.name}</option>)}
          </select>
          <button
            onClick={startRun}
            disabled={!prompt.trim() || !modelId || activeCount >= MAX_CONCURRENT_RUNS}
            className="px-4 py-2 rounded text-[12px] font-semibold bg-accentBlue/80 hover:bg-accentBlue text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            + New Run
          </button>
        </div>
        {startError && <div className="mt-2 text-[10.5px] text-red-400">{startError}</div>}
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
        {runs.length === 0 && (
          <div className="text-[11px] text-muted/50 text-center py-8">
            No pipeline runs yet. Describe a build above to start one.
          </div>
        )}
        {runs.slice().reverse().map(run => {
          const state = runStates[run.id];
          const isExpanded = !!expanded[run.id];
          const model = models.find(m => m.id === run.modelId);
          return (
            <div key={run.id} className="rounded-lg border border-border/40 bg-panel/30 overflow-hidden">
              <div className="p-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${STATUS_CLASS[run.status]}`}>
                      {STATUS_LABEL[run.status]}
                    </span>
                    {run.currentPhase && run.status === 'running' && (
                      <span className="text-[10px] text-muted/70 font-mono">{run.currentPhase}</span>
                    )}
                    <span className="text-[9px] text-muted/50 font-mono ml-auto">{formatElapsed(run)}</span>
                  </div>
                  <div className="text-[12px] text-foreground mt-1 truncate" title={run.prompt}>{run.prompt}</div>
                  <div className="text-[9.5px] text-muted/50 font-mono mt-0.5">{model?.name || run.modelId}</div>
                  {run.error && <div className="text-[10.5px] text-red-400 mt-1">{run.error}</div>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {(run.status === 'running' || run.status === 'awaiting_approval') && (
                    <button
                      onClick={() => vscode.postMessage({ type: 'cancelPipelineRun', value: { runId: run.id } })}
                      className="text-[10px] px-2 py-1 rounded border border-red-600/30 text-red-400 hover:bg-red-600/10 cursor-pointer"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    onClick={() => toggleExpanded(run.id)}
                    className="text-[10px] px-2 py-1 rounded border border-border/40 text-muted hover:text-foreground hover:bg-panel cursor-pointer"
                  >
                    {isExpanded ? 'Hide log' : 'View log'}
                  </button>
                </div>
              </div>

              {run.status === 'awaiting_approval' && state?.pendingPlan && (
                <div className="mx-3 mb-3 rounded-md border border-yellow-400/30 bg-yellow-400/5 p-2.5">
                  <details>
                    <summary className="text-[10.5px] text-foreground cursor-pointer font-medium">
                      Plan ready for review — {run.prompt.slice(0, 60)}
                    </summary>
                    <pre className="mt-1.5 text-[9.5px] text-muted/80 bg-background/50 rounded p-2 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono border border-border/30">
                      {state.pendingPlan.planContent}
                    </pre>
                  </details>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => vscode.postMessage({ type: 'approvePipelineRun', value: { runId: run.id } })}
                      className="flex-1 text-[10.5px] font-semibold py-1 px-2 rounded bg-green-600/80 hover:bg-green-600 text-white cursor-pointer"
                    >
                      ✅ Approve & Execute
                    </button>
                    <button
                      onClick={() => vscode.postMessage({ type: 'rejectPipelineRun', value: { runId: run.id } })}
                      className="flex-1 text-[10.5px] font-semibold py-1 px-2 rounded bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-600/30 cursor-pointer"
                    >
                      ❌ Reject
                    </button>
                  </div>
                </div>
              )}

              {isExpanded && state && (
                <div className="px-3 pb-3">
                  <PipelineLogPanel state={state} post={vscode.postMessage} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
