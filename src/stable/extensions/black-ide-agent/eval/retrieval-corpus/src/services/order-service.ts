import { Order, OrderLine, canTransition, isTerminal, orderSubtotalMinor } from '../models/order';
import { User } from '../models/user';
import { OrderRepository } from '../repositories/order-repository';
import { chargeCard, refundCharge, PaymentDeclinedError } from './payment-service';
import { reserveStock, releaseStock, OutOfStockError } from './inventory-service';
import { convertMinor } from '../utils/currency';
import { config } from '../config';

export class InvalidTransitionError extends Error {}

export class OrderService {
    constructor(private readonly orders: OrderRepository) {}

    /**
     * Places an order: reserve stock, price it in the customer's currency, then take
     * payment. Stock is reserved *before* the charge so we never take money for
     * something we cannot ship; if the charge fails the reservation is released in
     * the catch below.
     */
    async placeOrder(customer: User, lines: OrderLine[]): Promise<Order> {
        const reservations = await reserveStock(lines);

        try {
            const subtotal = lines.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0);
            const total = convertMinor(subtotal, config.baseCurrency, customer.preferredCurrency);

            const order = await this.orders.create({
                customer,
                lines,
                status: 'awaiting_payment',
                currency: customer.preferredCurrency,
                totalMinor: total,
                placedAt: Date.now(),
            });

            const charge = await chargeCard(order, `order-${order.id}`);
            return this.transition(order, 'paid', { paymentIntentId: charge.paymentIntentId });
        } catch (err) {
            await releaseStock(reservations);
            if (err instanceof PaymentDeclinedError || err instanceof OutOfStockError) {
                throw err;
            }
            throw err;
        }
    }

    /**
     * Cancels an order and, if it was already paid for, refunds it. Cancelling a
     * terminal order is a no-op rather than an error — the button is clickable twice
     * and support should not see a stack trace for a double click.
     */
    async cancelOrder(orderId: string, reason: string): Promise<Order> {
        const order = await this.orders.byId(orderId);
        if (isTerminal(order.status)) return order;

        if (order.status === 'paid' && order.paymentIntentId) {
            await refundCharge(order.paymentIntentId);
        }
        await releaseStock(order.lines.map(l => ({ sku: l.sku, quantity: l.quantity })));

        return this.transition(order, 'cancelled', { cancelledAt: Date.now(), reason });
    }

    /** Recomputes the order total from its lines, e.g. after a support edit. */
    async reprice(orderId: string): Promise<Order> {
        const order = await this.orders.byId(orderId);
        const subtotal = orderSubtotalMinor(order);
        const total = convertMinor(subtotal, config.baseCurrency, order.currency);
        return this.orders.update(order.id, { totalMinor: total });
    }

    private async transition(order: Order, to: Order['status'], patch: Record<string, unknown> = {}): Promise<Order> {
        if (!canTransition(order.status, to)) {
            throw new InvalidTransitionError(`${order.status} → ${to} is not a legal order transition`);
        }
        return this.orders.update(order.id, { status: to, ...patch });
    }
}
