import { Router } from 'express';
import { UserRepository } from '../repositories/user-repository';
import { OrderRepository } from '../repositories/order-repository';
import { InvoiceRepository } from '../repositories/invoice-repository';
import { requireAuth, requireStaff, AuthedRequest } from '../middleware/auth';
import { forSubject } from '../services/audit-service';
import { snapshot } from '../middleware/metrics';
import { pool } from '../repositories/db';

export function adminRoutes(users: UserRepository, orders: OrderRepository, invoices: InvoiceRepository): Router {
    const router = Router();

    router.use(requireAuth(users), requireStaff(users));

    router.get('/stats', async (_req, res) => {
        res.json({
            ordersPaid: await orders.countByStatus('paid'),
            ordersCancelled: await orders.countByStatus('cancelled'),
            invoicesOpen: await invoices.countByStatus('open'),
            pool: pool.stats(),
        });
    });

    router.get('/latency', (_req, res) => res.json(snapshot()));

    router.get('/audit/:type/:id', async (req: AuthedRequest, res) => {
        res.json(await forSubject(req.params.type as any, req.params.id, 200));
    });

    return router;
}
