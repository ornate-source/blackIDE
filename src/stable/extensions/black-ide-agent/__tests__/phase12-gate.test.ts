import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    Capabilities, DEFAULT_CAPABILITIES, applyOrgPolicy, capabilityScore, describeClamps,
    parseOrgPolicy, tightenBudget,
} from '../src/core/org-policy';
import {
    EGRESS_REGISTER, decideAnalyticsSend, optionalPoints, phoneHomePoints, toAnalyticsEvent,
} from '../src/core/egress';
import {
    buildConfirmation, completionNotice, decideOutbound, findTaskReferences,
} from '../src/core/task-sources';

/**
 * Phase 12 — the gate, which is four security clauses and nothing else:
 *
 *   1. the default build phones home to nobody (asserted in tests);
 *   2. an org policy cannot widen the deny list;
 *   3. nothing is posted to an external service without an explicit per-action confirmation;
 *   4. disabling the sink removes all egress.
 *
 * All four are decidable without a network, which is what makes them worth stating as a
 * gate rather than as a promise. G4 calls local-only telemetry "a selling point, not a
 * placeholder"; this file is where that stops being a sentence in a README.
 */

// ─── Clause 2: an org policy can only tighten ───────────────────────────────

const permissive: Capabilities = {
    ...DEFAULT_CAPABILITIES,
    autoApproveTerminal: true,
    autoApproveFileEdits: true,
    commandAllowList: ['npm', 'git', 'make'],
    commandDenyList: ['curl'],
    maxConcurrentAgents: 8,
    sessionTokenBudget: 0,
    allowExternalPosting: true,
    allowRemoteSkillPacks: true,
};

describe('clause 2: an org policy can only tighten', () => {
    it('cannot grant a capability the user did not have', () => {
        // The injection path this module exists to close: a `.blackide/policy.json` arrives
        // with a `git pull`, from anyone with commit access.
        const locked: Capabilities = { ...DEFAULT_CAPABILITIES, autoApproveTerminal: false };
        const result = applyOrgPolicy(locked, { capabilities: { autoApproveTerminal: true } });

        expect(result.capabilities.autoApproveTerminal).toBe(false);
        expect(result.refusals.map(r => r.setting)).toContain('autoApproveTerminal');
    });

    it('cannot remove an entry from the deny list', () => {
        const result = applyOrgPolicy(permissive, { capabilities: { commandDenyList: [] } });
        expect(result.capabilities.commandDenyList).toContain('curl');
    });

    it('can add to the deny list', () => {
        const result = applyOrgPolicy(permissive, { capabilities: { commandDenyList: ['wget', 'nc'] } });
        expect(result.capabilities.commandDenyList).toEqual(expect.arrayContaining(['curl', 'wget', 'nc']));
    });

    it('can remove from the allow list but never add to it', () => {
        const result = applyOrgPolicy(permissive, { capabilities: { commandAllowList: ['npm', 'rm'] } });
        expect(result.capabilities.commandAllowList).toEqual(['npm']);
        expect(result.capabilities.commandAllowList).not.toContain('rm');
        expect(result.refusals.map(r => r.setting)).toContain('commandAllowList');
    });

    it('can lower the concurrency cap but never raise it', () => {
        expect(applyOrgPolicy(permissive, { capabilities: { maxConcurrentAgents: 2 } }).capabilities.maxConcurrentAgents).toBe(2);
        expect(applyOrgPolicy({ ...permissive, maxConcurrentAgents: 2 }, { capabilities: { maxConcurrentAgents: 8 } })
            .capabilities.maxConcurrentAgents).toBe(2);
    });

    it('treats a 0 token budget as unlimited, not as the tightest value', () => {
        // `Math.min(0, 50_000)` is 0, so the obvious implementation lets an org setting a
        // ceiling *remove* one. A sentinel meaning infinity while sorting smallest is
        // exactly the bug that passes review.
        expect(tightenBudget(0, 50_000)).toBe(50_000);      // user unlimited, org sets a ceiling
        expect(tightenBudget(50_000, 0)).toBe(50_000);      // org declines to set one
        expect(tightenBudget(50_000, 10_000)).toBe(10_000);
        expect(tightenBudget(10_000, 50_000)).toBe(10_000); // org may not raise it
    });

    it('never raises the capability score, for any policy', () => {
        // The property, asserted over the whole structure rather than field by field —
        // a field-by-field test passes forever and cannot catch the next field somebody
        // adds with the direction reversed.
        const hostile: Array<Partial<Capabilities>> = [
            { autoApproveTerminal: true, autoApproveFileEdits: true, autoApproveFileCreate: true },
            { commandAllowList: ['npm', 'git', 'make', 'rm', 'curl'] },
            { commandDenyList: [] },
            { denyGlobs: [] },
            { maxConcurrentAgents: 99 },
            { sessionTokenBudget: 0 },
            { allowExternalPosting: true, analyticsEnabled: true, allowRemoteSkillPacks: true },
        ];
        for (const start of [DEFAULT_CAPABILITIES, permissive]) {
            const before = capabilityScore(start);
            for (const capabilities of hostile) {
                const after = capabilityScore(applyOrgPolicy(start, { capabilities }).capabilities);
                expect(after, JSON.stringify(capabilities)).toBeLessThanOrEqual(before);
            }
        }
    });

    it('reports a refusal prominently rather than dropping it quietly', () => {
        // A policy asking to widen is either a mistake or an attack; both deserve to be seen.
        const result = applyOrgPolicy(DEFAULT_CAPABILITIES, { capabilities: { autoApproveTerminal: true } });
        expect(describeClamps(result, 'SOC2')).toContain('can only restrict, never grant');
        expect(describeClamps(result, 'SOC2')).toContain('SOC2');
    });

    it('ignores a malformed policy rather than failing the extension', () => {
        // A policy file that can cause an outage is one an org stops deploying.
        const { policy, problems } = parseOrgPolicy('{ not json');
        expect(policy).toBeUndefined();
        expect(problems[0]).toContain('ignored');
        expect(applyOrgPolicy(permissive, policy).capabilities).toEqual(permissive);
    });

    it('is a no-op when there is no policy at all', () => {
        expect(applyOrgPolicy(permissive, undefined).capabilities).toEqual(permissive);
        expect(applyOrgPolicy(permissive, {}).clamps).toEqual([]);
    });
});

