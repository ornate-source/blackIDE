import { User } from './user';

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'refunded';
export type BillingInterval = 'monthly' | 'quarterly' | 'yearly';

export interface Subscription {
    id: string;
    customer: User;
    planId: string;
    planPriceMinor: number;
    currency: string;
    interval: BillingInterval;
    status: SubscriptionStatus;
    periodIndex: number;
    renewsAt: number;
    dunningAttempts: number;
    lastDeclineCode?: string;
    lastPaymentIntentId?: string;
}

const INTERVAL_DAYS: Record<BillingInterval, number> = {
    monthly: 30,
    quarterly: 91,
    yearly: 365,
};

/**
 * Next renewal timestamp, computed from the *scheduled* renewal rather than from
 * now — otherwise a retry two days late permanently shifts the billing date and
 * customers end up charged on a different day every month.
 */
export function nextRenewalAt(subscription: Subscription): number {
    return subscription.renewsAt + INTERVAL_DAYS[subscription.interval] * 24 * 60 * 60 * 1000;
}

export function isBillable(subscription: Subscription): boolean {
    return subscription.status === 'active' || subscription.status === 'past_due';
}
