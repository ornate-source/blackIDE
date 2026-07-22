---
name: aspnet-core
description: ASP.NET Core + EF Core idioms — DI, minimal APIs/controllers, migrations
roles: [backend]
stacks: [aspnet-core, dotnet, csharp, entity-framework-core]
triggers: [asp.net, "using microsoft", ef core, dbcontext, ".cs", controller]
priority: 10
---
# ASP.NET Core

## Conventions
- Register services in DI (`builder.Services.Add...`); depend on interfaces, inject via constructors.
- Controllers or minimal APIs; return `IActionResult`/`Results.*` with correct status codes.
- EF Core: `DbContext` per request (scoped); `async` queries (`ToListAsync`); migrations via `dotnet ef`.
- Use DTOs/records for API contracts, not entities. Validate with data annotations / FluentValidation.
- Config + secrets via `IConfiguration` / user-secrets, never in source.

## Commands
- `dotnet run` · `dotnet ef migrations add <Name> && dotnet ef database update`
- Tests: `dotnet test` (xUnit).

## Pitfalls
- Sync-over-async (`.Result`/`.Wait()`) → deadlocks. Returning entities directly (over-posting). Singletons capturing scoped services.
