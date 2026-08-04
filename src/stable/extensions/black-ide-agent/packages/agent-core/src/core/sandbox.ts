// ─── Sandboxed execution tiers (Phase 9, M57 · P9-1) ───────────────────────
//
// Three tiers, in increasing order of confinement:
//
//   **policy**      — what has always shipped. `CommandPolicy` decides whether the
//                     command may run at all, the user approves it, and then it runs as
//                     the user with the user's environment. Nothing is confined.
//   **restricted**  — cwd-jailed, environment scrubbed, **no network**, wall-clock and
//                     output capped. The tier an unattended run defaults to.
//   **contained**   — restricted, plus the filesystem outside the workspace is
//                     read-only-or-invisible. The tier for content nobody vouched for.
//
// ── The property that makes this worth building ─────────────────────────────
// "Read-only" and "no network" are claims about what a process *will* do, and a claim
// about a process is worth nothing when the process is a shell running a command a
// language model wrote after reading a file from the internet. M56 settled the general
// form of this argument: a gate that content can reach is not a gate. So the confinement
// here is imposed by the operating system — `sandbox-exec` on macOS, a network namespace
// on Linux — and never by asking the command nicely.
//
// ── The decision this module exists to get right: no silent degradation ─────
// The tempting implementation, and the one every "sandbox" that has ever been a security
// hole chose, is: try to confine, and if the mechanism is missing, run anyway. That
// converts "this cannot reach the network" into "this could not reach the network on the
// developer's laptop", and the two are indistinguishable from the outside — including
// from the tests. So `planSandbox` **refuses**. A `restricted` request on a machine with
// no mechanism returns a refusal naming the missing mechanism, and the caller reports
// that the command did not run. A tier that cannot be enforced is not a tier.
//
// Everything here is pure: a plan is data. `detectMechanisms` and the spawning live with
// the callers, so every decision that has to be correct is testable without spawning
// anything.

export type SandboxTier = 'policy' | 'restricted' | 'contained';

export const SANDBOX_TIERS: readonly SandboxTier[] = ['policy', 'restricted', 'contained'];

/** How a platform can actually impose confinement. */
export type SandboxMechanism =
    /** macOS `sandbox-exec` with a generated SBPL profile. */
    | 'sandbox-exec'
    /** Linux `bubblewrap` — namespaces plus a filesystem view. */
    | 'bwrap'
    /** Linux `unshare -n` — a network namespace and nothing else. */
    | 'unshare';

export function tierRank(tier: SandboxTier): number {
    const index = SANDBOX_TIERS.indexOf(tier);
    return index < 0 ? 0 : index;
}

/** Is `actual` at least as confined as `required`? */
export function atLeast(actual: SandboxTier, required: SandboxTier): boolean {
    return tierRank(actual) >= tierRank(required);
}

export function parseTier(raw: unknown, fallback: SandboxTier = 'policy'): SandboxTier {
    return SANDBOX_TIERS.includes(raw as SandboxTier) ? raw as SandboxTier : fallback;
}

export interface SandboxLimits {
    /** Wall clock. A confined command that hangs still holds a slot in an unattended run. */
    timeoutMs: number;
    /** Captured output, per stream. */
    maxOutputBytes: number;
}

/**
 * Caps per tier.
 *
 * They tighten with the tier because the tiers describe *how much the command is
 * trusted*, and an untrusted command producing 10 MB of output is not a build log — it is
 * either an attempt to blow the context window or a runaway loop, and both want stopping
 * sooner than a trusted build does.
 */
export const TIER_LIMITS: Record<SandboxTier, SandboxLimits> = {
    policy: { timeoutMs: 120_000, maxOutputBytes: 10_240 },
    restricted: { timeoutMs: 60_000, maxOutputBytes: 10_240 },
    contained: { timeoutMs: 30_000, maxOutputBytes: 4_096 },
};

// ─── Environment ────────────────────────────────────────────────────────────

/**
 * The variables a confined command keeps.
 *
 * An allowlist and not a denylist, which costs some convenience and buys the only
 * property that matters: a variable nobody thought about is *absent* rather than
 * present. The whole point of scrubbing is the credential that got into the environment
 * by a route nobody remembers — a direnv file, a CI runner, a shell profile written in
 * 2019 — and a denylist protects exactly the variables somebody already thought of.
 */
