---
name: rest-api-design
description: Resource modelling, status codes, versioning and pagination for HTTP APIs
roles: [backend, architect]
stacks: [express, fastapi, django, spring-boot, aspnet-core, gin, rails, nestjs]
triggers: [endpoint, rest api, http status, pagination, versioning, openapi]
priority: 6
---
# Rest Api Design

## Modelling
- Resources are nouns, plural: `/orders`, `/orders/{id}/items`. Verbs live in the method.
- Nest only one level deep. Beyond that, use a query parameter or a top-level resource.
- Model the state change, not the RPC: `POST /orders/{id}/cancellation` beats `POST /cancelOrder`.

## Status codes
- 200 read, 201 + `Location` on create, 202 accepted-async, 204 no body.
- 400 malformed, 401 unauthenticated, 403 authenticated-but-forbidden, 404 absent (or hidden), 409 conflict, 422 semantically invalid, 429 rate-limited.
- Never 200 with `{"error": ...}` — it defeats every client's error handling.

## Conventions
- Paginate every collection from day one; cursor for large or live data, offset only for small stable sets.
- Version in the path (`/v1/`) and change it only for breaking changes; add fields freely, never repurpose one.
- Return a consistent error shape with a stable machine-readable `code` alongside the human message.
- Make writes idempotent where you can — an `Idempotency-Key` header saves a duplicate charge.

## Pitfalls
- Unbounded list endpoints are a future incident.
- Leaking internal ids or enum names into a public contract makes them permanent.
