export type PromoKind = 'percent_off' | 'amount_off' | 'free_shipping';

export interface Promo {
    code: string;
    kind: PromoKind;
    /** Percent (1–100) for percent_off, minor units for amount_off, unused otherwise. */
    value: number;
    currency?: string;
    startsAt: number;
    endsAt: number;
    maxRedemptions?: number;
    redemptions: number;
}

export function isRedeemable(promo: Promo, now = Date.now()): boolean {
    if (now < promo.startsAt || now > promo.endsAt) return false;
    if (promo.maxRedemptions !== undefined && promo.redemptions >= promo.maxRedemptions) return false;
    return true;
}

/**
 * Discount in minor units. An amount_off promo in a different currency than the
 * order is refused rather than converted — a rate change must never silently make
 * a coupon more generous than finance signed off on.
 */
export function discountMinor(promo: Promo, subtotalMinor: number, currency: string): number {
    switch (promo.kind) {
        case 'percent_off':
            return Math.round(subtotalMinor * (promo.value / 100));
        case 'amount_off':
            if (promo.currency && promo.currency !== currency) return 0;
            return Math.min(subtotalMinor, promo.value);
        case 'free_shipping':
            return 0;
    }
}
