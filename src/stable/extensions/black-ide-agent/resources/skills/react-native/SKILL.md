---
name: react-native
description: React Native / Expo idioms — components, navigation, platform differences
roles: [frontend]
stacks: [react-native, expo, react, typescript]
triggers: [react native, expo, "react-navigation", stylesheet, native]
priority: 9
---
# React Native / Expo

## Conventions
- Compose with `View`/`Text`/`Pressable`; style via `StyleSheet.create` (no CSS). Use Flexbox for layout.
- Navigation via React Navigation (stack/tab). Keep screens thin; hooks for logic.
- Handle platform differences with `Platform.select` / `.ios.tsx`/`.android.tsx`.
- Lists: `FlatList`/`SectionList` with stable `keyExtractor` — never `.map` large lists.
- Expo: prefer Expo SDK modules; use EAS for builds.

## Pitfalls
- Web/DOM assumptions (no `div`, no CSS files). Blocking the JS thread. Unoptimized images/lists. Forgetting safe-area insets.
