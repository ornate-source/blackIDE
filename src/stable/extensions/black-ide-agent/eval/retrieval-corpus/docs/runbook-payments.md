# Runbook — payment failures

## Symptom: decline rate spike

1. Check the gateway status page before anything else. A provider incident looks
   identical to a bug in our code from the dashboard.
2. Look at `admin/latency` for `POST /orders`. If p95 is flat but declines are up,
   the gateway is answering quickly and saying no — that is upstream, not us.
3. Check the fraud service's block rate. A threshold change in `config.fraud`
   ships as a config value, so it can move without a deploy.

**Do not** retry declines in bulk. The gateway treats repeated declines from one
merchant as card testing, and the penalty is a raised processing rate for months.
Retries are only ever for 5xx responses; `payment-service` already encodes that
distinction and it must not be loosened "just this once".

## Symptom: duplicate charges

Duplicates mean an idempotency key was not reused across a retry. There are two
independent keys in this system and both matter:

- the **HTTP** `Idempotency-Key` header, which stops a double-tapped button
  creating two orders;
- the **gateway** idempotency key, which stops our own retry capturing twice.

Confirm which one was missing before changing anything. Refund immediately; the
customer should not be the one to notice.
