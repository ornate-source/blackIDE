export type ShipmentStatus = 'booked' | 'picked' | 'in_transit' | 'delivered' | 'returned' | 'lost';

export interface Shipment {
    id: string;
    orderId: string;
    skus: string[];
    address: string;
    carrier: string;
    trackingNumber: string;
    status: ShipmentStatus;
    bookedAt: number;
    updatedAt?: number;
    deliveredAt?: number;
}

const NEXT: Record<ShipmentStatus, ShipmentStatus[]> = {
    booked: ['picked', 'lost'],
    picked: ['in_transit', 'lost'],
    in_transit: ['delivered', 'returned', 'lost'],
    delivered: ['returned'],
    returned: [],
    lost: [],
};

export function canAdvance(from: ShipmentStatus, to: ShipmentStatus): boolean {
    return NEXT[from].includes(to);
}

export function isInFlight(status: ShipmentStatus): boolean {
    return status === 'booked' || status === 'picked' || status === 'in_transit';
}
