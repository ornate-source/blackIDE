# `@blackide/agent-core`

The editor-free core of the Black IDE agent: the loop, the host interface, the headless
runner, the daemon and the CLI. No `vscode` import anywhere in it, enforced rather than
intended.

```ts
import { createNodeHost, runHeadless, createHostExecutor } from '@blackide/agent-core';
import { planSandbox } from '@blackide/agent-core/core/sandbox';
```

## What this package is for

An agent that only runs inside one editor is an editor feature. This package is the part
that is not: it runs in a terminal, in CI, in a container, and — through the BYO runner —
on a machine that is not the one holding the source.

## The one rule

**Nothing here may import `vscode`.** Not directly, and not transitively.

That is checked two ways, and both are needed:

- **The build.** This is a separate compilation unit with its own `tsconfig` and no path
  back into the extension, so `../../../src/core/x` does not resolve. A stray import is a
  compile error.
- **`__tests__/agent-core-boundary.test.ts`.** Walks the import graph from
  `src/agent-core/index.ts` transitively and fails on any module that reaches `vscode`.
  The build only catches a *broken* import; the test catches a working one that drags an
  editor dependency in through a new, legitimate-looking dependency.

The test also asserts a **floor** on how much is reachable. A barrel that exported six
things would satisfy "zero vscode imports" trivially; the count is what makes the claim
about the core rather than about a stub.

## What is deliberately absent

No language server, no browser, no MCP, no webview — and no editor-shaped substitutes for
them. `AgentHost` is small on purpose: every method is something a terminal, a CI runner
and an editor can all genuinely do. Anything only an editor can do lives behind
`HostEditorCapabilities`, every member optional, and the core must degrade rather than
break when they are absent. If a missing capability made the agent *unable to work* rather
than merely less informed, the dependency was structural and the split would be cosmetic.

`agent/tool-executor.ts` is **not** here, and that is not an oversight — it is the
editor's executor, five hundred lines of `WorkspaceEdit`, LSP bridge and Playwright.
`agent-core/host-executor.ts` is its counterpart built on `AgentHost` and nothing else.
Two implementations of a narrow interface is what proves the interface was one, rather
than a description of a single caller.

## Layout

```
src/
  agent-core/   host interface, node host, headless executor, CLI, daemon, remote runner
  core/         the pure decision layers — prompts, memory, sandbox, retrieval, policy
  agent/        the loop, skills, the artifact manager
```

The subdirectory names match the extension's, so a module that crosses the boundary keeps
its path and every relative import inside the package keeps working.

## Consuming it

Subpath imports go through the `exports` map: `@blackide/agent-core/core/sandbox` resolves
to `dist/core/sandbox.js`. The barrel (`.`) re-exports the surface worth having a stable
name for.
