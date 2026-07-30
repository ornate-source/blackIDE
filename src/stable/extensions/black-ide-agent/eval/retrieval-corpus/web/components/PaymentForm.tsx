import React, { useState } from 'react';
import { request, ApiError } from '../lib/api-client';
import { formatAmount } from '../lib/format';

interface Props {
    orderId: string;
    amountMinor: number;
    currency: string;
    onPaid: () => void;
}

/**
 * Card entry form. The card number never reaches our servers — the iframe below
 * is the gateway's, and we only ever see the token it posts back. Anything that
 * would change that is a PCI scope change, not a UI tweak.
 */
export function PaymentForm({ orderId, amountMinor, currency, onPaid }: Props) {
    const [submitting, setSubmitting] = useState(false);
    const [declineMessage, setDeclineMessage] = useState<string>();

    async function submit(cardToken: string) {
        setSubmitting(true);
        setDeclineMessage(undefined);
        try {
            await request(`/orders/${orderId}/pay`, {
                method: 'POST',
                body: { cardToken },
                idempotencyKey: `pay-${orderId}`,
            });
            onPaid();
        } catch (err) {
            setDeclineMessage(
                err instanceof ApiError && err.status === 402
                    ? 'Your card was declined. Try another card.'
                    : 'Something went wrong taking payment. You have not been charged twice.'
            );
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <form onSubmit={e => { e.preventDefault(); submit(readTokenFromFrame()); }}>
            <p>Amount due: {formatAmount(amountMinor, currency)}</p>
            <iframe title="card" src="https://payments.example.internal/frame" />
            {declineMessage && <p role="alert">{declineMessage}</p>}
            <button type="submit" disabled={submitting}>
                {submitting ? 'Charging…' : `Pay ${formatAmount(amountMinor, currency)}`}
            </button>
        </form>
    );
}

function readTokenFromFrame(): string {
    return 'tok_placeholder';
}
