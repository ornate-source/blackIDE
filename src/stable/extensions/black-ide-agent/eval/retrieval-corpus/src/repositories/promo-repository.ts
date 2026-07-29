import { Promo } from '../models/promo';
import { pool } from './db';

export class PromoRepository {
    async byCode(code: string): Promise<Promo | undefined> {
        const rows = await pool.query<Promo>(
            'SELECT * FROM promos WHERE upper(code) = upper($1)', [code],
        );
        return rows[0];
    }

    /**
     * Atomically increments the redemption counter, refusing to go past the cap.
     * Doing this in SQL rather than read-modify-write is what stops a popular code
     * being over-redeemed by concurrent checkouts.
     */
    async redeem(code: string): Promise<boolean> {
        const rows = await pool.query<{ code: string }>(
            `UPDATE promos SET redemptions = redemptions + 1
             WHERE upper(code) = upper($1)
               AND (max_redemptions IS NULL OR redemptions < max_redemptions)
             RETURNING code`,
            [code],
        );
        return rows.length > 0;
    }

    async active(now: number): Promise<Promo[]> {
        return pool.query<Promo>(
            'SELECT * FROM promos WHERE starts_at <= $1 AND ends_at >= $1', [now],
        );
    }
}
