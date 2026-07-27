import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

/*
 * Loaded from `dist/` at runtime rather than imported from `src/`: this tsconfig sets
 * `rootDir` to test/integration, so a compile-time import of ../../../src would move
 * the output tree and break `extensionTestsPath`. Requiring the built module also means
 * these assertions run against exactly the code that ships.
 */
interface RenamePlan {
    workspaceEdit: vscode.WorkspaceEdit;
    files: string[];
    editCount: number;
}
interface LspToolsModule {
    goToDefinition(file: string, symbol: string, line?: number): Promise<string>;
    findReferences(file: string, symbol: string, line?: number): Promise<string>;
    hoverInfo(file: string, symbol: string, line?: number): Promise<string>;
    getDiagnostics(file?: string, severity?: 'error' | 'warning' | 'all'): Promise<string>;
    planRename(file: string, symbol: string, newName: string, line?: number): Promise<RenamePlan | { error: string }>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const LspTools: LspToolsModule = require(path.resolve(__dirname, '../../../../dist/tools/lsp-tools'));

/**
 * Real-extension-host cover for the Phase 1 language-server tools.
 *
 * Why providers are registered here instead of leaning on the built-in TypeScript
 * server: `runTest.ts` launches with `--disable-extensions`, which turns off the
 * built-ins too, so a suite depending on `vscode.typescript-language-features`
 * would either be dead or flaky on server warm-up timing. It would also be testing
 * Microsoft's rename algorithm rather than ours.
 *
 * What actually needs verifying is our side of the contract, and all of it is real
 * here: `executeDefinitionProvider` / `executeReferenceProvider` /
 * `executeDocumentRenameProvider` dispatch, `vscode.workspace.applyEdit`, and the
 * save step — plus the multi-file result landing correctly on disk. The provider
 * being a test double is the one part that does not matter.
 */

const LANG = 'plaintext';
const FILE_COUNT = 6; // the gate calls for a rename spanning 5+ files

suite('LSP tools (real extension host)', () => {
    const disposables: vscode.Disposable[] = [];
    let dir: vscode.Uri;
    let files: vscode.Uri[];

    /** Absolute path of file i, as the tools expect to receive it. */
    const abs = (i: number) => files[i].fsPath;

    suiteSetup(async () => {
        const root = vscode.workspace.workspaceFolders![0].uri;
        dir = vscode.Uri.joinPath(root, 'lsp-fixture');
        await vscode.workspace.fs.createDirectory(dir);

        // File 0 declares the symbol; the rest reference it.
        files = [];
        for (let i = 0; i < FILE_COUNT; i++) {
            const uri = vscode.Uri.joinPath(dir, `mod${i}.txt`);
            const body = i === 0
                ? `import { other } from './other'\nfunction TargetSymbol() {}\nTargetSymbol()\n`
                : `import { TargetSymbol } from './mod0'\nTargetSymbol()\nconst x = TargetSymbol\n`;
            await vscode.workspace.fs.writeFile(uri, Buffer.from(body, 'utf8'));
            files.push(uri);
        }

        // A definition provider that always points at file 0, line 1 (the declaration).
        disposables.push(vscode.languages.registerDefinitionProvider({ language: LANG }, {
            provideDefinition: () => new vscode.Location(files[0], new vscode.Position(1, 9)),
        }));

        // A reference provider that reports every occurrence across every fixture file,
        // so the grouped-by-file formatting is exercised with more than one file.
        disposables.push(vscode.languages.registerReferenceProvider({ language: LANG }, {
            provideReferences: () => files.flatMap(uri => [
                new vscode.Location(uri, new vscode.Range(1, 0, 1, 12)),
                new vscode.Location(uri, new vscode.Range(2, 0, 2, 12)),
            ]),
        }));

        // A rename provider that rewrites every occurrence of the identifier in every
        // fixture file — the multi-file WorkspaceEdit the gate is about.
        disposables.push(vscode.languages.registerRenameProvider({ language: LANG }, {
            provideRenameEdits: async (_doc, _pos, newName) => {
                const edit = new vscode.WorkspaceEdit();
                for (const uri of files) {
                    const d = await vscode.workspace.openTextDocument(uri);
                    for (let line = 0; line < d.lineCount; line++) {
                        const text = d.lineAt(line).text;
                        let at = text.indexOf('TargetSymbol');
                        while (at !== -1) {
                            edit.replace(uri, new vscode.Range(line, at, line, at + 'TargetSymbol'.length), newName);
                            at = text.indexOf('TargetSymbol', at + 1);
                        }
                    }
                }
                return edit;
            },
        }));

        disposables.push(vscode.languages.registerHoverProvider({ language: LANG }, {
            provideHover: () => new vscode.Hover('function TargetSymbol(): void'),
        }));
    });

    suiteTeardown(async () => {
        for (const d of disposables) d.dispose();
        try { await vscode.workspace.fs.delete(dir, { recursive: true }); } catch { /* best effort */ }
    });

    test('go_to_definition resolves through the real provider dispatch', async () => {
        const out = await LspTools.goToDefinition(abs(1), 'TargetSymbol');
        assert.match(out, /Definition of "TargetSymbol"/);
        assert.match(out, /mod0\.txt:2/, `expected the declaration at mod0 line 2, got:\n${out}`);
    });

    test('find_references groups hits by file across the whole fixture', async () => {
        const out = await LspTools.findReferences(abs(0), 'TargetSymbol');
        assert.match(out, new RegExp(`${FILE_COUNT * 2} reference\\(s\\)`), out);
        assert.match(out, new RegExp(`across ${FILE_COUNT} file\\(s\\)`), out);
        for (let i = 0; i < FILE_COUNT; i++) {
            assert.ok(out.includes(`mod${i}.txt`), `mod${i}.txt missing from the grouping`);
        }
    });

    test('hover returns the provider contents', async () => {
        const out = await LspTools.hoverInfo(abs(1), 'TargetSymbol');
        assert.match(out, /function TargetSymbol/);
    });

    test('get_diagnostics reports cleanly for a file with no problems', async () => {
        const out = await LspTools.getDiagnostics(abs(0));
        assert.match(out, /No errors or warnings|No problems/);
    });

    test('planRename produces a plan spanning 5+ files without touching disk', async () => {
        const before = Buffer.from(await vscode.workspace.fs.readFile(files[3])).toString('utf8');

        const plan = await LspTools.planRename(abs(0), 'TargetSymbol', 'RenamedSymbol');
        assert.ok(!('error' in plan), `planRename failed: ${(plan as any).error}`);
        const p = plan as RenamePlan;

        assert.ok(p.files.length >= 5, `expected 5+ files, got ${p.files.length}`);
        assert.strictEqual(p.files.length, FILE_COUNT);
        assert.ok(p.editCount >= FILE_COUNT, `expected at least one edit per file, got ${p.editCount}`);

        // Planning must be side-effect free — the executor owns approval and checkpointing.
        const after = Buffer.from(await vscode.workspace.fs.readFile(files[3])).toString('utf8');
        assert.strictEqual(after, before, 'planRename mutated a file before approval');
    });

    test('applying the plan rewrites and SAVES every file', async () => {
        const plan = await LspTools.planRename(abs(0), 'TargetSymbol', 'RenamedSymbol');
        assert.ok(!('error' in plan));
        const p = plan as RenamePlan;

        assert.ok(await vscode.workspace.applyEdit(p.workspaceEdit), 'applyEdit was refused');
        for (const file of p.files) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            if (doc.isDirty) await doc.save();
        }

        // Read from disk, not from the document buffer: an unsaved edit is invisible to
        // git, to the test runner, and to the next tool call, which is the failure mode
        // this assertion exists for.
        for (let i = 0; i < FILE_COUNT; i++) {
            const onDisk = Buffer.from(await vscode.workspace.fs.readFile(files[i])).toString('utf8');
            assert.ok(onDisk.includes('RenamedSymbol'), `mod${i}.txt was not rewritten on disk`);
            assert.ok(!onDisk.includes('TargetSymbol'), `mod${i}.txt still contains the old name on disk`);
        }
    });

    test('planRename refuses an invalid identifier before calling any provider', async () => {
        const plan = await LspTools.planRename(abs(0), 'RenamedSymbol', 'not a valid name');
        assert.ok('error' in plan);
        assert.match((plan as any).error, /not a valid identifier/);
    });

    test('a symbol that does not exist degrades to a text search instead of throwing', async () => {
        const out = await LspTools.goToDefinition(abs(0), 'NoSuchSymbolAnywhere');
        assert.match(out, /does not appear|text search/i, out);
    });

    test('no provider for a language degrades to a text search, not an error', async () => {
        // package.json is JSON; no definition provider is registered for it here.
        const root = vscode.workspace.workspaceFolders![0].uri;
        const out = await LspTools.goToDefinition(path.join(root.fsPath, 'package.json'), 'name');
        assert.doesNotMatch(out, /^Error/i, out);
        assert.match(out, /text search|No definition provider|does not appear/i, out);
    });
});
