---
name: fastapi
description: FastAPI async backend idioms — Pydantic models, dependency injection, routers
roles: [backend]
stacks: [fastapi, python]
triggers: [fastapi, pydantic, uvicorn, "async def", depends]
priority: 10
---
# FastAPI

## Conventions
- Define request/response schemas as Pydantic models; let FastAPI validate and serialize.
- Use `APIRouter` per resource; include with `app.include_router(...)`.
- Inject shared resources (DB session, current user) via `Depends(...)`.
- `async def` endpoints for I/O-bound work; use an async DB driver (asyncpg / SQLAlchemy async) — never block the event loop.
- Return Pydantic models or `response_model=`; set explicit `status_code`.

## Commands
- Dev: `uvicorn app.main:app --reload`
- Tests: `pytest` with `httpx.AsyncClient` / `TestClient`.

## Pitfalls
- Calling blocking/sync DB code inside `async def`. Doing heavy work in startup events. Forgetting `response_model` (leaks internal fields).
