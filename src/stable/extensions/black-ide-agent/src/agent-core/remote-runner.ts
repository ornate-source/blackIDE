import { SandboxTier } from '../core/sandbox';
import { AgentHost, HostProcess } from './host';

// ─── Remote / BYO-runner execution (Phase 12, M66 · P12-3) ─────────────────
//
// Run the agent's *commands* on a machine that is not this one: a beefier box, a
// container, a CI worker. The acceptance clause is short and is the whole design —
// **"opt-in; we do not become a data processor by default."**
//
// ── What that clause rules out ─────────────────────────────────────────────
// It rules out us hosting anything. There is no Black IDE runner service in this module
// and there is deliberately no default endpoint: `RemoteRunnerConfig.url` has no
// fallback, so a user who has not configured a runner has no remote execution rather
// than remote execution pointed at us. "Bring your own" is not a pricing tier here, it is
// the only mode — the moment we operate the endpoint, the user's source code is flowing
// through our infrastructure and we are a data processor for every enterprise that
// installed this from the marketplace.
//
// ── The tier travels with the command, and a runner that ignores it is refused ──
// `HostProcess.run` takes a `sandbox` tier (M57). A remote runner that quietly ignored it
// would turn a local guarantee into a claim about somebody else's machine, and the core
// would have no way to tell. So the protocol carries the tier, the runner is required to
// echo back what it actually enforced, and a mismatch is a refusal — not a warning.
// A confinement claim nobody checks is a confinement claim nobody has.

export interface RemoteRunnerConfig {
    /**
     * The runner endpoint. No default, on purpose — see the module header.
     */
    url: string;
    /** Bearer token for the runner. The user's own runner, the user's own token. */
    token?: string;
    /** Wall clock for the whole request. */
    timeoutMs?: number;
}

export interface RemoteExecRequest {
    command: string;
    cwd: string;
    /** The tier the caller requires. The runner must enforce at least this. */
    sandbox: SandboxTier;
    timeoutMs: number;
}

export interface RemoteExecResponse {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
    /**
     * The tier the runner actually enforced.
     *
     * Required. A response without it is refused rather than assumed to have honoured
     * the request: "the field was missing so it probably did what we asked" is the
     * reasoning that makes the whole tier system decorative over a network.
     */
    enforced?: SandboxTier;
}

export type RemoteOutcome =
    | { ok: true; response: RemoteExecResponse }
    | { ok: false; reason: string };

const TIER_RANK: Record<SandboxTier, number> = { policy: 0, restricted: 1, contained: 2 };

/**
 * Validate a runner's answer before its output is handed to the model.
 *
 * Three refusals, each of which the obvious implementation gets wrong:
 *
 * 1. **No `enforced` field** — refused. Absence is not compliance.
 * 2. **A weaker tier than requested** — refused. This is the case the field exists for:
 *    a runner that ran a `contained` command at `policy` has given the caller output
 *    produced with the network open, and the caller asked for the opposite.
 * 3. **A malformed body** — refused. Output that is not a string is not output, and
 *    coercing it produces `[object Object]` in a model's context.
 */
export function validateRemoteResponse(
    request: RemoteExecRequest,
    body: unknown,
): RemoteOutcome {
    if (!body || typeof body !== 'object') {
        return { ok: false, reason: 'The runner returned something that was not a response object.' };
    }
    const json = body as Record<string, unknown>;

    if (typeof json.exitCode !== 'number') {
        return { ok: false, reason: 'The runner returned no exit code, so whether the command succeeded is unknown.' };
    }

    const enforced = json.enforced;
    if (enforced !== 'policy' && enforced !== 'restricted' && enforced !== 'contained') {
        return {
            ok: false,
            reason: `The runner did not say which sandbox tier it enforced. The command may have run `
                + `unconfined, so its output is not trusted. A runner must echo "enforced" — absence is not compliance.`,
        };
    }

    if (TIER_RANK[enforced] < TIER_RANK[request.sandbox]) {
        return {
            ok: false,
            reason: `The runner enforced "${enforced}" for a command that required "${request.sandbox}". `
                + 'The output was produced under weaker confinement than was asked for and is not trusted.',
        };
    }

    return {
        ok: true,
        response: {
            stdout: String(json.stdout ?? ''),
            stderr: String(json.stderr ?? ''),
            exitCode: json.exitCode,
            timedOut: json.timedOut === true,
            enforced,
        },
    };
}

