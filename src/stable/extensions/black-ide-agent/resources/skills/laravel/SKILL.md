---
name: laravel
description: Laravel MVC, Eloquent, migrations, validation and artisan workflow
roles: [backend]
stacks: [laravel, php]
triggers: [laravel, artisan, eloquent, migration, blade, middleware]
priority: 10
---
# Laravel

## Structure
- `app/Models`, `app/Http/Controllers`, `app/Http/Requests`, `app/Services`, `database/migrations`, `routes/`.

## Conventions
- Validation goes in a `FormRequest`, not in the controller.
- Fat models are fine for query scopes; put orchestration in a service or an action class.
- Every schema change is a migration — never edit an applied one; add a new migration.
- Use `$fillable` or `$guarded` deliberately; mass assignment without it is a vulnerability.
- Eager-load relations (`with()`) — Eloquent lazy-loads by default and will N+1 quietly.

## Commands
- `php artisan make:model Post -mfsc` · `php artisan migrate` · `php artisan test`
- `php artisan route:list` to see what is actually registered.

## Pitfalls
- `env()` outside a config file returns null once configs are cached.
- Queued jobs serialise models by id — the row may have changed or gone by the time it runs.
