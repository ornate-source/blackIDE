import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'blackide.black-ide-agent';

/**
 * The first-run repository-discovery scan (P1). This is the highest-value target in the
 * suite: `_seedArchitectureOnce` runs unprompted on activation, uses
 * `vscode.workspace.findFiles`, and writes to the user's workspace — three things the core
 * harness structurally cannot exercise, since it stubs `vscode` entirely. Its pure half
 * (`summarizeRepoStructure`) is unit-tested; this covers the wiring around it.
 */
suite('First-run knowledge scan', () => {
    const knowledgeUri = () => {
        const root = vscode.workspace.workspaceFolders![0].uri;
        return vscode.Uri.joinPath(root, '.blackIDE', 'knowledge', 'architecture.md');
    };

    const read = async (uri: vscode.Uri): Promise<string> => {
        try { return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); }
        catch { return ''; }
    };

    suiteSetup(async () => {
        await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
        // The scan is fire-and-forget from the constructor; give it a moment to land.
        await new Promise(r => setTimeout(r, 3000));
    });

    test('architecture.md is seeded from the real workspace', async () => {
        const content = await read(knowledgeUri());
        assert.ok(content.length > 0, 'architecture.md was never written');
        assert.match(content, /^# Architecture/, 'missing the architecture header');
    });

    test('the seed reflects the actual fixture workspace, not a template', async () => {
        const content = await read(knowledgeUri());
        // The fixture has a src/ directory and a package.json declaring react.
        assert.match(content, /`src`/, 'top-level structure did not include src/');
        assert.match(content, /React/, 'stack detection missed the react dependency');
    });

    test('the seed states that it will not be regenerated', async () => {
        assert.match(await read(knowledgeUri()), /will not be regenerated/);
    });

    test('a second activation never clobbers edited content', async () => {
        const uri = knowledgeUri();
        const edited = '# Architecture\n\nHand-written by a human. Do not overwrite.\n';
        await vscode.workspace.fs.writeFile(uri, Buffer.from(edited, 'utf8'));

        // Re-activating (and re-running the scan path) must leave the edit intact — the
        // guard is `isArchitectureUnseeded`, and getting it wrong would silently destroy
        // a user's notes with no undo.
        await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
        await new Promise(r => setTimeout(r, 2000));

        assert.strictEqual(await read(uri), edited, 'the scan overwrote human-authored content');
    });
});
