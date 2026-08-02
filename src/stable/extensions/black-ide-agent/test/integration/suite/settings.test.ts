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
 *   - pipelineOutputMode — wrong default silently stops applying the user's work
 *
 * `pipelineParallelExecution` used to be the second; Phase 6 deleted the path it guarded
 * (M35), so what is asserted now is its absence rather than its default.
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

    test('the parallel wave executor is gone, not merely defaulted off', () => {
        // Phase 6 deleted it (M35). This suite used to assert its default was safe; the
        // stronger property now is that there is no path to it at all — including no
        // stale compiled artifact, which is how a deleted module stays requirable.
        assert.throws(
            () => require('../../../../dist/core/parallel-execution.js'),
            /Cannot find module/,
            'core/parallel-execution should no longer exist in dist',
        );
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
