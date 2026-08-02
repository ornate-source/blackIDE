---
name: coverage-tdd
description: Using coverage honestly, and a workable red-green-refactor loop
roles: [testing]
stacks: [jest, vitest, pytest, xunit, rspec, junit, cargo]
triggers: [tdd, coverage, red-green-refactor, red green refactor, istanbul, coverage report]
priority: 4
---
# Coverage Tdd

## The loop
- Red: write the smallest failing test that states the behaviour. Watch it fail — a test that has never failed has never been verified.
- Green: the simplest code that passes, even if it is ugly.
- Refactor: with the test as a net. This is the step people skip, and it is the one that pays.

## Coverage, used honestly
- Coverage tells you what was *executed*, not what was *checked*. A test with no assertions covers everything.
- Use it to find the untested branch you did not know about; do not use it as a target — teams hit targets by testing getters.
- Branch coverage over line coverage. Mutation testing over both, where the suite is worth the cost.

## Pitfalls
- Chasing a percentage after the fact produces tests that assert what the code does, including its bugs.
- Excluding hard files from the report instead of testing them.
