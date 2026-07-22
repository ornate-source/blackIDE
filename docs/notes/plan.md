# Black IDE — Engineering Plan: Project-Aware Agent Skills

**Author:** Principal Engineer (fleet + agent infrastructure)
**Date:** 2026-07-22
**Status:** Proposed — supersedes the prior notes/ set (audit + phase plans, now delivered).
**Scope reference:** `src/stable/extensions/black-ide-agent/`. Every claim below is grounded in
current code (file:line where it matters).

This plan does two things:
1. **Part 1** — a maturity map of *every* Black IDE capability, so we know where the product
   actually stands (Beginning / Mid / Advanced), not where the README says it does.
2. **Part 2** — the next big initiative: turn the eight agents from fixed-prompt generalists into
   a **project-aware fleet** that loads the right skills for the stack in front of them (Django,
   .NET, Rust, React, …), and keeps the mindmap synced to that reality.

---

## Part 1 — Feature Maturity Map

**Legend.** 🟢 **Advanced** — robust, tested, production-quality. 🟡 **Mid** — works, but with a
real limitation (not wired everywhere, not project-aware, opt-in, or thin). 🔴 **Beginning** —
exists but naive/experimental, or barely wired.

### Agent core & orchestration

| Capability | Level | Why this level |
|---|:--:|---|
| Bounded agent loop (context budgeting, execution interlock, native tools) | 🟢 | `agent/agent-loop.ts` + `core/context-manager.ts`; tested |
| Two-phase planning + human approval gate (persisted across reload) | 🟢 | `PlanningEngine`, Memento-backed approval |
| Multi-agent pipeline (HLD → LLD → Planner → Executors → reconcile) | 🟢 | `agent/pipeline-orchestrator.ts`; dependency graph, PR/apply modes |
| Subagent isolation (git worktrees, mutex, delta reconcile) | 🟢 | `agent/worktree-manager.ts`; real-git tests |
| Concurrent Pipeline Manager (up to 4 runs, durable history) | 🟢 | `core/pipeline-runs.ts` |
| Request classification / auto-plan / auto-orchestrate triggers | 🟡 | keyword heuristics (`planning-engine.ts`), not learned |
| Parallel wave execution | 🔴 | experimental, default off, "not verified under extension host" |

### The agents (fleet)

| Capability | Level | Why this level |
|---|:--:|---|
| **8 selectable agents** (Ask, Plan, Agent, Frontend, Backend, DevOps, Manager, Sr Architect) | 🟡 | **static system prompts** in `core/mode-loader.ts`; no project/stack awareness |
| 7 internal pipeline-phase agents (HLD, LLD, Planner, Design/Backend/Frontend/Testing Executors) | 🟡 | static prompts; **receive no skills today** (see Skills below) |
| Custom modes (YAML frontmatter, 3 scopes, hot-reload, inline diagnostics) | 🟢 | `ModeLoader.watchForChanges` |
| Per-mode tool allowlists + iteration budgets | 🟢 | enforced in the sandbox gate |

### Skills & knowledge — **the weak spine, and the subject of Part 2**

| Capability | Level | Why this level |
|---|:--:|---|
| **Skills framework** (`SkillsManager`) | 🔴 | discovers `.blackide/skills/*/SKILL.md`, but **matches by prompt keyword only**, is wired **into chat only — not the pipeline agents**, ships **no built-in packs**, and has **no notion of project type or agent role** |
| **Project-type detection** (Django / .NET / Rust / …) | 🔴 | none. Only a prompt-keyword `mentions()` check (`planning-engine.ts:168`); nothing reads manifests (`Cargo.toml`, `*.csproj`, `requirements.txt`, …) |
| Long-term project memory (`.blackIDE/knowledge/`) | 🟡 | solid store + first-run scan, but content is generic, not stack-specialized |
| **Mindmap syncing** (`project_mindmap.md`) | 🟡 | deterministic append + `update_mindmap` tool; **not structured/queryable, not stack-aware**, agents rarely read it back |
| First-run architecture scan | 🟡 | `summarizeRepoStructure()` lists files + `package.json`; does **not** classify the stack |

### Retrieval & context

