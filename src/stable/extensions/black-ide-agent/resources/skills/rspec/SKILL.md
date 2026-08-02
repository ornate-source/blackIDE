---
name: rspec
description: RSpec structure, matchers and Rails testing conventions
roles: [testing]
stacks: [rails, ruby, rspec]
triggers: [rspec, _spec.rb, spec_helper, factorybot, let!, aggregate_failures]
priority: 10
---
# Rspec

## Conventions
- `describe` the thing, `context` the condition, `it` the expected behaviour — the sentence should read.
- `let` is lazy and memoised per example; `let!` forces it. Prefer `let` and reach for `let!` deliberately.
- FactoryBot over fixtures; `build` unless the test needs a database row, then `create`.
- One expectation per example where practical, and use `aggregate_failures` when several belong together.

## Commands
- `bundle exec rspec` · `bundle exec rspec spec/models/user_spec.rb:42`

## Pitfalls
- `before(:all)` state leaks between examples and is not rolled back by the transaction.
- Stubbing what you are testing rather than its collaborators tests the stub.
