---
name: flutter
description: Flutter widget composition, state management and platform channels
roles: [frontend]
stacks: [flutter, dart]
triggers: [flutter, widget, StatelessWidget, pubspec.yaml, BuildContext, dart]
priority: 10
---
# Flutter

## Conventions
- Compose small widgets rather than deep `build` methods; extract a `Widget` subclass, not a `Widget _build()` helper — the subclass gets its own rebuild boundary.
- `const` constructors wherever possible; that is what stops a rebuild propagating.
- One state solution per app (Provider, Riverpod, Bloc). Mixing them makes ownership unanswerable.
- Never do async work in `build`. `initState` + `FutureBuilder`, or the state layer.

## Commands
- `flutter run` · `flutter test` · `flutter analyze` · `flutter build apk|ios`

## Pitfalls
- Using `BuildContext` after an `await` when the widget may have been disposed — check `mounted`.
- `setState` in a `StatelessWidget`'s callbacks (there is none) or after dispose.
- Layout overflow because a `Column` has an unbounded child — wrap in `Expanded`/`Flexible`.
