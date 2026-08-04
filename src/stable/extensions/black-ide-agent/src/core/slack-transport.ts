import { OutboundAction, completionNotice } from './task-sources';

// ─── Slack transport for completion notices (Phase 12, M68 · P12-2) ────────
//
// The acceptance clause: "outbound goes through the per-action confirmation; **no
// `alwaysAllow` field can express a standing grant**."
//
// The second half is a claim about a *type*, not about a code path, and that is why this
// module builds an `OutboundAction` and stops. It does not send anything. It cannot:
// sending is `decideOutbound` plus a caller that has just shown the user the message,
// and `OutboundContext` has no field a remembered answer could live in.
//
// ── Why a completion notice is the hardest case for that rule ──────────────
// Every other outbound action in the product is something the user just did — post this
// review, comment on this issue. A completion notice is different: it fires when a run
// *ends*, which is exactly when the user is not looking, and the natural feature request
// is "just send them all to #dev-agents". That request is the definition of an ambient
// bot, and it is the one this milestone exists to refuse.
//
// So the default destination for a completion notice is the **inbox** (Phase 6), which is
// local and needs no confirmation at all. Slack is a thing the user forwards a notice to,
// one notice at a time, having read it. `task-sources.ts` already states that; this is
// the transport that respects it.

export interface SlackTarget {
    /** An incoming-webhook URL, or a channel id when using a bot token. */
    webhookUrl?: string;
    botToken?: string;
    channel?: string;
}

export interface SlackMessage {
    /** Plain-text fallback, and what a notification shows. */
    text: string;
    /** Block Kit payload, for the message body. */
    blocks: unknown[];
}

export type SlackConfigError = { ok: false; reason: string };

/**
 * Validate a Slack destination.
 *
 * https-only, and the host is checked against Slack's own domain for the webhook form.
 * A webhook URL is a bearer credential in a string — anyone holding it can post as that
 * integration — so sending it to a host the user typo'd is a credential disclosure, not
 * a failed request.
 */
export function validateTarget(target: SlackTarget): { ok: true; target: SlackTarget } | SlackConfigError {
    if (target.webhookUrl) {
        let url: URL;
        try { url = new URL(target.webhookUrl); } catch { return { ok: false, reason: 'The webhook URL is not a valid URL.' }; }
        if (url.protocol !== 'https:') {
            return { ok: false, reason: 'The webhook URL must be https — a webhook URL is a credential.' };
        }
        if (url.hostname !== 'hooks.slack.com') {
            return {
                ok: false,
                reason: `Refusing to post to ${url.hostname}: a Slack webhook URL is a bearer credential, and `
                    + 'sending it to another host discloses it. Only hooks.slack.com is accepted.',
            };
        }
        return { ok: true, target };
    }

    if (target.botToken) {
        if (!target.channel) return { ok: false, reason: 'A bot token needs a channel.' };
        return { ok: true, target };
    }

    return { ok: false, reason: 'No Slack webhook URL or bot token is configured.' };
}

/**
 * Build the message for a finished run.
 *
 * Deliberately terse. A completion notice competes for attention in a channel with
 * everything else in it, and a wall of tool calls is what makes a team mute the
 * integration — after which the notices still arrive and nobody reads them, which is
 * worse than not sending them.
 */
export function buildCompletionMessage(run: {
    id: string;
    prompt: string;
    ok: boolean;
    summary?: string;
    changed?: string[];
    branch?: string;
}): SlackMessage {
    const headline = completionNotice(run);
    const details = [
        run.branch ? `branch \`${run.branch}\`` : '',
        run.changed?.length ? `${run.changed.length} file(s) changed` : '',
    ].filter(Boolean).join(' · ');

    return {
        text: headline,
        blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `${run.ok ? '✅' : '⚠️'} ${headline}` } },
            ...(details ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: details }] }] : []),
            {
                type: 'context',
                elements: [{
                    type: 'mrkdwn',
                    // Said in the message itself, because the recipients are not the person
                    // who confirmed it and have no other way to know what this channel is.
                    text: '_Sent by Black IDE because someone confirmed this specific message. '
                        + 'There is no automatic posting._',
                }],
            },
        ],
    };
}

/**
 * The outbound action a user confirms before anything is sent.
 *
 * `body` is the message as it will appear — `buildConfirmation` shows it verbatim, and a
 * confirmation the user has not read is not one.
 */
export function slackOutboundAction(target: SlackTarget, message: SlackMessage): OutboundAction {
    const destination = target.channel
        ? `Slack ${target.channel}`
        : `Slack (incoming webhook ${maskWebhook(target.webhookUrl)})`;
    return { kind: 'notification', destination, body: message.text };
}

/**
 * Show enough of a webhook URL to recognise it, and not enough to use it.
 *
 * The confirmation dialogue has to say *where* the message is going or the user cannot
 * make a decision — and printing the whole URL puts a live credential into a screenshot
 * the moment somebody reports a bug about this feature.
 */
export function maskWebhook(url: string | undefined): string {
    if (!url) return 'unset';
    try {
        const parsed = new URL(url);
        const segments = parsed.pathname.split('/').filter(Boolean);
        const team = segments[1] || '';
        return `${parsed.hostname}/…/${team}/…`;
    } catch { return 'invalid'; }
}

export interface SlackRequest {
    url: string;
    headers: Record<string, string>;
    body: string;
}

/** The HTTP request. Built only after `decideOutbound` has allowed this specific action. */
export function buildSlackRequest(target: SlackTarget, message: SlackMessage): SlackRequest {
    if (target.botToken) {
        return {
            url: 'https://slack.com/api/chat.postMessage',
            headers: { authorization: `Bearer ${target.botToken}`, 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ channel: target.channel, text: message.text, blocks: message.blocks }),
        };
    }
    return {
        url: target.webhookUrl!,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: message.text, blocks: message.blocks }),
    };
}

/**
 * Interpret Slack's answer.
 *
 * `chat.postMessage` answers **HTTP 200 with `{"ok": false}`** on failure, so a status
 * check alone reports every failure as a success — including an invalid token. This is
 * the single most common way a Slack integration is silently broken for a month.
 */
export function interpretSlackResponse(status: number, body: unknown): { ok: true } | { ok: false; reason: string } {
    if (status < 200 || status >= 300) {
        return { ok: false, reason: `Slack answered HTTP ${status}.` };
    }
    if (body && typeof body === 'object' && 'ok' in (body as object)) {
        const json = body as { ok?: boolean; error?: string };
        if (json.ok === false) return { ok: false, reason: `Slack refused it: ${json.error || 'no reason given'}.` };
    }
    return { ok: true };
}
