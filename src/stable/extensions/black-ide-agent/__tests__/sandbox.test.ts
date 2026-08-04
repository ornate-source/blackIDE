import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    ENV_ALLOWLIST, SandboxMechanism, SandboxPlan, atLeast, highest, macosProfile, parseTier,
    planSandbox, refusalMessage, scrubEnv, tierFor, tierRank, TIER_LIMITS,
} from '../src/core/sandbox';
import { detectMechanisms, runSandboxed } from '../src/core/sandbox-runner';

/**
 * Sandboxed execution tiers (Phase 9, M57 · P9-1).
 *
 * The acceptance clause is "a tier-2 command cannot reach the network, **asserted rather
 * than configured**", and the last three words are the reason the bottom half of this
 * file spawns real processes. A test that asserts `plan.argv` contains `-f profile.sb`
 * asserts that we wrote the flag we meant to write; it does not assert that the flag
 * does anything. On a machine that has the mechanism, this file makes a real command try
 * to open a socket and requires it to fail.
 *
 * On a machine that does not, the *refusal* is asserted instead — which is the same
 * property from the other side, and the more important one: the failure mode this design
 * exists to prevent is a run that could not confine and proceeded anyway.
 */

const plan = (over: Partial<Parameters<typeof planSandbox>[0]> = {}) => planSandbox({
    command: 'echo hi',
    cwd: '/work/repo',
    tier: 'restricted',
    platform: 'darwin',
    mechanisms: ['sandbox-exec'],
    env: { PATH: '/usr/bin', AWS_SECRET_ACCESS_KEY: 'shh' },
    ...over,
});

describe('tier ordering', () => {
    it('is policy < restricted < contained', () => {
        expect(tierRank('policy')).toBeLessThan(tierRank('restricted'));
        expect(tierRank('restricted')).toBeLessThan(tierRank('contained'));
        expect(atLeast('contained', 'restricted')).toBe(true);
        expect(atLeast('policy', 'restricted')).toBe(false);
        expect(highest('policy', 'contained')).toBe('contained');
    });

    it('limits tighten as the tier does', () => {
        expect(TIER_LIMITS.contained.timeoutMs).toBeLessThan(TIER_LIMITS.restricted.timeoutMs);
        expect(TIER_LIMITS.restricted.timeoutMs).toBeLessThanOrEqual(TIER_LIMITS.policy.timeoutMs);
        expect(TIER_LIMITS.contained.maxOutputBytes).toBeLessThan(TIER_LIMITS.policy.maxOutputBytes);
    });

    it('parses an unknown tier to the fallback rather than throwing', () => {
        expect(parseTier('restricted')).toBe('restricted');
        expect(parseTier('nonsense')).toBe('policy');
        expect(parseTier(undefined, 'contained')).toBe('contained');
    });
});

describe('tierFor only ever raises', () => {
    it('an unattended run defaults to restricted — P9-1\'s acceptance clause', () => {
        expect(tierFor({ unattended: true })).toBe('restricted');
    });

    it('an attended run stays at policy, so nothing that worked stops working', () => {
        expect(tierFor({ unattended: false })).toBe('policy');
    });

    it('untrusted content forces contained, attended or not', () => {
        expect(tierFor({ unattended: false, untrustedContent: true })).toBe('contained');
        expect(tierFor({ unattended: true, untrustedContent: true })).toBe('contained');
    });

    it('read-only work (the Reviewer) is restricted even with a human watching', () => {
        expect(tierFor({ unattended: false, readOnly: true })).toBe('restricted');
    });

    it('a configured tier raises but can never lower', () => {
        expect(tierFor({ unattended: false, configured: 'contained' })).toBe('contained');
        // The setting says "policy"; the run is unattended. Confinement wins.
        expect(tierFor({ unattended: true, configured: 'policy' })).toBe('restricted');
        expect(tierFor({ unattended: false, untrustedContent: true, configured: 'policy' })).toBe('contained');
    });
});

