---
name: astro
description: Astro islands, content collections and the zero-JS default
roles: [frontend]
stacks: [astro, typescript]
triggers: [astro, island, content collections, astro.config, client:load]
priority: 8
---
# Astro

## Conventions
- Components are static by default; JavaScript ships only where you write a `client:*` directive. Prefer `client:visible` over `client:load`.
- Content lives in `src/content/` collections with a Zod schema — the schema is the contract, so a bad frontmatter fails the build rather than the page.
- `.astro` for layout and markup; reach for React/Vue/Svelte only where interactivity actually is.

## Commands
- `npm run dev` · `npm run build` · `npm run astro check`

## Pitfalls
- Passing a function or a class instance as an island prop — props are serialised, so they must be JSON.
- Two islands cannot share client state; lift it into a store or a single island.
