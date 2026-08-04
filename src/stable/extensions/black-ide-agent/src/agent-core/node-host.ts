import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { runSandboxed } from '../core/sandbox-runner';
import {
    AgentHost, ApprovalRequest, HostFileSystem, HostNotifier, HostProcess, HostRoot,
    HostSecrets, HostStorage,
} from './host';

// ─── The Node host (Phase 11, M63) ──────────────────────────────────────────
//
// `AgentHost` implemented with nothing but Node. This is what makes the extraction real
// rather than nominal: if the core can run against this, it can run in a terminal, in CI,
// in a container and — Phase 12 — on somebody else's runner.
//
// It is also the *specification by example* of what the host interface costs to implement.
// An interface nobody has implemented twice is a guess; this is the second implementation,
// and every place it was awkward to write is a place the interface was shaped by the
// editor rather than by the problem.
//
// ── The security posture is different here, deliberately ────────────────────
// There is no user at a terminal in CI. So the defaults invert: approvals **deny** unless
// the caller opts in, and `exec` is denied even then unless explicitly allowed. G3 says
// auto-approve is "deliberately ignored in unattended pipeline runs"; making that a
// property of the host rather than a flag in the loop is what stops a future caller
// forgetting to set it.

export interface NodeHostOptions {
    /** The repository. Defaults to `process.cwd()`. */
    root?: string;
    /** Where caches and run state live. Defaults to `<root>/.blackIDE/cache`. */
    storagePath?: string;
    /**
     * Approval policy. `deny` is the default and the right one for CI.
     * `edits` allows file writes but never commands; `all` is for a human at a terminal.
     */
    approve?: 'deny' | 'edits' | 'all';
    /** Where log lines go. `process.stderr` by default, so stdout stays a clean event stream. */
    onLog?: (message: string) => void;
    /** Secrets. Defaults to `process.env`, which is how CI supplies them. */
    env?: Record<string, string | undefined>;
}

export function createNodeHost(options: NodeHostOptions = {}): AgentHost {
    const root = path.resolve(options.root || process.cwd());
    const storagePath = options.storagePath || path.join(root, '.blackIDE', 'cache');
    const env = options.env ?? process.env;
    const approve = options.approve ?? 'deny';
    const log = options.onLog ?? ((message: string) => process.stderr.write(`${message}\n`));

    const roots: HostRoot[] = [{ path: normalize(root), name: path.basename(root) }];

    return {
        roots,
        fs: nodeFileSystem(root),
        secrets: envSecrets(env),
        process: nodeProcess(),
        notifier: streamNotifier(log),
        storage: jsonStorage(storagePath),
        approval: {
            /*
             * A command is never auto-approved from the `edits` tier. The asymmetry is the
             * point: a file write is contained by the workspace guard (M55) and reversible
             * through git, while a command can reach the network, the filesystem outside
             * the repo, and the credentials in the environment it was handed.
             */
            request: async (request: ApprovalRequest) => {
                if (approve === 'all') return true;
                if (approve === 'edits') return request.kind !== 'exec';
                return false;
            },
        },
        // No `editor` capabilities: no diagnostics, no language server, no Problems panel.
        // That absence is the test of the boundary — the agent should be less informed
        // here, not broken.
    };
}

function nodeFileSystem(root: string): HostFileSystem {
    return {
        async read(target) { return fs.promises.readFile(target, 'utf8'); },
        async write(target, content) {
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            await fs.promises.writeFile(target, content, 'utf8');
        },
        async exists(target) {
            try { await fs.promises.access(target); return true; } catch { return false; }
        },
        async remove(target) {
            await fs.promises.rm(target, { recursive: true, force: true });
        },
        async list(target) {
            const entries = await fs.promises.readdir(target, { withFileTypes: true });
            return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
        },
        /**
         * A bounded walk.
         *
         * The editor implementation delegates to the editor's own index, which is why the
         * signature takes a limit rather than returning everything: this version has to
         * walk, and an unbounded walk of a monorepo from a CLI is a minute of stat calls
         * before the first token is spent.
         */
        async find(glob, opts = {}) {
            const limit = opts.limit ?? 4_000;
            const exclude = opts.exclude ? globToRegExp(opts.exclude) : DEFAULT_EXCLUDE;
            const match = globToRegExp(glob);
            const out: string[] = [];

            const walk = async (dir: string): Promise<void> => {
                if (out.length >= limit) return;
                let entries: fs.Dirent[];
                try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
                for (const entry of entries) {
                    if (out.length >= limit) return;
                    const full = path.join(dir, entry.name);
                    const rel = normalize(path.relative(root, full));
                    if (exclude.test(rel)) continue;
                    if (entry.isDirectory()) { await walk(full); continue; }
                    if (match.test(rel)) out.push(normalize(full));
                }
            };
            await walk(root);
            return out;
        },
        async realpath(target) { return normalize(await fs.promises.realpath(target)); },
    };
}

