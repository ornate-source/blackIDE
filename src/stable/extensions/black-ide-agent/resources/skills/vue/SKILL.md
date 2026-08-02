---
name: vue
description: Vue 3 composition API, reactivity, component and store structure
roles: [frontend]
stacks: [vue, typescript, javascript]
triggers: [vue, composition api, reactive, defineProps, definEmits, pinia, sfc]
priority: 10
---
# Vue

## Structure
- Single-file components with `<script setup lang="ts">`. Composables in `composables/useX.ts`. Stores in `stores/` (Pinia).

## Conventions
- `ref` for primitives, `reactive` for objects — and pick one per concept rather than mixing.
- `computed` for derived state; never compute in the template beyond a property access.
- Props down, events up (`defineEmits`). Reaching into a child with a template ref is a last resort.
- `watch` for side effects, `watchEffect` only when the dependency set is genuinely dynamic.
- Pinia stores are composition functions: state, getters, actions — no mutations layer.

## Commands
- `npm run dev` · `npm run build` · Tests: `vitest` with `@vue/test-utils`.

## Pitfalls
- Destructuring a `reactive` object loses reactivity — use `toRefs`.
- `v-for` without a stable `:key` reuses DOM nodes and carries state across rows.
- `v-html` with user content is an XSS hole.
