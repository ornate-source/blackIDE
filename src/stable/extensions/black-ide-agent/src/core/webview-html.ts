import * as vscode from 'vscode';

/**
 * Shell HTML for the three webview surfaces (chat view, settings panel, manager
 * panel). All three load the same bundle; which React root mounts is decided by
 * the `window.is*Panel` flags below.
 *
 * Extracted verbatim from `BlackIdeChatProvider.getHtmlForWebview` (Phase 0, M2)
 * — a pure function of the webview and the extension URI, so it needs none of the
 * provider's instance state.
 */
export function getHtmlForWebview(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    viewType: 'chat' | 'settings' | 'manager' = 'chat'
): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets', 'index.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets', 'index.css'));
    const avatarUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'agent-avatar.png'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Black IDE Assistant</title>
    <link href="${styleUri}" rel="stylesheet" />
    <script>
        window.agentAvatarUri = "${avatarUri}";
        window.isSettingsPanel = ${viewType === 'settings'};
        window.isManagerPanel = ${viewType === 'manager'};
    </script>
</head>
<body class="bg-background text-white select-none">
    <div id="root"></div>
    <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
