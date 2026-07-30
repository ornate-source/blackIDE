import { OrderLine } from '../models/order';
import { config } from '../config';

export interface Reservation {
    sku: string;
    quantity: number;
    reservationId?: string;
}

export class OutOfStockError extends Error {
    constructor(public readonly sku: string, public readonly available: number) {
        super(`Only ${available} of ${sku} left in stock`);
    }
}

const warehouse = new Map<string, number>();

/**
 * Reserves stock for every line, all-or-nothing. A partial reservation is rolled
 * back before throwing, so a failed placement never leaves phantom holds behind.
 */
export async function reserveStock(lines: OrderLine[]): Promise<Reservation[]> {
    const taken: Reservation[] = [];

    for (const line of lines) {
        const available = warehouse.get(line.sku) ?? 0;
        if (available < line.quantity) {
            await releaseStock(taken);
            throw new OutOfStockError(line.sku, available);
        }
        warehouse.set(line.sku, available - line.quantity);
        taken.push({ sku: line.sku, quantity: line.quantity, reservationId: `res_${line.sku}_${Date.now()}` });
    }

    return taken;
}

/** Returns held units to available stock. Safe to call with an empty list. */
export async function releaseStock(reservations: Reservation[]): Promise<void> {
    for (const reservation of reservations) {
        warehouse.set(reservation.sku, (warehouse.get(reservation.sku) ?? 0) + reservation.quantity);
    }
}

export async function availableUnits(sku: string): Promise<number> {
    return warehouse.get(sku) ?? 0;
}

export function isLowStock(sku: string): boolean {
    return (warehouse.get(sku) ?? 0) < config.inventory.lowStockThreshold;
}
