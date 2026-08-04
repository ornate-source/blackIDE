import { useState } from 'react';

/**
 * The memory panel (Phase 8, M45 · P8-2).
 *
 * The first surface on which a user can see what the agent believes about their project.
 * Everything shown here — entries, confidence, provenance, status — has existed since
 * Phase 8 and has never been visible; the store was written to, decayed and consolidated
 * entirely out of sight.
 *
 * ── Two decisions worth stating ─────────────────────────────────────────────
 *
 * **Pending candidates come first, and are the only thing with buttons.** The rest of
 * the panel is for reading; the confirm queue is the one place a decision is waiting on
 * the user, and burying it under forty remembered facts would make the "one-click
 * confirm" band decorative. It is capped at twenty upstream for the same reason.
 *
 * **"Edit memory.md" is a primary action, not a footnote.** ADR 007 makes the markdown a
 * *user file* — the agent preserves what it did not write, and decay archives rather than
 * deletes. A panel that only let you read would quietly turn it into an opaque store the
 * user is shown a rendering of, which is the opposite of that decision.
 */

export type MemoryStatus = 'active' | 'demoted' | 'archived';
export type MemoryType = 'preference' | 'convention' | 'fact' | 'decision' | 'constraint';

export interface MemoryRow {
  id: string;
  text: string;
  type: MemoryType;
  status: MemoryStatus;
  confidencePct: number;
  band: 'auto' | 'confirm' | 'drop';
  origin: string;
  provenance?: string;
  createdAt: number;
  lastUsedAt: number;
  uses: number;
  injected: boolean;
  supersedes: number;
}

export interface PendingRow {
  text: string;
  type: MemoryType;
  confidencePct: number;
  because?: string;
}

export interface MemoryView {
  rows: MemoryRow[];
  pending: PendingRow[];
  counts: {
    total: number; active: number; demoted: number; archived: number;
    pending: number; byType: Record<string, number>;
  };
  filePath?: string;
  empty?: string;
}

export interface MemoryPanelProps {
  view: MemoryView;
  post: (message: any) => void;
}

const TYPES: (MemoryType | 'all')[] = ['all', 'preference', 'convention', 'fact', 'decision', 'constraint'];
const STATUSES: (MemoryStatus | 'all')[] = ['all', 'active', 'demoted', 'archived'];

/** Colour by what the status *means* for the user, not by severity. */
const STATUS_STYLE: Record<MemoryStatus, string> = {
  active: 'text-emerald-400 border-emerald-500/40',
  demoted: 'text-amber-400 border-amber-500/40',
  archived: 'text-muted border-white/10',
};

