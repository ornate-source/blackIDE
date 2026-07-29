import { User } from './user';

export type OrderStatus =
    | 'draft'
    | 'awaiting_payment'
    | 'paid'
    | 'fulfilled'
    | 'cancelled'
    | 'refunded';

export interface OrderLine {
    sku: string;
    quantity: number;
    unitPriceMinor: number;
    currency: string;
}

export interface Order {
    id: string;
    customer: User;
    lines: OrderLine[];
    status: OrderStatus;
    currency: string;
    totalMinor: number;
    placedAt: number;
    cancelledAt?: number;
    paymentIntentId?: string;
}

/** Terminal states never transition again; the state machine below relies on this. */
export const TERMINAL_STATUSES: OrderStatus[] = ['fulfilled', 'cancelled', 'refunded'];

const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
    draft: ['awaiting_payment', 'cancelled'],
    awaiting_payment: ['paid', 'cancelled'],
    paid: ['fulfilled', 'refunded'],
    fulfilled: [],
    cancelled: [],
    refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
    return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: OrderStatus): boolean {
    return TERMINAL_STATUSES.includes(status);
}

export function orderSubtotalMinor(order: Order): number {
    return order.lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);
}
