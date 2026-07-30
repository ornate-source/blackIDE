import { NextFunction, Request, Response } from 'express';
import { createHash } from 'crypto';

interface StoredResponse {
    status: number;
    body: unknown;
    at: number;
}

const responses = new Map<string, StoredResponse>();

/**
 * Replays the original response for a repeated Idempotency-Key.
 *
 * This is the *HTTP* idempotency layer and is not the same thing as the
 * idempotency key the payment gateway takes (see payment-service). Both exist:
 * this one stops a double-tapped button creating two orders, that one stops a
 * retried gateway call capturing twice. Removing either re-opens a real bug.
 */
export function idempotency(ttlMs = 24 * 60 * 60 * 1000) {
    return (req: Request, res: Response, next: NextFunction) => {
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || req.method === 'GET') return next();

        const fingerprint = createHash('sha256')
            .update(`${key}:${req.method}:${req.path}:${JSON.stringify(req.body ?? null)}`)
            .digest('hex');

        const stored = responses.get(fingerprint);
        if (stored && Date.now() - stored.at < ttlMs) {
            res.setHeader('Idempotent-Replay', 'true');
            return res.status(stored.status).json(stored.body);
        }

        const json = res.json.bind(res);
        res.json = (body: unknown) => {
            responses.set(fingerprint, { status: res.statusCode, body, at: Date.now() });
            return json(body);
        };
        next();
    };
}

/** A key reused with a *different* body is a client bug and must not replay. */
export function conflictsWithStored(key: string, bodyHash: string): boolean {
    for (const stored of responses.keys()) {
        if (stored.startsWith(key) && !stored.endsWith(bodyHash)) return true;
    }
    return false;
}
