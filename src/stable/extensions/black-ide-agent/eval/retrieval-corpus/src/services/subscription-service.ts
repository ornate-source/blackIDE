import { withRetry } from '../utils/retry';
import { convertMinor } from '../utils/currency';
import { chargeCard, refundCharge, PaymentDeclinedError } from './payment-service';
import { SubscriptionRepository } from '../repositories/subscription-repository';
import { Subscription, nextRenewalAt } from '../models/subscription';
import { config } from '../config';

/**
 * Recurring billing. Shares almost all of its vocabulary with one-off order
 * payment — charge, decline, refund, currency, retry — which is exactly why it
 * lives in its own file: a change to dunning policy must not be made by editing
 * the order path by mistake.
 */
export class SubscriptionService {
    constructor(private readonly subscriptions: SubscriptionRepository) {}

    /** Charges one renewal. A decline starts dunning rather than cancelling outright. */
    async renew(subscriptionId: string): Promise<Subscription> {
        const subscription = await this.subscriptions.byId(subscriptionId);
        const amount = convertMinor(subscription.planPriceMinor, config.baseCurrency, subscription.currency);

        try {
            const charge = await withRetry(
                () => chargeCard(asChargeable(subscription, amount), `sub-${subscription.id}-${subscription.periodIndex}`),
                { attempts: 2, baseDelayMs: 500, isRetryable: (e) => !(e instanceof PaymentDeclinedError) },
            );
            return this.subscriptions.update(subscription.id, {
                status: 'active',
                dunningAttempts: 0,
                lastPaymentIntentId: charge.paymentIntentId,
                renewsAt: nextRenewalAt(subscription),
            });
        } catch (err) {
            if (err instanceof PaymentDeclinedError) return this.enterDunning(subscription, err.declineCode);
            throw err;
        }
    }

    /** Refunds the most recent period, e.g. after a support escalation. */
    async refundLastPeriod(subscriptionId: string): Promise<void> {
        const subscription = await this.subscriptions.byId(subscriptionId);
        if (!subscription.lastPaymentIntentId) return;
        await refundCharge(subscription.lastPaymentIntentId);
        await this.subscriptions.update(subscription.id, { status: 'refunded' });
    }

    private async enterDunning(subscription: Subscription, declineCode: string): Promise<Subscription> {
        const attempts = subscription.dunningAttempts + 1;
        if (attempts >= config.billing.maxDunningAttempts) {
            return this.subscriptions.update(subscription.id, { status: 'cancelled', dunningAttempts: attempts });
        }
        return this.subscriptions.update(subscription.id, {
            status: 'past_due',
            dunningAttempts: attempts,
            lastDeclineCode: declineCode,
        });
    }
}

function asChargeable(subscription: Subscription, totalMinor: number): any {
    return {
        id: subscription.id,
        customer: subscription.customer,
        currency: subscription.currency,
        totalMinor,
        lines: [],
    };
}
