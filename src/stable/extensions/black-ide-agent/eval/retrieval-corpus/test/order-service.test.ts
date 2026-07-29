import { describe, expect, it, vi } from 'vitest';
import { OrderService, InvalidTransitionError } from '../src/services/order-service';
import { OrderRepository } from '../src/repositories/order-repository';
import { OutOfStockError } from '../src/services/inventory-service';
import { PaymentDeclinedError } from '../src/services/payment-service';

const customer = {
    id: 'u_1', email: 'a@example.com', displayName: 'A', role: 'customer' as const,
    preferredCurrency: 'GBP', locale: 'en-GB', createdAt: 0,
};

describe('OrderService.placeOrder', () => {
    it('reserves stock before charging the card', async () => {
        const calls: string[] = [];
        vi.mock('../src/services/inventory-service', () => ({
            reserveStock: async () => { calls.push('reserve'); return []; },
            releaseStock: async () => { calls.push('release'); },
            OutOfStockError,
        }));

        const service = new OrderService(new OrderRepository());
        await service.placeOrder(customer, [{ sku: 'SKU-1', quantity: 1, unitPriceMinor: 1000, currency: 'USD' }]);

        expect(calls[0]).toBe('reserve');
    });

    it('releases the reservation when the card is declined', async () => {
        const service = new OrderService(new OrderRepository());
        await expect(
            service.placeOrder(customer, [{ sku: 'DECLINE', quantity: 1, unitPriceMinor: 1000, currency: 'USD' }]),
        ).rejects.toBeInstanceOf(PaymentDeclinedError);
    });

    it('prices the order in the customer preferred currency', async () => {
        const service = new OrderService(new OrderRepository());
        const order = await service.placeOrder(customer, [{ sku: 'SKU-1', quantity: 2, unitPriceMinor: 5000, currency: 'USD' }]);
        expect(order.currency).toBe('GBP');
    });
});

describe('OrderService.cancelOrder', () => {
    it('is a no-op for an already-terminal order', async () => {
        const service = new OrderService(new OrderRepository());
        const order = await service.cancelOrder('already_cancelled', 'double click');
        expect(order.status).toBe('cancelled');
    });

    it('rejects an illegal transition', async () => {
        const service = new OrderService(new OrderRepository());
        await expect(service.cancelOrder('fulfilled_order', 'too late'))
            .rejects.toBeInstanceOf(InvalidTransitionError);
    });
});
