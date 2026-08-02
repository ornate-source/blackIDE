---
name: vitest
description: Vitest configuration, mocking and fast-feedback testing patterns
roles: [testing]
stacks: [vitest, typescript, javascript, node]
triggers: [vitest, vi.mock, describe, expect, test, beforeEach]
priority: 10
---
# Vitest

## Conventions
- Co-locate `*.test.ts` beside the code, or in `__tests__/`. Pick one per repo.
- `vi.mock` is hoisted — declare the factory inline, and use `vi.importActual` to keep the rest of a module real.
- `vi.useFakeTimers()` for anything with a timeout; a test that sleeps is a test that flakes.
- Prefer `toEqual` over `toBe` for objects, and assert on behaviour rather than call counts where you can.

## Commands
- `npx vitest run` (CI) · `npx vitest` (watch) · `npx vitest run --coverage`
- One file: `npx vitest run path/to/file.test.ts`

## Pitfalls
- A performance assertion measured under a parallel worker pool measures the pool — take the best of N.
- `vi.mock` after an import of the mocked module is too late; hoisting only covers the factory.
- Forgetting `await` on an async expectation passes silently.
