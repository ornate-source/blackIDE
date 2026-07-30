/*
 * Retrieval golden queries (Phase 3).
 *
 * Each entry is a natural-language question of the kind a developer actually asks
 * the agent, plus `mustFind` — the files that genuinely have to be in the retrieved
 * set for the answer to be reachable. Scored as **recall@k**: of the gold files, how
 * many appear in the top k results from `CodebaseIndex.search()`.
 *
 * ── Rules the gold sets follow ───────────────────────────────────────────────
 *
 * 1. **Gold means necessary, not merely relevant.** `order-service.ts` mentions
 *    payment, but a question about *how the card is charged* is answered in
 *    `payment-service.ts`; listing both would make the metric easy and meaningless.
 *
 * 2. **Multi-file gold sets are the point.** The Phase 3 gate is "which files must
 *    change", and the interesting failures are the second and third file — the
 *    caller you have to update, the test that pins the old behaviour. Ten
 *    single-file queries would measure lexical matching, not retrieval.
 *
 * 3. **The query never quotes the answer's identifiers verbatim** where that can be
 *    avoided. "where do we charge the customer's card" rather than "chargeCard",
 *    because a user who already knows the symbol name would use grep.
 *
 * Queries are written against `eval/retrieval-corpus/`, which is frozen — see its
 * README for why the corpus is not this repo's own source.
 */

