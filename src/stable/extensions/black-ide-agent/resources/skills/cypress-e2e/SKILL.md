---
name: cypress-e2e
description: Cypress command chaining, retry-ability and test isolation
roles: [testing]
stacks: [cypress, typescript, javascript]
triggers: [cypress, cy.get, cy.visit, cy.intercept, should]
priority: 8
---
# Cypress E2E

## Conventions
- Chain assertions with `.should()` so Cypress retries — `cy.get(...).then(el => expect(...))` does not retry and will flake.
- `cy.intercept` to stub network calls; assert on the request as well as the response where it matters.
- `data-cy` attributes for selectors that must not move with styling.
- `cy.session()` for login so each test starts clean without paying the login cost.

## Commands
- `npx cypress run` (headless) · `npx cypress open`

## Pitfalls
- Commands are enqueued, not executed — mixing them with plain JS control flow does not do what it reads like.
- `cy.wait(500)` is the same flake generator as anywhere else; wait on an alias.
