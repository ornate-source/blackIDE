/**
 * Browser-side money and date formatting.
 *
 * Deliberately a *separate* implementation from `src/utils/currency.ts`: the
 * server formats with the invoice's frozen currency, the browser formats with the
 * viewer's locale, and merging them has broken this app twice. Conversion is NOT
 * duplicated here — the browser never converts, it only renders what it was sent.
 */
export function formatAmount(amountMinor: number, currency: string, locale = navigator.language): string {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amountMinor / 100);
}

export function formatDate(at: number, locale = navigator.language): string {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(at));
}

export function formatRelative(at: number, locale = navigator.language): string {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const deltaDays = Math.round((at - Date.now()) / 86_400_000);
    return rtf.format(deltaDays, 'day');
}

export function truncate(text: string, max = 60): string {
    return text.length <= max ? text : text.slice(0, max - 1) + '…';
}