module.exports = [
    // ── Single-concept lookups: can the index find the one right file? ───────
    {
        id: 'q-charge-card',
        query: "where do we charge the customer's credit card for an order",
        mustFind: ['src/services/payment-service.ts'],
    },
    {
        id: 'q-token-expiry',
        query: 'how is the bearer token expiry checked, and is there any clock skew allowance',
        mustFind: ['src/middleware/auth.ts'],
    },
    {
        id: 'q-rate-limit',
        query: 'the token bucket that rejects callers with 429 and sets Retry-After',
        mustFind: ['src/middleware/rate-limit.ts'],
    },
    {
        id: 'q-connection-pool',
        query: 'how are database connections checked out and returned to the pool',
        mustFind: ['src/repositories/db.ts'],
    },
    {
        id: 'q-dead-letter',
        query: 'what happens to a queue message after it has failed too many times',
        mustFind: ['worker/queue.go'],
    },

    // ── Multi-file: the caller and the callee both have to surface ───────────
    {
        id: 'q-retry-backoff',
        query: 'add jitter to the exponential backoff used when the payment gateway is down',
        mustFind: ['src/utils/retry.ts', 'src/services/payment-service.ts'],
    },
    {
        id: 'q-stock-reservation',
        query: 'stock is reserved before we take payment and released if the order fails',
        mustFind: ['src/services/inventory-service.ts', 'src/services/order-service.ts'],
    },
    {
        id: 'q-currency-conversion',
        query: 'converting the order total into the currency the customer prefers',
        mustFind: ['src/utils/currency.ts', 'src/services/order-service.ts'],
    },
    {
        id: 'q-order-status-machine',
        query: 'which order status transitions are legal and where is that enforced',
        mustFind: ['src/models/order.ts', 'src/services/order-service.ts'],
    },
    {
        id: 'q-cancel-endpoint',
        query: 'the HTTP endpoint a customer hits to cancel an order and get a refund',
        mustFind: ['src/routes/orders.ts', 'src/services/order-service.ts'],
    },
    {
        id: 'q-order-created-event',
        query: 'consuming the order-created event and scheduling the shipment',
        mustFind: ['worker/handler.go', 'worker/queue.go'],
    },
    {
        id: 'q-daily-rollup',
        query: 'the nightly job that computes conversion rate and average order value',
        mustFind: ['analytics/pipeline.py', 'analytics/metrics.py'],
    },

    // ── Change-impact: "if I change X, what else must change?" ───────────────
    {
        id: 'q-impact-currency-exponent',
        query: 'I want to support a currency with three minor digits — what needs updating',
        mustFind: ['src/utils/currency.ts', 'test/currency.test.ts'],
    },
    {
        id: 'q-impact-skew-config',
        query: 'change the auth clock skew allowance and everything that reads it',
        mustFind: ['src/middleware/auth.ts', 'src/config.ts', 'test/auth.test.ts'],
    },
    {
        id: 'q-impact-user-currency',
        query: 'let a user change their preferred currency and have orders priced with it',
        mustFind: ['src/routes/users.ts', 'src/repositories/user-repository.ts', 'src/services/order-service.ts'],
    },
    {
        id: 'q-impact-refund-notification',
        query: 'email the customer when a refund is issued for their order',
        mustFind: ['src/services/notification-service.ts', 'src/services/order-service.ts'],
    },

    // ── Cross-language: the corpus is three stacks; retrieval must not fixate ─
    {
        id: 'q-cohort-retention',
        query: 'how repeat customers inside a date window are counted for retention',
        mustFind: ['analytics/metrics.py'],
    },
    {
        id: 'q-graceful-shutdown',
        query: 'draining in-flight work on SIGTERM before the process exits',
        mustFind: ['worker/main.go'],
    },
    {
        id: 'q-keyset-pagination',
        query: 'listing a customer orders newest first without using OFFSET',
        mustFind: ['src/repositories/order-repository.ts'],
    },
    {
        id: 'q-masked-email',
        query: 'we must never write a full email address into an audit line',
        mustFind: ['src/models/user.ts', 'src/services/audit-service.ts'],
    },

    // ── Adversarial: a distractor is the strongest lexical match ─────────────
    // Every query below names a concept the *wrong* file talks about more. They
    // are where the line-window baseline actually loses, so they are where symbol
    // chunking and reranking have to show up.
    {
        id: 'q-fraud-before-charge',
        // "charge" and "decline" saturate payment-service and subscription-service.
        query: 'decide whether a payment attempt is too risky before we send it to the gateway',
        mustFind: ['src/services/fraud-service.ts'],
    },
    {
        id: 'q-double-submit',
        // "order", "cancel", "pay" all point at routes/ and services/ first.
        query: 'stop a double-tapped button from creating two of the same thing',
        mustFind: ['src/middleware/idempotency.ts'],
    },
    {
        id: 'q-concurrent-renewal',
        // "subscription" and "renew" match the service far more strongly than the repo.
        query: 'two workers must not bill the same recurring plan at the same time',
        mustFind: ['src/repositories/subscription-repository.ts'],
    },
    {
        id: 'q-renewal-date-drift',
        query: 'a late retry must not permanently shift which day of the month we bill',
        mustFind: ['src/models/subscription.ts'],
    },
    {
        id: 'q-secret-scrubbing',
        // "token", "secret" and "authorization" all appear in auth and session code.
        query: 'where are sensitive fields stripped out before anything is written to the logs',
        mustFind: ['src/utils/logger.ts'],
    },
    {
        id: 'q-account-enumeration',
        query: 'the sign-in failure message must not reveal whether the account exists',
        mustFind: ['web/components/LoginForm.tsx'],
    },
    {
        id: 'q-metrics-cardinality',
        query: 'bucket requests by route pattern so ids in the path do not explode the series count',
        mustFind: ['src/middleware/metrics.ts'],
    },
    {
        id: 'q-liveness-vs-readiness',
        query: 'the probe that decides whether to restart the process must not touch the database',
        mustFind: ['src/routes/health.ts'],
    },
    {
        id: 'q-promo-overredemption',
        query: 'a discount code must not be used more times than the cap allows under concurrent checkouts',
        mustFind: ['src/repositories/promo-repository.ts'],
    },
    {
        id: 'q-inbound-signature',
        // The raw-body requirement lives in the route, the HMAC in the service.
        query: 'verifying the signature on a callback from the payment provider',
        mustFind: ['src/services/webhook-service.ts', 'src/routes/webhooks.ts'],
    },
    {
        id: 'q-index-for-order-list',
        query: 'which database index makes the customer order listing fast',
        mustFind: ['migrations/0001_initial.sql', 'src/repositories/order-repository.ts'],
    },
    {
        id: 'q-why-browser-no-convert',
        // Prose, not code: the answer is a design note, and the code files that
        // mention "convert" are exactly the ones that must NOT be the answer.
        query: 'why does the frontend not do its own currency conversion',
        mustFind: ['docs/architecture.md', 'web/lib/format.ts'],
    },
    {
        id: 'q-replay-dead-letters',
        query: 'the procedure for replaying failed messages and why it is not automatic',
        mustFind: ['docs/runbook-queue.md'],
    },
    {
        id: 'q-decline-retry-policy',
        query: 'why we do not bulk retry declined cards',
        mustFind: ['docs/runbook-payments.md', 'src/services/payment-service.ts'],
    },
    {
        id: 'q-cors-origin',
        query: 'do not reflect an arbitrary origin back when credentials are allowed',
        mustFind: ['src/middleware/cors.ts'],
    },
    {
        id: 'q-audit-immutable',
        query: 'make it impossible for the application to edit or delete history rows',
        mustFind: ['migrations/0003_audit_and_webhooks.sql', 'src/services/audit-service.ts'],
    },
];
