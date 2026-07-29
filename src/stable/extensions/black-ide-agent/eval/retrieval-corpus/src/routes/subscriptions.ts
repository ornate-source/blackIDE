import { Router } from 'express';
import { SubscriptionService } from '../services/subscription-service';
import { SubscriptionRepository, SubscriptionNotFoundError } from '../repositories/subscription-repository';
import { UserRepository } from '../repositories/user-repository';
import { requireAuth, requireStaff, AuthedRequest } from '../middleware/auth';
import { formatMoney } from '../utils/currency';
import { isBillable } from '../models/subscription';

export function subscriptionRoutes(subscriptions: SubscriptionRepository, users: UserRepository): Router {
    const router = Router();
    const service = new SubscriptionService(subscriptions);

    router.use(requireAuth(users));

    router.get('/', async (req: AuthedRequest, res) => {
        const mine = await subscriptions.forCustomer(req.userId!);
        res.json(mine.map(s => ({
            id: s.id,
            plan: s.planId,
            status: s.status,
            billable: isBillable(s),
            price: formatMoney(s.planPriceMinor, s.currency),
            renewsAt: s.renewsAt,
        })));
    });

    router.post('/:id/renew', requireStaff(users), async (req, res) => {
        try {
            const subscription = await service.renew(req.params.id);
            res.json({ status: subscription.status, renewsAt: subscription.renewsAt });
        } catch (err) {
            if (err instanceof SubscriptionNotFoundError) return res.status(404).json({ error: 'not_found' });
            throw err;
        }
    });

    router.post('/:id/refund-last-period', requireStaff(users), async (req, res) => {
        await service.refundLastPeriod(req.params.id);
        res.status(204).end();
    });

    return router;
}
