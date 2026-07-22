---
name: express
description: Express/Node backend idioms — routers, middleware, async error handling
roles: [backend]
stacks: [express, nodejs, javascript, typescript]
triggers: [express, "app.use", middleware, "req, res", router]
priority: 9
---
# Express (Node)

## Conventions
- One `Router` per resource; mount under a versioned base (`/api/v1`).
- Middleware order matters: body parser → auth → routes → error handler (last).
- Centralize error handling in a final `(err, req, res, next)` handler; wrap async routes so rejections reach it.
- Validate input at the edge (zod / joi). Never trust `req.body`.
- Keep controllers thin; put logic in a service layer.

## Commands
- Dev: `npm run dev` (nodemon/tsx) · Tests: `jest` / `vitest` + supertest.

## Pitfalls
- Unhandled promise rejections in async handlers (use a wrapper). Blocking the event loop. Leaking stack traces in prod error responses.
