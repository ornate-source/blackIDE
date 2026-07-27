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