// ─── Clauses 1 and 4: egress ────────────────────────────────────────────────

describe('clause 1: the default build phones home to nobody', () => {
    it('has no egress point that is neither user-triggered nor part of a run', () => {
        // Computed rather than written down, so a future always-on entry appears here
        // automatically instead of being caught by whoever remembers to look.
        expect(phoneHomePoints()).toEqual([]);
    });

    it('names a reason and a module for every registered destination', () => {
        for (const point of EGRESS_REGISTER) {
            expect(point.why.length, point.id).toBeGreaterThan(30);
            expect(point.module, point.id).toMatch(/\.ts$/);
        }
    });

    it('every registered module actually exists', () => {
        // The register is an allowlist a test enforces, not documentation. A stale entry
        // makes the list a fiction, which is worse than no list.
        for (const point of EGRESS_REGISTER) {
            const file = path.join(__dirname, '..', 'src', point.module);
            expect(fs.existsSync(file), `${point.module} is registered but missing`).toBe(true);
        }
    });

    it('every module that makes a network call is registered', () => {
        // The other direction, and the one that matters: adding egress without declaring
        // it must fail. Walks the source for outbound primitives.
        const src = path.join(__dirname, '..', 'src');
        const declared = new Set(EGRESS_REGISTER.map(p => p.module));
        const offenders: string[] = [];

        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (!entry.name.endsWith('.ts')) continue;
                const rel = path.relative(src, full).replace(/\\/g, '/');
                if (declared.has(rel)) continue;
                const text = fs.readFileSync(full, 'utf8');
                // `fetch(`, `https.request`, `axios`, `new WebSocket`. Comments mentioning
                // them are fine; a call is not.
                if (/(^|[^.\w])fetch\s*\(/m.test(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))
                    || /https?\.request\s*\(/.test(text)
                    || /new\s+WebSocket\s*\(/.test(text)) {
                    offenders.push(rel);
                }
            }
        };
        walk(src);
        expect(offenders, `undeclared egress in: ${offenders.join(', ')}`).toEqual([]);
    });

    it('every module that reaches the network through a subprocess is registered too', () => {
        /*
         * The gap the register had until 2026-08-03, and the reason this clause is a
         * second test rather than a wider regex in the first.
         *
         * The walk above looks for `fetch`, `https.request` and `WebSocket`, so it can
         * only ever find egress that goes through Node. `agent/pipeline-entry.ts` has
         * been running `git push -u origin` and `gh pr create` since Phase 6 — real
         * egress, to a real remote, invisible to the accounting that claims "the only
         * egress is this list". A register whose enforcement only covers the shapes it
         * already knows about documents its own test rather than the code.
         *
         * The command list is deliberately short and specific. `git log` and `git blame`
         * (M22) are local and must not appear here, or the check becomes noise and gets
         * an exemption list, which is how it stops holding.
         */
        const src = path.join(__dirname, '..', 'src');
        const declared = new Set(EGRESS_REGISTER.map(p => p.module));
        const offenders: string[] = [];
        const networkCommands = /\b(?:git\s+(?:push|pull|clone|fetch|ls-remote)|gh\s+(?:pr|repo|api|issue)|npm\s+(?:install|i|publish)|npx\s|curl\s|wget\s|scp\s)/;

        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (!entry.name.endsWith('.ts')) continue;
                const rel = path.relative(src, full).replace(/\\/g, '/');
                if (declared.has(rel)) continue;
                // Comments discussing a command are fine; a string literal holding one,
                // in a file that also spawns processes, is not.
                const text = fs.readFileSync(full, 'utf8')
                    .replace(/^\s*(?:\/\/|\*).*$/gm, '')
                    .replace(/\/\*[\s\S]*?\*\//g, '');
                if (!/execFile\s*\(|\bspawn\s*\(|\bexec\s*\(|executeCommand\s*\(/.test(text)) continue;
                for (const literal of text.match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) || []) {
                    if (networkCommands.test(literal)) { offenders.push(`${rel} — ${literal.slice(0, 60)}`); break; }
                }
            }
        };
        walk(src);
        expect(offenders, `undeclared subprocess egress in: ${offenders.join(', ')}`).toEqual([]);
    });
});

describe('clause 4: disabling the sink removes all egress', () => {
    it('sends nothing when analytics is off, which is the default', () => {
        expect(decideAnalyticsSend(undefined).send).toBe(false);
        expect(decideAnalyticsSend({ enabled: false }).send).toBe(false);
        expect(decideAnalyticsSend({ enabled: false, endpoint: 'https://collector.example.com' }).send).toBe(false);
    });

    it('sends nothing when enabled with no endpoint, because there is no default endpoint', () => {
        // Not an empty string that falls back to ours, no constant elsewhere. If the URL is
        // absent the sink does nothing, which is what makes clause 4 true by construction.
        const decision = decideAnalyticsSend({ enabled: true });
        expect(decision.send).toBe(false);
        if (!decision.send) expect(decision.reason).toContain('no self-hosted endpoint');
    });

    it('refuses a non-http endpoint rather than guessing', () => {
        expect(decideAnalyticsSend({ enabled: true, endpoint: 'collector.example.com' }).send).toBe(false);
    });

    it('sends only to the org\'s own collector', () => {
        const decision = decideAnalyticsSend({ enabled: true, endpoint: 'https://collector.internal/ingest' });
        expect(decision.send).toBe(true);
        if (decision.send) expect(decision.endpoint).toBe('https://collector.internal/ingest');
    });

    it('has no default endpoint anywhere in the source', () => {
        const egress = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'egress.ts'), 'utf8');
        const code = egress.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        expect(code).not.toMatch(/https?:\/\/[a-z0-9.-]*(blackide|telemetry|analytics)[a-z0-9.-]*/i);
    });

    it('sends counts, never content', () => {
        // Redaction (M54) asks "does this look like a secret". This asks "is this one of
        // the eight things we said we would send" — the only question that survives
        // somebody adding a field to the audit trail later.
        const event = toAnalyticsEvent({
            at: 1, kind: 'tool-result',
            detail: {
                tool: 'read_file', ok: true, tokens: 1200, costUsd: 0.01, durationMs: 90,
                summary: 'the contents of the user\'s private file',
                arguments: { path: '/home/someone/secrets.env' },
                prompt: 'implement the acquisition model',
            },
        });
        expect(event).toEqual({ at: 1, kind: 'tool-result', tool: 'read_file', ok: true, tokens: 1200, costUsd: 0.01, durationMs: 90 });
        expect(JSON.stringify(event)).not.toContain('secrets.env');
        expect(JSON.stringify(event)).not.toContain('acquisition');
    });

    it('every optional egress point names the switch that removes it', () => {
        for (const point of optionalPoints()) {
            expect(point.disabledBy, point.id).toBeTruthy();
        }
    });
});

