import { Invoice, InvoiceStatus } from '../models/invoice';
import { pool } from './db';

export class InvoiceNotFoundError extends Error {
    constructor(id: string) { super(`No invoice ${id}`); }
}

export class InvoiceRepository {
    async byId(id: string): Promise<Invoice> {
        const rows = await pool.query<Invoice>('SELECT * FROM invoices WHERE id = $1', [id]);
        if (rows.length === 0) throw new InvoiceNotFoundError(id);
        return rows[0];
    }

    async create(draft: Omit<Invoice, 'id'>): Promise<Invoice> {
        const rows = await pool.query<Invoice>(
            `INSERT INTO invoices (customer_id, currency, subtotal_minor, tax_minor, total_minor, status, issued_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [draft.customerId, draft.currency, draft.subtotalMinor, draft.taxMinor, draft.totalMinor, draft.status, draft.issuedAt],
        );
        return rows[0];
    }

    async update(id: string, patch: Partial<Invoice>): Promise<Invoice> {
        const keys = Object.keys(patch);
        const assignments = keys.map((k, i) => `${snake(k)} = $${i + 2}`).join(', ');
        const rows = await pool.query<Invoice>(
            `UPDATE invoices SET ${assignments} WHERE id = $1 RETURNING *`,
            [id, ...keys.map(k => (patch as any)[k])],
        );
        if (rows.length === 0) throw new InvoiceNotFoundError(id);
        return rows[0];
    }

    /** Open invoices past their due date, oldest first — the dunning job's input. */
    async overdue(before: number, limit = 200): Promise<Invoice[]> {
        return pool.query<Invoice>(
            `SELECT * FROM invoices WHERE status = 'open' AND issued_at < $1
             ORDER BY issued_at ASC LIMIT $2`,
            [before, limit],
        );
    }

    async countByStatus(status: InvoiceStatus): Promise<number> {
        const rows = await pool.query<{ count: string }>(
            'SELECT COUNT(*)::text AS count FROM invoices WHERE status = $1', [status],
        );
        return Number(rows[0]?.count ?? 0);
    }
}

function snake(field: string): string {
    return field.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
}
