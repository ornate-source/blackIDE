import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFetchRequest, flattenAdf, parseFetchedTask, renderFetchFailure, renderFetchedTask } from '../src/core/task-fetchers';
import {
    buildCompletionMessage, buildSlackRequest, interpretSlackResponse, maskWebhook,
    slackOutboundAction, validateTarget,
} from '../src/core/slack-transport';
import { remoteProcess, validateRemoteResponse, validateRunnerConfig } from '../src/agent-core/remote-runner';
import { decideOutbound, findTaskReferences } from '../src/core/task-sources';
import { EGRESS_REGISTER } from '../src/core/egress';

/**
 * Phase 12's three integrations: tracker fetchers (M67), the Slack transport (M68) and
 * the BYO runner (M66).
 *
 * All three are outward-facing, and the phase's gate is four *security* clauses rather
 * than any feature. So the assertions here are mostly about what each one refuses.
 */

// ─── P12-1 · tracker fetchers ───────────────────────────────────────────────

describe('fetchers: the tracker is never guessed', () => {
    const github = findTaskReferences('fix #123')[0];

    it('builds a GitHub request when the repository is known', () => {
        const built = buildFetchRequest(github, { repo: 'acme/widgets', token: 'ghp_x' });
        expect(built).toMatchObject({ ok: true });
        expect(built.ok === true && built.request.url).toBe('https://api.github.com/repos/acme/widgets/issues/123');
        expect(built.ok === true && built.request.headers.authorization).toBe('Bearer ghp_x');
    });

    it('refuses a bare #n with no configured repository rather than inferring one', () => {
        /*
         * Inferring `owner/repo` from the git remote is the obvious convenience and is
         * wrong: a repository with two remotes would send the request to whichever
         * happened to be first, with the user's token attached.
         */
        const built = buildFetchRequest(github, { token: 'ghp_x' });
        expect(built.ok).toBe(false);
        expect(built.ok === false && built.failure.reason).toMatch(/needs a repository/);
        expect(built.ok === false && built.failure.reason).toMatch(/two\s+remotes/);
    });

    it('refuses a malformed repository', () => {
        expect(buildFetchRequest(github, { repo: 'not a repo', token: 't' }).ok).toBe(false);
    });

    it('refuses to build anything without a credential', () => {
        expect(buildFetchRequest(github, { repo: 'a/b' }).ok).toBe(false);
    });

    it('encodes the issue id into Linear\'s query rather than interpolating it', () => {
        const linear = findTaskReferences('see https://linear.app/acme/issue/ENG-45')[0];
        const built = buildFetchRequest(linear, { token: 'lin_x' });
        expect(built.ok).toBe(true);
        expect(built.ok === true && built.request.url).toMatch(/^https:\/\/api\.linear\.app\/graphql\?query=/);
        expect(built.ok === true && built.request.url).toContain(encodeURIComponent('"ENG-45"'));
    });

    it('refuses a plaintext Jira host — an API token in the clear is a leaked token', () => {
        const jira = findTaskReferences('https://jira.acme.com/browse/PROJ-9')[0];
        const built = buildFetchRequest(jira, { host: 'http://jira.acme.com', token: 't', email: 'a@b.c' });
        expect(built.ok).toBe(false);
        expect(built.ok === false && built.failure.reason).toMatch(/must be https/);
    });

    it('Jira needs both halves of its basic auth', () => {
        const jira = findTaskReferences('https://jira.acme.com/browse/PROJ-9')[0];
        expect(buildFetchRequest(jira, { host: 'https://jira.acme.com', token: 't' }).ok).toBe(false);
    });

    it('a bare ENG-45 is still not a reference at all, so no fetcher is reachable for it', () => {
        // M67's first half, restated here because P12-1's clause depends on it.
        expect(findTaskReferences('please look at ENG-45')).toEqual([]);
    });
});

