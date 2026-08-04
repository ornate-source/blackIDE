import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allSourceFiles } from './source-roots';

/**
 * Phase 11, M62 — the agent-core boundary.
 *
 * The gate is `grep -r "vscode"` in the core package returning nothing. This is that
 * grep, made structural: it walks the import graph **transitively** from
 * `src/agent-core/index.ts` and fails if anything reachable imports `vscode`.
 *
 * Transitively is the whole point. A barrel that imports a clean module which imports a
 * dirty one passes a shallow check and fails the actual requirement — the package still
 * cannot run outside an editor. A one-level grep would have declared this done on day one.
 *
 * It also fails in the *other* direction: a module that stops being reachable because
 * somebody deleted its export line would silently shrink the core, so the surface is
 * counted too.
 */

/*
 * The core is a package now (M62 · P11-2), so the walk starts inside it.
 *
 * This is the strongest form the boundary check has taken. Before the move it proved
 * "nothing *reachable from* the barrel imports vscode" while the modules sat in the same
 * tree as the editor, one careless relative import away from each other. Now the package
 * is a separate compilation unit that does not depend on the extension at all — a
 * `../../../src/core/x` would not resolve — so the property is enforced by the build as
 * well as by this file. The test stays because the build only catches a *broken* import,
 * not a working one that drags `vscode` in through a new dependency.
 */
const SRC = path.join(__dirname, '..', 'packages', 'agent-core', 'src');
const ENTRY = path.join(SRC, 'agent-core', 'index.ts');
/** The editor's tree, for the assertions about what the core must NOT reach into. */
const EXT_SRC = path.join(__dirname, '..', 'src');

/** Resolve a relative import specifier to a file on disk. */
function resolveImport(fromFile: string, specifier: string): string | undefined {
    if (!specifier.startsWith('.')) return undefined;   // a package, not our source
    const base = path.resolve(path.dirname(fromFile), specifier);
    for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), `${base}.tsx`]) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
}

/**
 * Value imports only. `import type` is **erased at compile time**, so it creates no runtime
 * dependency and cannot make a package require an editor to load.
 *
 * The distinction is load-bearing rather than a technicality: `agent-loop.ts` needs the
 * *shape* of `AgentToolExecutor`, and importing the class dragged the LSP bridge, the
 * codebase index and the artifact manager — and through them `vscode` — into everything
 * that imported the loop. A contract is not a dependency, and a checker that cannot tell
 * them apart forces you to duplicate types to satisfy it.
 */
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
const BARE_IMPORT = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

function importsOf(file: string): string[] {
    const text = fs.readFileSync(file, 'utf8');
    const out: string[] = [];
    for (const pattern of [IMPORT, BARE_IMPORT]) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) out.push(match[1]);
    }
    return out;
}

/** Everything reachable from the entry, and every vscode importer among them. */
function walk(entry: string): { reachable: Set<string>; offenders: { file: string; via: string[] }[] } {
    const reachable = new Set<string>();
    const parents = new Map<string, string>();
    const offenders: { file: string; via: string[] }[] = [];
    const queue = [entry];

    while (queue.length) {
        const file = queue.shift()!;
        if (reachable.has(file)) continue;
        reachable.add(file);

        const specifiers = importsOf(file);
        if (specifiers.includes('vscode')) {
            // The chain matters more than the file: "audit-trail imports vscode" is easy,
            // "the barrel reaches vscode through five hops" is what actually has to change.
            const via: string[] = [];
            let cursor: string | undefined = file;
            while (cursor) { via.unshift(path.relative(SRC, cursor)); cursor = parents.get(cursor); }
            offenders.push({ file: path.relative(SRC, file), via });
        }

        for (const specifier of specifiers) {
            const resolved = resolveImport(file, specifier);
            if (resolved && !reachable.has(resolved)) {
                if (!parents.has(resolved)) parents.set(resolved, file);
                queue.push(resolved);
            }
        }
    }
    return { reachable, offenders };
}

