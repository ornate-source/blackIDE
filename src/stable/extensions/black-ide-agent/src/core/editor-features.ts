import * as vscode from 'vscode';
import { SecretManager } from './secret-manager';
import { BlackIdeInlineCompletionProvider } from './inline-completion';
import { NextEditController } from './next-edit-controller';
import { CodeGraph } from './code-graph';

// ─── Editor-surface registration ────────────────────────────────────────────
//
// Everything the extension contributes to the *text editor itself*, as opposed to the
// chat view or the command palette. Extracted from `activate()` in Phase 5 when adding
// next-edit took `extension.ts` past its ≤700-line gate — the second time this phase's
// wiring has hit that gate, and the second time the answer was a module rather than a
// slightly larger entry point.
//
// The two providers here answer different questions and are deliberately separate:
// inline completion finishes the line under the cursor, next-edit predicts the change the
// last edit implies, which is usually somewhere else and often in another file.

export interface EditorFeatureDeps {
    /** Phase 3's code graph, read lazily — the index is not built at activation. */
    codeGraph: () => CodeGraph;
}

export function registerEditorFeatures(
    context: vscode.ExtensionContext,
    secretManager: SecretManager,
    deps: EditorFeatureDeps,
): void {
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' },
            new BlackIdeInlineCompletionProvider(secretManager),
        ),
    );

    new NextEditController(secretManager, deps.codeGraph).register(context);
}
