import express from 'express';
import { orderRoutes } from './routes/orders';
import { userRoutes } from './routes/users';
import { rateLimit } from './middleware/rate-limit';
import { OrderRepository } from './repositories/order-repository';
import { UserRepository } from './repositories/user-repository';
import { pool } from './repositories/db';
import { config } from './config';

export function createApp() {
    const app = express();
    const orders = new OrderRepository();
    const users = new UserRepository();

    app.use(express.json({ limit: '1mb' }));
    app.use(rateLimit());

    app.get('/healthz', (_req, res) => res.json({ ok: true, pool: pool.stats() }));
    app.use('/orders', orderRoutes(orders, users));
    app.use('/users', userRoutes(users));

    // Terminal error handler. Anything reaching here is a bug, so it is logged with
    // the stack and answered with a generic body — never the message, which can carry
    // row contents or a connection string.
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        console.error('[unhandled]', err.stack);
        res.status(500).json({ error: 'internal_error' });
    });

    return app;
}

export function start() {
    const app = createApp();
    return app.listen(config.http.port, () => {
        console.log(`listening on :${config.http.port}`);
    });
}

if (require.main === module) start();
