---
name: component-architecture
description: Component boundaries, state ownership and composition in UI codebases
roles: [architect, frontend]
stacks: []
triggers: [state management, prop drilling, container component, presentational component, component boundary, lift state]
priority: 5
---
# Component Architecture

## Ownership
- State lives at the lowest common ancestor of everything that reads it — no higher. Lifting further "just in case" is how a leaf edit re-renders a page.
- Server state (fetched, cached, invalidated) is not UI state. Use a query library for the first and local state for the second; conflating them is the commonest cause of stale-data bugs.

## Composition
- Prefer composition (`children`, slots) over configuration props. A component with eleven booleans wants to be three components.
- Presentational components take data and callbacks; containers know where data comes from. The split earns its keep when you test.
- Derive rather than sync. Two pieces of state that must agree will eventually disagree.

## Pitfalls
- Prop drilling more than two levels — that is a context or a store.
- `useEffect` to sync state that could have been computed during render.
- A component that both fetches and renders and formats is three tests you cannot write separately.
