// Project Profiler — Phase 1 of the Project-Aware Agent Skills initiative.
//
// Pure, vscode-free, fs-free detection of a repository's stack from its manifest files, so the
// skill resolver (Phase 2) and the mindmap (Phase 5) can key off *what the project actually is*
// rather than guessing from the prompt. The caller reads the manifest contents; this module only
// classifies. Fails safe: an ambiguous or empty repo yields an empty profile, never a wrong guess.

export type Role = 'backend' | 'frontend' | 'design' | 'testing' | 'devops';

export interface ProjectProfile {
    /** e.g. ['python', 'typescript'] */
    languages: string[];
    /** e.g. ['django', 'react'] */
    frameworks: string[];
    /** e.g. ['pytest', 'jest'] */
    testFrameworks: string[];
    /** e.g. ['pip', 'npm', 'cargo'] */
    packageManagers: string[];
    /** languages ∪ frameworks — the token set skills are matched against. */
    stacks: string[];
    /** 0..1 — how sure we are. 0 means "no signal, inject nothing". */
    confidence: number;
    /** Human-readable "signal → conclusion" strings, surfaced in the mindmap. */
    evidence: string[];
}

/** Root manifest files whose *contents* the caller should read and pass in. */
export const MANIFEST_FILENAMES = [
    'package.json', 'tsconfig.json', 'requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile',
    'go.mod', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json',
    'pubspec.yaml', 'Cargo.toml',
];

/** Filename patterns that identify a manifest even when their exact name varies (globbed). */
const GLOB_MANIFESTS: Array<[RegExp, string]> = [
    [/\.csproj$/i, 'csproj'],
    [/\.sln$/i, 'sln'],
    [/\.fsproj$/i, 'csproj'],
];

const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));

