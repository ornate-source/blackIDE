import { Router } from 'express';
import { UserRepository, UserNotFoundError } from '../repositories/user-repository';
import { requireAuth, requireStaff, AuthedRequest } from '../middleware/auth';
import { canImpersonate, maskEmail } from '../models/user';

export function userRoutes(users: UserRepository): Router {
    const router = Router();

    router.use(requireAuth(users));

    router.get('/me', async (req: AuthedRequest, res) => {
        const user = await users.byId(req.userId!);
        res.json({
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            role: user.role,
            preferredCurrency: user.preferredCurrency,
        });
    });

    router.patch('/me/currency', async (req: AuthedRequest, res) => {
        const currency = String(req.body.currency ?? '').toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) {
            return res.status(400).json({ error: 'currency must be an ISO 4217 code' });
        }
        const user = await users.setPreferredCurrency(req.userId!, currency);
        res.json({ preferredCurrency: user.preferredCurrency });
    });

    router.post('/:id/disable', requireStaff(users), async (req: AuthedRequest, res) => {
        try {
            const actor = await users.byId(req.userId!);
            const target = await users.byId(req.params.id);
            if (!canImpersonate(actor, target)) {
                return res.status(403).json({ error: 'cannot act on this account' });
            }
            await users.disable(target.id);
            res.json({ disabled: maskEmail(target.email) });
        } catch (err) {
            if (err instanceof UserNotFoundError) return res.status(404).json({ error: 'not_found' });
            throw err;
        }
    });

    return router;
}