describe('fetchers: parsing distinguishes an empty issue from a failed read', () => {
    it('parses a GitHub issue', () => {
        const outcome = parseFetchedTask('github', '123', {
            title: 'Pagination overlaps', body: 'Page 1 repeats an item.', state: 'open',
            html_url: 'https://github.com/a/b/issues/123', user: { login: 'ada' },
            labels: [{ name: 'bug' }],
        });
        expect(outcome).toMatchObject({ ok: true, task: { title: 'Pagination overlaps', author: 'ada', labels: ['bug'] } });
    });

    it('treats a GraphQL 200-with-errors as a failure, not an empty issue', () => {
        // Linear answers HTTP 200 with an `errors` array, so a status check alone would
        // hand the agent an empty issue and let it invent what the ticket said.
        const outcome = parseFetchedTask('linear', 'ENG-45', { errors: [{ message: 'Entity not found' }] });
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.failure.reason).toMatch(/Entity not found/);
    });

    it('flattens Jira\'s document format instead of stringifying an object', () => {
        // `String(description)` on ADF produces `[object Object]`, which is what the agent
        // would then be asked to implement.
        const outcome = parseFetchedTask('jira', 'PROJ-9', {
            fields: {
                summary: 'Fix the total',
                description: { type: 'doc', content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'The total is wrong.' }] },
                    { type: 'paragraph', content: [{ type: 'text', text: 'Rounding, probably.' }] },
                ] },
                status: { name: 'To Do' },
            },
        });
        expect(outcome.ok).toBe(true);
        expect(outcome.ok === true && outcome.task.body).toBe('The total is wrong.\nRounding, probably.\n');
    });

    it('flattenAdf handles strings, arrays, nulls and unknown node types', () => {
        expect(flattenAdf(null)).toBe('');
        expect(flattenAdf('plain')).toBe('plain');
        expect(flattenAdf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab');
        expect(flattenAdf({ type: 'weirdInline', content: [{ type: 'text', text: 'x' }] })).toBe('x');
    });

    it('a failed fetch tells the agent NOT to guess', () => {
        // An agent handed nothing concludes the issue is empty and implements its own idea
        // of what #123 meant, which is worse than being told it could not be read.
        const rendered = renderFetchFailure({ kind: 'github', id: '123', reason: 'HTTP 404' });
        expect(rendered).toMatch(/could not be read/);
        expect(rendered).toMatch(/Do not guess/);
    });

    it('renders a fetched task with its provenance', () => {
        const rendered = renderFetchedTask({
            kind: 'github', id: '123', title: 'Pagination overlaps',
            body: 'Page 1 repeats an item.', state: 'open', url: 'https://x/1', author: 'ada',
        });
        expect(rendered).toMatch(/github 123: Pagination overlaps/);
        expect(rendered).toMatch(/Reported by: ada/);
    });
});

// ─── P12-2 · Slack ──────────────────────────────────────────────────────────

