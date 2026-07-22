---
name: rails
description: Ruby on Rails idioms — MVC, ActiveRecord, migrations, strong params
roles: [backend]
stacks: [rails, ruby]
triggers: [rails, activerecord, "has_many", migration, "params.require"]
priority: 8
---
# Ruby on Rails

## Conventions
- Convention over configuration: RESTful resources, `resources :things` routes.
- Fat model / skinny controller; extract complex logic to service objects or concerns.
- ActiveRecord: use `has_many`/`belongs_to`, scopes, and `includes` to avoid N+1.
- Strong parameters (`params.require(:x).permit(...)`) for mass-assignment safety.
- Every schema change is a migration; never edit `schema.rb` by hand.

## Commands
- `bin/rails server` · `bin/rails db:migrate` · `bin/rails console`
- Tests: `rspec` or `bin/rails test`.

## Pitfalls
- N+1 queries. Callbacks doing too much. Skipping validations with `save(validate: false)`.
