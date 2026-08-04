import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
    PROFILE_PLACEHOLDER, SandboxMechanism, SandboxOutcome, SandboxRequest, SandboxTier,
    planSandbox, refusalMessage,
} from './sandbox';

// ─── Running a sandbox plan (Phase 9, M57 · P9-1) ───────────────────────────
//
// `sandbox.ts` decides; this spawns. The split keeps every decision testable without a
// child process, and keeps this file small enough that its one job — do exactly what the
// plan said, and nothing else — is checkable by reading it.
//
// Two things here are worth defending.
//
// **Mechanism detection is cached per process, not per call.** A `restricted` command in
// a pipeline runs dozens of times; stat-ing `/usr/bin/sandbox-exec` before each is waste.
// The cache is invalidated by nothing, because a machine does not grow a sandbox
// mechanism mid-session, and a stale *negative* is the safe direction anyway: it refuses.
//
// **The profile file is written per run, into the OS temp directory, and deleted.** Not
// into the workspace: a `.sb` file appearing in someone's repo is a file they have to
// gitignore, and a `contained` run cannot see outside its jail to read one there anyway.

export interface SandboxRunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    /** The tier that actually ran, for the audit trail. */
    tier: SandboxTier;
    /** One line describing the confinement, for the run header. */
    note: string;
    /**
     * Set when the tier could not be enforced. The command **did not run**; callers must
     * report this rather than treating it as a non-zero exit.
     */
    refused?: string;
}

let cachedMechanisms: SandboxMechanism[] | undefined;

/**
 * What this machine can actually enforce.
 *
 * Presence on disk is the test, not a version check or a trial run. A trial run would be
 * more certain and would spawn a process on every extension start; presence is the check
 * that fails in the safe direction, because a `sandbox-exec` that exists and errors turns
 * into a non-zero exit the caller sees, not a command that silently ran unconfined.
 */
export function detectMechanisms(platform: NodeJS.Platform = process.platform): SandboxMechanism[] {
    if (cachedMechanisms) return cachedMechanisms;
    const found: SandboxMechanism[] = [];

    if (platform === 'darwin' && existsExecutable('/usr/bin/sandbox-exec')) {
        found.push('sandbox-exec');
    }
    if (platform === 'linux') {
        if (whichOnPath('bwrap')) found.push('bwrap');
        // `unshare --net` needs unprivileged user namespaces. The kernel switch that
        // disables them is the common case on hardened distributions, so it is checked
        // here rather than discovered as a confusing exit code later.
        if (whichOnPath('unshare') && unprivilegedUserNamespacesEnabled()) found.push('unshare');
    }

    cachedMechanisms = found;
    return found;
}

/** Test seam: forget what was detected. */
export function resetMechanismCache(): void {
    cachedMechanisms = undefined;
}

function existsExecutable(p: string): boolean {
    try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
    } catch { return false; }
}

function whichOnPath(program: string): boolean {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (dir && existsExecutable(path.join(dir, program))) return true;
    }
    return false;
}

/**
 * Resolve symlinks before the path reaches a profile.
 *
 * Not cosmetic, and it cost an afternoon to find. Seatbelt matches `subpath` rules
 * against the *resolved* path, and on macOS the system temp directory is
 * `/var/folders/…` symlinked to `/private/var/folders/…`. A profile granting write
 * access to the unresolved cwd therefore grants it to a path the kernel never sees, and
 * the sandbox denies every write inside the workspace it was supposed to permit — which
 * presents as "the build fails under tier 2" and looks like the confinement being too
 * strict rather than the path being wrong. bwrap's `--bind` has the same property for
 * the same reason.
 *
 * Falls back to the original path when the target does not exist yet: a missing cwd is
 * the caller's error to report, not this function's to mask.
 */
function realPath(p: string): string {
    try { return fs.realpathSync(p); } catch { return p; }
}

function unprivilegedUserNamespacesEnabled(): boolean {
    try {
        const value = fs.readFileSync('/proc/sys/kernel/unprivileged_userns_clone', 'utf8').trim();
        return value !== '0';
    } catch {
        // The file is absent on kernels where the feature is unconditionally on, which is
        // most of them. Absent means "no reason to think it is off".
        return true;
    }
}

export interface SandboxRunOptions extends Omit<SandboxRequest, 'mechanisms' | 'platform' | 'env'> {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
    onChunk?: (stream: 'stdout' | 'stderr', text: string) => void;
}

/**
 * Plan and run a command at a tier.
 *
 * Returns a refusal rather than throwing when the tier cannot be enforced, because every
 * caller has to render that refusal to somebody — a model, a log, a user — and an
 * exception would make each of them invent its own wording for the one message that has
 * to be unambiguous.
 */
