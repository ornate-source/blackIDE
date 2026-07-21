import * as vscode from 'vscode';

/**
 * Diff Content Provider — Feature 5
 * Provides virtual document content for VS Code's built-in diff editor.
 * Used to show a visual diff preview before applying agent edits.
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
    private contents: Map<string, string> = new Map();

    /** Register content for a virtual URI */
    setContent(uri: string, content: string): void {
        this.contents.set(uri, content);
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.toString()) || '';
    }

    /** Show a diff between original and modified content */
    static async showDiff(
        originalContent: string,
        modifiedContent: string,
        filePath: string
    ): Promise<'Apply' | 'Reject' | undefined> {
        const provider = new DiffContentProvider();
        const scheme = 'blackide-diff';

        const originalUri = vscode.Uri.parse(`${scheme}:original/${filePath}`);
        const modifiedUri = vscode.Uri.parse(`${scheme}:modified/${filePath}`);

        provider.setContent(originalUri.toString(), originalContent);
        provider.setContent(modifiedUri.toString(), modifiedContent);

        const disposable = vscode.workspace.registerTextDocumentContentProvider(scheme, provider);

        try {
            await vscode.commands.executeCommand('vscode.diff',
                originalUri,
                modifiedUri,
                `Agent Edit: ${filePath} (Review Changes)`
            );

            const approval = await vscode.window.showInformationMessage(
                `Review the diff for ${filePath}. Apply changes?`,
                'Apply',
                'Reject'
            );

            return approval as 'Apply' | 'Reject' | undefined;
        } finally {
            disposable.dispose();
        }
    }
}
