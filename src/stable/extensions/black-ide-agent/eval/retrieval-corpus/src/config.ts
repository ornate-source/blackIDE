function env(name: string, fallback: string): string {
    return process.env[name] ?? fallback;
}

function envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
    baseCurrency: env('BASE_CURRENCY', 'USD'),
    defaultLocale: env('DEFAULT_LOCALE', 'en-US'),

    http: {
        port: envInt('PORT', 8080),
        requestsPerMinute: envInt('RATE_LIMIT_RPM', 120),
    },

    auth: {
        // Tokens are minted elsewhere; this service only verifies them.
        clockSkewSeconds: envInt('AUTH_CLOCK_SKEW_SECONDS', 30),
        issuer: env('AUTH_ISSUER', 'https://auth.example.internal'),
    },

    db: {
        url: env('DATABASE_URL', 'postgres://localhost:5432/orders'),
        maxConnections: envInt('DB_MAX_CONNECTIONS', 20),
        statementTimeoutMs: envInt('DB_STATEMENT_TIMEOUT_MS', 5_000),
    },

    payments: {
        baseUrl: env('PAYMENTS_BASE_URL', 'https://payments.example.internal'),
        apiKey: env('PAYMENTS_API_KEY', ''),
        maxAttempts: envInt('PAYMENTS_MAX_ATTEMPTS', 4),
        retryBaseDelayMs: envInt('PAYMENTS_RETRY_BASE_MS', 250),
    },

    notifications: {
        baseUrl: env('NOTIFICATIONS_BASE_URL', 'https://notify.example.internal'),
    },

    inventory: {
        lowStockThreshold: envInt('LOW_STOCK_THRESHOLD', 5),
    },
};
