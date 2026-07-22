---
name: axum
description: Rust Axum backend idioms — handlers, extractors, state, error handling
roles: [backend]
stacks: [axum, rust]
triggers: [axum, tokio, "async fn", extractor, router]
priority: 9
---
# Axum (Rust)

## Conventions
- Compose routes with `Router::new().route(...)`; share state via `State<T>` (clone-cheap, e.g. `Arc`).
- Handlers are `async fn` returning `impl IntoResponse` or `Result<T, AppError>`.
- Define one app error type implementing `IntoResponse`; use `?` to propagate — don't `unwrap()` in handlers.
- Extractors validate input (`Json<T>`, `Path`, `Query`); derive `serde::Deserialize`.
- Use `tokio` runtime; keep blocking work off the async threads (`spawn_blocking`).

## Commands
- `cargo run` · `cargo build --release` · Tests: `cargo test`.

## Pitfalls
- `.unwrap()`/`.expect()` in request paths (panics = 500s). Holding a `std::Mutex` across `.await`. Blocking the runtime.