| Capability | Level | Why |
|---|:--:|---|
| Semantic codebase index (embeddings + BM25 via RRF, AST-aware chunking) | 🟢 | `core/codebase-index.ts`; embeddings are opt-in |
| Context manager / token budgeting + compaction | 🟢 | `core/context-manager.ts` |
| Prompt builder (per-section budgets) | 🟢 | `core/prompt-builder.ts` |

### Tools

| Capability | Level | Why |
|---|:--:|---|
| File / grep / list / run_command | 🟢 | `tools/tool-runner.ts` |
| Checkpoints & rollback (reverse hunks, per-message undo) | 🟢 | `core/checkpoint-manager.ts` |
| **Browser automation** (Playwright, gated + on-demand install) | 🟡 | opt-in after Phase-1 hardening; per-task sessions, allowlist-enforced |
| **MCP client** (stdio JSON-RPC, tool registration) | 🟡 | works, Agent-mode only; no remote/SSE transport |
| Web search | 🟡 | DuckDuckGo only (`tools/web-search.ts`); no API-key providers |

### Editor integration & platform

| Capability | Level | Why |
|---|:--:|---|
| Inline completion (FIM-aware) | 🟡 | `core/inline-completion.ts`; single-model, no multi-file context |
| Inline chat (`Cmd+I`) | 🟡 | selection-scoped; solid but narrow |
| Commit-message generation | 🟡 | works; diff-size naive |
| Multi-provider LLM (OpenAI/Anthropic/Google/OpenRouter/Ollama/LM Studio) | 🟢 | `core/llm-client.ts` |
| Output modes (`apply` / `pr`) | 🟢 | `core/git-pr.ts` |
| Local-only telemetry + diagnostics export | 🟢 | `core/telemetry-sink.ts` |

**Read of the map:** the *engine* (loop, pipeline, checkpoints, index, worktrees) is Advanced. The
**intelligence layer that makes agents good at a specific stack is Beginning** — skills are
keyword-only and don't even reach the pipeline agents. That is the highest-leverage gap, and it is
exactly what Part 2 addresses.

---

## Part 2 — Initiative: Project-Aware Dynamic Agent Skills

### Problem statement

The eight agents share fixed, generic system prompts. A "Backend" agent writes the same way whether
the repo is Django, ASP.NET, or Actix — it has no loaded knowledge of the stack's idioms,
conventions, project layout, test runner, or common pitfalls. Meanwhile:

- `SkillsManager` **exists** but (a) triggers only on prompt keywords, (b) ships no content, and
  (c) is **never called inside the pipeline** (`extension.ts` uses it only in `_runAgentTask`,
  lines 1665/1742–1744 — `_runPipelineCore` injects zero skills into its executors).
- There is **no project-type detection** to key skills off of.
- The **mindmap** isn't stack-aware and isn't read back by the agents that could use it.

### Target

When a run starts, Black IDE should:
1. **Detect the project type** (languages, frameworks, package/test/build tooling) from manifests.
2. **Resolve the right skills per agent** — Backend-on-Django gets Django ORM/migrations/DRF
   idioms; Testing-on-Rust gets `cargo test`/proptest idioms; Frontend-on-Next gets App-Router
   conventions — combining *stack match + agent role + prompt relevance*.
3. **Inject those skills into every agent**, chat and pipeline alike, within the prompt budget.
4. **Sync the detected stack + conventions into the mindmap**, and have agents read the relevant
   section before acting.

### Design overview

```
manifests ─► ProjectProfiler ─► ProjectProfile {languages, frameworks,
   (Cargo.toml, *.csproj,          packageManager, testFrameworks, buildTool,
    requirements.txt, …)           confidence, evidence}
                                        │
                 ┌──────────────────────┼───────────────────────┐
                 ▼                       ▼                       ▼
          SkillResolver           Mindmap "Stack &          Knowledge base
   score = stackMatch·w1 +         Conventions" section       (architecture.md
     roleAffinity·w2 +             (seeded + agent-read)        stack-specialized)
     promptTrigger·w3
                 │
                 ▼
   per-agent skill injection  ──►  chat (_runAgentTask)  +  pipeline (_runPipelineCore executors)
   (budgeted via PromptBuilder)
```

