import * as vscode from 'vscode';

/**
 * The webview surfaces. `office` is the sidebar Front Desk, added by M73.
 *
 * Named rather than repeated inline because it is now stated in five places — the shell
 * below, the provider, and the three hosts that ask it for HTML — and a union that drifts
 * between them fails as a silently wrong surface rather than as a type error.
 */
export type WebviewSurface = 'chat' | 'settings' | 'manager' | 'office';

/**
 * Shell HTML for the four webview surfaces (chat view, settings panel, manager
 * panel, Front Desk). All four load the same bundle; which React root mounts is
 * decided by the `window.is*` flags below.
 *
 * Extracted verbatim from `BlackIdeChatProvider.getHtmlForWebview` (Phase 0, M2)
 * — a pure function of the webview and the extension URI, so it needs none of the
 * provider's instance state.
 */
export function getHtmlForWebview(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    viewType: WebviewSurface = 'chat'
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
        window.isOfficeSidebar = ${viewType === 'office'};
    </script>
</head>
<body class="bg-background text-white select-none">
    <div id="root"></div>
    <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
