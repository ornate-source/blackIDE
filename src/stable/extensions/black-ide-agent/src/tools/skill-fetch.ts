// ─── Remote skill-pack fetch (Phase 10, M60) ────────────────────────────────
//
// `core/skill-registry.ts` shipped the whole decision surface — pinned refs, checksums,
// the forbidden-key deny list, the install path — and nothing that fetches. So the
// enforcement was real and unreachable: `black-ide.addSkillFrom` did not exist, and the
// registry could only describe packs nobody could install.
//
// This is the transport, kept in `tools/` and deliberately thin. Every decision stays in
// the pure module, because the decisions are the security and they should be testable
// without a network or a git binary. What is here is the part that cannot be pure, plus
// the four things a subprocess needs in order not to become the hole:
//
//   1. **argv, never a shell string.** `execFile`, so a ref containing `;` is a ref.
//   2. **https only**, enforced by `validateSource` *before* git sees the URL — git's
//      `ext::` transport runs a command, and no checksum can undo code that already ran.
//   3. **no prompting.** `GIT_TERMINAL_PROMPT=0` and a no-op askpass: a clone that stops
//      to ask for a password does not fail, it hangs, and a hung install with a progress
//      notification looks like a slow network for as long as the user is willing to wait.
//   4. **no hooks, no config from the fetched tree.** A repository can ship
//      `.git/hooks/*` and `core.fsmonitor`; `--template=` with an empty dir and
//      `core.hooksPath` pointed at nothing means a fetch cannot run anything.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import {
    InstallVerdict, RegistryEntry, admitPack, installPathFor, validateRef, validateSource,
} from '../core/skill-registry';

/** A SKILL.md larger than this is not a skill pack. */
export const MAX_PACK_BYTES = 512 * 1024;

export const FETCH_TIMEOUT_MS = 60_000;

export function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Minimal frontmatter parse — enough to run the forbidden-key check against. */
export function readFrontmatter(content: string): Record<string, unknown> {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (!match) return {};
    const out: Record<string, unknown> = {};
    for (const line of match[1].split(/\r?\n/)) {
        // Only the key matters here: `admitPack` rejects on the key's *presence*, so a
        // value this simple parser gets wrong cannot weaken the check. Deliberately not
        // js-yaml — a pack that parses differently here than in the loader would be a way
        // to smuggle a key past the deny list.
        const key = /^([A-Za-z0-9_.\- ]+)\s*:/.exec(line)?.[1];
        if (key) out[key.trim()] = true;
    }
    return out;
}

function git(args: string[], cwd: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    return new Promise(resolve => {
        execFile('git', args, {
            cwd,
            timeout: FETCH_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0',
                GIT_ASKPASS: 'true',
                SSH_ASKPASS: 'true',
                GIT_CONFIG_NOSYSTEM: '1',
                // A fetch must not read the *user's* git config either: an `insteadOf`
                // rewrite there could redirect an https URL onto a transport this module
                // just refused, which would make the scheme check advisory.
                HOME: cwd,
                XDG_CONFIG_HOME: cwd,
            },
        }, (err, stdout, stderr) => {
            if (err) resolve({ ok: false, error: String(stderr || err.message).trim().split('\n').slice(-3).join(' ') });
            else resolve({ ok: true, stdout: String(stdout) });
        });
    });
}

export type FetchOutcome =
    | { ok: true; content: string }
    | { ok: false; error: string };

/**
 * Fetch one pack's SKILL.md at a pinned ref. Returns the text; writes nothing.
 *
 * Separated from installation so the checksum and the deny list are applied to a value in
 * memory. A fetch that wrote to the workspace first and validated afterwards would leave a
 * rejected pack on disk in the window between, and "we delete it again" is not the same
 * property as "it was never written".
 */
export async function fetchPack(entry: RegistryEntry, subPath = 'SKILL.md'): Promise<FetchOutcome> {
    const sourceCheck = validateSource(entry.source);
    if (!sourceCheck.ok) return { ok: false, error: sourceCheck.error };
    const refCheck = validateRef(entry.ref);
    if (!refCheck.ok) return { ok: false, error: refCheck.error };
    if (subPath.includes('..') || path.isAbsolute(subPath)) {
        return { ok: false, error: `"${subPath}" is not a path inside the pack.` };
    }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-pack-'));
    const empty = path.join(work, 'no-templates');
    fs.mkdirSync(empty, { recursive: true });
    try {
        const init = await git(['init', '--quiet', `--template=${empty}`, '-c', 'core.hooksPath=', 'repo'], work);
        if (!init.ok) return { ok: false, error: `git is unavailable: ${init.error}` };
        const repo = path.join(work, 'repo');

        const add = await git(['remote', 'add', 'origin', entry.source], repo);
        if (!add.ok) return { ok: false, error: add.error };

        // `--depth 1` of one ref: a tag or a SHA, never a branch tip, because
        // `validateRef` already refused the refs that move.
        const fetched = await git(['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
            'fetch', '--depth', '1', '--no-tags', 'origin', entry.ref], repo);
        if (!fetched.ok) {
            return { ok: false, error: `Could not fetch "${entry.ref}" from ${entry.source}: ${fetched.error}` };
        }

        const shown = await git(['show', `FETCH_HEAD:${subPath}`], repo);
        if (!shown.ok) {
            return { ok: false, error: `${entry.source} at ${entry.ref} has no ${subPath}: ${shown.error}` };
        }
        if (Buffer.byteLength(shown.stdout, 'utf8') > MAX_PACK_BYTES) {
            return { ok: false, error: `${subPath} is larger than ${Math.round(MAX_PACK_BYTES / 1024)} KB, which is not a skill pack.` };
        }
        return { ok: true, content: shown.stdout };
    } finally {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp dir */ }
    }
}

export type InstallOutcome =
    | { ok: true; name: string; path: string }
    | { ok: false; error: string; kind: 'checksum' | 'forbidden' | 'invalid' | 'fetch' | 'exists' };

/**
 * Fetch, admit, and only then write.
 *
 * `overwrite` defaults to false for the same reason `installSkillPacks` does: a pack the
 * user has edited is theirs, and re-running an install is not consent to lose those edits.
 */
export async function installPackFrom(
    entry: RegistryEntry,
    workspaceRoot: string,
    options: { overwrite?: boolean; fetch?: typeof fetchPack } = {},
): Promise<InstallOutcome> {
    const relative = installPathFor(entry.name);
    const target = path.join(workspaceRoot, relative);
    if (fs.existsSync(target) && !options.overwrite) {
        return { ok: false, kind: 'exists', error: `${relative} already exists. Nothing was fetched.` };
    }

    const fetched = await (options.fetch || fetchPack)(entry);
    if (!fetched.ok) return { ok: false, kind: 'fetch', error: fetched.error };

    const verdict: InstallVerdict = admitPack(entry, fetched.content, readFrontmatter(fetched.content), sha256);
    if (!verdict.ok) return { ok: false, kind: verdict.kind, error: verdict.error };

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fetched.content, 'utf8');
    return { ok: true, name: entry.name, path: relative };
}
