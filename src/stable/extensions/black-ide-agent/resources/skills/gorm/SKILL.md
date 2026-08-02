---
name: gorm
description: GORM models, migrations, associations and Go-specific pitfalls
roles: [backend]
stacks: [gin, go, gorm]
triggers: [gorm, gorm.Model, AutoMigrate, Preload, db.Where]
priority: 10
---
# Gorm

## Conventions
- Embed `gorm.Model` only when you want its `ID`/timestamps/soft delete; otherwise declare fields explicitly.
- `Preload` associations you need — GORM does not lazy-load, so a missing `Preload` gives you a zero value, not a query.
- Check `err` on every call, and `errors.Is(err, gorm.ErrRecordNotFound)` for the not-found case rather than comparing to nil result.
- Use transactions with `db.Transaction(func(tx *gorm.DB) error { ... })` so rollback is automatic.

## Commands
- `go test ./...` · `go vet ./...` · migrations via `AutoMigrate` in dev, a real migration tool in production.

## Pitfalls
- `AutoMigrate` never drops or narrows a column — it is not a migration system.
- Passing a struct with zero values to `Updates` skips them; use a map or `Select` to update to zero.
- Reusing a `*gorm.DB` after a chained condition carries the condition — start from the session.