// ─── Clause 3: nothing posted without an explicit per-action confirmation ───

describe('clause 3: nothing is posted without explicit per-action confirmation', () => {
    const action = { kind: 'comment' as const, destination: 'github.com/acme/api#123', body: 'Fixed in abc123.' };

    it('refuses without a confirmation', () => {
        const decision = decideOutbound(action, { allowExternalPosting: true, confirmedNow: false });
        expect(decision.allowed).toBe(false);
        if (!decision.allowed) expect(decision.reason).toContain('no "always allow"');
    });

    it('refuses when the org policy forbids outbound, even if confirmed', () => {
        const decision = decideOutbound(action, { allowExternalPosting: false, confirmedNow: true });
        expect(decision.allowed).toBe(false);
    });

    it('allows only with both', () => {
        expect(decideOutbound(action, { allowExternalPosting: true, confirmedNow: true }).allowed).toBe(true);
    });

    it('has no way to express a standing grant', () => {
        // The signature is the enforcement: a caller cannot pass "allowed last week"
        // because there is no field for it, so adding ambient posting means changing this
        // type — a change a reviewer sees.
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'task-sources.ts'), 'utf8');
        const contextType = source.slice(source.indexOf('interface OutboundContext'), source.indexOf('export type OutboundDecision') + 200);
        for (const forbidden of ['alwaysAllow', 'remember', 'dontAskAgain', 'trusted', 'standing']) {
            expect(contextType, forbidden).not.toContain(forbidden);
        }
    });

    it('shows the body verbatim in the confirmation', () => {
        // A confirmation that summarises asks the user to approve something they have not
        // read, and the whole value of the gate is that they read it.
        const confirmation = buildConfirmation(action);
        expect(confirmation.action.body).toBe('Fixed in abc123.');
        expect(confirmation.prompt).toContain('cannot be unsent');
        expect(confirmation.prompt).toContain('github.com/acme/api#123');
    });

    it('refuses an empty post', () => {
        expect(decideOutbound({ ...action, body: '  ' }, { allowExternalPosting: true, confirmedNow: true }).allowed).toBe(false);
    });
});

