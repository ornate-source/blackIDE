---
name: orm-patterns
description: Working with an ORM without inheriting its performance problems
roles: [backend]
stacks: [django, rails, spring-boot, aspnet-core, laravel, express, nestjs]
triggers: [n+1, eager loading, lazy loading, repository pattern, select_related, preload]
priority: 5
---
# Orm Patterns

## Conventions
- Know which calls hit the database and when. Lazy loading inside a loop is the N+1 problem, and it is invisible until the row count grows.
- Load what the response needs in one query (`select_related`/`Include`/`with`/`Preload`) and project to a DTO — selecting whole entities to read two fields is a habit, not a requirement.
- Push filtering, sorting and pagination into the query. Doing them in application code loads the table first.
- Keep transactions short and explicitly scoped. A transaction spanning an HTTP call holds a connection while a third party is slow.

## Pitfalls
- An ORM is a convenience over SQL, not a replacement for understanding it — read the generated query when something is slow.
- Bulk operations one row at a time; use the bulk API.
- Migrations generated from model diffs without reading them.
