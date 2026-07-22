---
name: angular
description: Angular idioms — components, services/DI, RxJS, modules/standalone
roles: [frontend]
stacks: [angular, typescript]
triggers: [angular, "@component", ngmodule, rxjs, observable, "@injectable"]
priority: 9
---
# Angular

## Conventions
- Standalone components (modern) or feature `NgModule`s; smart/dumb component split.
- Services are `@Injectable({providedIn: 'root'})`; inject via constructor DI.
- Prefer the `async` pipe over manual `subscribe`; unsubscribe (takeUntil/`DestroyRef`) when you must.
- Reactive forms over template forms for anything non-trivial. Strong typing everywhere.
- Change detection: prefer `OnPush`; avoid heavy work in templates.

## Commands
- `ng serve` · `ng generate component|service` · Tests: `ng test` (Jasmine/Karma) or jest.

## Pitfalls
- Memory leaks from unclosed subscriptions. Logic in templates. Mutating inputs. Overusing `any`.
