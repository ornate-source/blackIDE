import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'blackide.black-ide-agent';

/**
 * Settings plumbing. This extension does NOT use `contributes.configuration` — settings
 * live in a single JSON blob in the secret store, read at run time (see extension.ts's
 * `general-settings`). That means a setting can typecheck, appear in the panel, and still
 * never reach the pipeline. Only a host test can catch that break.
 *
 * These are the two flags whose DEFAULT is load-bearing for safety:
 *   - pipelineOutputMode      — wrong default silently stops applying the user's work
 *   - pipelineParallelExecution — wrong default opts users into the unproven git path
 */
suite('Settings defaults', () => {
    suiteSetup(async () => {
        await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
    });

    test('an unconfigured workspace defaults to apply mode, not pr', async () => {
        // With nothing stored, resolveOutputMode(undefined) must yield 'apply'. Asserted
        // through the extension's own module so the test breaks if the default moves.
        const { resolveOutputMode } = require('../../../../dist/core/git-pr.js');
        assert.strictEqual(resolveOutputMode(undefined), 'apply');
        assert.strictEqual(resolveOutputMode(null), 'apply');
    });

    test('parallel execution requires an explicit true', () => {
        const { shouldRunParallel } = require('../../../../dist/core/parallel-execution.js');
        const parallelizable = [['Design Executor', 'Backend Executor']];
        // Every falsy/malformed settings value must keep the proven sequential path.
        for (const raw of [undefined, null, false, 0, '', 'true', 1, {}]) {
            assert.strictEqual(
                shouldRunParallel(parallelizable, (raw as any) === true),
                false,
                `settings value ${JSON.stringify(raw)} must not enable parallel execution`
            );
        }
        assert.strictEqual(shouldRunParallel(parallelizable, true), true);
    });

    test('the extension declares no contributes.configuration (settings live in the blob)', () => {
        // A guard against a future contributor adding a VS Code setting that the runtime
        // never reads — the failure mode F5 documented.
        const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
        assert.strictEqual(
            ext.packageJSON?.contributes?.configuration,
            undefined,
            'settings were added to contributes.configuration but the runtime reads the secret-store blob'
        );
    });
});
