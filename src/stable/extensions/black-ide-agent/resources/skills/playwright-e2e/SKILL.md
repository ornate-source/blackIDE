---
name: playwright-e2e
description: Playwright end-to-end structure, locators, fixtures and flake control
roles: [testing]
stacks: [playwright, typescript, javascript]
triggers: [playwright, page.goto, locator, expect(page), e2e, test.describe]
priority: 10
---
# Playwright E2E

## Conventions
- Use role/text locators (`page.getByRole('button', { name: 'Save' })`), not CSS paths — they survive refactors and read like intent.
- Web-first assertions (`await expect(locator).toBeVisible()`) auto-retry; a bare `expect(await locator.count())` does not.
- Fixtures for setup (`test.extend`), and storage state for logged-in sessions rather than logging in per test.
- One assertion subject per test; parallel by default, so tests must not share mutable server state.

## Commands
- `npx playwright test` · `npx playwright test --ui` · `npx playwright show-report`
- `npx playwright codegen <url>` to bootstrap a selector, then rewrite it by role.

## Pitfalls
- `waitForTimeout` is a flake generator — wait for a condition instead.
- Asserting immediately after `click()` without a web-first assertion races the navigation.
- Tests that depend on order fail only in CI, where sharding changes it.
