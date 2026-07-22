---
name: jest
description: Jest / Testing Library idioms — unit + component tests (JS/TS)
roles: [testing]
stacks: [jest, react-testing-library, react, nextjs, express, javascript, typescript]
triggers: [jest, "describe(", "it(", expect, "test(", testing-library]
priority: 9
---
# Jest / Testing Library

## Conventions
- `describe`/`it` with behavior-focused names; Arrange–Act–Assert. Reset state between tests.
- Component tests (RTL): query by role/label/text (what users see), not test ids or implementation.
- Prefer `userEvent` over `fireEvent`; `await findBy*` for async UI. Assert on visible outcomes.
- Mock modules at the boundary (`jest.mock`); avoid mocking everything. Use fake timers deliberately.

## Commands
- `npx jest` / `npm test` · `jest --coverage` · `jest -t "name"`.

## Pitfalls
- Testing internal state instead of rendered output. Querying by class/test-id first. Unawaited async assertions. Leaky mocks across tests.
