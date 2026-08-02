---
name: db-migrations
description: Safe schema change: expand/contract, backfills and zero-downtime deploys
roles: [backend, devops, architect]
stacks: [django, rails, spring-boot, aspnet-core, express, fastapi, laravel]
triggers: [migration, alter table, schema change, backfill, zero downtime, index]
priority: 6
---
# Db Migrations

## The rule
- **Expand, migrate, contract** — in three deploys, not one. Add the new column nullable; write to both; backfill; read from the new; then drop the old. Any single-deploy rename breaks every instance still running the old code.

## Conventions
- Migrations are append-only. Never edit one that has run anywhere.
- Backfill in batches with a bound, not one `UPDATE` over ten million rows holding a lock.
- Add indexes concurrently where the engine supports it (`CREATE INDEX CONCURRENTLY` in Postgres) — a plain index build locks writes.
- Make every migration reversible, or state explicitly why it is not.

## Pitfalls
- `NOT NULL` with a default on a large table rewrites it on older engines.
- A foreign key added without `NOT VALID` + `VALIDATE` takes a heavy lock.
- Deploying code that reads a column before the migration that adds it has landed everywhere.
