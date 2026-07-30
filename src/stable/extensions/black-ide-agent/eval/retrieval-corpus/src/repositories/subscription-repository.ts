import { Subscription } from '../models/subscription';
import { pool } from './db';

export class SubscriptionNotFoundError extends Error {
    constructor(id: string) { super(`No subscription ${id}`); }
}

export class SubscriptionRepository {
    async byId(id: string): Promise<Subscription> {
        const rows = await pool.query<Subscription>('SELECT * FROM subscriptions WHERE id = $1', [id]);
        if (rows.length === 0) throw new SubscriptionNotFoundError(id);
        return rows[0];
    }

    async update(id: string, patch: Partial<Subscription>): Promise<Subscription> {
        const keys = Object.keys(patch);
        const assignments = keys.map((k, i) => `${snake(k)} = $${i + 2}`).join(', ');
        const rows = await pool.query<Subscription>(
            `UPDATE subscriptions SET ${assignments} WHERE id = $1 RETURNING *`,
            [id, ...keys.map(k => (patch as any)[k])],
        );
        if (rows.length === 0) throw new SubscriptionNotFoundError(id);
        return rows[0];
    }

    /**
     * Subscriptions due for renewal. Claimed with SKIP LOCKED so several renewal
     * workers can run without two of them charging the same card.
     */
    async claimDue(now: number, limit: number): Promise<Subscription[]> {
        return pool.query<Subscription>(
            `SELECT * FROM subscriptions
             WHERE status IN ('active', 'past_due') AND renews_at <= $1
             ORDER BY renews_at ASC LIMIT $2
             FOR UPDATE SKIP LOCKED`,
            [now, limit],
        );
    }

    async forCustomer(customerId: string): Promise<Subscription[]> {
        return pool.query<Subscription>(
            'SELECT * FROM subscriptions WHERE customer_id = $1 ORDER BY renews_at DESC', [customerId],
        );
    }
}

function snake(field: string): string {
    return field.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
}
