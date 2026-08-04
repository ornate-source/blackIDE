import { useEffect, useRef, useState } from 'react';

/**
 * The artifact review panel (Phase 7, M38).
 *
 * Two things happen here, and the second is the point. The first is browsing: artifacts
 * grouped by run and filterable by type, which is what the typed store has been able to
 * answer since M38 and nothing has ever asked. The second is **commenting on a region** —
 * select a passage of a plan or a diff, say what is wrong with it, and have that reach the
 * agent that produced it on its next turn.
 *
 * That second path is M39's, and until now its only entry point was a `window.prompt`
 * behind a "Steer" button. A prompt box cannot carry which artifact the user is reading or
 * which lines they meant, so the steering note arrived without the two pieces of context
 * that make a short correction actionable. "No, not like that" is useless; "no, not like
 * that" attached to the four lines it is about is the cheapest correction in the product.
 */

export type ArtifactType = 'plan' | 'task-list' | 'diff' | 'walkthrough' | 'screenshot' | 'recording' | 'test-report';

export interface ReviewComment {
  id: string;
  text: string;
  at: number;
  region?: string;
  delivered?: boolean;
}

export interface ReviewArtifact {
  id: string;
  runId: string;
  type: ArtifactType;
  title: string;
  path: string;
  createdAt: number;
  size?: number;
  binary: boolean;
  comments: ReviewComment[];
  /** Webview-safe URI for binary artifacts; a file:// path is blocked by the CSP. */
  src?: string;
}

export interface ReviewGroup {
  runId: string;
  latestAt: number;
  live: boolean;
  artifacts: ReviewArtifact[];
}

export interface ArtifactReviewProps {
  groups: ReviewGroup[];
  counts: { total: number; runs: number; byType: Record<string, number> };
  /** Body of the selected text artifact, keyed by id so a stale reply cannot land. */
  content?: { artifactId: string; content: string; error?: string };
  post: (message: any) => void;
}

const TYPE_TONE: Record<ArtifactType, string> = {
  plan: 'text-accentBlue border-accentBlue/30 bg-accentBlue/10',
  'task-list': 'text-purple-400 border-purple-400/30 bg-purple-400/10',
  diff: 'text-orange-400 border-orange-400/30 bg-orange-400/10',
  walkthrough: 'text-cyan-400 border-cyan-400/30 bg-cyan-400/10',
  screenshot: 'text-green-400 border-green-400/30 bg-green-400/10',
  recording: 'text-green-400 border-green-400/30 bg-green-400/10',
  'test-report': 'text-yellow-400 border-yellow-400/30 bg-yellow-400/10',
};

