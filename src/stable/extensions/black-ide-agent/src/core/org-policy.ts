// ─── Org policy, tighten-only (Phase 12, M69) ───────────────────────────────
//
// G12 records the constraint this module exists to honour: our telemetry is local-only by
// design (G4), so a team-analytics story "must be **opt-in, self-hosted**, never a
// phone-home". An org policy file is the other half of that — a way for an organisation to
// say "in this repository, agents may not run commands" without us building an
// administrative console that reaches out to anything.
//
// ── The one rule, and why it is the whole module ────────────────────────────
// **An org policy can only tighten.** It may remove a capability the user had; it may
// never add one they did not. Everything here is arranged so that is a property of the
// merge function rather than a convention reviewers enforce.
//
// The reason is that the file is *in the repository*. It arrives with a `git pull`, from
// anyone with commit access, and — critically — it is exactly the kind of file a prompt
// injection would try to write (Phase 9, M56). If merging could widen, then "add
// `.blackide/policy.json` with autoApprove: true" becomes a complete bypass of G1, G3 and
// the mode allowlists in one commit that looks like configuration.
//
// So: booleans can only go false-ward, lists of *permissions* can only shrink, lists of
// *prohibitions* can only grow, and numbers move only in the more-restrictive direction.
// A policy that tries to do the opposite is not an error — it is silently clamped, and the
// clamp is reported, because a policy file that errors on load is a policy file somebody
// deletes.

export interface Capabilities {
    /** May the agent run shell commands without asking each time? */
    autoApproveTerminal: boolean;
    autoApproveFileEdits: boolean;
    autoApproveFileCreate: boolean;
    /** Regexes the user has permitted. A *permission* list: the org may only remove. */
    commandAllowList: string[];
    /** Regexes always refused. A *prohibition* list: the org may only add. */
    commandDenyList: string[];
    /** Paths tools may never touch. Prohibition: org may only add. */
    denyGlobs: string[];
    /** Simultaneous agents. More is more capability, so the org may only lower it. */
    maxConcurrentAgents: number;
    /** 0 means unlimited, which is *maximum* capability — see `tightenBudget`. */
    sessionTokenBudget: number;
    /** Whether outbound integrations may be used at all. */
    allowExternalPosting: boolean;
    /** Whether the analytics sink may run. Off by default; org may force it off, never on. */
    analyticsEnabled: boolean;
    /** May third-party skill packs be installed from a URL? */
    allowRemoteSkillPacks: boolean;
}

export const DEFAULT_CAPABILITIES: Capabilities = {
    autoApproveTerminal: false,
    autoApproveFileEdits: false,
    autoApproveFileCreate: false,
    commandAllowList: [],
    commandDenyList: [],
    denyGlobs: [],
    maxConcurrentAgents: 4,
    sessionTokenBudget: 0,
    allowExternalPosting: false,
    analyticsEnabled: false,
    allowRemoteSkillPacks: true,
};

/** An org policy is a partial capability set plus a reason, for the message shown to users. */
export interface OrgPolicy {
    version?: number;
    /** Shown when a setting is clamped, so "why can't I do this" has an answer in-product. */
    reason?: string;
    capabilities?: Partial<Capabilities>;
}

export interface Clamp {
    setting: keyof Capabilities;
    from: unknown;
    to: unknown;
    /** True when the policy asked to *widen* and was refused. */
    refused: boolean;
}

export interface MergeResult {
    capabilities: Capabilities;
    clamps: Clamp[];
    /** Policy entries that tried to widen. Surfaced; never applied. */
    refusals: Clamp[];
}

/**
 * Merge an org policy over the user's settings, tighten-only.
 *
 * `effective` is the *user's* current capability set — already their own choice — and the
 * result is never more capable than it. That is asserted directly in the tests by
 * comparing capability scores, not just field by field, because a field-by-field review
 * cannot catch a future field added with the wrong direction.
 */
