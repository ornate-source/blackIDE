// ─── Task sources and outbound confirmation (Phase 12, M67/M68) ─────────────
//
// G13 records the shape: issue trackers and chat as *sources* of work and *destinations*
// for results. E8 already set the rule for the destination half — "**never** an ambient bot
// posting to GitHub without the user asking" — and this module is where that rule lives,
// because it is the half that is easy to get wrong by being helpful.
//
// ── Reading is cheap; writing is not ────────────────────────────────────────
// Pulling an issue's text into context is a read the user initiated by typing
// `implement #123`. Posting a comment back is an action *other people see*, under the
// user's name, that cannot be taken back. The asymmetry is the design: reads follow the
// prompt, writes require a per-action confirmation that **cannot be granted in advance**.
//
// That last clause is the one worth defending. A "don't ask me again" checkbox is the
// natural request and it is exactly what turns this into an ambient bot: the tenth post is
// authorised by a click from three weeks ago on a different repository. So there is no
// blanket grant in the model at all — not a setting that defaults to off; none.

export type TrackerKind = 'github' | 'linear' | 'jira';

export interface TaskReference {
    kind: TrackerKind;
    /** The identifier as the tracker uses it: `123`, `ENG-45`, `PROJ-9`. */
    id: string;
    /** The raw text that matched, so the caller can strip it from the prompt. */
    raw: string;
}

const PATTERNS: Array<{ kind: TrackerKind; pattern: RegExp; group: number }> = [
    // A full URL is unambiguous, so it is tried first.
    { kind: 'github', pattern: /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/gi, group: 1 },
    { kind: 'linear', pattern: /https?:\/\/linear\.app\/[\w-]+\/issue\/([A-Z][A-Z0-9]*-\d+)/gi, group: 1 },
    { kind: 'jira', pattern: /https?:\/\/[\w.-]+\/browse\/([A-Z][A-Z0-9]*-\d+)/gi, group: 1 },
    // Bare forms. `#123` is GitHub by convention.
    { kind: 'github', pattern: /(?:^|\s)#(\d{1,7})\b/g, group: 1 },
];

/**
 * Find issue references in a prompt.
 *
 * Conservative by design. A bare `ENG-45` is deliberately **not** matched: it is equally a
 * Linear id, a Jira key and a branch name, and resolving it by guessing means a request to
 * a tracker the user does not use — with their token attached. A URL or an explicit `#n`
 * is a statement of intent; a bare key is a coincidence waiting to happen.
 */
export function findTaskReferences(prompt: string): TaskReference[] {
    const text = String(prompt || '');
    const out: TaskReference[] = [];
    const seen = new Set<string>();

    for (const { kind, pattern, group } of PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            const id = match[group];
            const key = `${kind}:${id}`;
            if (!id || seen.has(key)) continue;
            seen.add(key);
            out.push({ kind, id, raw: match[0].trim() });
        }
    }
    return out;
}

// ── The outbound half ───────────────────────────────────────────────────────

export type OutboundKind = 'comment' | 'status-change' | 'notification';

export interface OutboundAction {
    kind: OutboundKind;
    /** Where it goes, in words a human can check before saying yes. */
    destination: string;
    /** Exactly what will be sent. Shown verbatim — a summary is not a confirmation. */
    body: string;
}

export interface ConfirmationRequest {
    action: OutboundAction;
    /** The sentence the user is agreeing to. */
    prompt: string;
}

/**
 * Build the confirmation a user must answer before anything leaves the machine.
 *
 * The body is carried **verbatim**, not summarised. A confirmation that says "post a
 * comment to issue #123?" asks the user to approve something they have not read, and the
 * whole value of the gate is that they read it.
 */
export function buildConfirmation(action: OutboundAction): ConfirmationRequest {
    return {
        action,
        prompt: `Post this ${action.kind.replace('-', ' ')} to ${action.destination}? `
            + 'It will be visible to everyone with access, under your account, and cannot be unsent.',
    };
}

export type OutboundDecision =
    | { allowed: true; action: OutboundAction }
    | { allowed: false; reason: string };

export interface OutboundContext {
    /** From the org policy (M69). False forbids outbound entirely. */
    allowExternalPosting: boolean;
    /** The answer to *this* confirmation. There is deliberately no standing grant. */
    confirmedNow: boolean;
}

/**
 * Decide whether one outbound action may proceed.
 *
 * Note what is absent from `OutboundContext`: any notion of a remembered answer. The
 * signature is the enforcement — a caller cannot pass "the user allowed this last week"
 * because there is no field for it, so the only way to add ambient posting later is to
 * change this type, which is a change a reviewer sees.
 */
export function decideOutbound(action: OutboundAction, context: OutboundContext): OutboundDecision {
    if (!context.allowExternalPosting) {
        return { allowed: false, reason: "Posting to external services is disabled by your organisation's policy." };
    }
    if (!context.confirmedNow) {
        return { allowed: false, reason: 'Not confirmed. Every post is confirmed individually — there is no "always allow".' };
    }
    if (!action.body.trim()) {
        return { allowed: false, reason: 'Nothing to post.' };
    }
    return { allowed: true, action };
}

/**
 * Render a completion notification for the inbox (M68).
 *
 * It goes to the **inbox** (Phase 6) rather than to Slack by default, because the inbox is
 * local and Slack is egress. Forwarding it onward is an outbound action like any other and
 * goes through `decideOutbound`.
 */
export function completionNotice(run: { id: string; prompt: string; ok: boolean; summary?: string }): string {
    const verdict = run.ok ? 'finished' : 'stopped';
    const flat = String(run.prompt || '').replace(/\s+/g, ' ').trim();
    const title = flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
    return `${verdict}: ${title}${run.summary ? ` — ${run.summary}` : ''}`;
}
