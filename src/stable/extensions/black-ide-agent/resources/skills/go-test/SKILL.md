---
name: go-test
description: Go table-driven tests, subtests and the standard toolchain
roles: [testing]
stacks: [gin, go]
triggers: [go test, func Test, t.Run, table driven, testify]
priority: 10
---
# Go Test

## Conventions
- Table-driven with `t.Run(tc.name, ...)` — each case gets its own name in the output and can be run alone.
- `t.Parallel()` where cases are independent, and capture the loop variable (pre-Go 1.22) or it aliases.
- `t.Helper()` in assertion helpers so failures point at the caller.
- `t.Cleanup` over `defer` for teardown that must run even on a subtest failure.

## Commands
- `go test ./...` · `go test -run TestName ./pkg` · `go test -race ./...` · `go vet ./...`

## Pitfalls
- Not running `-race` in CI: data races pass silently until production.
- `t.Fatal` inside a goroutine does not stop the test — send the error back on a channel.