// ─── M67: reading task sources ──────────────────────────────────────────────

describe('task references', () => {
    it('finds a GitHub issue URL and a bare #n', () => {
        const found = findTaskReferences('implement https://github.com/acme/api/issues/42 and also #7');
        expect(found.map(f => `${f.kind}:${f.id}`)).toEqual(expect.arrayContaining(['github:42', 'github:7']));
    });

    it('finds Linear and Jira URLs', () => {
        expect(findTaskReferences('see https://linear.app/acme/issue/ENG-45')[0]).toMatchObject({ kind: 'linear', id: 'ENG-45' });
        expect(findTaskReferences('see https://jira.acme.com/browse/PROJ-9')[0]).toMatchObject({ kind: 'jira', id: 'PROJ-9' });
    });

    it('does not guess a tracker from a bare key', () => {
        // `ENG-45` is equally a Linear id, a Jira key and a branch name. Guessing sends a
        // request to a tracker the user does not use, with their token attached.
        expect(findTaskReferences('rebase onto ENG-45 before merging')).toEqual([]);
    });

    it('does not match a colour or an anchor', () => {
        expect(findTaskReferences('set the background to #fff')).toEqual([]);
        expect(findTaskReferences('the #introduction section')).toEqual([]);
    });

    it('deduplicates repeats', () => {
        expect(findTaskReferences('fix #12, then verify #12 again')).toHaveLength(1);
    });

    it('finds nothing in an ordinary prompt', () => {
        expect(findTaskReferences('add retry logic to the payment client')).toEqual([]);
        expect(findTaskReferences('')).toEqual([]);
    });
});

describe('completionNotice', () => {
    it('goes to the inbox as text, not to a service', () => {
        const notice = completionNotice({ id: 'r1', prompt: 'add retry logic', ok: true, summary: '3 files' });
        expect(notice).toBe('finished: add retry logic — 3 files');
    });

    it('says stopped for a run that did not finish', () => {
        expect(completionNotice({ id: 'r1', prompt: 'x', ok: false })).toContain('stopped');
    });

    it('flattens and truncates a long prompt', () => {
        const notice = completionNotice({ id: 'r1', prompt: `${'x'.repeat(200)}\n\nmore`, ok: true });
        expect(notice.length).toBeLessThan(120);
        expect(notice).not.toContain('\n');
    });
});
