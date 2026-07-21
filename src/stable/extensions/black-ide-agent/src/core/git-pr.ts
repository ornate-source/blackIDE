// ─── PR-Output Mode ──────────────────────────────────────────────────────────
// plan.md / competitive parity (Cursor background agents open PRs): a completed
// pipeline's work already lives on a git branch before reconciliation, so "open a PR"
// is just push + create, no extra diffing. This module builds the command sequence
// purely (no execution, no vscode) so it's fully unit-testable; the caller runs them
// through the existing ToolRunner under the git mutex.

/**
 * What a completed pipeline does with its work.
 * - `apply` (default): reconcile the delta onto the live working tree — the proven path.
 * - `pr`:              leave the work on its branch and open a pull request instead.
 */
export type OutputMode = 'apply' | 'pr';

/**
 * Resolve the effective output mode from a raw settings value. Anything unrecognised —
 * absent, misspelled, wrong type — resolves to `apply`, because the failure mode of
 * guessing wrong must be "the user's changes land as usual", never "the run silently did
 * not touch the workspace and the user cannot find their work". Pure.
 */
export function resolveOutputMode(raw: unknown): OutputMode {
    return String(raw ?? '').toLowerCase() === 'pr' ? 'pr' : 'apply';
}

export interface PrRequest {
    branch: string;
    title: string;
    body?: string;
    /** Base branch to target; default 'main'. */
    base?: string;
}

/** Shell-quote a value for safe single-argument use. Pure. */
export function shellQuote(v: string): string {
    return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds the ordered command list to publish a run's branch as a PR:
 *   1. push the branch to origin
 *   2. open the PR via the GitHub CLI (`gh`)
 * The caller checks `gh` availability and falls back to a compare URL (see
 * compareUrlFallback) when it's absent. Pure/exported for testing.
 */
export function buildPrCommands(req: PrRequest): string[] {
    const base = req.base || 'main';
    const push = `git push -u origin ${shellQuote(req.branch)}`;
    const create = [
        'gh pr create',
        `--head ${shellQuote(req.branch)}`,
        `--base ${shellQuote(base)}`,
        `--title ${shellQuote(req.title)}`,
        `--body ${shellQuote(req.body || '')}`,
    ].join(' ');
    return [push, create];
}

/**
 * A best-effort GitHub "compare" URL for manual PR creation when `gh` isn't installed.
 * Normalizes SSH and https remotes to the web form. Returns '' if the remote isn't a
 * recognizable GitHub URL. Pure/exported for testing.
 */
export function compareUrlFallback(remoteUrl: string, branch: string, base = 'main'): string {
    const m = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
    if (!m) return '';
    return `https://github.com/${m[1]}/${m[2]}/compare/${base}...${encodeURIComponent(branch)}?expand=1`;
}
