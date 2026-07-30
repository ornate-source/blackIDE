import { Shipment, ShipmentStatus } from '../models/shipment';
import { pool } from './db';

export class ShipmentRepository {
    async byId(id: string): Promise<Shipment | undefined> {
        const rows = await pool.query<Shipment>('SELECT * FROM shipments WHERE id = $1', [id]);
        return rows[0];
    }

    async byOrder(orderId: string): Promise<Shipment[]> {
        return pool.query<Shipment>(
            'SELECT * FROM shipments WHERE order_id = $1 ORDER BY booked_at DESC', [orderId],
        );
    }

    async byTrackingNumber(trackingNumber: string): Promise<Shipment | undefined> {
        const rows = await pool.query<Shipment>(
            'SELECT * FROM shipments WHERE tracking_number = $1', [trackingNumber],
        );
        return rows[0];
    }

    async create(draft: Omit<Shipment, 'id'>): Promise<Shipment> {
        const rows = await pool.query<Shipment>(
            `INSERT INTO shipments (order_id, address, carrier, tracking_number, status, booked_at)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [draft.orderId, draft.address, draft.carrier, draft.trackingNumber, draft.status, draft.bookedAt],
        );
        return rows[0];
    }

    async update(id: string, patch: Partial<Shipment>): Promise<Shipment> {
        const keys = Object.keys(patch);
        const assignments = keys.map((k, i) => `${k.replace(/[A-Z]/g, c => '_' + c.toLowerCase())} = $${i + 2}`).join(', ');
        const rows = await pool.query<Shipment>(
            `UPDATE shipments SET ${assignments} WHERE id = $1 RETURNING *`,
            [id, ...keys.map(k => (patch as any)[k])],
        );
        return rows[0];
    }

    async stuckInTransit(olderThanMs: number): Promise<Shipment[]> {
        const status: ShipmentStatus = 'in_transit';
        return pool.query<Shipment>(
            'SELECT * FROM shipments WHERE status = $1 AND updated_at < $2', [status, Date.now() - olderThanMs],
        );
    }
}