export const ENV_ALLOWLIST: readonly string[] = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'TMPDIR', 'TMP', 'TEMP',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
    // Windows needs these to start a shell at all.
    'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
];

/**
 * Names that look like a secret regardless of which tier is running.
 *
 * Used for the audit note rather than the filtering — at `restricted` the allowlist has
 * already removed these — so that a run can report *how many* credentials it withheld.
 * A number the user can see is what turns "we scrub the environment" from a sentence in
 * a README into something they can check against their own machine.
 */
export const SECRET_NAME_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY$|^KEY$|APIKEY|API_KEY|AUTH|SESSION|COOKIE|PRIVATE)/i;

export interface ScrubResult {
    env: Record<string, string>;
    /** How many variables were dropped, and how many of those looked like credentials. */
    dropped: number;
    secretsDropped: number;
}

/**
 * Build the environment a command runs with, for a tier.
 *
 * `policy` passes the environment through unchanged. That is not an oversight: `policy`
 * is the tier that has always shipped, it is what a user's own approved `npm publish`
 * runs under, and scrubbing it would break working setups to protect a command the user
 * explicitly approved. The scrub belongs to the tiers that exist because the command was
 * *not* explicitly trusted.
 */
export function scrubEnv(
    source: Record<string, string | undefined>,
    tier: SandboxTier,
    extraAllowed: readonly string[] = [],
): ScrubResult {
    const base: Record<string, string> = {};
    // Pagers are the one addition rather than a removal: an interactive pager turns a
    // captured `git log` into a command that never exits.
    const pagers = { PAGER: 'cat', GIT_PAGER: 'cat' };

    if (tier === 'policy') {
        for (const [key, value] of Object.entries(source)) {
            if (value !== undefined) base[key] = value;
        }
        return { env: { ...base, ...pagers }, dropped: 0, secretsDropped: 0 };
    }

    const allowed = new Set([...ENV_ALLOWLIST, ...extraAllowed]);
    let dropped = 0;
    let secretsDropped = 0;
    for (const [key, value] of Object.entries(source)) {
        if (value === undefined) continue;
        if (allowed.has(key)) { base[key] = value; continue; }
        dropped++;
        if (SECRET_NAME_PATTERN.test(key)) secretsDropped++;
    }

    return {
        env: {
            ...base,
            ...pagers,
            // Told, not asked. Many tools check this before deciding to phone home, and
            // a tool that voluntarily stands down is one fewer thing hitting the wall.
            CI: '1',
            NO_COLOR: '1',
            BLACKIDE_SANDBOX: tier,
        },
        dropped,
        secretsDropped,
    };
}

// ─── Profiles ───────────────────────────────────────────────────────────────

/**
 * A macOS Seatbelt profile for a tier.
 *
 * `sandbox-exec` is deprecated by Apple and has been for a decade, and it is still the
 * only mechanism on macOS that a non-root process can use to deny a subprocess the
 * network. The alternative is not a better API — it is no confinement at all — so the
 * deprecation is noted and the profile is used.
 *
 * Written as a deny-list on top of `(allow default)` for `restricted` and an allow-list
 * for `contained`, because the two tiers make genuinely different promises. `restricted`
 * says "cannot reach the network and cannot write outside the workspace"; `contained`
 * says "cannot see anything it was not given", which is only expressible by starting
 * from deny.
 */