const DEFAULT_EXCLUDE = /(^|\/)(node_modules|\.git|dist|out|build|\.next|coverage|vendor|target|bin|obj)(\/|$)/;

/**
 * A glob to a regex. Minimal on purpose; the core's globs are simple.
 *
 * The example that belongs here cannot be written here: a doubled star followed by a slash
 * and a star closes a block comment, so spelling one out terminates the comment mid-word.
 * This is the same family as the NUL bytes this codebase has shipped three times — a
 * character that is invisible in an editor and changes what the file means.
 */
function globToRegExp(glob: string): RegExp {
    let pattern = '';
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob[i + 1] === '*') { pattern += '.*'; i++; if (glob[i + 1] === '/') i++; }
            else pattern += '[^/]*';
            continue;
        }
        if (ch === '{') {
            const close = glob.indexOf('}', i);
            if (close !== -1) {
                pattern += `(?:${glob.slice(i + 1, close).split(',').map(escapeLiteral).join('|')})`;
                i = close;
                continue;
            }
        }
        pattern += escapeLiteral(ch);
    }
    try { return new RegExp(`^${pattern}$`); } catch { return /$^/; }
}

function escapeLiteral(text: string): string {
    return text.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
}

/**
 * Secrets from the environment.
 *
 * Read-only in practice: `set` and `delete` mutate the in-process copy so a caller that
 * writes a key can read it back within the run, but nothing is persisted. Persisting a
 * credential to disk from a CLI would be a surprise, and CI supplies secrets through the
 * environment anyway.
 */
function envSecrets(env: Record<string, string | undefined>): HostSecrets {
    const overlay = new Map<string, string>();
    const key = (name: string) => `BLACKIDE_${name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
    return {
        async get(name) { return overlay.get(name) ?? env[key(name)] ?? env[name]; },
        async set(name, value) { overlay.set(name, value); },
        async delete(name) { overlay.delete(name); },
    };
}

function nodeProcess(): HostProcess {
    return {
        async run(command, options = {}) {
            /*
             * The confined path (M57).
             *
             * Delegated in full rather than partially reimplemented here. The comment
             * this replaces was right that half a containment is worse than none, and
             * the same argument applies to a second copy of it: `runSandboxed` owns the
             * profile, the env scrub, the private temp and the refusal, and this host
             * owns none of them.
             */
            if (options.sandbox && options.sandbox !== 'policy') {
                const result = await runSandboxed({
                    command,
                    cwd: options.cwd || process.cwd(),
                    tier: options.sandbox,
                    timeoutMs: options.timeoutMs,
                    signal: options.signal,
                    onChunk: options.onChunk,
                });
                return {
                    stdout: result.stdout, stderr: result.stderr,
                    exitCode: result.exitCode, timedOut: result.timedOut,
                    refused: result.refused,
                };
            }

            return new Promise((resolve) => {
                const child = spawn(command, {
                    shell: true,
                    cwd: options.cwd,
                    // Unscrubbed, and correctly so: this branch is the `policy` tier,
                    // where a human approved the command. Scrubbing here would break
                    // working setups to protect a command the user explicitly allowed.
                    env: process.env,
                });
                let stdout = '';
                let stderr = '';
                let timedOut = false;

                const timer = options.timeoutMs
                    ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs)
                    : undefined;
                const onAbort = () => child.kill('SIGKILL');
                options.signal?.addEventListener('abort', onAbort);

                child.stdout?.on('data', (d) => { const t = String(d); stdout += t; options.onChunk?.('stdout', t); });
                child.stderr?.on('data', (d) => { const t = String(d); stderr += t; options.onChunk?.('stderr', t); });
                child.on('close', (code) => {
                    if (timer) clearTimeout(timer);
                    options.signal?.removeEventListener('abort', onAbort);
                    resolve({ stdout, stderr, exitCode: code ?? 1, timedOut });
                });
                child.on('error', (err) => {
                    if (timer) clearTimeout(timer);
                    resolve({ stdout, stderr: `${stderr}${err.message}`, exitCode: 127 });
                });
            });
        },
    };
}

/** Log lines to stderr, so stdout can stay a machine-readable event stream. */
function streamNotifier(log: (message: string) => void): HostNotifier {
    return {
        info: (m) => log(m),
        warn: (m) => log(`warning: ${m}`),
        error: (m) => log(`error: ${m}`),
        log: (m) => log(m),
    };
}

function jsonStorage(dir: string): HostStorage {
    const file = path.join(dir, 'state.json');
    let cache: Record<string, unknown> | undefined;
    const load = () => {
        if (cache) return cache;
        try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cache = {}; }
        return cache!;
    };
    return {
        path: dir,
        get<T>(key: string) { return load()[key] as T | undefined; },
        async set<T>(key: string, value: T) {
            load()[key] = value;
            await fs.promises.mkdir(dir, { recursive: true });
            await fs.promises.writeFile(file, JSON.stringify(cache, null, 2), 'utf8');
        },
    };
}

function normalize(p: string): string {
    return p.replace(/\\/g, '/');
}
