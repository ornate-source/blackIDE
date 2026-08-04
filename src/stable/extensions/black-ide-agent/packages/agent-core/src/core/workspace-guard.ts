import { WorkspaceRoot, isWithin, normalizeRoot } from './workspace-roots';

// ─── The workspace boundary (Phase 9, M55) ──────────────────────────────────
//
// G7 has read 🟡 with the same sentence since rev 1: "Sandbox tests exist
// (`test_sandbox_*.js`); **not centrally enforced or documented.**" Those files are
// scratch scripts — they print things and assert nothing, and nothing runs them. Meanwhile
// every file tool resolves its own paths, so "can the agent write outside the workspace"
// has as many answers as there are call sites.
//
// This is the one chokepoint. Every file tool asks it, it answers yes or no with a reason,
// and the reason is what the model sees — a refusal it can understand is a refusal it
// works around correctly, whereas an unexplained error is one it retries verbatim.
//
// ── The three escapes, and why a prefix check misses all of them ─────────────
// The obvious implementation is `resolved.startsWith(root)`. It admits:
//
//   1. **Traversal** — `../../etc/passwd` resolves outside, but only after normalisation.
//      A check performed on the *unresolved* string sees a relative path and allows it.
//   2. **Prefix collision** — `/repo-backup/secrets` starts with `/repo`. Boundary-aware
//      comparison is what `workspace-roots.ts` already had to solve for M36; this reuses it
//      rather than growing a second, subtly different copy.
//   3. **Symlinks** — a link inside the workspace pointing at `/etc`. This one cannot be
//      solved by string comparison at all: it needs the real path from the filesystem, so
//      the guard takes an optional resolver and says plainly what it cannot check without
//      one.

export type GuardVerdict =
    | { allowed: true; path: string; root: WorkspaceRoot }
    | { allowed: false; reason: string; path: string };

export interface GuardOptions {
    /**
     * Resolves symlinks. Injected because the pure guard must be testable without a
     * filesystem, and because the caller (the tool runner) already has `fs`.
     *
     * When absent the guard still catches traversal and prefix collisions — it simply
     * cannot see through a link, and `symlinkChecked` says so rather than implying a
     * completeness it does not have.
     */
    realpath?: (p: string) => string;
    /** Paths that are always refused even inside the workspace. */
    denyGlobs?: string[];
}

/**
 * Directories no agent should touch even inside the workspace.
 *
 * `.git` is the one that matters: an agent that can write `.git/config` can set
 * `core.fsmonitor` to an arbitrary command and has escaped every other control in this
 * codebase — the command policy included, because git will run it.
 */
const ALWAYS_DENY = [
    /(^|\/)\.git(\/|$)/,
    /(^|\/)\.ssh(\/|$)/,
    /(^|\/)\.aws(\/|$)/,
    /(^|\/)node_modules\/\.bin(\/|$)/,
];

export interface GuardResult {
    verdict: GuardVerdict;
    /** False when no resolver was supplied, so symlinks were not followed. */
    symlinkChecked: boolean;
}

/**
 * May a file tool touch this path?
 *
 * `resolve` must already have made the path absolute — the guard deliberately does not
 * join relative paths itself, because "relative to what" is a multi-root question
 * (`resolveAgainstRoot`, M36) and a guard that guessed a base would be authorising against
 * the wrong repository.
 */
export function guardPath(
    absolutePath: string,
    roots: WorkspaceRoot[],
    options: GuardOptions = {},
): GuardResult {
    const raw = normalizeRoot(absolutePath);
    if (!raw) {
        return { verdict: { allowed: false, reason: 'No path was given.', path: raw }, symlinkChecked: false };
    }

    // Normalise `..` before comparing. A check on the unresolved string sees a relative
    // segment and a plausible prefix, and allows an escape that resolution would expose.
    const normalized = collapse(raw);

    let effective = normalized;
    let symlinkChecked = false;
    if (options.realpath) {
        try {
            effective = normalizeRoot(options.realpath(normalized));
            symlinkChecked = true;
        } catch {
            // The path does not exist yet — normal for a create. Fall back to the literal
            // path, which is still boundary-checked; a file that cannot be resolved cannot
            // be a symlink to somewhere else either.
            effective = normalized;
            symlinkChecked = false;
        }
    }

    if (!roots.length) {
        return {
            verdict: { allowed: false, reason: 'No workspace folder is open, so there is nothing this tool may write to.', path: effective },
            symlinkChecked,
        };
    }

    const owner = roots.find(root => isWithin(effective, normalizeRoot(root.path)));
    if (!owner) {
        return {
            verdict: {
                allowed: false,
                path: effective,
                reason: `That path is outside the workspace (${roots.map(r => r.name).join(', ')}). `
                    + 'Tools may only read and write inside an open folder.',
            },
            symlinkChecked,
        };
    }

    const relative = effective.slice(normalizeRoot(owner.path).length + 1);
    for (const pattern of ALWAYS_DENY) {
        if (pattern.test(`/${relative}`)) {
            return {
                verdict: { allowed: false, path: effective, reason: `That path is protected (${relative.split('/')[0]}) and cannot be modified by a tool.` },
                symlinkChecked,
            };
        }
    }
    for (const glob of options.denyGlobs || []) {
        if (matchesGlob(relative, glob)) {
            return {
                verdict: { allowed: false, path: effective, reason: `That path is excluded by your deny list (${glob}).` },
                symlinkChecked,
            };
        }
    }

    return { verdict: { allowed: true, path: effective, root: owner }, symlinkChecked };
}

/**
 * Resolve `.` and `..` without touching the filesystem.
 *
 * Hand-written rather than `path.resolve` so this module stays node-free for the Phase 11
 * core, and because `path.resolve` would join against `process.cwd()` for a relative input
 * — which is precisely the silent re-basing this guard must not do.
 */
export function collapse(p: string): string {
    const absolute = /^([A-Za-z]:)?\//.test(p);
    const prefix = p.match(/^[A-Za-z]:/)?.[0] ?? '';
    const body = prefix ? p.slice(prefix.length) : p;

    const out: string[] = [];
    for (const segment of body.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            // A `..` that would climb above the root is dropped, matching POSIX: `/..` is
            // `/`. Keeping it would let a path escape by counting segments.
            if (out.length && out[out.length - 1] !== '..') out.pop();
            else if (!absolute) out.push('..');
            continue;
        }
        out.push(segment);
    }
    const joined = out.join('/');
    return prefix + (absolute ? `/${joined}` : joined);
}

/**
 * Minimal glob: `*` within a segment, `**` across segments.
 *
 * Built by scanning once rather than by substituting a sentinel and substituting it back.
 * The sentinel version is the obvious way to write this, and it is how a **literal NUL
 * byte reached this file** — the third occurrence in this codebase (Phase 3 shipped two in
 * source, rev 6 found one in the roadmap itself). Each time it was invisible in an editor
 * and made the file binary to `grep`. `__tests__/source-hygiene.test.ts` caught this one
 * within the same phase, which is the guard working as intended.
 *
 * A single pass has no sentinel to leak, so the bug class is removed rather than escaped.
 */
function matchesGlob(relative: string, glob: string): boolean {
    let pattern = '';
    for (let i = 0; i < glob.length; i++) {
        if (glob[i] === '*') {
            if (glob[i + 1] === '*') { pattern += '.*'; i++; } else { pattern += '[^/]*'; }
            continue;
        }
        pattern += glob[i].replace(/[.+^${}()|[\]\\?]/, '\\$&');
    }
    try {
        return new RegExp(`^${pattern}$`).test(relative);
    } catch {
        return false;
    }
}