describe('Slack: no standing grant is expressible', () => {
    const target = { webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxxxxxxx' };
    const message = buildCompletionMessage({ id: 'r1', prompt: 'bump deps', ok: true, changed: ['a', 'b'], branch: 'agent/x' });

    it('an unconfirmed notice is refused, with the reason naming the rule', () => {
        const action = slackOutboundAction(target, message);
        const decision = decideOutbound(action, { allowExternalPosting: true, confirmedNow: false });
        expect(decision.allowed).toBe(false);
        expect(decision.allowed === false && decision.reason).toMatch(/no "always allow"/);
    });

    it('the transport builds an action and cannot send one', () => {
        /*
         * The structural version of the clause. This module has no `send`: it builds a
         * request only after `decideOutbound` has allowed *this* action, and there is no
         * field in `OutboundContext` a remembered answer could live in.
         */
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'slack-transport.ts'), 'utf8');
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(code).not.toMatch(/alwaysAllow|dontAsk|rememberChoice|autoPost/i);
        expect(code).not.toMatch(/await fetch\(/);
    });

    it('refuses a webhook URL pointing anywhere but Slack', () => {
        // A webhook URL is a bearer credential in a string: anyone holding it can post as
        // that integration, so a typo'd host is a credential disclosure.
        const outcome = validateTarget({ webhookUrl: 'https://hooks.slack.com.evil.test/services/x' });
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.reason).toMatch(/bearer credential/);
    });

    it('refuses a plaintext webhook', () => {
        expect(validateTarget({ webhookUrl: 'http://hooks.slack.com/services/x' }).ok).toBe(false);
    });

    it('accepts a real webhook, and a bot token with a channel', () => {
        expect(validateTarget(target).ok).toBe(true);
        expect(validateTarget({ botToken: 'xoxb-1', channel: 'C123' }).ok).toBe(true);
        expect(validateTarget({ botToken: 'xoxb-1' }).ok).toBe(false);
        expect(validateTarget({}).ok).toBe(false);
    });

    it('masks the webhook in the confirmation, so a bug report cannot leak it', () => {
        const action = slackOutboundAction(target, message);
        expect(action.destination).toContain('hooks.slack.com');
        expect(action.destination).not.toContain('xxxxxxxx');
        expect(maskWebhook(undefined)).toBe('unset');
        expect(maskWebhook('not a url')).toBe('invalid');
    });

    it('the message says it was confirmed, because its readers did not confirm it', () => {
        const rendered = JSON.stringify(message.blocks);
        expect(rendered).toMatch(/someone confirmed this specific message/);
        expect(rendered).toMatch(/no automatic posting/);
    });

    it('treats Slack\'s 200-with-ok-false as the failure it is', () => {
        /*
         * `chat.postMessage` answers HTTP 200 with `{"ok": false}` on failure — including
         * for an invalid token. A status check alone reports every failure as a success,
         * which is the single commonest way a Slack integration is quietly broken.
         */
        expect(interpretSlackResponse(200, { ok: false, error: 'invalid_auth' }))
            .toMatchObject({ ok: false, reason: expect.stringContaining('invalid_auth') });
        expect(interpretSlackResponse(200, { ok: true })).toEqual({ ok: true });
        expect(interpretSlackResponse(500, {}).ok).toBe(false);
    });

    it('builds the right request for each credential shape', () => {
        expect(buildSlackRequest(target, message).url).toBe(target.webhookUrl);
        const bot = buildSlackRequest({ botToken: 'xoxb-1', channel: 'C1' }, message);
        expect(bot.url).toBe('https://slack.com/api/chat.postMessage');
        expect(JSON.parse(bot.body).channel).toBe('C1');
    });
});

// ─── P12-3 · BYO runner ─────────────────────────────────────────────────────

describe('the runner is bring-your-own by construction', () => {
    it('has no default endpoint, and says why rather than implying one is coming', () => {
        const outcome = validateRunnerConfig({});
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.reason).toMatch(/no default endpoint/);
        expect(outcome.ok === false && outcome.reason).toMatch(/no Black IDE service/);
    });

    it('refuses a plaintext runner — it receives source and returns output the agent acts on', () => {
        expect(validateRunnerConfig({ url: 'http://runner.example.com' }).ok).toBe(false);
        expect(validateRunnerConfig({ url: 'https://runner.example.com' }).ok).toBe(true);
        // A local container is the common case and is exempt.
        expect(validateRunnerConfig({ url: 'http://127.0.0.1:8080' }).ok).toBe(true);
    });

    it('there is no hardcoded endpoint anywhere in the module', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent-core', 'remote-runner.ts'), 'utf8');
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        // Slack's and GitHub's hosts are legitimately hardcoded in their own modules; a
        // runner host is not, because the whole clause is that we operate none.
        expect(code).not.toMatch(/https:\/\/(?!slack|api\.github)[a-z0-9.-]*blackide/i);
    });
});

