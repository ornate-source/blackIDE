---
name: test-strategy
description: What to test at which level, and how to keep a suite trustworthy
roles: [testing, architect]
stacks: [jest, vitest, pytest, xunit, rspec, playwright, cypress, junit]
triggers: [test strategy, coverage, unit test, integration test, flaky, test pyramid]
priority: 5
---
# Test Strategy

## Levels
- **Unit** for logic with branches — pure functions, reducers, parsers, policy decisions. Fast, many.
- **Integration** for the seams: your code against a real database, a real router, a real serializer. This is where most real bugs live and where most suites are thinnest.
- **End-to-end** for the handful of journeys that must never break. Few, and owned.

## Conventions
- Test behaviour at a boundary you would not change during a refactor. A test that breaks on every rename is measuring the implementation.
- Assert the failure mode, not just the happy path — the error branch is the one nobody runs by hand.
- A flaky test is a broken test. Quarantine or fix it; a suite people re-run until green guards nothing.

## Pitfalls
- Coverage as a target rather than a signal: 100% of trivial getters and 0% of the retry logic.
- Mocking so deeply that the test passes when the real integration is broken.
- Performance assertions measured under a parallel runner — take the best of N samples.