**Data model changes (`agent/skills-manager.ts`)** — extend `Skill`:
```ts
interface Skill {
  name; description; instructions; triggerPatterns; directory;   // existing
  roles?: string[];    // 'backend' | 'frontend' | 'design' | 'testing' | 'devops' | 'architect'
  stacks?: string[];   // 'django' | 'fastapi' | 'dotnet' | 'rust' | 'react' | 'nextjs' | …
  priority?: number;   // tie-breaker for ranking
}
```
Existing keyword-only skills keep working (roles/stacks optional → fall back to `triggerPatterns`).

**Agent → role map** (drives resolution): Backend/Backend-Executor→`backend`; Frontend/
Frontend-Executor→`frontend`; Design-Executor→`design`; Testing-Executor→`testing`; DevOps→
`devops`; Sr Architect/HLD/LLD→`architect`; Ask/Plan/Agent/Manager→generalist (role-agnostic,
stack skills still apply).

### The built-in skill library (catalog by role)

Every skill is one `SKILL.md` pack that declares its `roles`, `stacks`, and `triggers` in
frontmatter, and its body carries idioms, canonical project layout, conventions, commands, and
common pitfalls. The resolver (Phase 2) picks packs by *role + detected stack + prompt*, so a skill
can be broad (a language) or narrow (a single framework) and still rank correctly.

