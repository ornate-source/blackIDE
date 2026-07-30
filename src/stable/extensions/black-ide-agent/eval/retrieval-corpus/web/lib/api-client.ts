/**
 * Browser API client with bounded retries.
 *
 * Only idempotent verbs are retried automatically. Retrying a POST from the
 * browser is how a customer ends up with two orders — the server's
 * Idempotency-Key path exists precisely so this client does not have to guess.
 */
export interface RequestOptions {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    idempotencyKey?: string;
    signal?: AbortSignal;
}

const RETRYABLE_METHODS = new Set(['GET', 'DELETE']);
const MAX_ATTEMPTS = 3;

export class ApiError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    let lastError: unknown;

    for (let attempt = 1; attempt <= (RETRYABLE_METHODS.has(method) ? MAX_ATTEMPTS : 1); attempt++) {
        try {
            const res = await fetch('/api' + path, {
                method,
                signal: options.signal,
                headers: {
                    'content-type': 'application/json',
                    ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
                },
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
            });

            if (res.status === 401) { window.location.href = '/login'; throw new ApiError(401, 'signed out'); }
            if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error ?? res.statusText);
            return res.status === 204 ? (undefined as T) : await res.json();
        } catch (err) {
            lastError = err;
            if (err instanceof ApiError && err.status < 500) throw err;
            if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 200 * 2 ** (attempt - 1) * Math.random()));
        }
    }
    throw lastError;
}
