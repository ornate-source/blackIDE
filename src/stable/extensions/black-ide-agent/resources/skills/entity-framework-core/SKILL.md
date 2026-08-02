---
name: entity-framework-core
description: EF Core DbContext, migrations, tracking and query pitfalls
roles: [backend]
stacks: [aspnet-core, csharp, efcore]
triggers: [dbcontext, efcore, entity framework, migration, DbSet, LINQ]
priority: 10
---
# Entity Framework Core

## Conventions
- One `DbContext` per unit of work, registered scoped. Never share one across threads.
- Configure with `IEntityTypeConfiguration<T>` classes, not a thousand-line `OnModelCreating`.
- `AsNoTracking()` for reads you will not save — tracking is the default and it costs.
- Every model change is a migration: `dotnet ef migrations add <Name>`, commit the generated file.
- Project to a DTO in the query (`.Select(...)`) so the SQL selects columns rather than entities.

## Commands
- `dotnet ef migrations add Init` · `dotnet ef database update` · `dotnet test`

## Pitfalls
- Client-side evaluation: a `.Where()` EF cannot translate silently pulls the table. EF Core 3+ throws instead — read the exception rather than adding `AsEnumerable()`.
- `Include` chains multiply rows; use `AsSplitQuery()` for multiple collections.
- Lazy loading proxies turn a loop into N queries.
