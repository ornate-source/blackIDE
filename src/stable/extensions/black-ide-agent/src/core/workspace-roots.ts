import { ProjectProfile } from './project-profiler';

// ─── Multi-root workspaces (Phase 6, M36) ───────────────────────────────────
//
// Thirteen files reach for `vscode.workspace.workspaceFolders?.[0]`. In a single-root
// workspace that is correct and reads as harmless. In a two-root workspace — the Django
// API and the React app open side by side, which is the ordinary shape of a real
// project — it means every one of them silently answers questions about the *first*
// folder no matter which folder the question was about.
//
// The failure is not an error. It is worse than an error:
//   - the profiler detects `python, django` and injects Django skills while the agent
//     edits a React component, so the wrong idiom arrives with full confidence;
//   - `.blackide/rules/` is read from one root, so the other root's rules never fire;
//   - a relative path resolves against the wrong folder and either misses or, if both
//     roots happen to contain `src/index.ts`, edits the wrong file entirely.
//
// This module is the single answer to "which root is this about". Pure and vscode-free:
// the host supplies the folder list, everything else here is decidable without it, which
// is what makes the resolution rule testable at all.

export interface WorkspaceRoot {
    /** Absolute path, separators normalised. */
    path: string;
    /** Folder name, for the UI. */
    name: string;
}

/** Everything derived per-root. Populated lazily; a root with no signal simply has none. */
export interface RootContext extends WorkspaceRoot {
    profile?: ProjectProfile;
}

/** `C:\a\b` and `/a/b` both become forward-slashed and un-trailing-slashed. */
export function normalizeRoot(p: string): string {
    const forward = String(p || '').replace(/\\/g, '/');
    return forward.length > 1 ? forward.replace(/\/+$/, '') : forward;
}

/**
 * Which root owns `filePath`.
 *
 * **Longest prefix wins, and that is the whole correctness of this function.** VS Code
 * permits nested roots — opening a monorepo and one package inside it is a normal thing
 * to do — and with nesting, "the first root whose prefix matches" resolves every file in
 * `repo/packages/api/` to `repo/`. The package's own rules, profile and manifests are
 * then invisible, which looks exactly like them not existing. Sorting candidates by
 * length and taking the longest picks the most specific root, which is the one a human
 * means.
 *
 * Boundary-aware: `/repo/app` must not claim `/repo/application/x.ts`. A plain
 * `startsWith` does, and the resulting bug appears only in workspaces where one folder
 * name is a prefix of another — rare enough to survive review, common enough to happen.
 */
export function rootFor(filePath: string, roots: WorkspaceRoot[]): WorkspaceRoot | undefined {
    const target = normalizeRoot(filePath);
    let best: WorkspaceRoot | undefined;
    for (const root of roots) {
        const candidate = normalizeRoot(root.path);
        if (!isWithin(target, candidate)) continue;
        if (!best || candidate.length > normalizeRoot(best.path).length) best = root;
    }
    return best;
}

/** True when `target` is `candidate` itself or lives underneath it. */
export function isWithin(target: string, candidate: string): boolean {
    if (target === candidate) return true;
    return target.startsWith(candidate.endsWith('/') ? candidate : candidate + '/');
}

/**
 * Resolve a possibly-relative path against the right root.
 *
 * An absolute path is returned as-is; a relative one is joined to `preferred` when given,
 * and otherwise to the first root. The `preferred` argument is how an agent's declared
 * root reaches path resolution — without it, a task agent working in the React root would
 * resolve `src/App.tsx` against the Django root and create a file nobody asked for.
 */
export function resolveAgainstRoot(p: string, roots: WorkspaceRoot[], preferred?: string): string {
    const normalized = normalizeRoot(p);
    if (isAbsolute(normalized)) return normalized;
    const base = normalizeRoot(preferred || roots[0]?.path || '');
    if (!base) return normalized;
    return `${base}/${normalized.replace(/^\.\//, '')}`;
}

function isAbsolute(p: string): boolean {
    return p.startsWith('/') || /^[A-Za-z]:\//.test(p);
}

/** Path relative to its owning root, for display and for the code graph's keys. */
export function relativeToRoot(filePath: string, roots: WorkspaceRoot[]): { root?: WorkspaceRoot; relative: string } {
    const root = rootFor(filePath, roots);
    const target = normalizeRoot(filePath);
    if (!root) return { relative: target };
    const base = normalizeRoot(root.path);
    return { root, relative: target === base ? '' : target.slice(base.length + 1) };
}

/**
 * A stable, filesystem-safe id for a root, used to shard per-root state.
 *
 * The folder *name* is not enough: `api/` and `web/` are fine, but two roots both called
 * `src` are not, and two workspaces on the same machine with a `frontend` each would share
 * an index shard and quietly serve each other's files. The path is what is unique, so the
 * id is derived from it.
 */
export function rootId(rootPath: string): string {
    const normalized = normalizeRoot(rootPath);
    const name = normalized.slice(normalized.lastIndexOf('/') + 1).replace(/[^A-Za-z0-9._-]/g, '-') || 'root';
    return `${name}-${shortHash(normalized)}`;
}

/**
 * FNV-1a. Not cryptographic and does not need to be — it names a cache directory, and the
 * only property required is that two different paths rarely collide. Written out rather
 * than pulled from `crypto` so this module stays vscode- *and* node-free, which is what
 * lets the Phase 11 core carry it.
 */
function shortHash(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36).padStart(6, '0').slice(0, 8);
}

/**
 * Group paths by owning root, preserving order within each group.
 *
 * Used where an operation has to be *per root* rather than per file — building an index
 * shard, choosing which profile's skills to inject, deciding which repo a git command runs
 * in. Files under no root land in `orphans` rather than being silently attributed to the
 * first one, because "outside the workspace" is a real answer and the alternative is
 * running a git command in a repo the file has nothing to do with.
 */
export function groupByRoot(
    paths: string[],
    roots: WorkspaceRoot[],
): { byRoot: Map<string, string[]>; orphans: string[] } {
    const byRoot = new Map<string, string[]>();
    const orphans: string[] = [];
    for (const p of paths) {
        const root = rootFor(p, roots);
        if (!root) { orphans.push(p); continue; }
        const key = normalizeRoot(root.path);
        const list = byRoot.get(key);
        if (list) list.push(p); else byRoot.set(key, [p]);
    }
    return { byRoot, orphans };
}

/**
 * The root an agent should act on when the user did not say.
 *
 * Prefers the root of the file being looked at, because that is what "this project" means
 * to somebody with an editor open, and falls back to the first root. Explicitly *not*
 * silent: callers surface the choice, since an agent that picks a root without saying so
 * is the single-root assumption again with extra steps.
 */
export function defaultRootFor(activeFile: string | undefined, roots: WorkspaceRoot[]): WorkspaceRoot | undefined {
    if (activeFile) {
        const owner = rootFor(activeFile, roots);
        if (owner) return owner;
    }
    return roots[0];
}
