---
name: react-testing-library
description: Testing React by behaviour: queries, user events and async assertions
roles: [testing]
stacks: [react, jest, vitest, typescript]
triggers: [render, screen, getByRole, userEvent, waitFor, testing-library]
priority: 10
---
# React Testing Library

## Conventions
- Query the way a user finds things: `getByRole` first, then `getByLabelText`, then `getByText`. `getByTestId` is the escape hatch, not the default.
- `userEvent` over `fireEvent` — it models real interaction (focus, key sequence) rather than dispatching one synthetic event.
- `findBy*` for anything async; `waitFor` only when there is no element to wait on.
- Assert on what the user sees, not on component state or props.

## Commands
- `npx vitest run` or `npx jest`; add `@testing-library/jest-dom` for readable matchers.

## Pitfalls
- `getBy*` throws when absent and `queryBy*` returns null — use `queryBy*` for "should not exist".
- Missing `await` on `userEvent` calls (they are async since v14) makes assertions race.
- Wrapping everything in `act` manually usually means the query should have been `findBy*`.
