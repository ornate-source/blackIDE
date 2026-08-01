/*
 * Golden tasks (Phase 0, M3).
 *
 * One task = a realistic prompt, the stack fixture it runs against, and the agent
 * role that would handle it. `expectSkills` names the bundled packs that *should*
 * be injected for that combination.
 *
 * `expectSkills: []` is meaningful, not a placeholder: it marks a (stack, role)
 * pair the bundled library does not cover yet. Those are the misses the Phase 10
 * breadth work has to close, and counting them is the point of the coverage metric.
 *
 * `forbidSkills: [...]` names packs that must **not** fire — the wrong-idiom metric
 * (§4.2). Every entry is a leak that was real on 2026-08-01, not a hypothetical:
 * growing this file from 19 tasks to 74 is what found them.
 *
 * `forbidAny: true` is the stronger fail-safe claim: *nothing* may be injected.
 *
 * ── Grown 2026-08-01 (M3 breadth) ───────────────────────────────────────────
 * 19 tasks / 8 fixtures → **74 tasks / 13 fixtures**, which is the 8–10 per stack
 * across six stacks that Phase 0 called for, plus coverage for every bundled pack.
 * Two properties are now assertable that were not before:
 *   1. every bundled pack is named by at least one task's `expectSkills`, so a pack
 *      cannot rot unnoticed (`flask`, `rails`, `angular` and `react-native` had no
 *      eval coverage at all until now);
 *   2. every role the resolver understands appears, including `architect` and
 *      `devops` — which is how the library's real shape becomes visible: we bundle
 *      nothing for either, and the roadmap's cross-cutting packs are Phase 10.
 *
 * What the breadth immediately bought: findings **F3** (wrong-framework injection),
 * **F3b** (quoted commas split in pack frontmatter, so `"req, res"` became the trigger
 * `res` and matched "Restyle"), and the priority-as-signal residue of F1. All three
 * were invisible at 19 tasks and are guarded by the `forbidSkills` rows below.
 */

