import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'blackide.black-ide-agent';

/**
 * Activation and contribution wiring. Cheap, but it is the layer that breaks silently:
 * a command declared in package.json but never registered fails only when a user runs it,
 * and nothing in the core harness can catch that.
 */
suite('Activation', () => {
    test('the extension is present and activates', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `extension ${EXTENSION_ID} not found`);
        await ext!.activate();
        assert.strictEqual(ext!.isActive, true);
    });

    test('every contributed command is actually registered', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
        await ext.activate();

        const declared: string[] = (ext.packageJSON?.contributes?.commands ?? []).map((c: any) => c.command);
        assert.ok(declared.length > 0, 'no commands declared in package.json');

        const registered = new Set(await vscode.commands.getCommands(true));
        const missing = declared.filter(c => !registered.has(c));
        assert.deepStrictEqual(missing, [], `declared but never registered: ${missing.join(', ')}`);
    });

    test('activation does not leave the workspace dirty', async () => {
        // Activation runs a first-run repo scan (see _seedArchitectureOnce). It must write
        // only under .blackIDE/, never touch project files.
        const root = vscode.workspace.workspaceFolders?.[0];
        assert.ok(root, 'the test workspace did not open');
        const marker = vscode.Uri.joinPath(root!.uri, 'src', 'index.ts');
        const before = (await vscode.workspace.fs.readFile(marker)).toString();
        await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
        const after = (await vscode.workspace.fs.readFile(marker)).toString();
        assert.strictEqual(after, before, 'activation modified a project file');
    });
});