describe('a runner that ignores the sandbox tier is refused', () => {
    const request = { command: 'npm test', cwd: '/repo', sandbox: 'restricted' as const, timeoutMs: 1_000 };

    it('accepts a response that enforced what was asked', () => {
        expect(validateRemoteResponse(request, { stdout: 'ok', stderr: '', exitCode: 0, enforced: 'restricted' }))
            .toMatchObject({ ok: true, response: { exitCode: 0 } });
    });

    it('accepts a STRONGER tier than asked for', () => {
        expect(validateRemoteResponse(request, { exitCode: 0, enforced: 'contained' }).ok).toBe(true);
    });

    it('refuses a weaker tier — the output was produced with the network open', () => {
        const outcome = validateRemoteResponse(request, { exitCode: 0, enforced: 'policy' });
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.reason).toMatch(/enforced "policy" for a command that required "restricted"/);
    });

    it('refuses a response with no `enforced` field — absence is not compliance', () => {
        /*
         * The whole reason the field exists. "It was missing so it probably did what we
         * asked" is the reasoning that makes M57's tiers decorative the moment a command
         * crosses a network.
         */
        const outcome = validateRemoteResponse(request, { exitCode: 0 });
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.reason).toMatch(/absence is not compliance/);
    });

    it('refuses a response with no exit code', () => {
        expect(validateRemoteResponse(request, { stdout: 'x', enforced: 'restricted' }).ok).toBe(false);
    });

    it('refuses a body that is not an object', () => {
        expect(validateRemoteResponse(request, 'fine').ok).toBe(false);
        expect(validateRemoteResponse(request, null).ok).toBe(false);
    });
});

describe('the remote process never silently falls back to local', () => {
    const config = { url: 'https://runner.example.com', timeoutMs: 1_000 };

    it('an unreachable runner refuses, and says the command did not run', async () => {
        /*
         * Running it on the user's laptop instead is the opposite of what "run this
         * elsewhere" asked for — on a machine that may lack the credentials, the tools, or
         * the isolation they chose a runner for.
         */
        const process = remoteProcess({ config, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
        const result = await process.run('npm test', { sandbox: 'restricted' });
        expect(result.refused).toMatch(/could not be reached/);
        expect(result.refused).toMatch(/not retried locally/);
        expect(result.stdout).toBe('');
    });

    it('a runner that under-enforces refuses rather than returning its output', async () => {
        const process = remoteProcess({
            config,
            fetchImpl: async () => new Response(
                JSON.stringify({ stdout: 'secrets', exitCode: 0, enforced: 'policy' }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        });
        const result = await process.run('npm test', { sandbox: 'contained' });
        expect(result.refused).toBeTruthy();
        expect(result.stdout).toBe('');
    });

    it('a compliant runner\'s output comes back', async () => {
        const process = remoteProcess({
            config,
            fetchImpl: async () => new Response(
                JSON.stringify({ stdout: '12 passed', stderr: '', exitCode: 0, enforced: 'restricted' }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        });
        const result = await process.run('npm test', { sandbox: 'restricted' });
        expect(result.refused).toBeUndefined();
        expect(result.stdout).toBe('12 passed');
    });

    it('defaults to restricted when the caller names no tier', async () => {
        let sent: any;
        const process = remoteProcess({
            config,
            fetchImpl: async (_url, init: any) => {
                sent = JSON.parse(init.body);
                return new Response(JSON.stringify({ exitCode: 0, enforced: 'restricted' }), { status: 200 });
            },
        });
        await process.run('npm test');
        expect(sent.sandbox).toBe('restricted');
    });
});

describe('all three are declared egress', () => {
    it('each new outbound module is registered with an honest trigger', () => {
        const points = Object.fromEntries(EGRESS_REGISTER.map(p => [p.module, p]));
        expect(points['core/task-fetchers.ts']?.trigger).toBe('user-action');
        expect(points['core/slack-transport.ts']?.trigger).toBe('user-action');
        // The runner is `opt-in`: absent configuration removes the egress entirely.
        expect(points['agent-core/remote-runner.ts']?.trigger).toBe('opt-in');
    });

    it('the runner\'s entry states the data-processor position', () => {
        const point = EGRESS_REGISTER.find(p => p.module === 'agent-core/remote-runner.ts')!;
        expect(point.why).toMatch(/no default endpoint/);
        expect(point.why).toMatch(/not become a data processor by default/);
    });

    it('none of the three is a phone-home point', () => {
        for (const module of ['core/task-fetchers.ts', 'core/slack-transport.ts', 'agent-core/remote-runner.ts']) {
            const point = EGRESS_REGISTER.find(p => p.module === module)!;
            expect(point.destination).not.toMatch(/blackide\.(com|dev|io)/i);
        }
    });
});
