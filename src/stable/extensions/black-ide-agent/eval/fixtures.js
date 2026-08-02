/*
 * Golden-task eval fixtures (Phase 0, M3).
 *
 * Each fixture is the *input* to `detectProjectProfile(files, manifests)` — a file
 * list plus the contents of the manifests the profiler reads. They are data rather
 * than real directory trees because the profiler is pure and fs-free, which keeps
 * the eval fast enough to run on every commit.
 *
 * `expect.stacks` lists tokens the profile MUST contain. It is deliberately not an
 * exact-equality check: detecting *more* than the minimum (e.g. also spotting the
 * test runner) is an improvement, not a regression, and the gate should not punish
 * it. Missing a required token is what counts as a failure.
 */

module.exports = [
    {
        id: 'django',
        label: 'Python · Django + DRF',
        files: [
            'manage.py', 'requirements.txt', 'app/settings.py', 'app/urls.py', 'app/wsgi.py',
            'api/models.py', 'api/serializers.py', 'api/views.py', 'api/migrations/0001_initial.py',
            'tests/test_api.py',
        ],
        manifests: {
            'requirements.txt': 'Django==5.0.1\ndjangorestframework==3.15.0\npytest==8.0.0\npytest-django==4.8.0\n',
        },
        expect: { stacks: ['python', 'django'], languages: ['python'] },
    },
    {
        id: 'fastapi',
        label: 'Python · FastAPI',
        files: [
            'pyproject.toml', 'app/main.py', 'app/routers/items.py', 'app/models.py',
            'app/deps.py', 'tests/test_items.py',
        ],
        manifests: {
            'pyproject.toml': '[project]\nname = "svc"\ndependencies = ["fastapi>=0.110", "uvicorn", "sqlalchemy"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
        },
        expect: { stacks: ['python', 'fastapi'], languages: ['python'] },
    },
    {
        id: 'node-express',
        label: 'JS/TS · Node + Express',
        files: [
            'package.json', 'tsconfig.json', 'src/server.ts', 'src/routes/users.ts',
            'src/middleware/auth.ts', 'test/users.test.ts',
        ],
        manifests: {
            'package.json': JSON.stringify({
                name: 'api', dependencies: { express: '^4.19.0' },
                devDependencies: { jest: '^29.7.0', typescript: '^5.4.0' },
            }),
            'tsconfig.json': '{ "compilerOptions": { "strict": true } }',
        },
        expect: { stacks: ['typescript', 'express'], languages: ['typescript'] },
    },
    {
        id: 'react-next',
        label: 'JS/TS · React + Next.js',
        files: [
            'package.json', 'tsconfig.json', 'next.config.js', 'app/layout.tsx', 'app/page.tsx',
            'components/Button.tsx', 'tailwind.config.js', '__tests__/Button.test.tsx',
        ],
        manifests: {
            'package.json': JSON.stringify({
                name: 'web', dependencies: { next: '^14.2.0', react: '^18.3.0' },
                devDependencies: { jest: '^29.7.0', tailwindcss: '^3.4.0' },
            }),
            'tsconfig.json': '{ "compilerOptions": { "jsx": "preserve" } }',
        },
        expect: { stacks: ['typescript', 'react', 'nextjs'], languages: ['typescript'] },
    },
    {
        id: 'dotnet',
        label: 'C# · ASP.NET Core',
        files: [
            'Api.sln', 'src/Api/Api.csproj', 'src/Api/Program.cs', 'src/Api/Controllers/UsersController.cs',
            'src/Api/Data/AppDbContext.cs', 'tests/Api.Tests/Api.Tests.csproj', 'tests/Api.Tests/UsersTests.cs',
        ],
        manifests: {
            'csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" /><PackageReference Include="xunit" Version="2.7.0" /></ItemGroup></Project>',
        },
        expect: { stacks: ['csharp'], languages: ['csharp'] },
    },
    {
        id: 'rust',
        label: 'Rust · Axum',
        files: [
            'Cargo.toml', 'src/main.rs', 'src/routes/mod.rs', 'src/routes/health.rs',
            'src/db.rs', 'tests/integration.rs',
        ],
        manifests: {
            'Cargo.toml': '[package]\nname = "svc"\nedition = "2021"\n\n[dependencies]\naxum = "0.7"\ntokio = { version = "1", features = ["full"] }\n',
        },
        expect: { stacks: ['rust', 'axum'], languages: ['rust'] },
    },
    {
        id: 'go',
        label: 'Go · Gin',
        files: [
            'go.mod', 'go.sum', 'main.go', 'internal/handlers/users.go',
            'internal/store/pg.go', 'internal/handlers/users_test.go',
        ],
        manifests: {
            'go.mod': 'module example.com/svc\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n',
        },
        expect: { stacks: ['go', 'gin'], languages: ['go'] },
    },
    // ── Added 2026-08-01 (M3 breadth) ────────────────────────────────────────
    // Five more fixtures, chosen so that **every bundled pack is exercised by at
    // least one golden task**. Before this, `flask`, `rails`, `angular` and
    // `react-native` shipped with no eval coverage at all: they could have been
    // broken by a resolver change and nothing would have failed. A pack count is a
    // weaker completion test than "each pack has a task that must select it".
    {
        id: 'node-nest',
        label: 'JS/TS · Node + NestJS',
        files: [
            'package.json', 'tsconfig.json', 'nest-cli.json', 'src/main.ts', 'src/app.module.ts',
            'src/users/users.controller.ts', 'src/users/users.service.ts', 'test/users.e2e-spec.ts',
        ],
        manifests: {
            'package.json': JSON.stringify({
                name: 'nest-api',
                dependencies: { '@nestjs/core': '^10.3.0', '@nestjs/common': '^10.3.0', 'reflect-metadata': '^0.2.0' },
                devDependencies: { jest: '^29.7.0', typescript: '^5.4.0' },
            }),
            'tsconfig.json': '{ "compilerOptions": { "experimentalDecorators": true } }',
        },
        expect: { stacks: ['typescript', 'nestjs'], languages: ['typescript'] },
    },
    {
        id: 'flask',
        label: 'Python · Flask',
        files: [
            'requirements.txt', 'app.py', 'blueprints/orders.py', 'models.py', 'tests/test_orders.py',
        ],
        manifests: {
            'requirements.txt': 'Flask==3.0.2\nSQLAlchemy==2.0.27\npytest==8.0.0\n',
        },
        expect: { stacks: ['python', 'flask'], languages: ['python'] },
    },
    {
        id: 'rails',
        label: 'Ruby · Rails',
        files: [
            'Gemfile', 'config/routes.rb', 'app/models/order.rb', 'app/controllers/orders_controller.rb',
            'db/schema.rb', 'spec/models/order_spec.rb',
        ],
        manifests: {
            'Gemfile': "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem 'pg'\ngem 'rspec-rails', group: :test\n",
        },
        expect: { stacks: ['ruby', 'rails'], languages: ['ruby'] },
    },
    {
        id: 'angular',
        label: 'JS/TS · Angular',
        files: [
            'package.json', 'tsconfig.json', 'angular.json', 'src/main.ts',
            'src/app/app.component.ts', 'src/app/orders/orders.service.ts', 'src/app/orders/orders.component.spec.ts',
        ],
        manifests: {
            'package.json': JSON.stringify({
                name: 'web',
                dependencies: { '@angular/core': '^17.3.0', '@angular/common': '^17.3.0', rxjs: '^7.8.0' },
                devDependencies: { typescript: '^5.4.0' },
            }),
            'tsconfig.json': '{ "compilerOptions": { "strict": true } }',
        },
        expect: { stacks: ['typescript', 'angular'], languages: ['typescript'] },
    },
    {
        id: 'react-native',
        label: 'JS/TS · React Native + Expo',
        files: [
            'package.json', 'tsconfig.json', 'app.json', 'App.tsx',
            'src/screens/OrdersScreen.tsx', 'src/components/OrderCard.tsx',
        ],
        manifests: {
            'package.json': JSON.stringify({
                name: 'mobile',
                dependencies: { 'react-native': '^0.74.0', react: '^18.3.0', expo: '^51.0.0' },
                devDependencies: { typescript: '^5.4.0' },
            }),
            'tsconfig.json': '{ "compilerOptions": { "jsx": "react-native" } }',
        },
        // React Native implies `react` — the F2 fix's contract, held here for a second
        // React-based framework so it cannot regress for one and not the other.
        expect: { stacks: ['typescript', 'react-native', 'react'], languages: ['typescript'] },
    },
    // ── Wave 2 fixtures (Phase 10, M59) ─────────────────────────────────────
    // Added so the new packs have golden tasks. A pack with no eval task can rot
    // unnoticed, which is what `eval-task-coverage.test.ts` asserts.
    {
        id: 'spring',
        label: 'Java · Spring Boot',
        files: ['pom.xml', 'src/main/java/com/example/App.java', 'src/main/java/com/example/UserController.java',
            'src/main/java/com/example/UserService.java', 'src/main/java/com/example/UserRepository.java',
            'src/test/java/com/example/UserServiceTest.java', 'src/main/resources/application.yml'],
        manifests: {
            'pom.xml': '<project><dependencies><dependency><groupId>org.springframework.boot</groupId>'
                + '<artifactId>spring-boot-starter-web</artifactId></dependency>'
                + '<dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId></dependency>'
                + '</dependencies></project>',
        },
        expect: { stacks: ['java', 'spring-boot'], languages: ['java'] },
    },
    {
        id: 'laravel',
        label: 'PHP · Laravel',
        files: ['composer.json', 'artisan', 'app/Models/User.php', 'app/Http/Controllers/UserController.php',
            'database/migrations/2024_01_01_create_users_table.php', 'routes/web.php', 'tests/Feature/UserTest.php'],
        manifests: { 'composer.json': '{"require":{"laravel/framework":"^11.0"},"require-dev":{"phpunit/phpunit":"^11.0"}}' },
        expect: { stacks: ['php', 'laravel'], languages: ['php'] },
    },
    {
        id: 'vue',
        label: 'TypeScript · Vue 3',
        files: ['package.json', 'src/main.ts', 'src/App.vue', 'src/components/UserCard.vue',
            'src/stores/users.ts', 'src/composables/useUsers.ts', 'tests/UserCard.spec.ts'],
        manifests: { 'package.json': '{"dependencies":{"vue":"^3.4.0","pinia":"^2.1.0"},"devDependencies":{"vitest":"^1.2.0"}}' },
        expect: { stacks: ['typescript', 'vue'], languages: ['typescript'] },
    },
    {
        id: 'sveltekit',
        label: 'TypeScript · SvelteKit',
        files: ['package.json', 'svelte.config.js', 'src/routes/+page.svelte', 'src/routes/+page.server.ts',
            'src/lib/db.ts', 'tests/page.test.ts'],
        manifests: { 'package.json': '{"devDependencies":{"svelte":"^4.2.0","@sveltejs/kit":"^2.0.0","vitest":"^1.2.0"}}' },
        expect: { stacks: ['typescript', 'svelte-kit'], languages: ['typescript'] },
    },
    {
        id: 'remix',
        label: 'TypeScript · Remix',
        files: ['package.json', 'app/root.tsx', 'app/routes/_index.tsx', 'app/routes/users.tsx', 'app/db.server.ts'],
        manifests: { 'package.json': '{"dependencies":{"@remix-run/react":"^2.5.0","@remix-run/node":"^2.5.0","react":"^18.2.0"}}' },
        expect: { stacks: ['typescript', 'remix', 'react'], languages: ['typescript'] },
    },
    {
        id: 'astro',
        label: 'TypeScript · Astro',
        files: ['package.json', 'astro.config.mjs', 'src/pages/index.astro', 'src/components/Card.astro',
            'src/content/config.ts', 'src/content/posts/first.md'],
        manifests: { 'package.json': '{"dependencies":{"astro":"^4.4.0"}}' },
        expect: { stacks: ['typescript', 'astro'], languages: ['typescript'] },
    },
    {
        id: 'flutter',
        label: 'Dart · Flutter',
        files: ['pubspec.yaml', 'lib/main.dart', 'lib/widgets/user_card.dart', 'lib/state/user_store.dart',
            'test/user_card_test.dart'],
        manifests: { 'pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n' },
        expect: { stacks: ['dart', 'flutter'], languages: ['dart'] },
    },
    {
        id: 'infra',
        label: 'Infrastructure · Docker + Kubernetes + Terraform + Actions',
        files: ['Dockerfile', 'docker-compose.yml', 'k8s/deployment.yaml', 'k8s/service.yaml',
            'infra/main.tf', 'infra/variables.tf', '.github/workflows/ci.yml', 'README.md'],
        manifests: {},
        expect: { stacks: ['docker', 'kubernetes', 'terraform', 'github-actions'], languages: [] },
    },
    {
        // Guards the fail-safe contract in project-profiler.ts: an empty or unrecognisable
        // repo must yield no stacks so that nothing is injected, rather than a wrong guess.
        id: 'empty',
        label: 'Empty / unrecognised repo (fail-safe)',
        files: ['README.md', 'LICENSE', 'notes.txt'],
        manifests: {},
        expect: { stacks: [], languages: [], mustBeEmpty: true },
    },
];