describe('environment scrubbing', () => {
    it('policy passes the environment through — it is the tier that always shipped', () => {
        const result = scrubEnv({ AWS_SECRET_ACCESS_KEY: 'shh', PATH: '/usr/bin' }, 'policy');
        expect(result.env.AWS_SECRET_ACCESS_KEY).toBe('shh');
        expect(result.dropped).toBe(0);
    });

    it('restricted keeps only the allowlist', () => {
        const result = scrubEnv({
            PATH: '/usr/bin', HOME: '/home/x',
            AWS_SECRET_ACCESS_KEY: 'shh', GITHUB_TOKEN: 'ghp_x', NPM_CONFIG_REGISTRY: 'https://x',
        }, 'restricted');
        expect(result.env.PATH).toBe('/usr/bin');
        expect(result.env.HOME).toBe('/home/x');
        expect(result.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
        expect(result.env.GITHUB_TOKEN).toBeUndefined();
        // Not credential-shaped, but not on the allowlist either — absent by default is
        // the whole point of an allowlist.
        expect(result.env.NPM_CONFIG_REGISTRY).toBeUndefined();
        expect(result.dropped).toBe(3);
        expect(result.secretsDropped).toBe(2);
    });

    it('reports how many credentials it withheld, so the claim is checkable', () => {
        const result = scrubEnv({ A_TOKEN: '1', B_SECRET: '2', C_PASSWORD: '3', HARMLESS: '4' }, 'restricted');
        expect(result.dropped).toBe(4);
        expect(result.secretsDropped).toBe(3);
    });

    it('an explicitly allowed variable passes, and only that one', () => {
        const result = scrubEnv({ MY_BUILD_FLAG: 'on', OTHER: 'x' }, 'restricted', ['MY_BUILD_FLAG']);
        expect(result.env.MY_BUILD_FLAG).toBe('on');
        expect(result.env.OTHER).toBeUndefined();
    });

    it('tells the command it is confined, and neutralises pagers', () => {
        const result = scrubEnv({ PATH: '/usr/bin' }, 'contained');
        expect(result.env.BLACKIDE_SANDBOX).toBe('contained');
        expect(result.env.PAGER).toBe('cat');
        expect(result.env.GIT_PAGER).toBe('cat');
    });

    it('the allowlist contains no credential-shaped name', () => {
        // A regression guard on the list itself: adding `GITHUB_TOKEN` here to fix
        // someone's build would silently defeat the scrub for every run.
        for (const name of ENV_ALLOWLIST) {
            expect(name).not.toMatch(/TOKEN|SECRET|PASSWORD|CREDENTIAL|APIKEY|API_KEY/i);
        }
    });
});

describe('planning: refuses rather than degrading', () => {
    it('policy never refuses and imposes no mechanism', () => {
        const outcome = plan({ tier: 'policy', platform: 'win32', mechanisms: [] });
        expect(outcome.ok).toBe(true);
        expect((outcome as SandboxPlan).mechanism).toBeUndefined();
        expect((outcome as SandboxPlan).note).toMatch(/not confined by the OS/);
    });

    it('restricted on a machine with no mechanism is REFUSED, not run unconfined', () => {
        const outcome = plan({ mechanisms: [] });
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.reason).toMatch(/no mechanism that can enforce it/);
        expect(outcome.ok === false && outcome.reason).toMatch(/sandbox-exec was not found/);
    });

    it('Windows refuses at restricted and says what to do instead', () => {
        const outcome = plan({ platform: 'win32', cwd: 'C:\\work\\repo', mechanisms: [] });
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.reason).toMatch(/WSL/);
    });

    it('a relative cwd is refused — a jail whose root moves is not a jail', () => {
        const outcome = plan({ cwd: 'repo' });
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.reason).toMatch(/absolute working directory/);
    });

    it('unshare is accepted for restricted and REFUSED for contained', () => {
        const mechanisms: SandboxMechanism[] = ['unshare'];
        const restricted = plan({ platform: 'linux', mechanisms });
        expect(restricted.ok).toBe(true);
        expect((restricted as SandboxPlan).argv).toContain('--net');

        // `unshare -n` gives a network namespace and nothing else, which is not what
        // "contained" promises. Accepting it under that name is the exact substitution
        // this module exists to refuse.
        const contained = plan({ platform: 'linux', tier: 'contained', mechanisms });
        expect(contained.ok).toBe(false);
        expect(contained.ok === false && contained.reason).toMatch(/bubblewrap/);
    });

    it('bwrap never shares the network, at any tier', () => {
        for (const tier of ['restricted', 'contained'] as const) {
            const outcome = plan({ platform: 'linux', tier, mechanisms: ['bwrap'] });
            expect(outcome.ok).toBe(true);
            const argv = (outcome as SandboxPlan).argv;
            expect(argv).toContain('--unshare-all');
            expect(argv).not.toContain('--share-net');
        }
    });

    it('contained on Linux binds explicit roots rather than ro-binding all of /', () => {
        const outcome = plan({ platform: 'linux', tier: 'contained', mechanisms: ['bwrap'] }) as SandboxPlan;
        const joined = outcome.argv.join(' ');
        expect(joined).not.toMatch(/--ro-bind \/ \//);
        expect(joined).toMatch(/--ro-bind-try \/usr \/usr/);
    });

    it('the timeout may be lowered by the caller but never raised above the tier cap', () => {
        const lowered = plan({ timeoutMs: 5_000 }) as SandboxPlan;
        expect(lowered.limits.timeoutMs).toBe(5_000);
        const attempted = plan({ timeoutMs: 999_000 }) as SandboxPlan;
        expect(attempted.limits.timeoutMs).toBe(TIER_LIMITS.restricted.timeoutMs);
    });

    it('the plan carries the scrub count into the audit note', () => {
        const outcome = plan() as SandboxPlan;
        expect(outcome.note).toMatch(/no network/);
        expect(outcome.note).toMatch(/env var\(s\) withheld/);
        expect(outcome.scrub.secretsDropped).toBe(1);
    });

    it('the refusal message tells the model not to retry', () => {
        const outcome = plan({ mechanisms: [] });
        const message = refusalMessage('curl example.com', outcome as any);
        expect(message).toMatch(/was not run/);
        expect(message).toMatch(/Do not retry it/);
    });
});

