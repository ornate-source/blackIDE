import { config } from '../config';

/** Minor-unit exponent per currency. JPY has none; most have two. */
const EXPONENTS: Record<string, number> = {
    USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, JPY: 0, KRW: 0, BHD: 3,
};

const RATES: Record<string, number> = {
    USD: 1, EUR: 0.92, GBP: 0.79, CAD: 1.36, AUD: 1.52, JPY: 157.2, KRW: 1370, BHD: 0.376,
};

export function exponentFor(currency: string): number {
    return EXPONENTS[currency.toUpperCase()] ?? 2;
}

/**
 * Converts an amount held in minor units from one currency to another.
 *
 * Rounds half-up at the target currency's exponent — never store a fractional minor
 * unit, and never convert a converted amount back, because two roundings do not
 * cancel out. Callers keep the base-currency figure as the source of truth.
 */
export function convertMinor(amountMinor: number, from: string, to: string): number {
    if (from.toUpperCase() === to.toUpperCase()) return amountMinor;

    const fromRate = RATES[from.toUpperCase()];
    const toRate = RATES[to.toUpperCase()];
    if (!fromRate || !toRate) {
        throw new Error(`No exchange rate for ${from} → ${to}`);
    }

    const major = amountMinor / 10 ** exponentFor(from);
    const converted = (major / fromRate) * toRate;
    return Math.round(converted * 10 ** exponentFor(to));
}

/** Renders minor units for display, e.g. 129999 GBP → "£1,299.99". */
export function formatMoney(amountMinor: number, currency: string, locale = config.defaultLocale): string {
    return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currency.toUpperCase(),
        minimumFractionDigits: exponentFor(currency),
    }).format(amountMinor / 10 ** exponentFor(currency));
}

export function sumMinor(amounts: number[]): number {
    return amounts.reduce((a, b) => a + b, 0);
}
