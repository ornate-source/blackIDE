import { User } from '../models/user';
import { pool } from './db';

export class UserNotFoundError extends Error {
    constructor(id: string) { super(`No user ${id}`); }
}

export class UserRepository {
    async byId(id: string): Promise<User> {
        const rows = await pool.query<User>('SELECT * FROM users WHERE id = $1', [id]);
        if (rows.length === 0) throw new UserNotFoundError(id);
        return rows[0];
    }

    async byEmail(email: string): Promise<User | undefined> {
        const rows = await pool.query<User>('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
        return rows[0];
    }

    async create(draft: Omit<User, 'id' | 'createdAt'>): Promise<User> {
        const rows = await pool.query<User>(
            `INSERT INTO users (email, display_name, role, preferred_currency, locale, created_at)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [draft.email, draft.displayName, draft.role, draft.preferredCurrency, draft.locale, Date.now()],
        );
        return rows[0];
    }

    /** Soft delete. Rows are kept because orders reference them. */
    async disable(id: string): Promise<void> {
        await pool.query('UPDATE users SET disabled_at = $2 WHERE id = $1', [id, Date.now()]);
    }

    async setPreferredCurrency(id: string, currency: string): Promise<User> {
        const rows = await pool.query<User>(
            'UPDATE users SET preferred_currency = $2 WHERE id = $1 RETURNING *', [id, currency],
        );
        if (rows.length === 0) throw new UserNotFoundError(id);
        return rows[0];
    }
}
