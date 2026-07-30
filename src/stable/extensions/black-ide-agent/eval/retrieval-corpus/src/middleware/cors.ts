import { NextFunction, Request, Response } from 'express';
import { config } from '../config';

/**
 * Origin allowlist. Reflecting the request's Origin unconditionally — the usual
 * shortcut — turns every browser on the internet into an authenticated client
 * once credentials are allowed, so the origin is matched, never echoed blindly.
 */
export function cors(allowed: string[] = config.http.allowedOrigins) {
    const allowset = new Set(allowed.map(o => o.toLowerCase()));

    return (req: Request, res: Response, next: NextFunction) => {
        const origin = req.headers.origin?.toLowerCase();
        if (origin && allowset.has(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            res.setHeader('Vary', 'Origin');
        }
        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE');
            res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,idempotency-key');
            return res.status(204).end();
        }
        next();
    };
}
