---
name: nextjs
description: Next.js App Router idioms — server/client components, data fetching, routing
roles: [frontend]
stacks: [nextjs, react, typescript]
triggers: [next, "app router", "use client", server component, route handler]
priority: 10
---
# Next.js (App Router)

## Conventions
- Default to **Server Components**; add `"use client"` only where you need state/effects/browser APIs.
- Fetch data in server components (async) or route handlers; keep secrets server-side.
- File-based routing in `app/`: `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `route.ts`.
- Use `next/image`, `next/link`, and metadata exports. Server Actions for mutations where appropriate.
- Cache intentionally (`fetch` cache options / `revalidate`).

## Pitfalls
- Importing server-only code into client components. Leaking env secrets to the client (only `NEXT_PUBLIC_*` is exposed). Overusing `"use client"` at the tree root.