const FILTERS: Array<{ id: 'all' | ArtifactType; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'plan', label: 'Plans' },
  { id: 'diff', label: 'Diffs' },
  { id: 'test-report', label: 'Tests' },
  { id: 'screenshot', label: 'Screens' },
  { id: 'walkthrough', label: 'Walkthroughs' },
];

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ArtifactReview({ groups, counts, content, post }: ArtifactReviewProps) {
  const [filter, setFilter] = useState<'all' | ArtifactType>('all');
  const [selectedId, setSelectedId] = useState<string>('');
  const [region, setRegion] = useState('');
  const [comment, setComment] = useState('');
  const bodyRef = useRef<HTMLPreElement>(null);

  const all = groups.flatMap(g => g.artifacts);
  const selected = all.find(a => a.id === selectedId);
  const selectedGroup = groups.find(g => g.artifacts.some(a => a.id === selectedId));

  // Ask for the body when the selection changes, and only then: a listing that carried
  // every plan and diff inline would ship megabytes to render a sidebar.
  useEffect(() => {
    if (selected && !selected.binary) post({ type: 'readArtifact', value: { artifactId: selected.id } });
    setRegion('');
  }, [selectedId]);

  // A selection the user has since scrolled past is still what they meant to quote, so it
  // is captured on mouse-up rather than read at submit time — by then the click on the
  // comment box has already collapsed it.
  const captureSelection = () => {
    const text = window.getSelection()?.toString() || '';
    if (text.trim() && bodyRef.current) setRegion(text);
  };

  const submit = () => {
    if (!selected || !comment.trim()) return;
    post({
      type: 'commentArtifact',
      value: { artifactId: selected.id, text: comment.trim(), region: region || undefined, type: filter },
    });
    setComment('');
    setRegion('');
  };

  if (!counts.total) {
    return (
      <div className="flex-1 overflow-y-auto p-3">
        <div className="text-[11px] text-muted/50 text-center py-8">
          No artifacts yet. Plans, diffs, test reports and screenshots from every run land here.
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex">
      {/* ── Browse: by type, then by run ── */}
      <div className="w-[38%] min-w-[220px] border-r border-border/40 flex flex-col min-h-0">
        <div className="px-3 py-2 flex gap-1 flex-wrap border-b border-border/40 shrink-0">
          {FILTERS.map(f => {
            const count = f.id === 'all' ? counts.total : (counts.byType[f.id] || 0);
            if (!count && f.id !== 'all') return null;
            return (
              <button
                key={f.id}
                onClick={() => { setFilter(f.id); post({ type: 'listArtifacts', value: { type: f.id } }); }}
                className={`px-2 py-0.5 rounded text-[10px] font-medium cursor-pointer border transition-colors ${
                  filter === f.id ? 'border-accentBlue/40 bg-accentBlue/15 text-accentBlue'
                                  : 'border-border/40 text-muted/60 hover:text-foreground'}`}
              >
                {f.label} {count}
              </button>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
          {groups.map(group => (
            <div key={group.runId} className="rounded border border-border/40 bg-panel/20 overflow-hidden">
              <div className="px-2 py-1.5 flex items-center gap-2 border-b border-border/30">
                <span className="text-[10px] font-mono text-muted/70 truncate flex-1">{group.runId}</span>
                {/* Live means a comment still reaches an agent. Shown because it changes
                    what commenting *does*, and the user is entitled to know which. */}
                {group.live && (
                  <span className="px-1.5 py-0.5 rounded-full border text-[9px] text-green-400 border-green-400/30 bg-green-400/10">
                    live
                  </span>
                )}
              </div>
              {group.artifacts.map(artifact => (
                <button
                  key={artifact.id}
                  onClick={() => setSelectedId(artifact.id)}
                  className={`w-full text-left px-2 py-1.5 flex items-center gap-2 cursor-pointer transition-colors ${
                    artifact.id === selectedId ? 'bg-accentBlue/10' : 'hover:bg-panel/40'}`}
                >
                  <span className={`text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border shrink-0 ${TYPE_TONE[artifact.type]}`}>
                    {artifact.type}
                  </span>
                  <span className="text-[11px] truncate flex-1">{artifact.title}</span>
                  {artifact.comments.length > 0 && (
                    <span className="text-[9.5px] text-muted/60 shrink-0">{artifact.comments.length}💬</span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ── Read, and comment on what you read ── */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {!selected && (
          <div className="flex-1 flex items-center justify-center text-[11px] text-muted/50">
            Select an artifact to review it.
          </div>
        )}

        {selected && (
          <>
            <div className="px-3 py-2 border-b border-border/40 flex items-center gap-2 shrink-0">
              <span className="text-[12px] font-medium truncate flex-1">{selected.title}</span>
              <span className="text-[10px] text-muted/50 font-mono shrink-0">{formatSize(selected.size)}</span>
              <button
                onClick={() => post({ type: 'openArtifact', value: { artifactId: selected.id } })}
                className="text-[10.5px] py-1 px-2 rounded bg-muted/10 hover:bg-muted/20 text-muted border border-border/40 cursor-pointer shrink-0"
              >
                Open
              </button>
            </div>

            <div className="flex-1 overflow-auto p-3 min-h-0">
              {selected.binary && selected.src && (
                <img src={selected.src} alt={selected.title} className="max-w-full rounded border border-border/40" />
              )}
              {selected.binary && !selected.src && (
                <div className="text-[11px] text-muted/50">This file has to be opened outside the panel.</div>
              )}
              {!selected.binary && (
                <pre
                  ref={bodyRef}
                  onMouseUp={captureSelection}
                  className="text-[11.5px] font-mono whitespace-pre-wrap leading-relaxed text-foreground/90 select-text"
                >
                  {content?.artifactId === selected.id
                    ? (content.error || content.content)
                    : 'Loading…'}
                </pre>
              )}
            </div>

            {selected.comments.length > 0 && (
              <div className="px-3 py-2 border-t border-border/40 max-h-[25%] overflow-y-auto shrink-0 flex flex-col gap-1.5">
                {selected.comments.map(c => (
                  <div key={c.id} className="text-[10.5px] text-muted/80">
                    {c.region && (
                      <div className="border-l-2 border-border/60 pl-2 mb-0.5 text-muted/50 font-mono whitespace-pre-wrap">
                        {c.region}
                      </div>
                    )}
                    <span>{c.text}</span>
                    {/* Delivered means an agent has it. Absent means it was recorded for a
                        reader, which is a different promise and is shown as one. */}
                    <span className={`ml-2 text-[9px] ${c.delivered ? 'text-green-400' : 'text-muted/40'}`}>
                      {c.delivered ? 'sent to agent' : 'saved'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="p-3 border-t border-border/40 shrink-0 flex flex-col gap-2">
              {region && (
                <div className="flex items-start gap-2">
                  <div className="flex-1 border-l-2 border-accentBlue/50 pl-2 text-[10px] font-mono text-muted/60 max-h-[60px] overflow-y-auto whitespace-pre-wrap">
                    {region}
                  </div>
                  <button onClick={() => setRegion('')} className="text-[10px] text-muted/50 hover:text-foreground cursor-pointer shrink-0">
                    clear
                  </button>
                </div>
              )}
              <div className="flex gap-2">
                <input
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
                  placeholder={region
                    ? 'What is wrong with the selected passage?'
                    : 'Comment on this artifact — select a passage first to quote it…'}
                  className="flex-1 bg-[rgba(255,255,255,0.04)] text-foreground border border-border/40 rounded px-3 py-2 text-[12px] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)]"
                />
                <button
                  onClick={submit}
                  disabled={!comment.trim()}
                  className="px-3 py-2 rounded text-[11.5px] font-semibold bg-accentBlue/80 hover:bg-accentBlue text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  {selectedGroup?.live ? 'Comment & steer' : 'Comment'}
                </button>
              </div>
              <span className="text-[10px] text-muted/40">
                {selectedGroup?.live
                  ? 'This run is still going — the comment reaches the agent on its next turn.'
                  : 'This run has finished, so the comment is saved with the artifact rather than sent.'}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
