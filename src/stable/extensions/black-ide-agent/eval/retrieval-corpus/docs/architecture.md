# Architecture

Three deployables share one Postgres database and one broker.

| Component | Language | Responsibility |
|---|---|---|
| `src/` | TypeScript | Customer-facing HTTP API |
| `worker/` | Go | Asynchronous fulfilment and webhook delivery |
| `analytics/` | Python | Nightly rollups and finance exports |

## Boundaries that matter

**Currency conversion happens exactly once**, in `src/utils/currency.ts`, at the
moment an order is priced. Nothing downstream converts again: the worker, the
analytics jobs and the browser all render amounts in the currency they were given.
Two conversions do not round-trip, and a report that disagrees with the charge by a
cent costs more to explain than it did to build.

**Stock is reserved before payment**, never after. `order-service` holds the
reservation across the charge and releases it in a `catch`. The inverse ordering —
charge, then reserve — is simpler and is wrong: it takes money for things that
cannot ship.

**The API never talks to the carrier or the mail provider directly.** Those are the
worker's job, reached by publishing an event. A synchronous call to a third party
inside a request handler makes our availability the product of theirs.

## What is deliberately duplicated

`web/lib/format.ts` re-implements money formatting rather than importing the
server's. The server formats in the invoice's frozen currency, the browser in the
viewer's locale; unifying them has been tried twice and reverted twice.
