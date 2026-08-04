import { useEffect, useReducer, useState } from 'react';
import { agentReducer, initialAgentState, AgentState } from './agent-store';
import { PipelineLogPanel } from './AgentPanels';
import ArtifactReview, { ReviewGroup } from './ArtifactReview';
import { MemoryPanel, MemoryView } from './MemoryPanel';
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

/**
 * Task agents (Phase 6, M31) — independent jobs, not pipelines.
 *
 * Rendered beside pipeline runs rather than in a separate view, because "what is my
 * machine doing" is one question. The card carries the two things a pipeline row never
 * needed: which model ran it (M32) and what to do with the result, since a finished agent
 * has changed nothing the user can see until they apply it.
 */
interface TaskAgentSummary {
  id: string;
  prompt: string;
  modelId: string;
  mode: string;
  rootPath: string;
  branch: string;
  status: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt?: number;
  error?: string;
  currentAction?: string;
  diff?: { files: number; insertions: number; deletions: number };
  tokens?: number;
  costUsd?: number;
  appliedAt?: number;
  discardedAt?: number;
  raceId?: string;
  verification?: {
    outcome: 'verified' | 'failed' | 'unverifiable' | 'incomplete';
    testsRan: boolean;
    passed?: number;
    failed?: number;
    reportPath?: string;
  };
}

interface InboxItem {
  id: string;
  kind: 'pipeline' | 'task';
  reason: 'blocked' | 'review' | 'failed' | 'parked';
  title: string;
  detail: string;
}

const INBOX_TONE: Record<InboxItem['reason'], string> = {
  parked: 'text-orange-400 border-orange-400/30 bg-orange-400/10',
  blocked: 'text-yellow-400 border-yellow-400/30 bg-yellow-400/10',
  failed: 'text-red-400 border-red-400/30 bg-red-400/10',
  review: 'text-green-400 border-green-400/30 bg-green-400/10',
};

function describeDiff(diff: TaskAgentSummary['diff']): string {
  if (!diff || diff.files === 0) return 'no changes';
  return `${diff.files} file${diff.files === 1 ? '' : 's'}, +${diff.insertions}/-${diff.deletions}`;
}