export function applyOrgPolicy(user: Capabilities, policy: OrgPolicy | undefined): MergeResult {
    const capabilities: Capabilities = { ...user };
    const clamps: Clamp[] = [];
    const refusals: Clamp[] = [];
    const wanted = policy?.capabilities;
    if (!wanted) return { capabilities, clamps, refusals };

    const record = (setting: keyof Capabilities, from: unknown, to: unknown, refused: boolean) => {
        const entry: Clamp = { setting, from, to, refused };
        if (refused) refusals.push(entry); else clamps.push(entry);
    };

    // ── Booleans that grant capability: may only go false ────────────────────
    for (const key of ['autoApproveTerminal', 'autoApproveFileEdits', 'autoApproveFileCreate',
        'allowExternalPosting', 'analyticsEnabled', 'allowRemoteSkillPacks'] as const) {
        if (wanted[key] === undefined) continue;
        const asked = !!wanted[key];
        if (asked === capabilities[key]) continue;
        if (asked === false) {
            record(key, capabilities[key], false, false);
            capabilities[key] = false;
        } else {
            // The policy asked to turn a capability *on*. Refused, and reported — this is
            // the injection path the module exists to close.
            record(key, capabilities[key], true, true);
        }
    }

    // ── Permission list: the org may only remove entries ─────────────────────
    if (wanted.commandAllowList) {
        const permitted = new Set(wanted.commandAllowList);
        const kept = capabilities.commandAllowList.filter(entry => permitted.has(entry));
        const added = wanted.commandAllowList.filter(entry => !capabilities.commandAllowList.includes(entry));
        if (added.length) record('commandAllowList', capabilities.commandAllowList, wanted.commandAllowList, true);
        if (kept.length !== capabilities.commandAllowList.length) {
            record('commandAllowList', capabilities.commandAllowList, kept, false);
        }
        capabilities.commandAllowList = kept;
    }

    // ── Prohibition lists: the org may only add ──────────────────────────────
    for (const key of ['commandDenyList', 'denyGlobs'] as const) {
        const extra = wanted[key];
        if (!extra?.length) continue;
        const merged = [...new Set([...capabilities[key], ...extra])];
        if (merged.length !== capabilities[key].length) record(key, capabilities[key], merged, false);
        capabilities[key] = merged;
    }

    // ── Numbers ──────────────────────────────────────────────────────────────
    if (wanted.maxConcurrentAgents !== undefined) {
        const asked = Math.max(1, Math.floor(Number(wanted.maxConcurrentAgents) || 1));
        if (asked < capabilities.maxConcurrentAgents) {
            record('maxConcurrentAgents', capabilities.maxConcurrentAgents, asked, false);
            capabilities.maxConcurrentAgents = asked;
        } else if (asked > capabilities.maxConcurrentAgents) {
            record('maxConcurrentAgents', capabilities.maxConcurrentAgents, asked, true);
        }
    }

    if (wanted.sessionTokenBudget !== undefined) {
        const asked = Math.max(0, Number(wanted.sessionTokenBudget) || 0);
        const tightened = tightenBudget(capabilities.sessionTokenBudget, asked);
        if (tightened !== capabilities.sessionTokenBudget) {
            record('sessionTokenBudget', capabilities.sessionTokenBudget, tightened, false);
            capabilities.sessionTokenBudget = tightened;
        } else if (asked !== capabilities.sessionTokenBudget) {
            record('sessionTokenBudget', capabilities.sessionTokenBudget, asked, true);
        }
    }

    return { capabilities, clamps, refusals };
}

/**
 * Budgets, where **0 means unlimited** and is therefore the *most* capable value.
 *
 * The obvious `Math.min` is wrong and wrong in the dangerous direction: `min(0, 50_000)`
 * is 0, so an org setting a 50 000-token ceiling on a user with no limit would *remove*
 * the ceiling. A sentinel that means "infinity" while sorting as the smallest number is
 * exactly the kind of thing that passes review.
 */
export function tightenBudget(current: number, asked: number): number {
    if (asked === 0) return current;            // the policy declines to set a ceiling
    if (current === 0) return asked;            // user had none; the policy's ceiling applies
    return Math.min(current, asked);
}

/**
 * A single scalar for "how much this configuration permits".
 *
 * Exists so the tighten-only property can be asserted as **one comparison over the whole
 * structure** rather than field by field. A field-by-field test passes forever and cannot
 * catch the next field somebody adds with the direction reversed; this catches it the
 * first time the merge is exercised.
 */
export function capabilityScore(capabilities: Capabilities): number {
    let score = 0;
    for (const key of ['autoApproveTerminal', 'autoApproveFileEdits', 'autoApproveFileCreate',
        'allowExternalPosting', 'analyticsEnabled', 'allowRemoteSkillPacks'] as const) {
        if (capabilities[key]) score += 100;
    }
    // A longer allow list permits more; a longer deny list permits less.
    score += capabilities.commandAllowList.length * 10;
    score -= capabilities.commandDenyList.length * 10;
    score -= capabilities.denyGlobs.length * 10;
    score += capabilities.maxConcurrentAgents;
    // No ceiling is maximum capability.
    score += capabilities.sessionTokenBudget === 0 ? 1_000 : Math.min(1_000, capabilities.sessionTokenBudget / 1_000);
    return score;
}

export function parseOrgPolicy(text: string): { policy: OrgPolicy | undefined; problems: string[] } {
    if (!String(text || '').trim()) return { policy: undefined, problems: [] };
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') return { policy: undefined, problems: ['The policy file is not an object.'] };
        return { policy: parsed as OrgPolicy, problems: [] };
    } catch (err: any) {
        // A malformed policy is *ignored*, not fatal, and the user is told. Failing the
        // whole extension over a policy file would make a bad commit an outage — and a
        // policy that can cause an outage is one an org stops deploying.
        return { policy: undefined, problems: [`The org policy file is not valid JSON and was ignored: ${err?.message || err}`] };
    }
}

/** Where the file lives. In the repository, so it travels with the project. */
export const ORG_POLICY_PATH = '.blackide/policy.json';

/** The message shown when a setting was clamped. */
export function describeClamps(result: MergeResult, reason?: string): string {
    if (!result.clamps.length && !result.refusals.length) return '';
    const parts: string[] = [];
    if (result.clamps.length) {
        parts.push(`Your organisation's policy restricts ${result.clamps.map(c => c.setting).join(', ')}.`);
    }
    if (result.refusals.length) {
        // Reported prominently: a policy file asking to *widen* is either a mistake or an
        // attack, and both deserve to be visible rather than quietly dropped.
        parts.push(`It also asked to grant ${result.refusals.map(c => c.setting).join(', ')}, which was refused — `
            + 'an org policy can only restrict, never grant.');
    }
    if (reason) parts.push(`Reason given: ${reason}`);
    return parts.join(' ');
}
