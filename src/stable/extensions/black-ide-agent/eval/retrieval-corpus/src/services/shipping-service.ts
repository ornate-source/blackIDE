import { ShipmentRepository } from '../repositories/shipment-repository';
import { Shipment, ShipmentStatus } from '../models/shipment';
import { availableUnits } from './inventory-service';
import { withRetry } from '../utils/retry';
import { config } from '../config';

export class CarrierUnavailableError extends Error {}

/**
 * Books shipments with the carrier once stock has been reserved and paid for.
 * Reservation itself belongs to inventory-service; this file only consumes the
 * already-held units, which is why it reads stock but never decrements it.
 */
export class ShippingService {
    constructor(private readonly shipments: ShipmentRepository) {}

    async book(orderId: string, skus: string[], address: string): Promise<Shipment> {
        for (const sku of skus) {
            const units = await availableUnits(sku);
            if (units < 0) throw new Error(`negative stock for ${sku} — reservation bug upstream`);
        }

        const label = await withRetry(
            () => requestLabel(orderId, address),
            { attempts: 3, baseDelayMs: 400, isRetryable: (e) => e instanceof CarrierUnavailableError },
        );

        return this.shipments.create({
            orderId,
            skus,
            address,
            carrier: config.shipping.carrier,
            trackingNumber: label.trackingNumber,
            status: 'booked',
            bookedAt: Date.now(),
        });
    }

    async advance(shipmentId: string, to: ShipmentStatus): Promise<Shipment> {
        return this.shipments.update(shipmentId, { status: to, updatedAt: Date.now() });
    }

    /** Estimated delivery in whole days, from the carrier's service level. */
    estimateDays(serviceLevel: 'standard' | 'express' | 'overnight'): number {
        return { standard: 5, express: 2, overnight: 1 }[serviceLevel];
    }
}

async function requestLabel(orderId: string, address: string): Promise<{ trackingNumber: string }> {
    const res = await fetch(`${config.shipping.baseUrl}/labels`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ order_id: orderId, address }),
    });
    if (res.status >= 500) throw new CarrierUnavailableError(`carrier ${res.status}`);
    return res.json();
}
