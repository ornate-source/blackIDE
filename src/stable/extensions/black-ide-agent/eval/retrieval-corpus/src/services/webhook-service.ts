import { createHmac, timingSafeEqual } from 'crypto';
import { withRetry } from '../utils/retry';
import { WebhookRepository } from '../repositories/webhook-repository';
import { WebhookDelivery, WebhookEndpoint } from '../models/webhook';
import { config } from '../config';

export class WebhookDeliveryError extends Error {}

/**
 * Outbound webhooks with signed payloads and at-least-once delivery.
 *
 * Deliberately shares the retry/backoff and dead-letter vocabulary of the queue
 * worker without sharing its code: an endpoint is a *customer's* server, so the
 * attempt budget is far longer and failure is normal rather than exceptional.
 */
export class WebhookService {
    constructor(private readonly repo: WebhookRepository) {}

    async deliver(endpoint: WebhookEndpoint, event: string, payload: unknown): Promise<WebhookDelivery> {
        const body = JSON.stringify({ event, data: payload, sent_at: Date.now() });
        const signature = sign(body, endpoint.secret);

        try {
            await withRetry(
                () => post(endpoint.url, body, signature),
                {
                    attempts: config.webhooks.maxAttempts,
                    baseDelayMs: config.webhooks.retryBaseDelayMs,
                    maxDelayMs: 60 * 60_000,
                },
            );
            return this.repo.record({ endpointId: endpoint.id, event, status: 'delivered', attempts: 1 });
        } catch (err) {
            // Exhausted endpoints are disabled rather than retried forever; the
            // customer is emailed and can re-enable from the dashboard.
            await this.repo.disableEndpoint(endpoint.id, String(err));
            return this.repo.record({ endpointId: endpoint.id, event, status: 'exhausted', attempts: config.webhooks.maxAttempts });
        }
    }

    /** Verifies an *inbound* webhook from the payment gateway. */
    static verifyInbound(rawBody: string, header: string, secret: string): boolean {
        const expected = Buffer.from(sign(rawBody, secret));
        const provided = Buffer.from(header);
        if (expected.length !== provided.length) return false;
        return timingSafeEqual(expected, provided);
    }
}

function sign(body: string, secret: string): string {
    return createHmac('sha256', secret).update(body).digest('hex');
}

async function post(url: string, body: string, signature: string): Promise<void> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature': signature },
        body,
    });
    if (!res.ok) throw new WebhookDeliveryError(`endpoint responded ${res.status}`);
}
