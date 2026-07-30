import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

/**
 * Guards the fixture-backed `findFiles` that Phase 3's recall metric stands on.
 *
 * This is the failure this suite exists to catch: `findFiles` returned `[]`
 * unconditionally until Phase 3, so `CodebaseIndex.build()` indexed nothing and
 * any recall figure would have been measuring the stub. That produced a *plausible*
 * number, not an obviously broken one, which is why it went unnoticed long enough
 * to defer the metric across three phases. If enumeration breaks again, recall
 * silently collapses to 0% and the eval gate reports it as a retrieval regression —
 * so the enumeration contract is asserted here, where the diagnosis is unambiguous.
 */

const stub = vscode as any;

function makeTree(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-findfiles-'));
    fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

    fs.writeFileSync(path.join(root, 'top.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'readme.md'), '# hi\n');
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const b = 2;\n');
    fs.writeFileSync(path.join(root, 'src', 'nested', 'deep.py'), 'x = 3\n');
    fs.writeFileSync(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'var x=1;\n');
    return root;
}

describe('vscode stub — workspace.findFiles', () => {
    const roots: string[] = [];
    const originalFolders = stub.workspace.workspaceFolders;

    afterEach(() => {
        stub.workspace.workspaceFolders = originalFolders;
        for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    });

    function openWorkspace(): string {
        const root = makeTree();
        roots.push(root);
        stub.workspace.workspaceFolders = [{ uri: { fsPath: root }, name: 'fixture', index: 0 }];
        return root;
    }

    it('returns nothing when no workspace is open', async () => {
        stub.workspace.workspaceFolders = [];
        expect(await stub.workspace.findFiles('**/*', undefined, 100)).toEqual([]);
    });

    it('walks the whole tree, not just the top level', async () => {
        openWorkspace();
        const found = await stub.workspace.findFiles('**/*', '**/{node_modules,dist}/**', 100);
        const names = found.map((u: any) => path.basename(u.fsPath)).sort();
        expect(names).toEqual(['deep.py', 'index.ts', 'readme.md', 'top.ts']);
    });

    it('honours a braced exclude list', async () => {
        openWorkspace();
        const found = await stub.workspace.findFiles('**/*', '**/{node_modules,dist}/**', 100);
        expect(found.some((u: any) => u.fsPath.includes('node_modules'))).toBe(false);
        expect(found.some((u: any) => u.fsPath.includes(`${path.sep}dist${path.sep}`))).toBe(false);
    });

    it('honours a single-name exclude', async () => {
        openWorkspace();
        const found = await stub.workspace.findFiles('**/*', '**/node_modules/**', 100);
        expect(found.some((u: any) => u.fsPath.includes('node_modules'))).toBe(false);
        // `dist` was not excluded this time, so it must come back.
        expect(found.some((u: any) => u.fsPath.includes(`${path.sep}dist${path.sep}`))).toBe(true);
    });

    it('filters by extension when the include glob names one', async () => {
        openWorkspace();
        const found = await stub.workspace.findFiles('**/*.ts', '**/{node_modules,dist}/**', 100);
        expect(found.map((u: any) => path.basename(u.fsPath)).sort()).toEqual(['index.ts', 'top.ts']);
    });

    it('respects maxResults', async () => {
        openWorkspace();
        const found = await stub.workspace.findFiles('**/*', '**/node_modules/**', 2);
        expect(found).toHaveLength(2);
    });

    it('resolves a RelativePattern against its own base, not the workspace root', async () => {
        const root = openWorkspace();
        const found = await stub.workspace.findFiles(
            new stub.RelativePattern({ fsPath: path.join(root, 'src') }, '**/*'), undefined, 100,
        );
        expect(found.map((u: any) => path.basename(u.fsPath)).sort()).toEqual(['deep.py', 'index.ts']);
    });

    it('makes paths relative to the workspace root', () => {
        const root = openWorkspace();
        expect(stub.workspace.asRelativePath({ fsPath: path.join(root, 'src', 'index.ts') }))
            .toBe(path.join('src', 'index.ts'));
    });

    it('leaves a path outside the workspace absolute', () => {
        openWorkspace();
        expect(stub.workspace.asRelativePath({ fsPath: '/elsewhere/x.ts' })).toBe('/elsewhere/x.ts');
    });
});

describe('retrieval corpus', () => {
    const CORPUS = path.join(__dirname, '..', 'eval', 'retrieval-corpus');

    it('exists and is large enough for recall@10 to discriminate', () => {
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else files.push(full);
            }
        };
        walk(CORPUS);

        // Below roughly 50 files, "the top 10 results" covers so much of the corpus
        // that recall@10 saturates and stops distinguishing anything.
        expect(files.length).toBeGreaterThan(50);
    });

    it('every gold file named by a query actually exists', async () => {
        const queries = require('../eval/retrieval-queries');
        const missing: string[] = [];
        for (const q of queries) {
            for (const file of q.mustFind) {
                if (!fs.existsSync(path.join(CORPUS, file))) missing.push(`${q.id} → ${file}`);
            }
        }
        expect(missing).toEqual([]);
    });
});
