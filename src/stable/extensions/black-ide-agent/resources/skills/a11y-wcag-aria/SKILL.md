---
name: a11y-wcag-aria
description: Accessibility practices — semantic HTML, ARIA, keyboard, contrast (WCAG)
roles: [design, frontend]
stacks: []
triggers: [accessibility, a11y, aria, wcag, screen reader, keyboard, contrast]
priority: 6
---
# Accessibility (WCAG / ARIA)

## Conventions
- Semantic HTML first (`button`, `nav`, `main`, `label`) — ARIA only to fill gaps, never to replace semantics.
- Everything operable by keyboard; visible focus states; logical tab order; no keyboard traps.
- Label every control; associate errors with fields (`aria-describedby`). Images need meaningful `alt` (or empty alt if decorative).
- Meet WCAG AA contrast (4.5:1 text). Don't convey meaning by color alone. Respect `prefers-reduced-motion`.
- Live regions (`aria-live`) for async updates.

## Pitfalls
- `div`/`span` as buttons. Placeholder used as a label. Removing focus outlines. Color-only status. Missing form labels.