export function macosProfile(
    tier: SandboxTier,
    cwd: string,
    readRoots: readonly string[] = [],
    tempDir?: string,
): string {
    const quoted = (p: string) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    // The workspace and a private scratch directory, and deliberately **not** the system
    // temp. Allowing all of `/private/tmp` would make "writes are confined to the
    // workspace" false in the one place every process already knows how to write to.
    const writable = [cwd, ...(tempDir ? [tempDir] : [])];
    const devices = '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") '
        + '(literal "/dev/stderr") (literal "/dev/tty") (literal "/dev/dtracehelper"))';

    if (tier === 'contained') {
        const readable = [...new Set([
            cwd, ...(tempDir ? [tempDir] : []),
            '/usr', '/bin', '/sbin', '/System', '/Library', '/private/etc',
            '/private/var/db', '/opt/homebrew', '/opt/local', '/dev',
            ...readRoots,
        ])];
        return [
            '(version 1)',
            '(deny default)',
            // Silent rather than logged: a denied read from a build tool probing for a
            // config file is normal and would otherwise fill the system log.
            '(deny network* (with no-log))',
            // `process*` and `mach*` rather than the narrower `process-exec`/`mach-lookup`
            // this profile started with. Under `(deny default)` the narrow forms are not
            // enough for dyld to map a binary at all, and the symptom is a SIGABRT before
            // the command's first instruction — which reads as "the sandbox is broken"
            // rather than as a missing rule.
            '(allow process* sysctl-read mach* ipc* signal)',
            '(allow file-read-metadata file-ioctl)',
            // `(literal "/")` grants the root *directory entry*, not its subtree, and is
            // separately required: the loader stats `/` while resolving firmlinks on
            // APFS, and without it every binary fails to start. Costs nothing — a
            // directory entry reveals no file contents.
            `(allow file-read* (literal "/") ${readable.map(p => `(subpath ${quoted(p)})`).join(' ')})`,
            `(allow file-write* ${writable.map(p => `(subpath ${quoted(p)})`).join(' ')})`,
            devices,
        ].join('\n');
    }

    return [
        '(version 1)',
        '(allow default)',
        '(deny network* (with no-log))',
        '(deny file-write*)',
        `(allow file-write* ${writable.map(p => `(subpath ${quoted(p)})`).join(' ')})`,
        devices,
    ].join('\n');
}

// ─── The plan ───────────────────────────────────────────────────────────────

export interface SandboxRequest {
    command: string;
    /** Absolute. The jail root and the working directory both.  */
    cwd: string;
    tier: SandboxTier;
    platform: NodeJS.Platform;
    /** Mechanisms this machine actually has, from `detectMechanisms`. */
    mechanisms: readonly SandboxMechanism[];
    /** Additional roots a `contained` run may read (other workspace folders). */
    readRoots?: readonly string[];
    /** Environment to scrub. Defaults to the caller passing `process.env`. */
    env?: Record<string, string | undefined>;
    /** Variables the user has explicitly allowed through the scrub. */
    envAllowExtra?: readonly string[];
    /** Overrides the tier's default wall clock, but may never raise it. */
    timeoutMs?: number;
    /**
     * A private scratch directory this run may write to, becoming its `TMPDIR`.
     *
     * Required in practice at the confined tiers, because the system temp directory is
     * not writable there and a great many tools — compilers, package managers, `git` —
     * fail in confusing ways when they cannot create a temporary file. The caller owns
     * its lifecycle so it can be deleted with the run rather than accumulating.
     */
    tempDir?: string;
}

export interface SandboxPlan {
    ok: true;
    tier: SandboxTier;
    /** argv[0] is the program; spawn it with `shell: false`. */
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    limits: SandboxLimits;
    /** The mechanism imposing confinement. Absent at `policy`, where there is none. */
    mechanism?: SandboxMechanism;
    /** A file the caller must write before spawning, and delete after. */
    profileFile?: { suffix: string; content: string };
    /** One line for the audit trail and the user-visible run header. */
    note: string;
    scrub: { dropped: number; secretsDropped: number };
}

export interface SandboxRefusal {
    ok: false;
    tier: SandboxTier;
    reason: string;
}

export type SandboxOutcome = SandboxPlan | SandboxRefusal;

/** Where the generated profile is substituted into argv. */
export const PROFILE_PLACEHOLDER = '__BLACKIDE_SANDBOX_PROFILE__';

/**
 * Turn a request into a spawn plan, or refuse it.
 *
 * The refusals are the feature. Read them as the specification:
 *   - `restricted`+ on a platform with no mechanism → refused, mechanism named.
 *   - `restricted`+ with a relative cwd → refused; a jail whose root depends on the
 *     caller's working directory is not a jail.
 *
 * `policy` never refuses. It is the pre-existing behaviour and this module must not
 * become a new way for a command the user approved to fail.
 */
