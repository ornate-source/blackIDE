// ─── Who made this edit? (Phase 5, M28) ─────────────────────────────────────
//
// `onDidChangeTextDocument` reports *that* a document changed, never *who* changed it —
// there is no API for it, and `TextDocumentChangeEvent.reason` only distinguishes undo
// and redo. That gap costs money here: the agent writing eleven files during a run looks
// exactly like a developer typing, so next-edit would fire a prediction after each one,
// spending a model call per agent edit to guess what the developer will do next while the
// developer is watching an agent work.
//
// So the writer says so. `ToolRunner.writeFile` is the one path the agent's file edits go
// through, and it brackets its writes with this counter. A counter rather than a boolean
// because writes overlap: the pipeline runs phases concurrently, and a boolean would be
// cleared by whichever write finished first while three others were still in flight.
//
// Deliberately module-level state with no `vscode` import. It is process-wide because the
// writer and the listener have no other relationship — threading a handle from the tool
// runner to an editor feature would couple two things that should not know about each
// other, to carry one integer.

let depth = 0;

/** True while the agent is writing. Callers on the keystroke path should stand down. */
export function agentIsWriting(): boolean {
    return depth > 0;
}

/**
 * Run `work` marked as an agent edit.
 *
 * `finally` rather than a plain decrement, so a throwing write cannot leave the counter
 * permanently above zero — which would silently disable next-edit for the rest of the
 * session, in a way nobody would connect to a failed file write an hour earlier.
 */
export async function asAgentEdit<T>(work: () => Promise<T>): Promise<T> {
    depth++;
    try {
        return await work();
    } finally {
        depth--;
    }
}

/**
 * How long an edit still counts as the agent's after the write returns.
 *
 * The write completes before VS Code notices the file changed and reloads the open
 * document, so the change event arrives *after* the counter would already be back to
 * zero. This grace period covers that gap. It is short enough that a developer typing
 * immediately after an agent run is not ignored, and long enough to cover a filesystem
 * watcher round trip.
 */
export const AGENT_EDIT_GRACE_MS = 1_500;

let lastAgentWriteAt = 0;

export function markAgentWrite(now = Date.now()): void {
    lastAgentWriteAt = now;
}

export function withinAgentEditGrace(now = Date.now()): boolean {
    return now - lastAgentWriteAt < AGENT_EDIT_GRACE_MS;
}

/** Test seam: reset the module state between cases. */
export function resetEditOrigin(): void {
    depth = 0;
    lastAgentWriteAt = 0;
}
