-- Billing tables.

CREATE TABLE invoices (
    id                TEXT PRIMARY KEY,
    customer_id       TEXT NOT NULL REFERENCES users (id),
    currency          CHAR(3) NOT NULL,
    subtotal_minor    BIGINT NOT NULL,
    tax_minor         BIGINT NOT NULL DEFAULT 0,
    total_minor       BIGINT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'draft',
    issued_at         BIGINT NOT NULL,
    paid_at           BIGINT,
    payment_intent_id TEXT,
    void_reason       TEXT
);

CREATE INDEX invoices_open_idx ON invoices (issued_at) WHERE status = 'open';

CREATE TABLE subscriptions (
    id                     TEXT PRIMARY KEY,
    customer_id            TEXT NOT NULL REFERENCES users (id),
    plan_id                TEXT NOT NULL,
    plan_price_minor       BIGINT NOT NULL,
    currency               CHAR(3) NOT NULL,
    interval               TEXT NOT NULL,
    status                 TEXT NOT NULL,
    period_index           INTEGER NOT NULL DEFAULT 0,
    renews_at              BIGINT NOT NULL,
    dunning_attempts       INTEGER NOT NULL DEFAULT 0,
    last_decline_code      TEXT,
    last_payment_intent_id TEXT
);

-- Drives SubscriptionRepository.claimDue's FOR UPDATE SKIP LOCKED scan.
CREATE INDEX subscriptions_due_idx ON subscriptions (renews_at)
    WHERE status IN ('active', 'past_due');