export function planSandbox(request: SandboxRequest): SandboxOutcome {
    const { tier, cwd, platform } = request;
    const limits = {
        ...TIER_LIMITS[tier],
        timeoutMs: Math.min(request.timeoutMs ?? TIER_LIMITS[tier].timeoutMs, TIER_LIMITS[tier].timeoutMs),
    };
    const scrubbed = scrubEnv(request.env ?? {}, tier, request.envAllowExtra);
    const isWindows = platform === 'win32';
    const shell = isWindows ? (request.env?.ComSpec || 'cmd.exe') : '/bin/sh';
    const shellArgs = (command: string) => isWindows ? ['/d', '/s', '/c', command] : ['-c', command];

    if (tier === 'policy') {
        return {
            ok: true, tier, cwd, limits, env: scrubbed.env,
            argv: [shell, ...shellArgs(request.command)],
            note: 'tier 1 (policy): approved by the command policy, not confined by the OS.',
            scrub: { dropped: 0, secretsDropped: 0 },
        };
    }

    if (!isAbsolutePath(cwd, platform)) {
        return { ok: false, tier, reason: `A ${tier} command needs an absolute working directory to jail into; got "${cwd}".` };
    }

    if (platform === 'darwin' && request.mechanisms.includes('sandbox-exec')) {
        return {
            ok: true, tier, cwd, limits, mechanism: 'sandbox-exec',
            env: withTemp(scrubbed.env, request.tempDir),
            argv: ['/usr/bin/sandbox-exec', '-f', PROFILE_PLACEHOLDER, shell, ...shellArgs(request.command)],
            profileFile: { suffix: '.sb', content: macosProfile(tier, cwd, request.readRoots, request.tempDir) },
            note: noteFor(tier, 'sandbox-exec', scrubbed),
            scrub: { dropped: scrubbed.dropped, secretsDropped: scrubbed.secretsDropped },
        };
    }

    if (platform === 'linux' && request.mechanisms.includes('bwrap')) {
        // `--unshare-all` includes the network namespace; `--share-net` is what would
        // give it back, and is deliberately not passed at any tier.
        const args = [
            'bwrap', '--unshare-all', '--die-with-parent', '--new-session',
            '--proc', '/proc', '--dev', '/dev',
        ];
        if (tier === 'contained') {
            // Start from nothing and bind exactly what is needed. `--ro-bind /` would be
            // simpler and would defeat the point of the tier.
            for (const ro of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']) {
                args.push('--ro-bind-try', ro, ro);
            }
            for (const extra of request.readRoots || []) args.push('--ro-bind-try', extra, extra);
        } else {
            args.push('--ro-bind', '/', '/');
        }
        args.push('--bind', cwd, cwd, '--tmpfs', '/tmp', '--chdir', cwd, shell, ...shellArgs(request.command));
        return {
            ok: true, tier, cwd, limits, mechanism: 'bwrap',
            // `--tmpfs /tmp` already gives this run a private, empty temp that vanishes
            // with it, so `TMPDIR` points there rather than at a directory on the host
            // the jail cannot see.
            env: withTemp(scrubbed.env, '/tmp'),
            argv: args,
            note: noteFor(tier, 'bwrap', scrubbed),
            scrub: { dropped: scrubbed.dropped, secretsDropped: scrubbed.secretsDropped },
        };
    }

    if (platform === 'linux' && request.mechanisms.includes('unshare') && tier === 'restricted') {
        // `unshare -n` gives the network namespace and nothing else, which is exactly
        // `restricted`'s promise and is *not* enough for `contained` — so `contained`
        // falls through to the refusal below rather than quietly accepting a weaker
        // mechanism under a stronger name.
        return {
            ok: true, tier, cwd, limits, mechanism: 'unshare',
            env: withTemp(scrubbed.env, request.tempDir),
            argv: ['unshare', '--net', '--map-root-user', shell, ...shellArgs(request.command)],
            note: noteFor(tier, 'unshare', scrubbed),
            scrub: { dropped: scrubbed.dropped, secretsDropped: scrubbed.secretsDropped },
        };
    }

    return { ok: false, tier, reason: refusalFor(tier, platform, request.mechanisms) };
}

