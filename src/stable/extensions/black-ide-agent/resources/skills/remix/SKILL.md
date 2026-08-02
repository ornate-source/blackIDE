---
name: remix
description: Remix loaders, actions, nested routes and progressive enhancement
roles: [frontend]
stacks: [remix, react, typescript]
triggers: [remix, loader, action, useLoaderData, defer, remix.config]
priority: 10
---
# Remix

## Conventions
- `loader` reads, `action` writes. Both run on the server only — put secrets there freely.
- Return `json()` / `redirect()` from loaders and actions; throw `Response` for 404s so the nearest `ErrorBoundary` catches it.
- Use `<Form>` over `fetch` — it degrades without JS and gives you pending states via `useNavigation`.
- Nested routes mean nested data: each level loads its own, in parallel.

## Commands
- `npm run dev` · `npm run build` · Tests: `vitest`, plus Playwright for the route-level behaviour.

## Pitfalls
- Client-only code (`window`, `localStorage`) at module scope breaks SSR — guard it or use `useEffect`.
- Forgetting `key` on a `<Form>` inside a list submits the wrong row.