export async function runSandboxed(options: SandboxRunOptions): Promise<SandboxRunResult> {
    const platform = options.platform ?? process.platform;
    const confined = options.tier !== 'policy';

    /*
     * The scratch directory a confined run writes temporary files into.
     *
     * Created before planning because the plan has to name it in the profile, and torn
     * down in the `finally` below so a run cannot leave one behind. Per-run rather than
     * shared: two concurrent agents sharing a temp directory is a way for one run's
     * half-written file to be read by another, and Phase 6 made four concurrent runs the
     * normal case.
     */
    const tempDir = confined
        ? realPath(fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-run-')))
        : undefined;

    const outcome: SandboxOutcome = planSandbox({
        command: options.command,
        cwd: realPath(options.cwd),
        tier: options.tier,
        platform,
        mechanisms: detectMechanisms(platform),
        readRoots: (options.readRoots || []).map(realPath),
        env: options.env ?? process.env,
        envAllowExtra: options.envAllowExtra,
        timeoutMs: options.timeoutMs,
        tempDir,
    });

    if (!outcome.ok) {
        if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* nothing there */ } }
        return {
            stdout: '', stderr: '', exitCode: 1, timedOut: false,
            tier: options.tier,
            note: `tier "${options.tier}" could not be enforced`,
            refused: refusalMessage(options.command, outcome),
        };
    }

    let profileDir: string | undefined;
    let argv = outcome.argv;
    if (outcome.profileFile) {
        profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-sandbox-'));
        const profilePath = path.join(profileDir, `profile${outcome.profileFile.suffix}`);
        fs.writeFileSync(profilePath, outcome.profileFile.content, 'utf8');
        argv = argv.map(arg => (arg === PROFILE_PLACEHOLDER ? profilePath : arg));
    }

    try {
        const result = await spawnCaptured(argv, {
            cwd: outcome.cwd,
            env: outcome.env,
            timeoutMs: outcome.limits.timeoutMs,
            maxOutputBytes: outcome.limits.maxOutputBytes,
            signal: options.signal,
            onChunk: options.onChunk,
            isWindows: platform === 'win32',
        });
        return { ...result, tier: outcome.tier, note: outcome.note };
    } finally {
        for (const dir of [profileDir, tempDir]) {
            if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } }
        }
    }
}

interface SpawnOptions {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
    onChunk?: (stream: 'stdout' | 'stderr', text: string) => void;
    isWindows: boolean;
}

/**
 * Spawn argv with no shell, capture both streams, kill the whole group on timeout.
 *
 * `shell: false` is not a detail. The plan's argv already contains the user's command as
 * a single `-c` argument; handing the whole argv to a second shell would re-interpret
 * that argument's metacharacters and, worse, would let a crafted command break out of the
 * `sandbox-exec` wrapper by ending the first command and starting another.
 */
function spawnCaptured(argv: string[], options: SpawnOptions): Promise<Omit<SandboxRunResult, 'tier' | 'note'>> {
    return new Promise(resolve => {
        const child = spawn(argv[0], argv.slice(1), {
            cwd: options.cwd,
            env: options.env,
            shell: false,
            detached: !options.isWindows,
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;

        const cap = (text: string) => text.length > options.maxOutputBytes
            ? `${text.slice(0, options.maxOutputBytes)}\n... (truncated, total ${text.length} chars)`
            : text;

        const finish = (code: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', kill);
            resolve({ stdout: cap(stdout), stderr: cap(stderr), exitCode: code ?? 1, timedOut });
        };

        const kill = () => {
            const pid = child.pid;
            if (options.isWindows) {
                if (pid) { try { spawn('taskkill', ['/F', '/T', '/PID', String(pid)]); } catch { /* gone */ } }
                try { child.kill('SIGKILL'); } catch { /* gone */ }
                return;
            }
            try { if (pid) process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
        };

        const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs);
        if (options.signal) {
            if (options.signal.aborted) kill();
            else options.signal.addEventListener('abort', kill);
        }

        child.stdout?.on('data', (data: Buffer) => {
            const text = data.toString();
            // Bounded in memory as well as in what is returned: a command emitting a
            // gigabyte should not be held in full just to be truncated at the end.
            if (stdout.length < options.maxOutputBytes * 4) stdout += text;
            try { options.onChunk?.('stdout', text); } catch { /* UI callback */ }
        });
        child.stderr?.on('data', (data: Buffer) => {
            const text = data.toString();
            if (stderr.length < options.maxOutputBytes * 4) stderr += text;
            try { options.onChunk?.('stderr', text); } catch { /* UI callback */ }
        });
        child.on('error', (error: Error) => {
            stderr += `\nCommand execution failed: ${error.message}`;
            finish(1);
        });
        child.on('close', (code: number | null) => finish(code));
    });
}