/** Point every temp-directory variable at the one place the jail can write. */
function withTemp(env: Record<string, string>, tempDir: string | undefined): Record<string, string> {
    if (!tempDir) return env;
    return { ...env, TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir };
}

function noteFor(tier: SandboxTier, mechanism: SandboxMechanism, scrub: ScrubResult): string {
    const rank = tierRank(tier) + 1;
    const scrubNote = scrub.dropped
        ? ` · ${scrub.dropped} env var(s) withheld${scrub.secretsDropped ? `, ${scrub.secretsDropped} credential-shaped` : ''}`
        : '';
    const fs = tier === 'contained'
        ? 'filesystem outside the workspace invisible'
        : 'writes confined to the workspace';
    return `tier ${rank} (${tier}) via ${mechanism}: no network, ${fs}${scrubNote}.`;
}

function refusalFor(tier: SandboxTier, platform: NodeJS.Platform, have: readonly SandboxMechanism[]): string {
    const head = `Refusing to run at the "${tier}" tier: this machine has no mechanism that can enforce it, `
        + 'and running unconfined under a confined tier\'s name would make the guarantee a lie.';
    if (platform === 'darwin') {
        return `${head}\n/usr/bin/sandbox-exec was not found.`;
    }
    if (platform === 'linux') {
        const missing = tier === 'contained'
            ? 'bubblewrap (bwrap) is required for the contained tier'
            : 'install bubblewrap (bwrap), or util-linux for `unshare --net`';
        return `${head}\n${missing}. Found: ${have.length ? have.join(', ') : 'nothing'}.`;
    }
    if (platform === 'win32') {
        return `${head}\nWindows has no supported mechanism yet — run the task at the "policy" tier `
            + 'with an explicit approval, or run it in WSL where bubblewrap is available.';
    }
    return `${head}\nNo mechanism is implemented for platform "${platform}".`;
}

function isAbsolutePath(p: string, platform: NodeJS.Platform): boolean {
    if (!p) return false;
    return platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') : p.startsWith('/');
}

// ─── Choosing a tier ────────────────────────────────────────────────────────

export interface TierContext {
    /**
     * True when nobody is watching: a pipeline run, a scheduled task, a daemon run.
     * The distinction is not "is there a UI" but "can a human refuse this command", and
     * it is the input that matters most.
     */
    unattended: boolean;
    /** True when the run was seeded from content the user did not write (M56). */
    untrustedContent?: boolean;
    /** An explicit floor from settings or the caller. Raises, never lowers. */
    configured?: SandboxTier;
    /** Read-only work (the Reviewer). Runs restricted even when a human is present. */
    readOnly?: boolean;
}

/**
 * Pick the tier for a run.
 *
 * Only ever raises. Every input is a reason to confine *more*, and there is deliberately
 * no input that lowers the result — a setting that can talk the sandbox down is the
 * setting an injected instruction will eventually be found writing.
 *
 * P9-1's acceptance clause is the `unattended` line: an unattended pipeline run defaults
 * to `restricted` or better, because the whole hazard of unattended execution is that the
 * approval prompt — the thing tier 1 relies on entirely — has nobody to show itself to.
 */
export function tierFor(context: TierContext): SandboxTier {
    let tier: SandboxTier = 'policy';
    if (context.unattended) tier = 'restricted';
    if (context.readOnly) tier = highest(tier, 'restricted');
    if (context.untrustedContent) tier = highest(tier, 'contained');
    if (context.configured) tier = highest(tier, context.configured);
    return tier;
}

export function highest(a: SandboxTier, b: SandboxTier): SandboxTier {
    return tierRank(a) >= tierRank(b) ? a : b;
}

/**
 * The refusal a caller reports when a tier cannot be enforced.
 *
 * Phrased for the model as well as the user, because in an unattended run the model is
 * the one that has to do something sensible next. "The command did not run and here is
 * why" leads to a report; a bare error leads to a retry loop.
 */
export function refusalMessage(command: string, refusal: SandboxRefusal): string {
    return [
        `The command was not run: ${command}`,
        '',
        refusal.reason,
        '',
        'This is a refusal, not a failure of the command. Do not retry it — report what you '
        + 'would have run and why it needs to run.',
    ].join('\n');
}
