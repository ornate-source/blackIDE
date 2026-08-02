---
name: svelte-kit
description: SvelteKit routing, load functions, form actions and server/client split
roles: [frontend]
stacks: [sveltekit, svelte, typescript]
triggers: [sveltekit, +page.svelte, +page.server.ts, load, form actions, svelte]
priority: 10
---
# Svelte Kit

## Structure
- File-based routes under `src/routes/`: `+page.svelte`, `+page.ts` (universal load), `+page.server.ts` (server-only), `+layout.*`.
- Shared code in `src/lib/`, imported as `$lib/...`.

## Conventions
- Anything touching a secret or a database goes in `+page.server.ts` or `+server.ts` — never in `+page.ts`, which also runs in the browser.
- Fetch data in `load`, not in `onMount`; that is what makes SSR and prefetching work.
- Mutations are **form actions**, so the app works without JavaScript and you get progressive enhancement free.
- `$state`/`$derived` (runes) in Svelte 5; stores from `svelte/store` for cross-component state in Svelte 4.

## Commands
- `npm run dev` · `npm run build` · `npm run check` (svelte-check) · Tests: `vitest` + `@testing-library/svelte`.

## Pitfalls
- Importing a server-only module into a universal file leaks it into the client bundle — SvelteKit will error, so read it rather than working around it.
- `invalidate`/`depends` forgotten means data does not refresh after an action.
