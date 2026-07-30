-- Audit log and webhook delivery.
--
-- The audit table is insert-only by grant, not merely by convention: the
-- application role is given INSERT and SELECT and nothing else, so a compromised
-- service account cannot rewrite history.

CREATE TABLE audit_log (
    id           BIGSERIAL PRIMARY KEY,
    actor_id     TEXT NOT NULL,
    action       TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id   TEXT NOT NULL,
    at           BIGINT NOT NULL,
    detail       TEXT
);

CREATE INDEX audit_subject_idx ON audit_log (subject_type, subject_id, at DESC);

REVOKE UPDATE, DELETE ON audit_log FROM application;
GRANT INSERT, SELECT ON audit_log TO application;

CREATE TABLE webhook_endpoints (
    id              TEXT PRIMARY KEY,
    customer_id     TEXT NOT NULL REFERENCES users (id),
    url             TEXT NOT NULL,
    secret          TEXT NOT NULL,
    events          TEXT[] NOT NULL DEFAULT '{}',
    disabled_at     BIGINT,
    disabled_reason TEXT
);

CREATE TABLE webhook_deliveries (
    id          BIGSERIAL PRIMARY KEY,
    endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints (id),
    event       TEXT NOT NULL,
    status      TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 1,
    at          BIGINT NOT NULL
);

CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, at DESC);
