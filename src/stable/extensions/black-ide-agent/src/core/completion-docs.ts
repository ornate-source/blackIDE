// ─── Completion doc regime ───────────────────────────────────────────────────
// plan.md's deliverable doc set: a finished run should leave the project's own
// documentation updated, not just its code. Pure formatters + prepend/merge logic so the
// shape is unit-testable and the read/modify/write at the call site cannot drift from it.

export interface RunSummary {
    /** The user's original request. */
    prompt: string;
    /** Phases that actually ran, in order. */
    phases: string[];
    /** Workspace-relative paths the run touched, with what happened to them. */
    files: { path: string; kind: 'created' | 'modified' | 'deleted' }[];
    /** ISO date (YYYY-MM-DD). Defaults to today. */
    date?: string;
    /** Branch the work landed on, when the run used PR output mode. */
    branch?: string;
}

const KEEP_A_CHANGELOG_HEAD = '# Changelog\n\nAll notable changes to this project are documented in this file.\n';

/** One-line summary of a request, trimmed to a headline length. Pure. */
export function summarizeRequest(prompt: string, maxLen = 72): string {
    const oneLine = String(prompt || '').replace(/\s+/g, ' ').trim();
    if (!oneLine) return 'Untitled change';
    return oneLine.length <= maxLen ? oneLine : oneLine.slice(0, maxLen - 1).trimEnd() + '…';
}

/**
 * A CHANGELOG.md entry for one run, PREPENDED under the header so the newest change is
 * first — the opposite of the knowledge base's append-only logs, and deliberately so:
 * changelogs are read top-down by humans looking for what changed most recently.
 */
export function formatChangelogEntry(run: RunSummary): string {
    const date = run.date || new Date().toISOString().slice(0, 10);
    const lines = [`## ${date} — ${summarizeRequest(run.prompt)}`, ''];

    const added = run.files.filter(f => f.kind === 'created');
    const changed = run.files.filter(f => f.kind === 'modified');
    const removed = run.files.filter(f => f.kind === 'deleted');
    const group = (label: string, files: typeof run.files) => {
        if (!files.length) return;
        lines.push(`### ${label}`);
        for (const f of files) lines.push(`- \`${f.path}\``);
        lines.push('');
    };
    group('Added', added);
    group('Changed', changed);
    group('Removed', removed);
    if (!run.files.length) lines.push('_No file changes recorded._', '');
    return lines.join('\n');
}

/**
 * Merge a new entry into an existing changelog, keeping the header at the top and the
 * newest entry directly beneath it. Creates the Keep-a-Changelog header when the file is
 * absent or empty. Pure — returns the full new document.
 */
export function prependChangelogEntry(existing: string, entry: string): string {
    const content = (existing || '').trim();
    if (!content) return `${KEEP_A_CHANGELOG_HEAD}\n${entry}`;

    // Insert immediately before the first existing entry, so the file's own preamble
    // (title, description, any "Unreleased" note) is preserved above it.
    const firstEntry = content.indexOf('\n## ');
    if (firstEntry < 0) return `${content}\n\n${entry}`;
    return `${content.slice(0, firstEntry + 1)}\n${entry}${content.slice(firstEntry + 1)}`;
}

/**
 * Human-facing release notes for one run — the "what changed for you" view, as opposed to
 * the changelog's per-file record. Pure.
 */
export function formatReleaseNotes(run: RunSummary): string {
    const date = run.date || new Date().toISOString().slice(0, 10);
    const lines = [
        `# Release Notes — ${date}`,
        ``,
        `## ${summarizeRequest(run.prompt)}`,
        ``,
        run.prompt.trim() || '_No description provided._',
        ``,
        `**Delivered by:** ${run.phases.length ? run.phases.join(' → ') : '_no phases recorded_'}`,
        `**Files touched:** ${run.files.length}`,
    ];
    if (run.branch) lines.push(`**Branch:** \`${run.branch}\``);
    lines.push('');
    return lines.join('\n');
}
