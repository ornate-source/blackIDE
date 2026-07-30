import { Order } from '../models/order';
import { withRetry } from '../utils/retry';
import { config } from '../config';

export interface ChargeResult {
    paymentIntentId: string;
    capturedMinor: number;
    currency: string;
}

export class PaymentDeclinedError extends Error {
    constructor(public readonly declineCode: string) {
        super(`Card was declined (${declineCode})`);
    }
}

/**
 * Charges the customer's saved card for the order total.
 *
 * The gateway call is wrapped in exponential backoff because the provider returns
 * 503 under load and a dropped charge is worse than a slow one. A decline is NOT
 * retried — the card said no, and retrying a decline is how you get an account
 * flagged for fraud.
 */
export async function chargeCard(order: Order, idempotencyKey: string): Promise<ChargeResult> {
    return withRetry(
        async () => {
            const response = await gatewayPost('/v1/charges', {
                amount: order.totalMinor,
                currency: order.currency,
                customer_id: order.customer.id,
                idempotency_key: idempotencyKey,
            });

            if (response.status === 'declined') {
                throw new PaymentDeclinedError(response.decline_code || 'generic_decline');
            }

            return {
                paymentIntentId: response.id,
                capturedMinor: response.amount_captured,
                currency: response.currency,
            };
        },
        {
            attempts: config.payments.maxAttempts,
            baseDelayMs: config.payments.retryBaseDelayMs,
            isRetryable: (err) => !(err instanceof PaymentDeclinedError),
        },
    );
}

/** Refunds a previously captured charge, in full or in part. */
export async function refundCharge(paymentIntentId: string, amountMinor?: number): Promise<void> {
    await gatewayPost('/v1/refunds', {
        payment_intent: paymentIntentId,
        amount: amountMinor,
    });
}

async function gatewayPost(pathname: string, body: Record<string, unknown>): Promise<any> {
    const res = await fetch(config.payments.baseUrl + pathname, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.payments.apiKey}`,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok && res.status >= 500) {
        throw new Error(`payment gateway ${res.status}`);
    }
    return res.json();
}
