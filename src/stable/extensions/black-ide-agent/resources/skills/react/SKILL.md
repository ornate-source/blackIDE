---
name: react
description: React idioms — hooks, component composition, state, effects
roles: [frontend]
stacks: [react, typescript, javascript]
triggers: [react, usestate, useeffect, jsx, component, hook]
priority: 10
---
# React

## Conventions
- Function components + hooks only. Keep components small and composable; lift state only as needed.
- Rules of hooks: call at top level, never conditionally. Keep `useEffect` deps honest; clean up subscriptions.
- Derive state, don't duplicate it. Prefer controlled inputs. Key lists by stable ids, never index.
- Data fetching via TanStack Query / SWR, not ad-hoc effects, for caching + loading/error states.
- Type props with TS interfaces; avoid `any`.

## Pitfalls
- Missing/incorrect effect deps (stale closures). Derived state stored in `useState`. Expensive work each render (memoize deliberately, not everywhere). Index keys causing reconciliation bugs.
