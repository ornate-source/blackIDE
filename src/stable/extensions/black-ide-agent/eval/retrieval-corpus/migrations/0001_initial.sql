-- Initial schema.
--
-- Money is stored as BIGINT minor units, never NUMERIC and never a float. The
-- currency is stored alongside every amount because an amount without its
-- currency is not a number, it is a bug waiting for a second market.

CREATE TABLE users (
    id                 TEXT PRIMARY KEY,
    email              TEXT NOT NULL,
    display_name       TEXT NOT NULL,
    role               TEXT NOT NULL DEFAULT 'customer',
    preferred_currency CHAR(3) NOT NULL DEFAULT 'USD',
    locale             TEXT NOT NULL DEFAULT 'en-US',
    created_at         BIGINT NOT NULL,
    disabled_at        BIGINT
);

CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE orders (
    id                TEXT PRIMARY KEY,
    customer_id       TEXT NOT NULL REFERENCES users (id),
    status            TEXT NOT NULL,
    currency          CHAR(3) NOT NULL,
    total_minor       BIGINT NOT NULL CHECK (total_minor >= 0),
    placed_at         BIGINT NOT NULL,
    cancelled_at      BIGINT,
    payment_intent_id TEXT
);

-- Supports the keyset pagination in order-repository.listForCustomer.
CREATE INDEX orders_customer_placed_idx ON orders (customer_id, placed_at DESC);
CREATE INDEX orders_status_idx ON orders (status) WHERE status IN ('awaiting_payment', 'paid');
