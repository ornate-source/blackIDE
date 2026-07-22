---
name: gin
description: Go Gin backend idioms — handlers, middleware, context, error handling
roles: [backend]
stacks: [gin, go]
triggers: [gin, "gin.context", "c.json", go http, handler]
priority: 8
---
# Gin (Go)

## Conventions
- Group routes with `r.Group("/api/v1")`; one handler file per resource.
- Handlers take `*gin.Context`; bind+validate with `c.ShouldBindJSON(&dto)`.
- Return explicit status + JSON: `c.JSON(http.StatusOK, obj)`. Handle errors, don't swallow them.
- Pass `context.Context` down to DB/HTTP calls for cancellation/timeouts.
- Keep handlers thin; put logic in a service package. Return wrapped errors (`fmt.Errorf("...: %w", err)`).

## Commands
- `go run ./...` · `go build ./...` · Tests: `go test ./...` (table-driven).

## Pitfalls
- Ignoring returned errors. Not propagating `context`. Data races on shared maps (use mutex/channels).
