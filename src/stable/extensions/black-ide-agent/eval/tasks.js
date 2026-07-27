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
 */

module.exports = [
    // ── Python · Django ──────────────────────────────────────────────────────
    { id: 'django-be-1', fixture: 'django', role: 'backend', prompt: 'Add a Customer model with a name and email field, plus a migration', expectSkills: ['django'] },
    { id: 'django-be-2', fixture: 'django', role: 'backend', prompt: 'Expose a paginated REST endpoint listing all orders', expectSkills: ['django'] },
    { id: 'django-test-1', fixture: 'django', role: 'testing', prompt: 'Write tests covering the orders endpoint', expectSkills: ['pytest'] },
    { id: 'django-fe-1', fixture: 'django', role: 'frontend', prompt: 'Style the admin dashboard header', expectSkills: [] },

    // ── Python · FastAPI ─────────────────────────────────────────────────────
    { id: 'fastapi-be-1', fixture: 'fastapi', role: 'backend', prompt: 'Add a POST /items endpoint with request validation', expectSkills: ['fastapi'] },
    { id: 'fastapi-test-1', fixture: 'fastapi', role: 'testing', prompt: 'Add tests for the items router', expectSkills: ['pytest'] },

    // ── Node · Express ───────────────────────────────────────────────────────
    { id: 'express-be-1', fixture: 'node-express', role: 'backend', prompt: 'Add a users route with JWT auth middleware', expectSkills: ['express'] },
    { id: 'express-test-1', fixture: 'node-express', role: 'testing', prompt: 'Write unit tests for the auth middleware', expectSkills: ['jest'] },

    // ── React / Next.js ──────────────────────────────────────────────────────
    { id: 'next-fe-1', fixture: 'react-next', role: 'frontend', prompt: 'Add a settings page with a form', expectSkills: ['nextjs', 'react'] },
    { id: 'next-fe-2', fixture: 'react-next', role: 'frontend', prompt: 'Extract the button into a reusable component', expectSkills: ['react'] },
    { id: 'next-design-1', fixture: 'react-next', role: 'design', prompt: 'Make the navigation accessible to screen readers', expectSkills: ['a11y-wcag-aria'] },
    { id: 'next-test-1', fixture: 'react-next', role: 'testing', prompt: 'Add component tests for the settings form', expectSkills: ['jest'] },

    // ── C# · ASP.NET Core ────────────────────────────────────────────────────
    { id: 'dotnet-be-1', fixture: 'dotnet', role: 'backend', prompt: 'Add a UsersController with CRUD actions backed by EF Core', expectSkills: ['aspnet-core'] },
    // No xunit pack is bundled yet — a known Phase 10 gap, recorded rather than hidden.
    { id: 'dotnet-test-1', fixture: 'dotnet', role: 'testing', prompt: 'Write unit tests for the users service', expectSkills: [] },

    // ── Rust · Axum ──────────────────────────────────────────────────────────
    { id: 'rust-be-1', fixture: 'rust', role: 'backend', prompt: 'Add a health check route returning JSON', expectSkills: ['axum'] },
    // No cargo-test pack bundled yet — Phase 10 gap.
    { id: 'rust-test-1', fixture: 'rust', role: 'testing', prompt: 'Add integration tests for the health route', expectSkills: [] },

    // ── Go · Gin ─────────────────────────────────────────────────────────────
    { id: 'go-be-1', fixture: 'go', role: 'backend', prompt: 'Add a users handler with request binding', expectSkills: ['gin'] },
    // No go-test pack bundled yet — Phase 10 gap.
    { id: 'go-test-1', fixture: 'go', role: 'testing', prompt: 'Add table-driven tests for the users handler', expectSkills: [] },

    // ── Fail-safe ────────────────────────────────────────────────────────────
    // No detected stack must mean no stack skills injected, per the profiler's
    // fail-safe contract. A regression here means we inject wrong-stack idioms.
    { id: 'empty-be-1', fixture: 'empty', role: 'backend', prompt: 'Add a database layer', expectSkills: [], forbidAny: true },
];
