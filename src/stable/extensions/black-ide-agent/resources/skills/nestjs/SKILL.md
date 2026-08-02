---
name: nestjs
description: NestJS module/provider/controller structure, DI, pipes and testing
roles: [backend]
stacks: [nestjs, typescript, node]
triggers: [nestjs, controller, provider, module, dto, guard, interceptor]
priority: 12
---
# Nestjs

## Structure
- One feature = one module: `users.module.ts` owning `users.controller.ts`, `users.service.ts`, `dto/`, `entities/`.
- Controllers do HTTP only — parse, delegate, return. Business logic lives in the service.
- Register providers in the module's `providers`, export only what other modules import.

## Conventions
- Constructor injection with `private readonly`. Never `new` a service.
- DTOs are classes with `class-validator` decorators, enabled by a global `ValidationPipe({ whitelist: true, transform: true })`.
- Guards for authn/authz, interceptors for cross-cutting response shaping, filters for exceptions. Do not put any of the three in a service.
- Throw `HttpException` subclasses (`NotFoundException`, `BadRequestException`), not raw errors.

## Commands
- `nest g module users` · `nest g service users` · `nest g controller users`
- Tests: `npm run test` (unit, `.spec.ts`) · `npm run test:e2e` (supertest against a real app instance).

## Pitfalls
- `whitelist: true` off means unknown body fields reach your DTO silently.
- Circular imports between modules — use `forwardRef` only as a last resort; it usually means the boundary is wrong.
- `@Injectable()` missing on a provider gives an opaque DI error at boot, not at compile.