/**
 * Validate the runner configuration.
 *
 * https-only except loopback, the same rule as MCP and the skill fetch — a runner
 * receives the user's source code and returns output the agent acts on, which is the
 * strongest case in the product for not sending it in plaintext.
 */
export function validateRunnerConfig(config: Partial<RemoteRunnerConfig>): { ok: true; config: RemoteRunnerConfig } | { ok: false; reason: string } {
    const url = String(config.url ?? '').trim();
    if (!url) {
        return {
            ok: false,
            // Phrased so nobody reads it as "a runner is coming later". There is no
            // default endpoint because there is no endpoint of ours to default to.
            reason: 'No runner is configured. Remote execution is bring-your-own — there is no default endpoint, '
                + 'and no Black IDE service that commands are sent to.',
        };
    }
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { ok: false, reason: `"${url}" is not a valid URL.` }; }

    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '::1'
        || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(parsed.hostname);
    if (parsed.protocol !== 'https:' && !loopback) {
        return {
            ok: false,
            reason: `Refusing ${parsed.protocol}//${parsed.host}: a runner receives your source code and returns `
                + 'output the agent acts on, so it must be https. Loopback is exempt for local containers.',
        };
    }

    return { ok: true, config: { url, token: config.token, timeoutMs: config.timeoutMs ?? 120_000 } };
}

export interface RemoteProcessOptions {
    config: RemoteRunnerConfig;
    /** Injected for tests. Defaults to the global. */
    fetchImpl?: typeof fetch;
    log?: (message: string) => void;
}

/**
 * A `HostProcess` backed by a remote runner.
 *
 * Implementing the same interface as the local one is what makes M62's boundary pay off:
 * nothing in the agent knows or cares that its commands are running somewhere else, and
 * the seam is a field on the host rather than a branch in every caller.
 *
 * Note what it does **not** do: it never falls back to running locally. A remote runner
 * that is unreachable means the command did not run, and silently running it on the
 * user's laptop instead would be the opposite of what "run this elsewhere" asked for —
 * on a machine that may not have the credentials, the tools, or the isolation the user
 * chose a runner for.
 */
export function remoteProcess(options: RemoteProcessOptions): HostProcess {
    const fetchImpl = options.fetchImpl || fetch;
    const { config } = options;

    return {
        async run(command, runOptions = {}) {
            const request: RemoteExecRequest = {
                command,
                cwd: runOptions.cwd || '.',
                sandbox: runOptions.sandbox ?? 'restricted',
                timeoutMs: runOptions.timeoutMs ?? config.timeoutMs ?? 120_000,
            };

            let response: Response;
            try {
                response = await fetchImpl(config.url, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
                    },
                    body: JSON.stringify(request),
                    signal: runOptions.signal ?? AbortSignal.timeout(request.timeoutMs + 5_000),
                });
            } catch (error: any) {
                return {
                    stdout: '', stderr: '', exitCode: 1,
                    refused: `The remote runner at ${config.url} could not be reached: ${error?.message || error}. `
                        + 'The command did not run — it is deliberately not retried locally, because a runner was '
                        + 'chosen for a reason this machine may not satisfy.',
                };
            }

            if (!response.ok) {
                return {
                    stdout: '', stderr: '', exitCode: 1,
                    refused: `The remote runner answered HTTP ${response.status}. The command did not run.`,
                };
            }

            let body: unknown;
            try { body = await response.json(); } catch { body = undefined; }

            const outcome = validateRemoteResponse(request, body);
            if (!outcome.ok) {
                return { stdout: '', stderr: '', exitCode: 1, refused: outcome.reason };
            }

            options.log?.(`[Runner] ${command.slice(0, 60)} → exit ${outcome.response.exitCode} `
                + `(${outcome.response.enforced} on ${new URL(config.url).host})`);
            return {
                stdout: outcome.response.stdout,
                stderr: outcome.response.stderr,
                exitCode: outcome.response.exitCode,
                timedOut: outcome.response.timedOut,
            };
        },
    };
}

/**
 * Swap a host's process onto a remote runner.
 *
 * Only `process` changes. The filesystem stays local, which is the design decision that
 * makes this useful rather than a rewrite: the agent reads and writes the user's actual
 * working tree and only the *commands* — the slow, dependency-heavy, isolation-worthy
 * part — go elsewhere. A runner that also owned the filesystem would need the whole repo
 * synchronised to it before every command, and would be a different product.
 */
export function withRemoteRunner(host: AgentHost, options: RemoteProcessOptions): AgentHost {
    return { ...host, process: remoteProcess(options) };
}
