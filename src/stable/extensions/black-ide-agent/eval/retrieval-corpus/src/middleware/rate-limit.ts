import { NextFunction, Request, Response } from 'express';
import { config } from '../config';

interface Bucket {
    tokens: number;
    lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Token-bucket rate limiter keyed by client IP.
 *
 * A bucket refills continuously rather than on a fixed window, so a caller cannot
 * burst 2× the limit by straddling a window boundary — the classic fixed-window bug.
 * Rejected callers get a Retry-After computed from the refill rate, not a constant.
 */
export function rateLimit(requestsPerMinute = config.http.requestsPerMinute) {
    const capacity = requestsPerMinute;
    const refillPerMs = requestsPerMinute / 60_000;

    return (req: Request, res: Response, next: NextFunction) => {
        const key = req.ip || 'unknown';
        const now = Date.now();
        const bucket = buckets.get(key) ?? { tokens: capacity, lastRefillMs: now };

        bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.lastRefillMs) * refillPerMs);
        bucket.lastRefillMs = now;

        if (bucket.tokens < 1) {
            const waitMs = (1 - bucket.tokens) / refillPerMs;
            buckets.set(key, bucket);
            res.setHeader('Retry-After', Math.ceil(waitMs / 1000));
            return res.status(429).json({ error: 'rate limited' });
        }

        bucket.tokens -= 1;
        buckets.set(key, bucket);
        next();
    };
}

/** Drops idle buckets so the map does not grow with every IP ever seen. */
export function evictIdleBuckets(olderThanMs = 10 * 60_000): number {
    const cutoff = Date.now() - olderThanMs;
    let evicted = 0;
    for (const [key, bucket] of buckets) {
        if (bucket.lastRefillMs < cutoff) { buckets.delete(key); evicted++; }
    }
    return evicted;
}
