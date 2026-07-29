import { Router } from 'express';
import { OrderService, InvalidTransitionError } from '../services/order-service';
import { OrderRepository, OrderNotFoundError } from '../repositories/order-repository';
import { UserRepository } from '../repositories/user-repository';
import { OutOfStockError } from '../services/inventory-service';
import { PaymentDeclinedError } from '../services/payment-service';
import { notifyOrderConfirmed } from '../services/notification-service';
import { requireAuth, requireStaff, AuthedRequest } from '../middleware/auth';
import { formatMoney } from '../utils/currency';

export function orderRoutes(orders: OrderRepository, users: UserRepository): Router {
    const router = Router();
    const service = new OrderService(orders);

    router.use(requireAuth(users));

    router.post('/', async (req: AuthedRequest, res) => {
        try {
            const customer = await users.byId(req.userId!);
            const order = await service.placeOrder(customer, req.body.lines);
            await notifyOrderConfirmed(order);
            res.status(201).json(present(order));
        } catch (err) {
            if (err instanceof OutOfStockError) {
                return res.status(409).json({ error: 'out_of_stock', sku: err.sku, available: err.available });
            }
            if (err instanceof PaymentDeclinedError) {
                return res.status(402).json({ error: 'payment_declined', code: err.declineCode });
            }
            throw err;
        }
    });

    router.get('/', async (req: AuthedRequest, res) => {
        const list = await orders.listForCustomer(req.userId!, {
            limit: Math.min(Number(req.query.limit ?? 20), 100),
            before: req.query.before ? Number(req.query.before) : undefined,
        });
        res.json(list.map(present));
    });

    router.post('/:id/cancel', async (req: AuthedRequest, res) => {
        try {
            const order = await service.cancelOrder(req.params.id, req.body.reason ?? 'customer_request');
            res.json(present(order));
        } catch (err) {
            if (err instanceof OrderNotFoundError) return res.status(404).json({ error: 'not_found' });
            if (err instanceof InvalidTransitionError) return res.status(409).json({ error: err.message });
            throw err;
        }
    });

    router.post('/:id/reprice', requireStaff(users), async (req, res) => {
        res.json(present(await service.reprice(req.params.id)));
    });

    return router;
}

function present(order: { id: string; status: string; totalMinor: number; currency: string }) {
    return {
        id: order.id,
        status: order.status,
        total: formatMoney(order.totalMinor, order.currency),
        currency: order.currency,
    };
}
