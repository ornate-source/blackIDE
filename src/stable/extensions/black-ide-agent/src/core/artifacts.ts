// ─── Typed artifacts (Phase 7, M38) ─────────────────────────────────────────
//
// `agent/artifact-manager.ts` has stored markdown in a flat directory since Feature 18.
// Three things make it insufficient for a review surface, and the third is a bug:
//
//   1. **No run association.** Artifacts are a directory, so "what did this run produce"
//      cannot be answered — which is the first question a review panel asks.
//   2. **Markdown only.** `screenshot` and `recording` are two of the seven types this
//      milestone names, and neither is text.
//   3. **`list()` reports every artifact as `report`.** `save()` accepts a type and drops
//      it on the floor; the listing then hardcodes `type: 'report'`. So the type has been
//      accepted, ignored and misreported since it was introduced, and nothing noticed
//      because nothing rendered it.
//
// This module is the typed model and its index. Pure and vscode-free — the interesting
// decisions here are ordering, identity and what a review surface is allowed to assume,
// none of which need a filesystem to test.

export type ArtifactType =
    | 'plan'
    | 'task-list'
    | 'diff'
    | 'walkthrough'
    | 'screenshot'
    | 'recording'
    | 'test-report'
    /**
     * A code review of a working diff (Phase 9, M47).
     *
     * Its own type rather than a `walkthrough`, because the panel filters by type and
     * "show me the reviews" is the question this surface exists to answer. Folding it
     * into an existing type would make the Reviewer's output findable only by reading
     * every artifact a run produced — which is the state M38 was built to end.
     */
    | 'review';

export const ARTIFACT_TYPES: readonly ArtifactType[] = [
    'plan', 'task-list', 'diff', 'walkthrough', 'screenshot', 'recording', 'test-report', 'review',
];

/** Which types are readable as text, and which are files to open with something else. */
const BINARY_TYPES: ArtifactType[] = ['screenshot', 'recording'];

export function isBinaryArtifact(type: ArtifactType): boolean {
    return BINARY_TYPES.includes(type);
}

export interface ArtifactRecord {
    id: string;
    /** The run that produced it — a pipeline runId or a task agent id. */
    runId: string;
    type: ArtifactType;
    title: string;
    /** Absolute path on disk. */
    path: string;
    createdAt: number;
    /** Bytes, for the panel; a 40 MB recording should say so before it is opened. */
    size?: number;
    /**
     * Comments left on this artifact (M39). Kept *with* the artifact rather than with the
     * run, so re-opening a finished run still shows what was said about it — a review
     * whose comments vanish when the run ends is a review nobody trusts twice.
     */
    comments?: ArtifactComment[];
}

export interface ArtifactComment {
    id: string;
    text: string;
    at: number;
    /** The quoted region the comment is about. */
    region?: string;
    /** True once it has been delivered to a running agent as a steering note. */
    delivered?: boolean;
}

/** Stable, human-readable, collision-free enough for one machine. */
export function artifactId(runId: string, type: ArtifactType, now: number, seq: number): string {
    return `${runId}_${type}_${now.toString(36)}${seq.toString(36)}`;
}

/**
 * A filesystem-safe name that keeps the type and the run visible.
 *
 * The type is in the filename rather than only in the index because the index is a
 * derived, losable thing: delete it and the directory should still be legible. That is
 * also the property the current flat store lacks, which is how a mislabelled type went
 * unnoticed for three phases.
 */
export function artifactFilename(record: Pick<ArtifactRecord, 'runId' | 'type' | 'title'>, extension: string): string {
    const safeTitle = String(record.title || record.type)
        .replace(/[^a-z0-9_-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || record.type;
    const safeRun = String(record.runId).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 24);
    return `${safeRun}__${record.type}__${safeTitle}${extension.startsWith('.') ? extension : `.${extension}`}`;
}

/** The default extension for a type, when the caller does not supply one. */
export function extensionFor(type: ArtifactType): string {
    switch (type) {
        case 'screenshot': return '.png';
        case 'recording': return '.webm';
        case 'diff': return '.diff';
        default: return '.md';
    }
}

/**
 * The review ordering: newest first, but **grouped by run**.
 *
 * A flat newest-first list interleaves four concurrent agents' artifacts, so reviewing one
 * run means reading every fourth card. Grouping by run and ordering the groups by their
 * most recent artifact keeps a run's story together while still surfacing whatever just
 * happened at the top — which is the ordering a review surface actually needs now that
 * Phase 6 made four concurrent runs normal.
 */
export function groupForReview(records: ArtifactRecord[]): { runId: string; latestAt: number; artifacts: ArtifactRecord[] }[] {
    const byRun = new Map<string, ArtifactRecord[]>();
    for (const record of records || []) {
        const list = byRun.get(record.runId);
        if (list) list.push(record); else byRun.set(record.runId, [record]);
    }

    return [...byRun.entries()]
        .map(([runId, artifacts]) => ({
            runId,
            artifacts: [...artifacts].sort((a, b) => b.createdAt - a.createdAt),
            latestAt: Math.max(...artifacts.map(a => a.createdAt)),
        }))
        .sort((a, b) => b.latestAt - a.latestAt);
}

/**
 * Whether a run produced the evidence Phase 7 requires of it (M40's half of the gate).
 *
 * `test-report` is the one artifact every run owes, so its absence is the measurable form
 * of "this run was never verified" — which is exactly the §4.2 row this phase adds.
 */
export function hasVerificationEvidence(records: ArtifactRecord[], runId: string): boolean {
    return (records || []).some(r => r.runId === runId && r.type === 'test-report');
}

/** The share of runs that emitted a test report. The gate is 100% for pipeline runs. */
export function evidenceCoverage(records: ArtifactRecord[], runIds: string[]): number {
    if (!runIds.length) return 1;
    const covered = runIds.filter(id => hasVerificationEvidence(records, id)).length;
    return covered / runIds.length;
}

/**
 * Attach a comment.
 *
 * Returns a **new** record. Artifacts are handed to a webview and back, and mutating one
 * in place is how a panel ends up rendering a comment that the extension host has not
 * persisted yet.
 */
export function addComment(
    record: ArtifactRecord,
    text: string,
    options: { region?: string; at?: number; id?: string } = {},
): ArtifactRecord {
    const trimmed = String(text || '').trim();
    if (!trimmed) return record;
    const comment: ArtifactComment = {
        id: options.id || `c_${(options.at ?? Date.now()).toString(36)}_${(record.comments?.length ?? 0)}`,
        text: trimmed,
        at: options.at ?? Date.now(),
        region: options.region,
    };
    return { ...record, comments: [...(record.comments || []), comment] };
}

/** Mark comments delivered once they have been queued as steering notes. */
export function markDelivered(record: ArtifactRecord, commentIds: string[]): ArtifactRecord {
    const ids = new Set(commentIds);
    return {
        ...record,
        comments: (record.comments || []).map(c => (ids.has(c.id) ? { ...c, delivered: true } : c)),
    };
}

/** Comments that have not yet reached an agent. */
export function undeliveredComments(records: ArtifactRecord[]): { record: ArtifactRecord; comment: ArtifactComment }[] {
    const out: { record: ArtifactRecord; comment: ArtifactComment }[] = [];
    for (const record of records || []) {
        for (const comment of record.comments || []) {
            if (!comment.delivered) out.push({ record, comment });
        }
    }
    return out.sort((a, b) => a.comment.at - b.comment.at);
}
