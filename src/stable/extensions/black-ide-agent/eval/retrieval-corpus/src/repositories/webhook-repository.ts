import { WebhookDelivery, WebhookEndpoint } from '../models/webhook';
import { pool } from './db';

export class WebhookRepository {
    async endpointsFor(customerId: string, event: string): Promise<WebhookEndpoint[]> {
        return pool.query<WebhookEndpoint>(
            `SELECT * FROM webhook_endpoints
             WHERE customer_id = $1 AND disabled_at IS NULL AND ($2 = ANY(events) OR '*' = ANY(events))`,
            [customerId, event],
        );
    }

    async record(delivery: WebhookDelivery): Promise<WebhookDelivery> {
        const rows = await pool.query<WebhookDelivery>(
            `INSERT INTO webhook_deliveries (endpoint_id, event, status, attempts, at)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [delivery.endpointId, delivery.event, delivery.status, delivery.attempts, Date.now()],
        );
        return rows[0] ?? delivery;
    }

    async disableEndpoint(endpointId: string, reason: string): Promise<void> {
        await pool.query(
            'UPDATE webhook_endpoints SET disabled_at = $2, disabled_reason = $3 WHERE id = $1',
            [endpointId, Date.now(), reason.slice(0, 500)],
        );
    }

    /** Delivery success rate over a window, for the customer-facing dashboard. */
    async successRate(endpointId: string, sinceMs: number): Promise<number> {
        const rows = await pool.query<{ delivered: string; total: string }>(
            `SELECT
                 COUNT(*) FILTER (WHERE status = 'delivered')::text AS delivered,
                 COUNT(*)::text AS total
             FROM webhook_deliveries WHERE endpoint_id = $1 AND at >= $2`,
            [endpointId, sinceMs],
        );
        const total = Number(rows[0]?.total ?? 0);
        return total === 0 ? 1 : Number(rows[0].delivered) / total;
    }
}