function age(at: number): string {
  const ms = Math.max(0, Date.now() - at);
  const days = Math.floor(ms / 86_400_000);
  if (days >= 365) return `${Math.floor(days / 365)}y`;
  if (days >= 30) return `${Math.floor(days / 30)}mo`;
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h`;
  const minutes = Math.floor(ms / 60_000);
  return minutes >= 1 ? `${minutes}m` : 'now';
}

export function MemoryPanel({ view, post }: MemoryPanelProps) {
  const [status, setStatus] = useState<MemoryStatus | 'all'>('all');
  const [type, setType] = useState<MemoryType | 'all'>('all');
  const [query, setQuery] = useState('');

  const refresh = (next: Partial<{ status: string; type: string; query: string }> = {}) => {
    post({ type: 'listMemory', value: { status, type, query, ...next } });
  };

  return (
    <div className="flex flex-col gap-3 p-3 overflow-y-auto">
      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select
          className="bg-panel/60 border border-white/10 rounded px-2 py-1"
          value={status}
          onChange={e => { const v = e.target.value as MemoryStatus | 'all'; setStatus(v); refresh({ status: v }); }}
        >
          {STATUSES.map(s => <option key={s} value={s}>{s === 'all' ? 'All statuses' : s}</option>)}
        </select>
        <select
          className="bg-panel/60 border border-white/10 rounded px-2 py-1"
          value={type}
          onChange={e => { const v = e.target.value as MemoryType | 'all'; setType(v); refresh({ type: v }); }}
        >
          {TYPES.map(t => <option key={t} value={t}>{t === 'all' ? 'All types' : t}</option>)}
        </select>
        <input
          className="flex-1 min-w-[8rem] bg-panel/60 border border-white/10 rounded px-2 py-1"
          placeholder="Filter…"
          value={query}
          onChange={e => { setQuery(e.target.value); refresh({ query: e.target.value }); }}
        />
        <span className="text-muted">
          {view.counts.active} active · {view.counts.demoted} demoted · {view.counts.archived} archived
        </span>
        <button
          className="px-2 py-1 rounded border border-white/10 hover:bg-panel/60"
          title="memory.md is your file. Editing it is the supported way to correct a memory."
          onClick={() => post({ type: 'openMemoryFile' })}
        >
          Edit memory.md
        </button>
      </div>

      {/* ── The confirm queue: the only decision waiting on the user ─────── */}
      {view.pending.length > 0 && (
        <div className="rounded border border-accentBlue/40 bg-accentBlue/5 p-3 flex flex-col gap-2">
          <div className="text-xs font-semibold">
            {view.pending.length} candidate{view.pending.length === 1 ? '' : 's'} awaiting confirmation
          </div>
          <div className="text-[11px] text-muted">
            Extracted from a conversation but not confident enough to write without asking.
          </div>
          {view.pending.map(candidate => (
            <div key={candidate.text} className="flex items-start gap-2 border-t border-white/5 pt-2">
              <div className="flex-1">
                <div className="text-xs">{candidate.text}</div>
                <div className="text-[11px] text-muted">
                  {candidate.type} · {candidate.confidencePct}% confident
                  {candidate.because ? ` · ${candidate.because}` : ''}
                </div>
              </div>
              <button
                className="px-2 py-1 text-xs rounded bg-accentBlue/20 border border-accentBlue/40 hover:bg-accentBlue/30"
                onClick={() => post({ type: 'confirmMemory', value: { text: candidate.text } })}
              >
                Remember
              </button>
              <button
                className="px-2 py-1 text-xs rounded border border-white/10 hover:bg-panel/60"
                onClick={() => post({ type: 'rejectMemory', value: { text: candidate.text } })}
              >
                Discard
              </button>
            </div>
          ))}
        </div>
      )}

      {view.empty && <div className="text-xs text-muted p-4 text-center">{view.empty}</div>}

      {/* ── Everything remembered ───────────────────────────────────────── */}
      {view.rows.map(row => (
        <div
          key={row.id}
          className={`rounded border p-3 flex flex-col gap-1 ${STATUS_STYLE[row.status]} ${
            row.status === 'archived' ? 'opacity-60' : ''
          }`}
        >
          <div className="flex items-start gap-2">
            <div className="flex-1 text-xs text-foreground">{row.text}</div>
            <div className="text-[11px] shrink-0">{row.status}</div>
          </div>

          {/* Confidence as a bar: the number that decided this entry's fate should be
              readable without arithmetic. */}
          <div className="flex items-center gap-2">
            <div className="h-1 flex-1 bg-white/10 rounded overflow-hidden">
              <div
                className={`h-full ${row.band === 'auto' ? 'bg-emerald-500' : row.band === 'confirm' ? 'bg-amber-500' : 'bg-white/30'}`}
                style={{ width: `${row.confidencePct}%` }}
              />
            </div>
            <span className="text-[11px] text-muted w-10 text-right">{row.confidencePct}%</span>
          </div>

          <div className="text-[11px] text-muted flex flex-wrap gap-x-3">
            <span>{row.type}</span>
            <span>{row.origin}</span>
            <span title="How many turns have used this fact. Anything used never decays.">
              used {row.uses}×
            </span>
            <span title={new Date(row.createdAt).toLocaleString()}>{age(row.createdAt)} old</span>
            {row.injected && <span className="text-emerald-400/80">in your prompts</span>}
            {row.supersedes > 0 && <span>replaced {row.supersedes} earlier fact(s)</span>}
            {row.provenance && <span className="italic">{row.provenance}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
