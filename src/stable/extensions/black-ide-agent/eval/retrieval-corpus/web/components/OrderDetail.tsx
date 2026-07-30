import React, { useState } from 'react';
import { request, ApiError } from '../lib/api-client';
import { formatAmount, formatDate } from '../lib/format';

interface Props {
    orderId: string;
}

/**
 * One order, with the cancel affordance. Cancelling is confirmed first and the
 * button is disabled while in flight — a double click here used to produce two
 * refund attempts and a very confused customer.
 */
export function OrderDetail({ orderId }: Props) {
    const [cancelling, setCancelling] = useState(false);
    const [message, setMessage] = useState<string>();

    async function cancel() {
        if (!window.confirm('Cancel this order? Any payment will be refunded.')) return;
        setCancelling(true);
        try {
            await request(`/orders/${orderId}/cancel`, {
                method: 'POST',
                body: { reason: 'customer_request' },
                idempotencyKey: `cancel-${orderId}`,
            });
            setMessage('Order cancelled. Your refund is on its way.');
        } catch (err) {
            setMessage(err instanceof ApiError ? err.message : 'Could not cancel that order.');
        } finally {
            setCancelling(false);
        }
    }

    return (
        <article>
            <h2>Order {orderId}</h2>
            <p>Placed {formatDate(Date.now())}</p>
            <p>Total {formatAmount(0, 'USD')}</p>
            {message && <p role="status">{message}</p>}
            <button onClick={cancel} disabled={cancelling}>
                {cancelling ? 'Cancelling…' : 'Cancel order'}
            </button>
        </article>
    );
}
