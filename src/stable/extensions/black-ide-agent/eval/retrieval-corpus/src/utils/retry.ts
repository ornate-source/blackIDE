export interface RetryOptions {
    attempts: number;
    baseDelayMs: number;
    maxDelayMs?: number;
    /** Return false to give up immediately. Defaults to "retry everything". */
    isRetryable?: (err: unknown) => boolean;
    onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Runs `fn`, retrying with exponential backoff and full jitter.
 *
 * Jitter is not decoration: without it every client that failed on the same upstream
 * blip retries at the same instant and re-creates the outage it is backing off from.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
    const { attempts, baseDelayMs, maxDelayMs = 30_000, isRetryable = () => true, onRetry } = options;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt === attempts || !isRetryable(err)) break;

            const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
            const delayMs = Math.random() * ceiling;
            onRetry?.(err, attempt, delayMs);
            await sleep(delayMs);
        }
    }
    throw lastError;
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Wraps a function so concurrent callers with the same key share one in-flight call. */
export function coalesce<T>(fn: (key: string) => Promise<T>): (key: string) => Promise<T> {
    const inFlight = new Map<string, Promise<T>>();
    return (key: string) => {
        const existing = inFlight.get(key);
        if (existing) return existing;
        const promise = fn(key).finally(() => inFlight.delete(key));
        inFlight.set(key, promise);
        return promise;
    };
}
