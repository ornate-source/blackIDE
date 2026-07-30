import React from 'react';
import { request } from '../lib/api-client';
import { formatAmount } from '../lib/format';

const SUPPORTED = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'] as const;

interface Props {
    value: string;
    previewMinor?: number;
    onChange: (currency: string) => void;
}

/**
 * Lets a customer pick the currency their orders are priced in.
 *
 * The preview is illustrative only and is rendered from a figure the server sent;
 * the browser never converts, because a client-side rate would disagree with the
 * charge by a cent and every such cent becomes a support ticket.
 */
export function CurrencySelector({ value, previewMinor, onChange }: Props) {
    async function save(currency: string) {
        await request('/users/me/currency', { method: 'PATCH', body: { currency } });
        onChange(currency);
    }

    return (
        <label>
            Display prices in
            <select value={value} onChange={e => save(e.target.value)}>
                {SUPPORTED.map(code => (
                    <option key={code} value={code}>{code}</option>
                ))}
            </select>
            {previewMinor !== undefined && (
                <span aria-live="polite"> e.g. {formatAmount(previewMinor, value)}</span>
            )}
        </label>
    );
}
