---
name: tailwind
description: Tailwind CSS idioms — utility-first, tokens via config, responsive & a11y
roles: [frontend, design]
stacks: [tailwind]
triggers: [tailwind, classname, "@apply", utility, "tailwind.config"]
priority: 7
---
# Tailwind CSS

## Conventions
- Utility-first in markup; extract repetition into components, not premature `@apply` soup.
- Centralize design tokens (colors, spacing, fonts) in `tailwind.config` `theme.extend` — reference tokens, not raw hex.
- Mobile-first responsive prefixes (`md:`, `lg:`). Support dark mode via the `dark:` variant.
- Respect accessibility: sufficient contrast, focus-visible rings, don't remove outlines without a replacement.

## Pitfalls
- Arbitrary values everywhere (defeats the system). Duplicated class strings instead of a component. Ignoring focus/contrast.
