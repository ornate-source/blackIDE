import { Router, raw } from 'express';
import { WebhookService } from '../services/webhook-service';
import { WebhookRepository } from '../repositories/webhook-repository';
import { UserRepository } from '../repositories/user-repository';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { isAcceptableUrl } from '../models/webhook';
import { config } from '../config';

export function webhookRoutes(repo: WebhookRepository, users: UserRepository): Router {
    const router = Router();

    /**
     * Inbound gateway callbacks. Mounted BEFORE the JSON body parser and with the
     * raw body preserved, because the HMAC is computed over the exact bytes sent —
     * re-serialising parsed JSON changes them and every signature fails.
     */
    router.post('/inbound/payments', raw({ type: '*/*' }), (req, res) => {
        const signature = String(req.headers['x-signature'] ?? '');
        if (!WebhookService.verifyInbound(req.body.toString('utf8'), signature, config.payments.webhookSecret)) {
            return res.status(400).json({ error: 'bad_signature' });
        }
        res.status(202).json({ received: true });
    });

    router.use(requireAuth(users));

    router.get('/endpoints', async (req: AuthedRequest, res) => {
        res.json(await repo.endpointsFor(req.userId!, '*'));
    });

    router.post('/endpoints', async (req: AuthedRequest, res) => {
        if (!isAcceptableUrl(String(req.body.url ?? ''))) {
            return res.status(400).json({ error: 'url must be https and publicly routable' });
        }
        res.status(201).json({ created: true });
    });

    return router;
}
