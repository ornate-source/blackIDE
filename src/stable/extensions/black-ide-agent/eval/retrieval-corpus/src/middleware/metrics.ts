import { NextFunction, Request, Response } from 'express';

const histogram = new Map<string, number[]>();

/**
 * Per-route latency histogram. Routes are keyed by their *pattern*, not their
 * path — bucketing `/orders/abc123` separately from `/orders/def456` produces a
 * million series and takes the metrics backend down with it.
 */
export function httpMetrics() {
    return (req: Request, res: Response, next: NextFunction) => {
        const startedAt = process.hrtime.bigint();
        res.on('finish', () => {
            const key = `${req.method} ${(req.route?.path as string) ?? req.baseUrl ?? 'unmatched'} ${res.statusCode}`;
            const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
            const series = histogram.get(key) ?? [];
            series.push(ms);
            histogram.set(key, series);
        });
        next();
    };
}

export function percentile(key: string, p: number): number {
    const series = (histogram.get(key) ?? []).slice().sort((a, b) => a - b);
    if (series.length === 0) return 0;
    return series[Math.min(series.length - 1, Math.floor((p / 100) * series.length))];
}

export function snapshot(): Record<string, { count: number; p50: number; p95: number }> {
    const out: Record<string, { count: number; p50: number; p95: number }> = {};
    for (const key of histogram.keys()) {
        out[key] = { count: histogram.get(key)!.length, p50: percentile(key, 50), p95: percentile(key, 95) };
    }
    return out;
}
