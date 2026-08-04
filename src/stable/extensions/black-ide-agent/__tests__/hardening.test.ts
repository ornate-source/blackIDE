import { describe, expect, it } from 'vitest';
import { WorkspaceRoot } from '@blackide/agent-core/core/workspace-roots';
import { collapse, guardPath } from '@blackide/agent-core/core/workspace-guard';
import { ToolBreaker } from '@blackide/agent-core/core/tool-breaker';

/**
 * Phase 9, M55 + M52 — the workspace boundary and tool circuit breakers.
 *
 * G7 has said "sandbox tests exist; **not centrally enforced or documented**" since rev 1.
 * The `test_sandbox_*.js` files it refers to are scratch scripts that print things, assert
 * nothing, and are run by nothing. This is the enforcement, and these are the tests.
 *
 * The escapes below are the three a `startsWith(root)` check admits, and each of them is a
 * bug that reads as correct: traversal (only visible after normalisation), prefix collision
 * (`/repo-backup` starts with `/repo`), and symlinks (not decidable by string comparison at
 * all).
 */

const roots: WorkspaceRoot[] = [
    { path: '/work/repo', name: 'repo' },
    { path: '/work/web', name: 'web' },
];

const allow = (p: string, opts = {}) => guardPath(p, roots, opts).verdict;

describe('the boundary holds against traversal', () => {
    it('allows an ordinary path inside a root', () => {
        const verdict = allow('/work/repo/src/index.ts');
        expect(verdict.allowed).toBe(true);
        if (verdict.allowed) expect(verdict.root.name).toBe('repo');
    });

    it('refuses a traversal that climbs out', () => {
        // Visible only after normalisation; a check on the raw string sees a plausible
        // prefix and allows it.
        expect(allow('/work/repo/../../etc/passwd').allowed).toBe(false);
        expect(allow('/work/repo/src/../../../etc/shadow').allowed).toBe(false);
    });

    it('allows a traversal that stays inside', () => {
        const verdict = allow('/work/repo/src/../lib/util.ts');
        expect(verdict.allowed).toBe(true);
        expect(verdict.path).toBe('/work/repo/lib/util.ts');
    });

    it('refuses a path outside every root', () => {
        expect(allow('/etc/passwd').allowed).toBe(false);
        expect(allow('/Users/someone/.ssh/id_rsa').allowed).toBe(false);
    });

    it('names the open folders in the refusal, so the model can correct itself', () => {
        const verdict = allow('/etc/passwd');
        if (verdict.allowed) throw new Error('should have refused');
        expect(verdict.reason).toContain('repo');
        expect(verdict.reason).toContain('web');
    });
});

describe('the boundary holds against prefix collision', () => {
    it('refuses a sibling directory whose name extends a root', () => {
        // `startsWith('/work/repo')` says yes. This is the same boundary problem M36 had
        // to solve, reusing that answer rather than growing a second, subtly different one.
        expect(allow('/work/repo-backup/secrets.env').allowed).toBe(false);
        expect(allow('/work/repository/x.ts').allowed).toBe(false);
    });

    it('still allows the root itself', () => {
        expect(allow('/work/repo').allowed).toBe(true);
    });

    it('attributes a file to the right root in a multi-root workspace', () => {
        const verdict = allow('/work/web/src/App.tsx');
        if (!verdict.allowed) throw new Error('should have allowed');
        expect(verdict.root.name).toBe('web');
    });
});

describe('the boundary and symlinks', () => {
    it('follows a link out of the workspace and refuses it', () => {
        const realpath = (p: string) => (p === '/work/repo/link' ? '/etc/passwd' : p);
        expect(allow('/work/repo/link', { realpath }).allowed).toBe(false);
    });

    it('reports that symlinks were not checked when no resolver is supplied', () => {
        // The guard says what it cannot see rather than implying completeness.
        expect(guardPath('/work/repo/a.ts', roots).symlinkChecked).toBe(false);
        expect(guardPath('/work/repo/a.ts', roots, { realpath: p => p }).symlinkChecked).toBe(true);
    });

    it('allows a path that does not exist yet, which is normal for a create', () => {
        const realpath = () => { throw new Error('ENOENT'); };
        const result = guardPath('/work/repo/new-file.ts', roots, { realpath });
        expect(result.verdict.allowed).toBe(true);
        expect(result.symlinkChecked).toBe(false);
    });

    it('still refuses a non-existent path outside the workspace', () => {
        const realpath = () => { throw new Error('ENOENT'); };
        expect(guardPath('/etc/new-file', roots, { realpath }).verdict.allowed).toBe(false);
    });
});

describe('protected paths inside the workspace', () => {
    it('refuses .git, which is an escape from every other control', () => {
        // An agent that can write `.git/config` can set `core.fsmonitor` to an arbitrary
        // command, and git will run it — past the command policy entirely.
        expect(allow('/work/repo/.git/config').allowed).toBe(false);
        expect(allow('/work/repo/.git/hooks/pre-commit').allowed).toBe(false);
    });

    it('refuses credential directories', () => {
        expect(allow('/work/repo/.ssh/id_rsa').allowed).toBe(false);
        expect(allow('/work/repo/.aws/credentials').allowed).toBe(false);
    });

    it('allows a file that merely mentions git in its name', () => {
        expect(allow('/work/repo/.gitignore').allowed).toBe(true);
        expect(allow('/work/repo/src/git-helpers.ts').allowed).toBe(true);
    });

    it('honours a user deny glob', () => {
        expect(allow('/work/repo/secrets/prod.env', { denyGlobs: ['secrets/**'] }).allowed).toBe(false);
        expect(allow('/work/repo/src/a.ts', { denyGlobs: ['secrets/**'] }).allowed).toBe(true);
    });

    it('ignores a malformed deny glob rather than refusing everything', () => {
        expect(allow('/work/repo/a.ts', { denyGlobs: ['['] }).allowed).toBe(true);
    });
});

