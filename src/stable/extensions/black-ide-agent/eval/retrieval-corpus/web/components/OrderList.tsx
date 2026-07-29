import React from 'react';
import { useOrders } from '../hooks/useOrders';
import { formatRelative, truncate } from '../lib/format';

/**
 * The customer's order history. Statuses are rendered as text as well as colour —
 * "cancelled" and "delivered" are indistinguishable to a red/green colourblind
 * user if the badge is the only signal.
 */
export function OrderList() {
    const { orders, loading, error, loadMore } = useOrders();

    if (error) return <p role="alert">{error}</p>;

    return (
        <section aria-busy={loading}>
            <h2>Your orders</h2>
            <table>
                <thead>
                    <tr><th>Order</th><th>Status</th><th>Total</th><th>Placed</th></tr>
                </thead>
                <tbody>
                    {orders.map(order => (
                        <tr key={order.id}>
                            <td>{truncate(order.id, 12)}</td>
                            <td><span className={`badge badge--${order.status}`}>{order.status}</span></td>
                            <td>{order.total}</td>
                            <td>{formatRelative(Number(order.id.slice(4)) || Date.now())}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {loading && <p>Loading…</p>}
            <button onClick={loadMore} disabled={loading}>Load more</button>
        </section>
    );
}