describe('the macOS profile', () => {
    it('denies the network at every confined tier', () => {
        expect(macosProfile('restricted', '/work/repo')).toMatch(/\(deny network\*/);
        expect(macosProfile('contained', '/work/repo')).toMatch(/\(deny network\*/);
    });

    it('restricted allows writes only under the workspace and its private temp', () => {
        const profile = macosProfile('restricted', '/work/repo', [], '/tmp/private-run');
        expect(profile).toMatch(/\(deny file-write\*\)/);
        expect(profile).toMatch(/subpath "\/work\/repo"/);
        expect(profile).toMatch(/subpath "\/tmp\/private-run"/);
    });

    it('does not make the system temp writable — that would void the write confinement', () => {
        // Every process already knows how to write to /tmp, so granting it would be the
        // one exception that makes "writes are confined to the workspace" untrue.
        for (const tier of ['restricted', 'contained'] as const) {
            const profile = macosProfile(tier, '/work/repo', [], '/tmp/private-run');
            expect(profile).not.toMatch(/file-write\*[^\n]*subpath "\/private\/tmp"/);
            expect(profile).not.toMatch(/file-write\*[^\n]*subpath "\/private\/var\/folders"/);
        }
    });

    it('contained starts from deny-all rather than allow-all', () => {
        const profile = macosProfile('contained', '/work/repo');
        expect(profile).toMatch(/\(deny default\)/);
        expect(profile).not.toMatch(/\(allow default\)/);
    });

    it('contained grants the root directory entry, without which no binary starts', () => {
        // Found the hard way: under `(deny default)` the loader stats `/` while resolving
        // APFS firmlinks, and its absence aborts the process before its first
        // instruction — which reads as "the sandbox is broken", not "a rule is missing".
        expect(macosProfile('contained', '/work/repo')).toMatch(/file-read\*\s*\(literal "\/"\)/);
    });

    it('a confined run gets TMPDIR pointed inside its jail', () => {
        const outcome = plan({ tempDir: '/tmp/private-run' }) as SandboxPlan;
        expect(outcome.env.TMPDIR).toBe('/tmp/private-run');
        expect(outcome.env.TMP).toBe('/tmp/private-run');
    });

    it('quotes a path containing a quote rather than producing a broken profile', () => {
        // A malformed profile makes sandbox-exec exit non-zero, which reads as "the
        // command failed" — a silent loss of confinement is not possible here, but a
        // confusing one is, so the escaping is asserted.
        const profile = macosProfile('restricted', '/work/we"ird');
        expect(profile).toMatch(/subpath "\/work\/we\\"ird"/);
    });
});

// ─── Asserted, not configured ───────────────────────────────────────────────

const mechanisms = detectMechanisms();
const canConfine = mechanisms.length > 0;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-sandbox-test-'));

describe('the guarantee, against a real process', () => {
    it('runs an ordinary command at the policy tier', async () => {
        const result = await runSandboxed({ command: 'echo hello-policy', cwd: scratch, tier: 'policy' });
        expect(result.refused).toBeUndefined();
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/hello-policy/);
    }, 30_000);

    it.runIf(canConfine)('a tier-2 command still runs — confinement is not breakage', async () => {
        const result = await runSandboxed({ command: 'echo hello-restricted', cwd: scratch, tier: 'restricted' });
        expect(result.refused).toBeUndefined();
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/hello-restricted/);
        expect(result.note).toMatch(/no network/);
    }, 30_000);

    it.runIf(canConfine)('a tier-2 command CANNOT reach the network', async () => {
        /*
         * The clause, asserted. A TCP connect to a public DNS resolver on port 53 — no
         * name resolution involved, so a pass cannot be an artefact of DNS being
         * unavailable in the test environment, and no dependency on the machine having
         * curl. The unconfined control below is what makes the confined failure mean
         * something: without it, a green result here is equally consistent with the
         * machine simply having no network at all.
         */
        const probe = 'require("net").connect({host:"1.1.1.1",port:53})'
            + '.on("connect",()=>{console.log("REACHED");process.exit(0)})'
            + '.on("error",e=>{console.log("BLOCKED:"+e.code);process.exit(0)});'
            + 'setTimeout(()=>{console.log("BLOCKED:TIMEOUT");process.exit(0)},4000)';
        const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(probe)}`;

        const unconfined = await runSandboxed({ command, cwd: scratch, tier: 'policy' });
        if (!/REACHED/.test(unconfined.stdout)) {
            // No network on this machine, so the confined result would prove nothing.
            // Saying so beats a green tick that means "the wire is unplugged".
            expect(unconfined.stdout).toMatch(/BLOCKED/);
            return;
        }

        const confined = await runSandboxed({ command, cwd: scratch, tier: 'restricted' });
        expect(confined.refused).toBeUndefined();
        expect(confined.stdout).not.toMatch(/REACHED/);
        expect(confined.stdout).toMatch(/BLOCKED/);
    }, 60_000);

    it.runIf(canConfine)('a tier-2 command cannot write outside its workspace', async () => {
        const outside = path.join(os.tmpdir(), `blackide-escape-${Date.now()}.txt`);
        const result = await runSandboxed({
            command: `echo escaped > ${JSON.stringify(path.join(scratch, 'inside.txt'))} `
                + `&& echo escaped > ${JSON.stringify(outside)} || echo WRITE-DENIED`,
            cwd: scratch,
            tier: 'contained',
        });
        expect(result.refused).toBeUndefined();
        // The in-jail write must succeed: a sandbox that breaks the build is one nobody
        // leaves switched on.
        expect(fs.existsSync(path.join(scratch, 'inside.txt'))).toBe(true);
        expect(fs.existsSync(outside)).toBe(false);
        try { fs.rmSync(outside, { force: true }); } catch { /* never created */ }
    }, 60_000);

    it.runIf(canConfine)('a tier-2 command cannot read the credentials it was started with', async () => {
        const result = await runSandboxed({
            command: process.platform === 'win32' ? 'echo %SUPER_SECRET_TOKEN%' : 'echo "[$SUPER_SECRET_TOKEN]"',
            cwd: scratch,
            tier: 'restricted',
            env: { ...process.env, SUPER_SECRET_TOKEN: 'leaked-value-9f3a' },
        });
        expect(result.refused).toBeUndefined();
        expect(result.stdout).not.toMatch(/leaked-value-9f3a/);
    }, 30_000);

    it.runIf(!canConfine)('refuses tier 2 outright when nothing can enforce it', async () => {
        // The other side of the same guarantee, and the one that matters more: a machine
        // that cannot confine must not run the command anyway.
        const result = await runSandboxed({ command: 'echo should-not-run', cwd: scratch, tier: 'restricted' });
        expect(result.refused).toBeTruthy();
        expect(result.stdout).toBe('');
        expect(result.refused).toMatch(/no mechanism that can enforce it/);
    }, 30_000);

    it('a timeout kills the command rather than hanging the run', async () => {
        const result = await runSandboxed({
            command: process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30',
            cwd: scratch,
            tier: 'policy',
            timeoutMs: 1_500,
        });
        expect(result.timedOut).toBe(true);
    }, 30_000);
});