describe('no workspace open', () => {
    it('refuses everything, with a reason that says why', () => {
        const verdict = guardPath('/anywhere/x.ts', []).verdict;
        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) expect(verdict.reason).toContain('No workspace folder is open');
    });

    it('refuses an empty path', () => {
        expect(guardPath('', roots).verdict.allowed).toBe(false);
    });
});

describe('collapse', () => {
    it('resolves . and ..', () => {
        expect(collapse('/a/b/../c/./d')).toBe('/a/c/d');
    });

    it('does not climb above an absolute root', () => {
        expect(collapse('/../../etc')).toBe('/etc');
    });

    it('keeps a leading .. on a relative path', () => {
        expect(collapse('../a/b')).toBe('../a/b');
    });

    it('handles a Windows drive prefix', () => {
        expect(collapse('C:/work/repo/../src')).toBe('C:/work/src');
    });

    it('does not re-base a relative path against the process cwd', () => {
        // `path.resolve` would, which is the silent re-basing this guard must not do.
        expect(collapse('src/a.ts')).toBe('src/a.ts');
    });
});

// ─── M52: circuit breakers ──────────────────────────────────────────────────

describe('tool circuit breakers', () => {
    it('trips after the threshold and stays tripped', () => {
        const breaker = new ToolBreaker({ threshold: 3 });
        expect(breaker.recordFailure('mcp_call')).toBeUndefined();
        expect(breaker.recordFailure('mcp_call')).toBeUndefined();

        const trip = breaker.recordFailure('mcp_call');
        expect(trip?.tool).toBe('mcp_call');
        expect(breaker.isUsable('mcp_call')).toBe(false);
        expect(breaker.isUsable('read_file')).toBe(true);
    });

    it('counts consecutive failures, not cumulative ones', () => {
        // A tool failing one call in ten is being used on awkward input, not broken; a
        // cumulative count would eventually disable every tool a long task touched.
        const breaker = new ToolBreaker({ threshold: 3 });
        breaker.recordFailure('grep_search');
        breaker.recordFailure('grep_search');
        breaker.recordSuccess('grep_search');
        breaker.recordFailure('grep_search');
        expect(breaker.isUsable('grep_search')).toBe(true);
    });

    it('trips on latency even when the call succeeds', () => {
        // A call that returns after four minutes is a failure from the run's point of
        // view — the budget it spent is gone either way.
        const breaker = new ToolBreaker({ threshold: 2, latencyBudgetMs: 60_000 });
        breaker.recordSuccess('run_command', 120_000);
        breaker.recordSuccess('run_command', 120_000);
        expect(breaker.isUsable('run_command')).toBe(false);
        expect(breaker.refusalFor('run_command')).toContain('over the 60s budget');
    });

    it('does not trip on a fast success', () => {
        const breaker = new ToolBreaker({ threshold: 1, latencyBudgetMs: 60_000 });
        breaker.recordSuccess('run_command', 500);
        expect(breaker.isUsable('run_command')).toBe(true);
    });

    it('gives the model a refusal it can act on', () => {
        const breaker = new ToolBreaker({ threshold: 1 });
        breaker.recordFailure('mcp_call', 'connection refused');
        const refusal = breaker.refusalFor('mcp_call')!;
        expect(refusal).toContain('connection refused');
        expect(refusal).toContain('disabled for the rest of this task');
        expect(refusal).toContain('different approach');
    });

    it('removes a tripped tool from the advertised list as well as refusing it', () => {
        // Both halves are needed — Phase 1's trap was a tool that was permitted but never
        // advertised; this is the mirror image, and advertising alone is a suggestion.
        const breaker = new ToolBreaker({ threshold: 1 });
        breaker.recordFailure('mcp_call');
        const tools = [{ name: 'read_file' }, { name: 'mcp_call' }];
        expect(breaker.filterAdvertised(tools).map(t => t.name)).toEqual(['read_file']);
    });

    it('reports its trips for the run log and the audit trail', () => {
        const breaker = new ToolBreaker({ threshold: 1, now: () => 1_234 });
        breaker.recordFailure('a');
        breaker.recordFailure('b');
        expect(breaker.trips().map(t => t.tool).sort()).toEqual(['a', 'b']);
        expect(breaker.trips()[0].at).toBe(1_234);
    });

    it('resets, so a fixed server can be retried in the next run', () => {
        const breaker = new ToolBreaker({ threshold: 1 });
        breaker.recordFailure('mcp_call');
        breaker.reset('mcp_call');
        expect(breaker.isUsable('mcp_call')).toBe(true);
    });

    it('treats a threshold below 1 as 1 rather than tripping on nothing', () => {
        const breaker = new ToolBreaker({ threshold: 0 });
        expect(breaker.isUsable('x')).toBe(true);
        breaker.recordFailure('x');
        expect(breaker.isUsable('x')).toBe(false);
    });
});