describe('the agent-core boundary', () => {
    const { reachable, offenders } = walk(ENTRY);

    it('the entry point exists and reaches a real surface', () => {
        expect(fs.existsSync(ENTRY)).toBe(true);
        // A barrel that reached six files would pass the vscode check trivially. The count
        // is what makes "zero vscode imports" a claim about the *core* rather than about a
        // stub, and shrinking it should be a deliberate act rather than a side effect.
        //
        // 64 since P11-2 (2026-08-04): 60 after P11-1's boundary refactor, plus the
        // daemon, the remote runner, the daemon protocol and the CLI entry, which the
        // barrel now exports so they fall inside the graph this test walks. Before that
        // they were `agent-core` modules nothing reached — free to acquire a `vscode`
        // import with nothing to object until somebody ran the CLI.
        //
        // The floor is a floor, not a target, and it has moved in both directions. It
        // *fell* to 45 when `agent-loop` switched to a type-only import of the executor,
        // which correctly stopped dragging the LSP bridge into everything importing the
        // loop. A drop is sometimes right; it should just never be silent.
        expect(reachable.size).toBeGreaterThanOrEqual(64);
    });

    it('nothing reachable from the core imports vscode', () => {
        const rendered = offenders.map(o => `${o.file}\n      via ${o.via.join(' → ')}`);
        expect(rendered, `core modules importing vscode:\n    ${rendered.join('\n    ')}`).toEqual([]);
    });

    it('does not reach the extension entry point', () => {
        // The direction of dependency is the architecture: the extension consumes the core.
        // A core that reaches back into `extension.ts` is a circular dependency wearing a
        // barrel. Since P11-2 it would also not compile — but asserting it costs a line and
        // the property is the point, not the mechanism that currently happens to enforce it.
        expect([...reachable].some(f => f.startsWith(EXT_SRC))).toBe(false);
    });

    it('does not reach a webview panel or a provider', () => {
        const hostOnly = [
            'core/webview-html.ts', 'core/webview-message-handler.ts', 'core/settings-panel.ts',
            'core/manager-panel.ts', 'core/command-registry.ts', 'core/inline-completion.ts',
            'core/next-edit-controller.ts', 'core/inline-chat-controller.ts', 'core/editor-features.ts',
        ];
        const files = new Set([...reachable].map(f => path.relative(SRC, f).replace(/\\/g, '/')));
        for (const host of hostOnly) {
            expect(files.has(host), `${host} is host code and must not be in the core`).toBe(false);
        }
    });
});

describe('the core is a real package (M62 · P11-2)', () => {
    const PKG_ROOT = path.join(__dirname, '..', 'packages', 'agent-core');
    const manifest = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

    it('has its own manifest, entry point and subpath exports', () => {
        expect(manifest.name).toBe('@blackide/agent-core');
        expect(manifest.main).toMatch(/agent-core\/index\.js$/);
        // The subpath map is what lets a consumer write
        // `@blackide/agent-core/core/sandbox` instead of reaching into `dist/`.
        expect(manifest.exports['./*']).toBeTruthy();
    });

    it('does not depend on the extension — in either direction', () => {
        /*
         * The property the physical move buys over the logical boundary alone. Before it,
         * "the core does not import vscode" was true of files sitting in the same tree as
         * the editor, one careless relative import away. Now a path back into the
         * extension does not resolve, so the build enforces what the walk above asserts.
         */
        expect(manifest.dependencies?.vscode).toBeUndefined();
        expect(Object.keys(manifest.dependencies || {})).not.toContain('@types/vscode');
        for (const { file } of allSourceFiles().filter(f => f.file.startsWith(SRC))) {
            const text = fs.readFileSync(file, 'utf8');
            expect(text, `${path.relative(SRC, file)} reaches back into the extension`)
                .not.toMatch(/from\s+['"](?:\.\.\/){3,}src\//);
        }
    });

    it('the extension consumes it by name, never by relative path', () => {
        // A single `../packages/agent-core/src/...` import would re-couple the two trees
        // and make the package unpublishable without anybody noticing.
        const offenders = allSourceFiles()
            .filter(f => !f.file.startsWith(SRC))
            .filter(f => /from\s+['"][^'"]*packages\/agent-core/.test(fs.readFileSync(f.file, 'utf8')))
            .map(f => f.rel);
        expect(offenders, `import the package by name: ${offenders.join(', ')}`).toEqual([]);
    });

    it('the built package is what the CLI shim points at', () => {
        const bin = fs.readFileSync(path.join(__dirname, '..', 'bin', 'blackide'), 'utf8');
        expect(bin).toMatch(/packages\/agent-core\/dist\/agent-core\/main\.js/);
    });
});

describe('the host interface stays small and honest', () => {
    const host = fs.readFileSync(path.join(SRC, 'agent-core', 'host.ts'), 'utf8');

    it('is itself vscode-free', () => {
        expect(host).not.toContain("from 'vscode'");
    });

    it('does not let the core ask the user a question', () => {
        // A core that can *ask* cannot run unattended, and every caller that awaits an
        // answer is a place a headless run hangs forever. Approval is separate and explicit
        // precisely so "there is nobody to ask" is a first-class answer.
        const notifier = host.slice(host.indexOf('interface HostNotifier'), host.indexOf('export type ApprovalKind'));
        expect(notifier).not.toMatch(/Promise<\s*(?:string|boolean|choice)/);
    });

    it('makes every editor-only capability optional', () => {
        const caps = host.slice(host.indexOf('interface HostEditorCapabilities'), host.indexOf('/** Everything the core needs'));
        // If a missing capability broke the agent rather than merely informing it less, the
        // dependency was structural and the split would be cosmetic.
        for (const member of ['diagnostics', 'languageServer', 'publishProblems', 'openFile']) {
            expect(caps, member).toMatch(new RegExp(`${member}\\?`));
        }
        expect(caps).not.toMatch(/^\s{4}(diagnostics|languageServer|publishProblems|openFile):/m);
    });

    it('offers a denying approval gate, so unattended is a host property not a flag', () => {
        expect(host).toContain('denyingApproval');
    });
});