function safeJson(text: string | undefined): any {
    if (!text) return undefined;
    try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * Classify a project from its file list and manifest contents.
 * @param files     workspace-relative paths (e.g. from vscode.workspace.findFiles)
 * @param manifests filename → file contents, for the manifests the caller could read. For
 *                  project files whose name varies, use the keys 'csproj'/'sln' with any one
 *                  matching file's content.
 */
export function detectProjectProfile(files: string[], manifests: Record<string, string> = {}): ProjectProfile {
    const languages: string[] = [];
    const frameworks: string[] = [];
    const testFrameworks: string[] = [];
    const packageManagers: string[] = [];
    const evidence: string[] = [];

    const rel = (files || []).map(f => String(f).replace(/\\/g, '/').replace(/^\.\//, ''));
    const base = rel.map(f => f.slice(f.lastIndexOf('/') + 1));
    const hasFile = (name: string) => base.includes(name);
    const hasExt = (ext: string) => rel.some(f => f.toLowerCase().endsWith(ext));
    const globManifest = (key: string) => manifests[key] || (GLOB_MANIFESTS.some(([re, k]) => k === key && rel.some(f => re.test(f))) ? '' : undefined);

    const add = (bucket: string[], v: string, why: string) => {
        if (!bucket.includes(v)) { bucket.push(v); evidence.push(why); }
    };
    // A framework implies its language and, usually, a package manager.
    const fw = (name: string, why: string, lang?: string, pm?: string, tests?: string[]) => {
        add(frameworks, name, why);
        if (lang) add(languages, lang, `${name} → ${lang}`);
        if (pm && !packageManagers.includes(pm)) packageManagers.push(pm);
        for (const t of tests || []) if (!testFrameworks.includes(t)) testFrameworks.push(t);
    };

    // ── Node / JavaScript / TypeScript ──────────────────────────────────────
    const pkg = safeJson(manifests['package.json']);
    if (pkg || hasFile('package.json')) {
        add(languages, 'javascript', 'package.json → javascript');
        if (!packageManagers.includes('npm')) packageManagers.push('npm');
        const deps: Record<string, string> = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
        const dep = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);
        const depLike = (re: RegExp) => Object.keys(deps).some(d => re.test(d));

        if (hasFile('tsconfig.json') || dep('typescript')) add(languages, 'typescript', 'tsconfig/typescript → typescript');

        if (dep('next')) fw('nextjs', 'package.json:next', 'typescript');
        else if (dep('react-native') || dep('expo')) fw('react-native', 'package.json:react-native', 'typescript');
        else if (dep('react')) fw('react', 'package.json:react', 'typescript');
        if (dep('@angular/core')) fw('angular', 'package.json:@angular/core', 'typescript');
        if (dep('vue')) fw('vue', 'package.json:vue', 'typescript');
        if (dep('svelte')) fw('svelte-kit', 'package.json:svelte', 'typescript');
        if (dep('@nestjs/core')) fw('nestjs', 'package.json:@nestjs/core', 'typescript');
        else if (dep('express')) fw('express', 'package.json:express', 'javascript');
        if (dep('fastify')) fw('fastify', 'package.json:fastify', 'javascript');
        if (dep('tailwindcss')) add(frameworks, 'tailwind', 'package.json:tailwindcss');

        if (dep('jest')) add(testFrameworks, 'jest', 'package.json:jest');
        if (dep('vitest')) add(testFrameworks, 'vitest', 'package.json:vitest');
        if (depLike(/@testing-library\//)) add(testFrameworks, 'react-testing-library', 'package.json:@testing-library');
        if (dep('@playwright/test') || dep('playwright')) add(testFrameworks, 'playwright', 'package.json:playwright');
        if (dep('cypress')) add(testFrameworks, 'cypress', 'package.json:cypress');
    }

    // ── Python ──────────────────────────────────────────────────────────────
    const py = [manifests['requirements.txt'], manifests['pyproject.toml'], manifests['Pipfile'], manifests['setup.py']]
        .filter(Boolean).join('\n').toLowerCase();
    const pyManifest = hasFile('requirements.txt') || hasFile('pyproject.toml') || hasFile('setup.py') || hasFile('Pipfile');
    if (pyManifest || hasFile('manage.py') || hasExt('.py')) {
        add(languages, 'python', 'python sources/manifest → python');
        if (!packageManagers.includes('pip')) packageManagers.push('pip');
        const pyHas = (needle: string) => py.includes(needle);
        if (hasFile('manage.py') || pyHas('django')) {
            fw('django', hasFile('manage.py') ? 'manage.py → django' : 'requirements:django', 'python', 'pip', ['pytest-django']);
            if (pyHas('djangorestframework') || pyHas('rest_framework')) add(frameworks, 'django-rest-framework', 'requirements:djangorestframework');
        }
        if (pyHas('fastapi')) fw('fastapi', 'requirements:fastapi', 'python', 'pip', ['pytest']);
        if (pyHas('flask')) fw('flask', 'requirements:flask', 'python', 'pip', ['pytest']);
        if (pyHas('pytest') || hasFile('conftest.py') || hasFile('pytest.ini')) add(testFrameworks, 'pytest', 'pytest signal');
    }

    // ── .NET / C# ───────────────────────────────────────────────────────────
    const csproj = globManifest('csproj');
    if (csproj !== undefined || globManifest('sln') !== undefined) {
        add(languages, 'csharp', 'csproj/sln → csharp');
        if (!packageManagers.includes('nuget')) packageManagers.push('nuget');
        const c = (csproj || '').toLowerCase();
        if (c.includes('microsoft.aspnetcore') || c.includes('microsoft.net.sdk.web')) fw('aspnet-core', 'csproj:AspNetCore', 'csharp');
        else fw('dotnet', 'csproj → dotnet', 'csharp');
        if (c.includes('microsoft.entityframeworkcore')) add(frameworks, 'entity-framework-core', 'csproj:EntityFrameworkCore');
        if (c.includes('xunit')) add(testFrameworks, 'xunit', 'csproj:xunit');
        if (c.includes('nunit')) add(testFrameworks, 'nunit', 'csproj:nunit');
        if (c.includes('mstest')) add(testFrameworks, 'mstest', 'csproj:mstest');
    }

    // ── Rust ────────────────────────────────────────────────────────────────
    const cargo = manifests['Cargo.toml'];
    if (cargo !== undefined || hasFile('Cargo.toml')) {
        fw('rust', 'Cargo.toml → rust', 'rust', 'cargo', ['cargo-test']);
        const r = (cargo || '').toLowerCase();
        if (r.includes('axum')) add(frameworks, 'axum', 'Cargo.toml:axum');
        if (r.includes('actix-web')) add(frameworks, 'actix-web', 'Cargo.toml:actix-web');
        if (r.includes('rocket')) add(frameworks, 'rocket', 'Cargo.toml:rocket');
        if (r.includes('proptest')) add(testFrameworks, 'proptest', 'Cargo.toml:proptest');
    }

    // ── Go ──────────────────────────────────────────────────────────────────
    const gomod = manifests['go.mod'];
    if (gomod !== undefined || hasFile('go.mod')) {
        fw('go', 'go.mod → go', 'go', 'gomod', ['go-test']);
        const g = (gomod || '').toLowerCase();
        if (g.includes('gin-gonic/gin')) add(frameworks, 'gin', 'go.mod:gin');
        if (g.includes('labstack/echo')) add(frameworks, 'echo', 'go.mod:echo');
        if (g.includes('gofiber/fiber')) add(frameworks, 'fiber', 'go.mod:fiber');
        if (g.includes('gorm.io/gorm')) add(frameworks, 'gorm', 'go.mod:gorm');
    }

    // ── Ruby / Java / PHP / Dart ────────────────────────────────────────────
    const gemfile = manifests['Gemfile'];
    if (gemfile !== undefined || hasFile('Gemfile')) {
        add(languages, 'ruby', 'Gemfile → ruby');
        if (!packageManagers.includes('bundler')) packageManagers.push('bundler');
        const gm = (gemfile || '').toLowerCase();
        if (gm.includes("'rails'") || gm.includes('"rails"') || hasFile('routes.rb')) fw('rails', 'Gemfile:rails', 'ruby');
        if (gm.includes('rspec')) add(testFrameworks, 'rspec', 'Gemfile:rspec');
    }
    const java = [manifests['pom.xml'], manifests['build.gradle'], manifests['build.gradle.kts']].filter(Boolean).join('\n').toLowerCase();
    if (java || hasFile('pom.xml') || hasFile('build.gradle') || hasFile('build.gradle.kts')) {
        add(languages, 'java', 'pom/gradle → java');
        packageManagers.push(hasFile('pom.xml') || manifests['pom.xml'] ? 'maven' : 'gradle');
        if (java.includes('spring-boot') || java.includes('springframework')) fw('spring-boot', 'build:spring', 'java');
        if (java.includes('junit')) add(testFrameworks, 'junit', 'build:junit');
    }
    const composer = safeJson(manifests['composer.json']);
    if (composer || hasFile('composer.json')) {
        add(languages, 'php', 'composer.json → php');
        packageManagers.push('composer');
        const cdeps = { ...(composer?.require || {}), ...(composer?.['require-dev'] || {}) };
        const ck = Object.keys(cdeps).join(' ').toLowerCase();
        if (ck.includes('laravel/framework')) fw('laravel', 'composer:laravel', 'php');
        if (ck.includes('symfony/')) fw('symfony', 'composer:symfony', 'php');
    }
    const pubspec = manifests['pubspec.yaml'];
    if (pubspec !== undefined || hasFile('pubspec.yaml')) {
        add(languages, 'dart', 'pubspec.yaml → dart');
        packageManagers.push('pub');
        if ((pubspec || '').toLowerCase().includes('flutter')) fw('flutter', 'pubspec:flutter', 'dart');
    }

    // ── DevOps signals (supporting) ─────────────────────────────────────────
    if (hasFile('Dockerfile') || hasFile('docker-compose.yml') || hasFile('docker-compose.yaml')) add(frameworks, 'docker', 'Dockerfile/compose → docker');
    if (rel.some(f => f.startsWith('.github/workflows/'))) add(frameworks, 'github-actions', '.github/workflows → CI');
    if (hasExt('.tf')) add(frameworks, 'terraform', '*.tf → terraform');

    const stacks = uniq([...languages, ...frameworks]);
    // Confidence: none without a signal; grows with corroborating frameworks/languages, capped.
    const confidence = stacks.length === 0 ? 0 : Math.min(1, 0.4 + 0.2 * frameworks.length + 0.1 * languages.length);

    return {
        languages: uniq(languages),
        frameworks: uniq(frameworks),
        testFrameworks: uniq(testFrameworks),
        packageManagers: uniq(packageManagers),
        stacks,
        confidence: Number(confidence.toFixed(2)),
        evidence,
    };
}

/** A one-line human summary for the mindmap / architecture doc (Phase 5). */
export function formatProfileLine(p: ProjectProfile): string {
    if (!p.stacks.length) return '';
    const parts: string[] = [];
    if (p.frameworks.length) parts.push(`frameworks: ${p.frameworks.join(', ')}`);
    if (p.languages.length) parts.push(`languages: ${p.languages.join(', ')}`);
    if (p.testFrameworks.length) parts.push(`tests: ${p.testFrameworks.join(', ')}`);
    return `${parts.join(' · ')} (confidence ${Math.round(p.confidence * 100)}%)`;
}

/** The mindmap's canonical stack heading — one place so the section can be found and upserted. */
export const STACK_MINDMAP_HEADING = 'Project Stack & Conventions';

/** Render the profile as a stable, idempotent mindmap section (Phase 5). Empty if no stack. */
export function stackMindmapSection(p: ProjectProfile): string {
    if (!p.stacks.length) return '';
    const lines = [
        `## ${STACK_MINDMAP_HEADING}`,
        '',
        '_Auto-detected by the Project Profiler; agents load matching skill packs automatically._',
        '',
        `${formatProfileLine(p)}`,
        '',
    ];
    if (p.frameworks.length) lines.push(`- **Frameworks:** ${p.frameworks.join(', ')}`);
    if (p.languages.length) lines.push(`- **Languages:** ${p.languages.join(', ')}`);
    if (p.testFrameworks.length) lines.push(`- **Testing:** ${p.testFrameworks.join(', ')}`);
    if (p.packageManagers.length) lines.push(`- **Tooling:** ${p.packageManagers.join(', ')}`);
    return lines.join('\n');
}

/**
 * Idempotently insert-or-replace a `## <heading>` section in a markdown doc. Re-syncing the same
 * profile does not duplicate the section (Phase 5 requirement). `section` must start with `## `.
 */
export function upsertMarkdownSection(existing: string, heading: string, section: string): string {
    const body = (existing || '').trim();
    const re = new RegExp(`(^|\\n)## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=\\n## |$)`);
    if (re.test(body)) {
        return (body.replace(re, `\n${section}`).replace(/\n{3,}/g, '\n\n').trim() + '\n');
    }
    return (body ? body + '\n\n' : '') + section.trim() + '\n';
}
