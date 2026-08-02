---
name: cargo-test
description: Rust test layout, integration tests and cargo tooling
roles: [testing]
stacks: [axum, rust, cargo]
triggers: [cargo test, #[test], assert_eq, mod tests, tokio::test]
priority: 10
---
# Cargo Test

## Conventions
- Unit tests in a `#[cfg(test)] mod tests` beside the code; integration tests in `tests/`, which only see the public API.
- `#[tokio::test]` for async. `#[should_panic(expected = "...")]` with the message, not bare.
- `assert_eq!` gives a diff; `assert!(a == b)` gives `false`. Prefer the former.
- Use `cargo nextest` on large suites — it isolates per test and is markedly faster.

## Commands
- `cargo test` · `cargo test -- --nocapture` to see stdout · `cargo clippy -- -D warnings` · `cargo fmt --check`

## Pitfalls
- Tests run in parallel threads: shared statics and a shared temp dir will collide.
- Doc tests run too, and a broken example in a doc comment fails the build.