Skills come in three grains, and a pack can belong to more than one via multiple `stacks`:
- **Language skills** — idioms, tooling, packaging for a language (Python, TypeScript, C#, …).
- **Framework skills** — the specific stack layered on the language (Django on Python, ASP.NET on
  C#, React on TypeScript).
- **Cross-cutting skills** — role practices independent of stack (REST API design, a11y, TDD).

#### 🟩 BACKEND (`roles: [backend]`)

| Grain | Skills (`stacks`) |
|---|---|
| **Languages** | `python-backend`, `nodejs-backend` (JavaScript/TypeScript), `csharp-backend`, `rust-backend`, `go-backend`, `ruby-backend`, `java-backend`, `php-backend` |
| **Python frameworks** | `django`, `django-rest-framework`, `fastapi`, `flask` |
| **Node frameworks** | `express`, `nestjs`, `fastify` |
| **C# / .NET** | `aspnet-core`, `entity-framework-core`, `dotnet-minimal-apis` |
| **Rust** | `actix-web`, `axum`, `rust-diesel-sea-orm` |
| **Go** | `gin`, `echo`, `go-net-http`, `gorm` |
| **Ruby / Java / PHP** | `rails`, `spring-boot` (JPA/Hibernate), `laravel`, `symfony` |
| **Cross-cutting** | `rest-api-design`, `graphql-api`, `auth-jwt-oauth`, `db-migrations`, `orm-patterns`, `caching-strategies`, `message-queues`, `websockets` |

#### 🟦 FRONTEND (`roles: [frontend]`)

| Grain | Skills (`stacks`) |
|---|---|
| **Languages** | `javascript-frontend`, `typescript-frontend` |
| **Web frameworks** | `react`, `nextjs`, `angular`, `vue`, `svelte-kit`, `solidjs`, `remix`, `astro` |
| **Mobile / cross-platform** | `react-native` (+ `expo`), `flutter` (Dart) |
| **State & data** | `redux-toolkit`, `zustand`, `pinia`, `ngrx`, `tanstack-query` |
| **Styling** | `tailwind`, `css-modules`, `styled-components`, `scss-sass` |
| **Cross-cutting** | `component-architecture`, `web-performance`, `forms-validation`, `spa-routing` |

#### 🟪 DESIGN (`roles: [design]`)

| Grain | Skills (`stacks`) |
|---|---|
| **Systems & foundations** | `design-systems-tokens`, `atomic-design`, `responsive-layout` (flexbox/grid), `typography-color` |
| **Accessibility** | `a11y-wcag-aria` |
| **Toolkits** | `tailwind-design`, `material-design`, `shadcn-radix` |
| **Interaction** | `motion-animation`, `ux-patterns`, `figma-to-code` |

#### 🟨 TESTING (`roles: [testing]`)

| Grain | Skills (`stacks`) |
|---|---|
| **Python** | `pytest`, `pytest-django`, `python-unittest` |
| **JS / TS** | `jest`, `vitest`, `react-testing-library`, `playwright-e2e`, `cypress-e2e` |
| **C#** | `xunit`, `nunit`, `mstest` |
| **Rust / Go** | `cargo-test` (+ `proptest`), `go-test` (table-driven, `testify`) |
| **Ruby / Java** | `rspec`, `junit-mockito` |
| **Cross-cutting** | `test-strategy` (unit/integration/e2e), `mocking-stubbing`, `coverage-tdd`, `contract-testing`, `load-testing` |

#### ⬛ DEVOPS (`roles: [devops]`) — supporting role

`docker`, `docker-compose`, `kubernetes`, `github-actions-ci`, `terraform`, plus stack build/deploy
notes (e.g. `gunicorn`/`uvicorn` for Python, `dotnet publish`, `cargo build --release`, Go
multistage images) attached to the relevant framework packs.

#### Compact stack × role view

| Stack ↓ / Role → | backend | frontend | design | testing |
|---|---|---|---|---|
| **Python · Django/DRF** | `django`, `django-rest-framework`, `orm-patterns` | — | — | `pytest-django` |
| **Python · FastAPI/Flask** | `fastapi`, `flask`, `rest-api-design` | — | — | `pytest` |
| **JS/TS · Node** | `express`, `nestjs`, `auth-jwt-oauth` | — | — | `jest`, `vitest` |
| **C# · .NET** | `aspnet-core`, `entity-framework-core` | — | — | `xunit`, `nunit` |
| **Rust** | `axum`, `actix-web` | — | — | `cargo-test`, `proptest` |
| **Go** | `gin`, `go-net-http`, `gorm` | — | — | `go-test` |
| **Ruby · Rails** | `rails`, `db-migrations` | — | — | `rspec` |
| **Java · Spring** | `spring-boot` | — | — | `junit-mockito` |
| **React / Next.js** | — | `react`, `nextjs`, `tanstack-query` | `design-systems-tokens`, `a11y-wcag-aria` | `react-testing-library`, `playwright-e2e` |
| **Angular** | — | `angular`, `ngrx` | `a11y-wcag-aria` | `jest`, `cypress-e2e` |
| **React Native / Expo** | — | `react-native`, `expo` | `responsive-layout` | `jest`, `react-testing-library` |
| **Vue / Svelte** | — | `vue`+`pinia`, `svelte-kit` | `design-systems-tokens` | `vitest`, `playwright-e2e` |
| **Any + Tailwind** | — | `tailwind` | `tailwind-design`, `a11y-wcag-aria` | — |

> This is the *initial* library. It is data, not code — new stacks are added by dropping another
> `SKILL.md`, no release required (see storage model below).

Detection signals the profiler keys on: `manage.py`+`settings.py`→Django; `pyproject.toml`/
`requirements.txt`→Python; `package.json` deps (`react`,`next`,`@angular/core`,`react-native`,
`vue`,`svelte`,`express`,`@nestjs/core`)→JS frameworks; `*.csproj`/`*.sln`→.NET; `Cargo.toml`→Rust;
`go.mod`→Go; `Gemfile`+`config/routes.rb`→Rails; `pom.xml`/`build.gradle`→Spring;
`composer.json`→Laravel/Symfony; `pubspec.yaml`→Flutter.

### Storage & discovery model — everything lives in `.blackide/skills/`

Skills — **both the built-in library and anything a user writes** — are plain `SKILL.md` folders
under a `skills/` directory. `SkillsManager` already scans `.blackide/skills/` (workspace) and
`~/.blackide/skills/` (global); this initiative formalizes it into a clear precedence:

```
skills/<skill-name>/SKILL.md         ← one folder per skill

Discovery precedence (later overrides earlier by skill name):
  1. Bundled built-ins   ─ shipped read-only in the extension (resources/skills/)
  2. Global user skills  ─ ~/.blackide/skills/        (apply to every project)
  3. Workspace skills    ─ <repo>/.blackide/skills/   (project-specific; highest precedence)
```

- **Users add dynamic skills** by dropping a folder into `<repo>/.blackide/skills/<name>/SKILL.md`
  (or the global `~/.blackide/skills/`). Hot-reloaded on save (Phase 6), with validation
  diagnostics for malformed frontmatter — same UX as custom modes.
- **Built-ins are materializable into `.blackide/skills/`** too: a "Black IDE: Install Skill Packs"
  command copies selected bundled packs into `<repo>/.blackide/skills/`, so they are visible,
  diffable, editable, and **overridable** by name — the folder is the single source of truth the
  user can see and own, exactly as requested. A user pack named `django` shadows the built-in one.
- **`SKILL.md` frontmatter** (superset of today's format, backward compatible):

  ```markdown
  ---
  name: django
  description: Django + DRF backend idioms, project layout, and pitfalls
  roles: [backend]
  stacks: [django, python]
  triggers: [django, models.py, migrations, drf, serializer]   # optional; legacy still works
  priority: 10
  ---
  # When to use ... / Project layout ... / Conventions ... / Commands ... / Pitfalls ...
  ```

  `roles`/`stacks`/`priority` are optional additions; existing keyword-only skills keep working.

---

## Phased execution

Each phase ships independently, ends green on the harness (`vscode`-free tier wherever the logic
allows) plus its own tests, `tsc -b` clean, and the webview building.

### Phase 1 — Project Profiler (detection foundation)
- **New:** `core/project-profiler.ts` → `detectProjectProfile(files, manifests): ProjectProfile`
  (pure, testable). `ProjectProfile { languages[], frameworks[], packageManager, testFrameworks[],
  buildTool, confidence, evidence[] }`.
- Cache to `.blackIDE/knowledge/project_profile.json`; refresh on manifest change (reuse the
  workspace watcher pattern from `ModeLoader`).
- Fold the profile into the first-run scan (`summarizeRepoStructure` gains a stack line).
- **Tests:** fixture repos (django / dotnet / rust / react / go) → expected profile; ambiguous/
  polyglot repos → ranked frameworks with confidence; empty repo → empty profile, no throw.
- **Ship gate:** detection accuracy on the fixture set; zero effect on runs until Phase 4 consumes it.

### Phase 2 — Skill model + resolver
- Extend `Skill` (roles/stacks/priority) and `SkillsManager` parsing (backward compatible).
- **New:** `SkillResolver.resolve(role, profile, prompt, budget)` → ranked `Skill[]`, scoring
  `stackMatch·w1 + roleAffinity·w2 + promptTrigger·w3`, capped by count/token budget.
- **Tests:** (role=backend, stack=django, prompt) → django-backend ranked first; role mismatch
  demoted; legacy keyword-only skill still resolvable; empty profile → prompt-trigger behavior
  (today's behavior preserved).

### Phase 3 — Built-in skill pack library + `.blackide/skills` storage
- Author the catalog above as bundled `SKILL.md` packs (shipped read-only under the extension's
  `resources/skills/`), each declaring `roles`, `stacks`, `priority`, plus idioms, canonical project
  layout, conventions, commands, and pitfalls (≤~2 KB injected each — the resolver/PromptBuilder
  enforces the budget).
- **Rollout by wave** so value lands early:
  - *Wave 1 (highest traffic):* backend `django`, `django-rest-framework`, `fastapi`, `express`,
    `nestjs`, `aspnet-core`, `axum`, `gin`; frontend `react`, `nextjs`, `angular`, `react-native`,
    `vue`, `tailwind`; design `design-systems-tokens`, `a11y-wcag-aria`, `tailwind-design`; testing
    `pytest`, `jest`, `react-testing-library`, `xunit`, `cargo-test`, `playwright-e2e`.
  - *Wave 2:* remaining languages/frameworks (`flask`, `entity-framework-core`, `gorm`, `rails`,
    `spring-boot`, `laravel`, `svelte-kit`, `solidjs`, `remix`, `astro`, `flutter`) and cross-cutting
    packs (`rest-api-design`, `auth-jwt-oauth`, `orm-patterns`, `component-architecture`,
    `test-strategy`, `coverage-tdd`, …).
- **Storage / discovery (per the model above):** `SkillsManager` resolves bundled → global
  (`~/.blackide/skills/`) → workspace (`<repo>/.blackide/skills/`), later overriding earlier by name.
- **New command `black-ide.installSkillPacks`** — copies selected built-in packs into
  `<repo>/.blackide/skills/` so users can see, edit, and override them, and so project-specific packs
  live beside them. (Mirrors the `installBrowserSupport` command pattern already in `extension.ts`.)
- **Tests:** every bundled pack parses and declares ≥1 role and ≥1 stack; a workspace pack shadows a
  bundled pack of the same name; discovery precedence holds.

### Phase 4 — Wire skills into all agents (the highest-leverage step)
- **Chat** (`_runAgentTask`): resolve by `(role-of-selected-mode, profile, prompt)` instead of
  prompt-only. Already budgeted through `PromptBuilder`'s `skills` section.
- **Pipeline** (`_runPipelineCore`): **inject resolved skills per executor**, keyed by each phase
  mode's role — this is the gap where pipeline agents currently get **nothing**. Add a `skills`
  section to each executor's prompt build.
- **Tests:** given a Django profile, the Backend Executor's assembled system prompt contains the
  django-backend skill; a Rust profile yields cargo-testing for the Testing Executor; no profile →
  no stack skills injected (safe default).

### Phase 5 — Project-aware mindmap syncing
- Give `project_mindmap.md` a **stable, sectioned schema** with a seeded **"Stack & Conventions"**
  block from `ProjectProfile` (upgrade `syncMindmap` from blind append to sectioned upsert — the
  `update_mindmap` tool already supports `replace_section`).
- Have agents **read the relevant mindmap section** before editing (inject a compact digest, like
  the knowledge base already does), so the mindmap becomes a working memory, not write-only.
- Cross-link: mindmap ↔ knowledge base ↔ which skills fired this run.
- **Tests:** sectioned upsert is idempotent (re-sync doesn't duplicate); the stack section reflects
  the detected profile; a run reads back the section it wrote.

### Phase 6 — Authoring, lifecycle & observability
- Hot-reload user skills (mirror `ModeLoader.watchForChanges`) + validation diagnostics for
  malformed `SKILL.md` (missing roles/stacks/frontmatter).
- Telemetry: record which skills fired per run (`telemetry-sink.ts`), so we can measure coverage
  and prune dead packs.
- Docs: "Authoring stack/role skills" guide in `docs/wiki_docs/`.

---

## Sequencing & dependencies

```
Phase 1 (profiler) ─► Phase 2 (resolver) ─► Phase 4 (wire-in)  ◄─ the payoff
                          │
Phase 3 (packs) ─────────┘  (parallel with 2; needed by 4)
Phase 5 (mindmap)  depends on Phase 1
Phase 6 (lifecycle) independent; can trail
```

- **1 → 2 → 4** is the critical path to value; **3** runs in parallel with **2**.
- **5** needs only the profiler (1). **6** can land any time.

## Success metrics

- **Coverage:** on a typed project, every relevant agent (chat *and* pipeline) receives ≥1
  stack-appropriate skill. Today: pipeline agents receive **zero**.
- **Detection:** ≥95% correct primary-framework detection on the fixture set; graceful degrade on
  polyglot/empty repos.
- **Quality:** measurable drop in wrong-idiom output (e.g. generic SQL where the ORM is idiomatic;
  wrong test runner) — track via a golden-task set per stack.
- **Mindmap utility:** agents read the stack section before acting; re-sync is idempotent.

## Risks & mitigations

- **Prompt-budget pressure** from injected skills → the `PromptBuilder` section budget already caps
  and truncates; resolver ranks so the *most* relevant skill survives truncation.
- **Wrong detection** on polyglot repos → confidence + evidence in `ProjectProfile`; ambiguous
  cases inject nothing rather than a wrong pack (fail safe, like the browser allowlist did).
- **Skill sprawl / staleness** → Phase 6 telemetry + validation; bundled packs are versioned and
  reviewed, user packs are clearly scoped.
- **Backward compatibility** → `roles`/`stacks` are optional; existing keyword-only skills and the
  current chat behavior are preserved when no profile is available.

## Out of scope (named, so it isn't assumed)

- A learned/embedding-based skill router (start rule-based; revisit if precision demands it).
- Auto-generating skills from a repo (future — could mine conventions into a project-local pack).
- Remote/marketplace skill distribution.