/** Applied and discarded are one-way exits; the buttons must not offer a second one. */
function agentSettled(agent: TaskAgentSummary): boolean {
  return !!agent.appliedAt || !!agent.discardedAt;
}

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
  const [agents, setAgents] = useState<TaskAgentSummary[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [lane, setLane] = useState<'pipeline' | 'agent' | 'review' | 'memory'>('pipeline');
  // The review surface (M38). Held here rather than in the component so one message
  // listener serves the whole panel, as it already does for runs, agents and the inbox.
  const [artifactGroups, setArtifactGroups] = useState<ReviewGroup[]>([]);
  const [artifactCounts, setArtifactCounts] = useState({ total: 0, runs: 0, byType: {} as Record<string, number> });
  const [artifactContent, setArtifactContent] = useState<{ artifactId: string; content: string; error?: string } | undefined>();
  // Durable memory (M45). Same reasoning as the review surface above: one listener for
  // the whole panel rather than a second one inside the component.
  const [memory, setMemory] = useState<MemoryView>({
    rows: [], pending: [],
    counts: { total: 0, active: 0, demoted: 0, archived: 0, pending: 0, byType: {} },
  });
  const [, forceTick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    vscode.postMessage({ type: 'listPipelineRuns' });
    vscode.postMessage({ type: 'listTaskAgents' });
    vscode.postMessage({ type: 'listArtifacts' });
    vscode.postMessage({ type: 'listMemory' });
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
        case 'taskAgentListSync':
          setAgents(message.value || []);
          break;
        case 'agentInboxSync':
          setInbox(message.value?.items || []);
          break;
        case 'artifactListSync':
          setArtifactGroups(message.value?.groups || []);
          setArtifactCounts(message.value?.counts || { total: 0, runs: 0, byType: {} });
          break;
        case 'artifactContentSync':
          setArtifactContent(message.value);
          break;
        case 'memorySync':
          setMemory(message.value);
          break;
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

  const startAgent = () => {
    if (!prompt.trim() || !modelId) return;
    setStartError('');
    vscode.postMessage({ type: 'startTaskAgent', value: { prompt: prompt.trim(), modelId } });
    setPrompt('');
  };

  const liveAgents = agents.filter(a => a.status === 'queued' || a.status === 'running' || a.status === 'awaiting_approval');
  const visibleAgents = agents.filter(a => !a.discardedAt).slice().reverse();

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground overflow-hidden">
      <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold">✦ Agent Manager</span>
          <span className="text-[10px] text-muted/60 font-mono">
            {activeCount + liveAgents.length}/{MAX_CONCURRENT_RUNS} running
          </span>
        </div>
        {/* The inbox badge (M34). Blocked work is counted apart from finished work:
            one is holding something up, the other is only waiting to be looked at. */}
        {inbox.length > 0 && (
          <div className="flex items-center gap-1.5">
            {(['parked', 'blocked', 'failed', 'review'] as const).map(reason => {
              const count = inbox.filter(i => i.reason === reason).length;
              if (!count) return null;
              return (
                <span key={reason} className={`px-2 py-0.5 rounded-full border text-[10px] font-medium ${INBOX_TONE[reason]}`}>
                  {count} {reason}
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div className="px-3 pt-2 flex gap-1 shrink-0">
        {(['pipeline', 'agent', 'review', 'memory'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => {
              setLane(tab);
              if (tab === 'review') vscode.postMessage({ type: 'listArtifacts' });
              // Re-read on every visit rather than trusting the mount sync: memory.md is
              // a file the user may have edited in the next tab since this panel opened.
              if (tab === 'memory') vscode.postMessage({ type: 'listMemory' });
            }}
            className={`px-3 py-1.5 rounded-t text-[11px] font-medium cursor-pointer transition-colors ${
              lane === tab ? 'bg-panel/50 text-foreground border-b-2 border-accentBlue'
                           : 'text-muted/60 hover:text-foreground'}`}
          >
            {tab === 'pipeline' ? `Pipelines (${runs.length})`
              : tab === 'agent' ? `Task Agents (${visibleAgents.length})`
              : tab === 'review' ? `Review (${artifactCounts.total})`
              // The pending count is surfaced on the tab itself: a confirm queue nobody
              // knows about is a confirm queue nobody empties.
              : `Memory (${memory.counts.total}${memory.counts.pending ? ` · ${memory.counts.pending} to confirm` : ''})`}
          </button>
        ))}
      </div>

      {/* The launcher belongs to the two lanes that launch things. Review reads what they
          produced, and a prompt box above it would suggest it starts something. */}
      <div className={`p-3 border-b border-border/40 shrink-0 ${lane === 'review' ? 'hidden' : ''}`}>
        <div className="flex gap-2">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (lane === 'agent' ? startAgent : startRun)(); } }}
            placeholder={lane === 'agent'
              ? 'Describe one task — it runs in its own git worktree and changes nothing until you apply it…'
              : 'Describe what to build — this runs as its own isolated pipeline, in parallel with any others…'}
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
            onClick={lane === 'agent' ? startAgent : startRun}
            disabled={!prompt.trim() || !modelId}
            className="px-4 py-2 rounded text-[12px] font-semibold bg-accentBlue/80 hover:bg-accentBlue text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            {lane === 'agent' ? '+ New Agent' : '+ New Run'}
          </button>
        </div>
        {startError && <div className="mt-2 text-[10.5px] text-red-400">{startError}</div>}
      </div>

      <div className={`flex-1 overflow-y-auto p-3 flex-col gap-2 ${lane === 'pipeline' ? 'flex' : 'hidden'}`}>
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

      {/* ── Task agents (Phase 6, M31/M32/M34) ───────────────────────────── */}
      <div className={`flex-1 overflow-y-auto p-3 flex-col gap-2 ${lane === 'agent' ? 'flex' : 'hidden'}`}>
        {visibleAgents.length === 0 && (
          <div className="text-[11px] text-muted/50 text-center py-8">
            No task agents yet. Describe one task above — it runs in its own git worktree,
            and your workspace is untouched until you apply the result.
          </div>
        )}
        {visibleAgents.map(agent => {
          const model = models.find(m => m.id === agent.modelId);
          const settled = agentSettled(agent);
          const canApply = agent.status === 'completed' && !settled;
          return (
            <div key={agent.id} className="rounded-lg border border-border/40 bg-panel/30 overflow-hidden">
              <div className="p-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-foreground truncate">{agent.prompt}</div>
                  <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-muted/60 font-mono">
                    <span className={`px-1.5 py-0.5 rounded border ${STATUS_CLASS[agent.status === 'queued' ? 'running' : agent.status]}`}>
                      {agent.appliedAt ? 'Applied' : STATUS_LABEL[agent.status === 'queued' ? 'running' : agent.status]}
                    </span>
                    {/* M32: which model ran this one. */}
                    <span>{model?.name || agent.modelId}</span>
                    <span>{agent.mode}</span>
                    <span>{describeDiff(agent.diff)}</span>
                    {agent.currentAction && <span className="text-accentBlue">{agent.currentAction}…</span>}
                    {/* Verification (M40) — evidence, not an assertion that it worked. */}
                    {agent.verification && (
                      <span className={
                        agent.verification.outcome === 'verified' ? 'text-green-400'
                          : agent.verification.outcome === 'failed' ? 'text-red-400' : 'text-yellow-400'
                      }>
                        {agent.verification.outcome}
                        {agent.verification.failed ? ` (${agent.verification.failed} failing)` : ''}
                      </span>
                    )}
                    {agent.raceId && <span className="text-purple-400">race</span>}
                  </div>
                  {/* The branch is the recovery instruction, so it is always visible —
                      a cancelled or failed agent's work is still on it. */}
                  <div className="mt-1 text-[9.5px] text-muted/40 font-mono truncate">{agent.branch}</div>
                  {agent.error && <div className="mt-1 text-[10.5px] text-red-400">{agent.error}</div>}
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  {(agent.status === 'running' || agent.status === 'queued') && (
                    <>
                      {/*
                        Mid-run steering (M39). Only offered while the agent is live: a
                        finished run has no next turn to inject into, and a comment the
                        user believes was delivered is worse than one that was refused.
                      */}
                      <button
                        onClick={() => {
                          const text = window.prompt('Correct this agent — it reaches the model on its next turn:');
                          if (text?.trim()) vscode.postMessage({ type: 'steerAgent', value: { agentId: agent.id, text } });
                        }}
                        className="text-[10.5px] py-1 px-2 rounded bg-accentBlue/20 hover:bg-accentBlue/40 text-accentBlue border border-accentBlue/30 cursor-pointer"
                      >
                        Steer
                      </button>
                      <button
                        onClick={() => vscode.postMessage({ type: 'cancelTaskAgent', value: { agentId: agent.id } })}
                        className="text-[10.5px] py-1 px-2 rounded bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-600/30 cursor-pointer"
                      >
                        Cancel
                      </button>
                    </>
                  )}
                  {canApply && (
                    <button
                      onClick={() => vscode.postMessage({ type: 'applyTaskAgent', value: { agentId: agent.id } })}
                      className="text-[10.5px] font-semibold py-1 px-2 rounded bg-green-600/20 hover:bg-green-600/40 text-green-400 border border-green-600/30 cursor-pointer"
                    >
                      Apply
                    </button>
                  )}
                  {!settled && (
                    <button
                      onClick={() => vscode.postMessage({ type: 'discardTaskAgent', value: { agentId: agent.id } })}
                      className="text-[10.5px] py-1 px-2 rounded bg-muted/10 hover:bg-muted/20 text-muted border border-border/40 cursor-pointer"
                    >
                      Discard
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Durable memory (Phase 8, M45) ────────────────────────────────── */}
      {lane === 'memory' && <MemoryPanel view={memory} post={vscode.postMessage} />}

      {/* ── Artifact review (Phase 7, M38) ───────────────────────────────── */}
      {lane === 'review' && (
        <ArtifactReview
          groups={artifactGroups}
          counts={artifactCounts}
          content={artifactContent}
          post={vscode.postMessage}
        />
      )}
    </div>
  );
}
