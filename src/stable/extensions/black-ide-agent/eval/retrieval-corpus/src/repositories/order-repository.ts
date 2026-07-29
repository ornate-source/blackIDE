import { Order, OrderStatus } from '../models/order';
import { pool } from './db';

export class OrderNotFoundError extends Error {
    constructor(id: string) { super(`No order ${id}`); }
}

export class OrderRepository {
    async byId(id: string): Promise<Order> {
        const rows = await pool.query<Order>('SELECT * FROM orders WHERE id = $1', [id]);
        if (rows.length === 0) throw new OrderNotFoundError(id);
        return rows[0];
    }

    async create(draft: Omit<Order, 'id'>): Promise<Order> {
        const rows = await pool.query<Order>(
            `INSERT INTO orders (customer_id, status, currency, total_minor, placed_at)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [draft.customer.id, draft.status, draft.currency, draft.totalMinor, draft.placedAt],
        );
        return rows[0];
    }

    async update(id: string, patch: Partial<Order> & Record<string, unknown>): Promise<Order> {
        const keys = Object.keys(patch);
        const assignments = keys.map((k, i) => `${columnFor(k)} = $${i + 2}`).join(', ');
        const rows = await pool.query<Order>(
            `UPDATE orders SET ${assignments} WHERE id = $1 RETURNING *`,
            [id, ...keys.map(k => (patch as any)[k])],
        );
        if (rows.length === 0) throw new OrderNotFoundError(id);
        return rows[0];
    }

    /** Paginated listing, newest first. Keyset pagination — OFFSET degrades badly here. */
    async listForCustomer(customerId: string, opts: { limit: number; before?: number }): Promise<Order[]> {
        return pool.query<Order>(
            `SELECT * FROM orders
             WHERE customer_id = $1 AND placed_at < $2
             ORDER BY placed_at DESC LIMIT $3`,
            [customerId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit],
        );
    }

    async countByStatus(status: OrderStatus): Promise<number> {
        const rows = await pool.query<{ count: string }>(
            'SELECT COUNT(*)::text AS count FROM orders WHERE status = $1', [status],
        );
        return Number(rows[0]?.count ?? 0);
    }
}

function columnFor(field: string): string {
    return field.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
}