module.exports = [
    // ── Python · Django ──────────────────────────────────────────────────────
    { id: 'django-be-1', fixture: 'django', role: 'backend', prompt: 'Add a Customer model with a name and email field, plus a migration', expectSkills: ['django'], forbidSkills: ['rails', 'aspnet-core'] },
    { id: 'django-be-2', fixture: 'django', role: 'backend', prompt: 'Expose a paginated REST endpoint listing all orders', expectSkills: ['django'] },
    { id: 'django-be-3', fixture: 'django', role: 'backend', prompt: 'Fix the N+1 query when serializing orders with their customer', expectSkills: ['django'] },
    { id: 'django-be-4', fixture: 'django', role: 'backend', prompt: 'Move the discount calculation out of the view into a service layer', expectSkills: ['django'], forbidSkills: ['aspnet-core'] },
    { id: 'django-test-1', fixture: 'django', role: 'testing', prompt: 'Write tests covering the orders endpoint', expectSkills: ['pytest'] },
    { id: 'django-test-2', fixture: 'django', role: 'testing', prompt: 'Add a regression test for the order total rounding bug', expectSkills: ['pytest'] },
    // Django templates and static handling are backend concerns, so the django pack
    // firing here is right; what is missing is a styling pack for a server-rendered UI.
    { id: 'django-fe-1', fixture: 'django', role: 'frontend', prompt: 'Style the admin dashboard header', expectSkills: [] },
    { id: 'django-arch-1', fixture: 'django', role: 'architect', prompt: 'Propose how to split the orders app into bounded contexts', expectSkills: ['django'] },
    // No docker / github-actions-ci pack bundled — Phase 10's cross-cutting wave.
    { id: 'django-ops-1', fixture: 'django', role: 'devops', prompt: 'Add a docker-compose with postgres for local development', expectSkills: [] },

    // ── Python · FastAPI ─────────────────────────────────────────────────────
    { id: 'fastapi-be-1', fixture: 'fastapi', role: 'backend', prompt: 'Add a POST /items endpoint with request validation', expectSkills: ['fastapi'], forbidSkills: ['django', 'flask'] },
    { id: 'fastapi-be-2', fixture: 'fastapi', role: 'backend', prompt: 'Add dependency-injected database sessions to the items router', expectSkills: ['fastapi'], forbidSkills: ['express'] },
    { id: 'fastapi-be-3', fixture: 'fastapi', role: 'backend', prompt: 'Return a 409 instead of a 500 when an item already exists', expectSkills: ['fastapi'] },
    { id: 'fastapi-be-4', fixture: 'fastapi', role: 'backend', prompt: 'Add background processing for the item import job', expectSkills: ['fastapi'] },
    { id: 'fastapi-test-1', fixture: 'fastapi', role: 'testing', prompt: 'Add tests for the items router', expectSkills: ['pytest'] },
    { id: 'fastapi-test-2', fixture: 'fastapi', role: 'testing', prompt: 'Add tests that assert the 422 validation response shape', expectSkills: ['pytest'] },
    { id: 'fastapi-arch-1', fixture: 'fastapi', role: 'architect', prompt: 'Split the monolith router file into per-domain routers', expectSkills: ['fastapi'] },
    { id: 'fastapi-ops-1', fixture: 'fastapi', role: 'devops', prompt: 'Add a Dockerfile and healthcheck for the service', expectSkills: [] },
    { id: 'fastapi-fe-1', fixture: 'fastapi', role: 'frontend', prompt: 'Add a minimal HTML page that lists items', expectSkills: [], forbidSkills: ['react', 'nextjs'] },

    // ── Node · Express ───────────────────────────────────────────────────────
    { id: 'express-be-1', fixture: 'node-express', role: 'backend', prompt: 'Add a users route with JWT auth middleware', expectSkills: ['express'] },
    { id: 'express-be-2', fixture: 'node-express', role: 'backend', prompt: 'Add request validation to the users route', expectSkills: ['express'] },
    { id: 'express-be-3', fixture: 'node-express', role: 'backend', prompt: 'Centralise error handling into one middleware', expectSkills: ['express'], forbidSkills: ['aspnet-core'] },
    { id: 'express-be-4', fixture: 'node-express', role: 'backend', prompt: 'Add rate limiting to the auth endpoints', expectSkills: ['express'] },
    { id: 'express-test-1', fixture: 'node-express', role: 'testing', prompt: 'Write unit tests for the auth middleware', expectSkills: ['jest'] },
    { id: 'express-test-2', fixture: 'node-express', role: 'testing', prompt: 'Add integration tests for the users route', expectSkills: ['jest'] },
    { id: 'express-arch-1', fixture: 'node-express', role: 'architect', prompt: 'Restructure the server into routes, services and repositories', expectSkills: ['express'] },
    { id: 'express-ops-1', fixture: 'node-express', role: 'devops', prompt: 'Add a multi-stage Dockerfile for the API', expectSkills: [] },
    { id: 'express-fe-1', fixture: 'node-express', role: 'frontend', prompt: 'Serve a small status page from the API', expectSkills: [], forbidSkills: ['react', 'nextjs', 'angular'] },

    // ── Node · NestJS ────────────────────────────────────────────────────────
    // The wrong-framework guard that matters most. On 2026-08-01 the first of these
    // resolved to **express, aspnet-core, nextjs, react, angular** — five packs, every
    // one of them wrong, three of them not even the right language. No `nestjs` pack is
    // bundled (Phase 10), and "nothing" is the correct answer until one is.
    { id: 'nest-be-1', fixture: 'node-nest', role: 'backend', prompt: 'Add a users controller with a service and DTO validation', expectSkills: [], forbidSkills: ['express', 'aspnet-core', 'nextjs', 'react', 'angular'] },
    { id: 'nest-be-2', fixture: 'node-nest', role: 'backend', prompt: 'Add a guard that rejects requests without a valid token', expectSkills: [], forbidSkills: ['express', 'aspnet-core'] },
    { id: 'nest-test-1', fixture: 'node-nest', role: 'testing', prompt: 'Write e2e tests for the users controller', expectSkills: ['jest'], forbidSkills: ['express', 'react', 'nextjs', 'angular'] },
    { id: 'nest-arch-1', fixture: 'node-nest', role: 'architect', prompt: 'Split the app module into feature modules', expectSkills: [], forbidSkills: ['express', 'aspnet-core'] },

    // ── React / Next.js ──────────────────────────────────────────────────────
    { id: 'next-fe-1', fixture: 'react-next', role: 'frontend', prompt: 'Add a settings page with a form', expectSkills: ['nextjs', 'react'], forbidSkills: ['angular', 'react-native'] },
    { id: 'next-fe-2', fixture: 'react-next', role: 'frontend', prompt: 'Extract the button into a reusable component', expectSkills: ['react'], forbidSkills: ['angular'] },
    { id: 'next-fe-3', fixture: 'react-next', role: 'frontend', prompt: 'Fetch orders on the server and stream the list', expectSkills: ['nextjs'] },
    { id: 'next-fe-4', fixture: 'react-next', role: 'frontend', prompt: 'Add optimistic updates to the order status toggle', expectSkills: ['react'] },
    { id: 'next-fe-5', fixture: 'react-next', role: 'frontend', prompt: 'Memoise the expensive order total calculation', expectSkills: ['react'] },
    { id: 'next-design-1', fixture: 'react-next', role: 'design', prompt: 'Make the navigation accessible to screen readers', expectSkills: ['a11y-wcag-aria'] },
    { id: 'next-design-2', fixture: 'react-next', role: 'design', prompt: 'Restyle the settings page to match the design tokens', expectSkills: ['tailwind'] },
    { id: 'next-test-1', fixture: 'react-next', role: 'testing', prompt: 'Add component tests for the settings form', expectSkills: ['jest'] },
    { id: 'next-test-2', fixture: 'react-next', role: 'testing', prompt: 'Add a test that the order list renders an empty state', expectSkills: ['jest'] },
    { id: 'next-arch-1', fixture: 'react-next', role: 'architect', prompt: 'Decide where server and client component boundaries should fall', expectSkills: ['nextjs'] },

    // ── C# · ASP.NET Core ────────────────────────────────────────────────────
    { id: 'dotnet-be-1', fixture: 'dotnet', role: 'backend', prompt: 'Add a UsersController with CRUD actions backed by EF Core', expectSkills: ['aspnet-core'] },
    { id: 'dotnet-be-2', fixture: 'dotnet', role: 'backend', prompt: 'Add a migration for the new Orders table', expectSkills: ['aspnet-core'], forbidSkills: ['django', 'rails'] },
    { id: 'dotnet-be-3', fixture: 'dotnet', role: 'backend', prompt: 'Return ProblemDetails instead of raw exceptions', expectSkills: ['aspnet-core'] },
    { id: 'dotnet-be-4', fixture: 'dotnet', role: 'backend', prompt: 'Add request validation with FluentValidation to the users endpoint', expectSkills: ['aspnet-core'] },
    // No xunit pack is bundled yet — a known Phase 10 gap, recorded rather than hidden.
    { id: 'dotnet-test-1', fixture: 'dotnet', role: 'testing', prompt: 'Write unit tests for the users service', expectSkills: [], forbidSkills: ['jest', 'pytest'] },
    { id: 'dotnet-test-2', fixture: 'dotnet', role: 'testing', prompt: 'Add integration tests for the users controller', expectSkills: [], forbidSkills: ['jest', 'pytest'] },
    { id: 'dotnet-arch-1', fixture: 'dotnet', role: 'architect', prompt: 'Introduce a repository layer between controllers and the DbContext', expectSkills: ['aspnet-core'] },
    { id: 'dotnet-ops-1', fixture: 'dotnet', role: 'devops', prompt: 'Add a Dockerfile and a GitHub Actions build for the API', expectSkills: [] },
    { id: 'dotnet-fe-1', fixture: 'dotnet', role: 'frontend', prompt: 'Add a Razor page listing users', expectSkills: [], forbidSkills: ['react', 'nextjs', 'angular'] },

    // ── Rust · Axum ──────────────────────────────────────────────────────────
    { id: 'rust-be-1', fixture: 'rust', role: 'backend', prompt: 'Add a health check route returning JSON', expectSkills: ['axum'] },
    { id: 'rust-be-2', fixture: 'rust', role: 'backend', prompt: 'Add typed extractors and error responses to the routes', expectSkills: ['axum'], forbidSkills: ['express'] },
    { id: 'rust-be-3', fixture: 'rust', role: 'backend', prompt: 'Share a connection pool across handlers with state', expectSkills: ['axum'] },
    // No cargo-test pack bundled yet — Phase 10 gap.
    { id: 'rust-test-1', fixture: 'rust', role: 'testing', prompt: 'Add integration tests for the health route', expectSkills: [], forbidSkills: ['jest', 'pytest'] },
    { id: 'rust-arch-1', fixture: 'rust', role: 'architect', prompt: 'Split the binary into a library crate plus a thin main', expectSkills: ['axum'] },

    // ── Go · Gin ─────────────────────────────────────────────────────────────
    { id: 'go-be-1', fixture: 'go', role: 'backend', prompt: 'Add a users handler with request binding', expectSkills: ['gin'] },
    { id: 'go-be-2', fixture: 'go', role: 'backend', prompt: 'Add middleware that logs request duration', expectSkills: ['gin'], forbidSkills: ['express'] },
    { id: 'go-be-3', fixture: 'go', role: 'backend', prompt: 'Return structured JSON errors from the handlers', expectSkills: ['gin'] },
    // No go-test pack bundled yet — Phase 10 gap.
    { id: 'go-test-1', fixture: 'go', role: 'testing', prompt: 'Add table-driven tests for the users handler', expectSkills: [], forbidSkills: ['jest', 'pytest'] },
    { id: 'go-ops-1', fixture: 'go', role: 'devops', prompt: 'Containerise the service and add a GitHub Actions build', expectSkills: [] },

    // ── Python · Flask ───────────────────────────────────────────────────────
    // `flask` shipped with no eval coverage. The forbids are the Python half of F3:
    // both django and fastapi fired here, purely because the repo is Python.
    { id: 'flask-be-1', fixture: 'flask', role: 'backend', prompt: 'Add an orders blueprint with SQLAlchemy models', expectSkills: ['flask'], forbidSkills: ['django', 'fastapi'] },
    { id: 'flask-be-2', fixture: 'flask', role: 'backend', prompt: 'Add an application factory and config objects', expectSkills: ['flask'], forbidSkills: ['django', 'fastapi'] },
    { id: 'flask-test-1', fixture: 'flask', role: 'testing', prompt: 'Add tests for the orders blueprint', expectSkills: ['pytest'], forbidSkills: ['django', 'fastapi'] },

    // ── Ruby · Rails ─────────────────────────────────────────────────────────
    // `aspnet-core` lists the generic trigger `controller`, which fired here on a Ruby
    // repo before the identity rule required an identifying mention.
    { id: 'rails-be-1', fixture: 'rails', role: 'backend', prompt: 'Add an Order model with validations and a controller', expectSkills: ['rails'], forbidSkills: ['aspnet-core', 'django'] },
    { id: 'rails-be-2', fixture: 'rails', role: 'backend', prompt: 'Add a scope and an index for recent orders', expectSkills: ['rails'] },
    { id: 'rails-test-1', fixture: 'rails', role: 'testing', prompt: 'Add model specs for Order', expectSkills: ['rails'], forbidSkills: ['jest', 'pytest'] },

    // ── JS/TS · Angular ──────────────────────────────────────────────────────
    // `react` lists the generic trigger `component`; an Angular component task pulled in
    // React and Next.js before F3.
    { id: 'angular-fe-1', fixture: 'angular', role: 'frontend', prompt: 'Add an orders list component using the orders service', expectSkills: ['angular'], forbidSkills: ['react', 'nextjs', 'react-native'] },
    { id: 'angular-fe-2', fixture: 'angular', role: 'frontend', prompt: 'Move the HTTP calls into an injectable service with rxjs', expectSkills: ['angular'], forbidSkills: ['react', 'nextjs'] },
    // Angular's default runner is Karma + Jasmine, and no pack is bundled for either.
    // `jest` fires on the TypeScript match; its content (structure, mocking, assertions)
    // transfers, so this is recorded as a judgement rather than forbidden.
    { id: 'angular-test-1', fixture: 'angular', role: 'testing', prompt: 'Add unit tests for the orders service', expectSkills: ['jest'], forbidSkills: ['react', 'nextjs'] },

    // ── JS/TS · React Native ─────────────────────────────────────────────────
    // `nextjs` ranked *first* here before F3: it matched on `react`, which React Native
    // genuinely implies (F2's contract), and App Router idioms are wrong for a phone.
    { id: 'rn-fe-1', fixture: 'react-native', role: 'frontend', prompt: 'Add an orders screen with a flat list', expectSkills: ['react-native', 'react'], forbidSkills: ['nextjs', 'angular'] },
    { id: 'rn-fe-2', fixture: 'react-native', role: 'frontend', prompt: 'Add pull-to-refresh to the orders screen', expectSkills: ['react-native'], forbidSkills: ['nextjs'] },
    { id: 'rn-design-1', fixture: 'react-native', role: 'design', prompt: 'Make the order card readable at large font sizes', expectSkills: ['a11y-wcag-aria'], forbidSkills: ['nextjs', 'tailwind'] },

    // ── Fail-safe ────────────────────────────────────────────────────────────
    // No detected stack must mean no stack skills injected, per the profiler's
    // fail-safe contract. A regression here means we inject wrong-stack idioms.
    { id: 'empty-be-1', fixture: 'empty', role: 'backend', prompt: 'Add a database layer', expectSkills: [], forbidAny: true },
    // The frontend half states the *other* side of the contract explicitly: a
    // stack-agnostic pack is still correct with no stack detected (role is the only
    // signal it has, and it is the right one), while every framework pack must stay out.
    { id: 'empty-fe-1', fixture: 'empty', role: 'frontend', prompt: 'Add a component library', expectSkills: ['a11y-wcag-aria'], forbidSkills: ['react', 'nextjs', 'angular', 'react-native', 'tailwind'] },
];
