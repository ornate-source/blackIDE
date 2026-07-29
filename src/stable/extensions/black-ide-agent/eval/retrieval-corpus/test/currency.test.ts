import { describe, expect, it } from 'vitest';
import { convertMinor, exponentFor, formatMoney } from '../src/utils/currency';

describe('convertMinor', () => {
    it('is the identity for a same-currency conversion', () => {
        expect(convertMinor(12345, 'USD', 'usd')).toBe(12345);
    });

    it('crosses the minor-unit exponent boundary for JPY', () => {
        // 100.00 USD → yen has no minor units at all, so the result must be whole.
        const yen = convertMinor(10_000, 'USD', 'JPY');
        expect(Number.isInteger(yen)).toBe(true);
        expect(exponentFor('JPY')).toBe(0);
    });

    it('throws for a currency with no rate rather than silently returning the input', () => {
        expect(() => convertMinor(100, 'USD', 'XYZ')).toThrow();
    });
});

describe('formatMoney', () => {
    it('renders minor units with the right number of decimals', () => {
        expect(formatMoney(129_999, 'GBP', 'en-GB')).toContain('1,299.99');
    });

    it('renders a zero-exponent currency without decimals', () => {
        expect(formatMoney(1500, 'JPY', 'ja-JP')).not.toContain('.');
    });
});
