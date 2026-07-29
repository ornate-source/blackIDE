import { Router } from 'express';
import { pool } from '../repositories/db';

/**
 * Liveness and readiness are separate endpoints on purpose.
 *
 * `/healthz` answers "is this process alive" and must never touch the database —
 * a slow query would otherwise get healthy pods restarted during an incident,
 * turning a degradation into an outage. `/readyz` is the one that checks
 * dependencies and takes a pod out of rotation.
 */
export function healthRoutes(): Router {
    const router = Router();

    router.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

    router.get('/readyz', async (_req, res) => {
        const stats = pool.stats();
        const saturated = stats.waiting > 0 && stats.idle === 0;
        res.status(saturated ? 503 : 200).json({ ready: !saturated, pool: stats });
    });

    return router;
}
