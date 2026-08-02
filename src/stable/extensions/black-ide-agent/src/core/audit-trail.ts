import { redact, redactDeep } from './redaction';

// ─── Append-only audit trail (Phase 9, M53) ─────────────────────────────────
//
// G5 has read 🔴/🟡 since rev 1 with a precise complaint: "Diagnostics export ≠ audit
// trail." The diagnostics export is a snapshot of what the extension thinks *now*; an
// audit trail is a record of what happened, in order, that cannot be rewritten after the
// fact. The difference matters the moment somebody asks "what did this agent do to my
// repository at 14:20", and it is the difference between a log and evidence.
//
// JSONL, append-only, one file per run. Every property of that sentence is load-bearing:
//   - **JSONL** — a partial write loses one line, not the file. A JSON array would be
//     unparseable if the host died mid-run, which is exactly when the record matters most.
//   - **Append-only** — entries are never edited or reordered. There is no update method
//     on this class, deliberately.
//   - **One file per run** — a run is the unit a human asks about, and it is the unit that
//     can be handed to somebody else without leaking every other run.
//
// ── Redacted on the way in, not on the way out ───────────────────────────────
// M54's scrubbing runs before the line is written, not when it is exported. An audit file
// containing a live credential is a credential in the user's repo with a filename that
// invites them to attach it to a bug report. Redacting at export would leave the secret on
// disk in between, which is the whole window that matters.

export type AuditKind =
    | 'run-started'
    | 'run-ended'
    | 'tool-call'
    | 'tool-result'
    | 'approval'
    | 'model'
    | 'usage'
    | 'steering'
    | 'policy'
    | 'verification';

export interface AuditEntry {
    /** Monotonic within a run, so ordering survives equal timestamps. */
    seq: number;
    at: number;
    kind: AuditKind;
    /** Free-form, already redacted. */
    detail: Record<string, unknown>;
}

/** The sink, injected so the recorder is testable without a filesystem. */
export interface AuditSink {
    append(line: string): void;
}

export class AuditTrail {
    private seq = 0;
    private readonly entries: AuditEntry[] = [];

    constructor(
        readonly runId: string,
        private readonly sink?: AuditSink,
        private readonly now: () => number = Date.now,
    ) {}

    /**
     * Record something. Returns the entry, already scrubbed.
     *
     * `redactDeep` rather than a field allowlist: a tool call's arguments are whatever the
     * model decided to pass, so which key might hold a secret is not knowable in advance.
     * An allowlist would be safer against over-redaction and would miss the first tool
     * somebody adds.
     */
    record(kind: AuditKind, detail: Record<string, unknown> = {}): AuditEntry {
        const entry: AuditEntry = {
            seq: ++this.seq,
            at: this.now(),
            kind,
            detail: redactDeep(detail),
        };
        this.entries.push(entry);
        try {
            this.sink?.append(JSON.stringify(entry));
        } catch {
            // A failed audit write must never fail the run. The in-memory copy survives and
            // the export still has it; losing the durable line is worse than losing the run
            // only in a regulatory setting this codebase does not claim to serve (G12).
        }
        return entry;
    }

    toolCall(name: string, args: unknown): AuditEntry {
        return this.record('tool-call', { tool: name, arguments: args });
    }

    toolResult(name: string, ok: boolean, summary: string, durationMs?: number): AuditEntry {
        // The summary is capped here rather than at the call site: an audit line carrying a
        // whole file's contents makes the trail unreadable and, on a big repo, unbounded.
        return this.record('tool-result', { tool: name, ok, summary: cap(summary, 500), durationMs });
    }

    approval(kind: string, granted: boolean, subject?: string): AuditEntry {
        return this.record('approval', { kind, granted, subject: subject ? cap(subject, 300) : undefined });
    }

    model(modelId: string, reason?: string): AuditEntry {
        return this.record('model', { modelId, reason });
    }

    usage(tokens: number, costUsd?: number): AuditEntry {
        return this.record('usage', { tokens, costUsd });
    }

    steering(text: string, artifactPath?: string): AuditEntry {
        return this.record('steering', { text: cap(text, 500), artifactPath });
    }

    /** Everything recorded this run, for the export artifact. */
    all(): AuditEntry[] {
        return [...this.entries];
    }

    /** The whole trail as one JSONL document. */
    export(): string {
        return this.entries.map(e => JSON.stringify(e)).join('\n') + (this.entries.length ? '\n' : '');
    }

    /** A human-readable digest, for the run card and the artifact's header. */
    summary(): string {
        const counts = new Map<AuditKind, number>();
        for (const entry of this.entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
        const tokens = this.entries
            .filter(e => e.kind === 'usage')
            .reduce((sum, e) => sum + (Number(e.detail.tokens) || 0), 0);

        const parts = [...counts.entries()].map(([kind, n]) => `${n} ${kind}`);
        if (tokens) parts.push(`${tokens.toLocaleString()} tokens`);
        return parts.join(' · ');
    }
}

function cap(text: string, max: number): string {
    const flat = String(text ?? '');
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Parse a trail back.
 *
 * Tolerant of a truncated final line, because that is exactly what a host crash leaves
 * behind — and refusing to read a trail because its last line is half-written would throw
 * away the record in the one situation it exists for.
 */
export function parseAuditTrail(text: string): AuditEntry[] {
    const out: AuditEntry[] = [];
    for (const line of String(text || '').split('\n')) {
        if (!line.trim()) continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed.seq === 'number') out.push(parsed);
        } catch {
            // A partial trailing line from an interrupted write. Skipped, not fatal.
        }
    }
    return out;
}

/**
 * The path a run's trail lives at.
 *
 * Inside `.blackIDE/audit/`, which is in the user's repository — deliberately, because the
 * trail is theirs and should travel with the project rather than living in extension
 * storage they cannot find. Anything sensitive is already redacted (M54), which is what
 * makes that safe.
 */
export function auditRelativePath(runId: string): string {
    // Separators are stripped first, which is what actually prevents traversal — but any
    // remaining `..` is also collapsed, and a leading dot removed. Neither is exploitable
    // once the separators are gone; both are removed because a filename that *looks* like
    // a traversal attempt is one a reviewer has to stop and reason about, and a guard
    // nobody can check at a glance is a guard that erodes.
    const safe = String(runId)
        .replace(/[^A-Za-z0-9._-]/g, '-')
        .replace(/\.{2,}/g, '.')
        .replace(/^[.-]+/, '')
        .slice(0, 64) || 'run';
    return `.blackIDE/audit/${safe}.jsonl`;
}
