# Getting Started with Black IDE

This guide will help you install, configure, and start using Black IDE.

---

## 🛠️ Installation

Black IDE is distributed as a custom standalone distribution of VS Code (packaged as an Electron application). You can download pre-compiled releases for macOS, Linux, and Windows from the [GitHub Releases page](https://github.com/ornate-source/blackIDE/releases).

### Release Channels

| Channel | Repository | Installs alongside stable? |
|---|---|---|
| **Stable** — `black-ide` | [`ornate-source/blackIDE`](https://github.com/ornate-source/blackIDE/releases) | — |
| **Insiders** — `black-ide-insiders` | [`ornate-source/blackIDE-insiders`](https://github.com/ornate-source/blackIDE-insiders/releases) | Yes — separate app, settings, and data folder |

Insiders uses its own bundle identifier and data directory (`.black-ide-insiders`), so the
two channels never share state and can be run side by side.

### Platform Notes:
* **macOS**: Download the `.dmg` or `.zip` file for your architecture (usually Apple Silicon `darwin-arm64` or Intel `darwin-x64`). Mount the DMG and drag Black IDE to your `/Applications` folder.
* **Linux**: Download the appropriate package (like `.deb`, `.rpm`, or `.tar.gz`) for your distribution.
* **Windows**: Download the installer executable `.exe` or portable zip archive.

---

## 🚀 First Steps

After launching Black IDE for the first time, follow these steps to get oriented:

1. **Open a Project**: Go to **File > Open Folder...** to open your workspace.
2. **Access the AI Agent**: Look for the **Black IDE Chat** icon in the sidebar (Activity Bar). This opens the native AI coding assistant.
3. **Add an API Key**: Run **✦ Black IDE Settings** from the Command Palette and add a key for Anthropic, OpenAI, Google, OpenRouter, or point it at a local Ollama instance. Keys go to the OS keychain, not `settings.json`. See [[AI Agent|AI-Agent]].
4. **Configure Settings**: Go to **File > Preferences > Settings** (`Cmd+,` or `Ctrl+,`) to customize your editor preferences.
5. **Install Extensions**: Click the Extensions icon in the Activity Bar to browse and install tools from the Open VSX Registry.

---

## 💡 Key Differences from VS Code

Black IDE is fully based on the open-source core of Visual Studio Code, but contains several important changes:

* **No Telemetry**: All tracking, feedback reports, and background telemetry endpoints have been patched out of the codebase.
* **Open VSX Gallery**: It connects to the [Open VSX Registry](https://open-vsx.org/) instead of the proprietary Microsoft Marketplace by default.
* **Built-in AI Assistant**: Built directly into the core editor is `black-ide-agent`, an autonomous developer loop with checkpoint undo controls.

---

## ⌨️ Essential Keyboard Shortcuts

| Shortcut (macOS) | Shortcut (Win/Linux) | Action |
|---|---|---|
| `Cmd + Shift + P` | `Ctrl + Shift + P` | Open the Command Palette |
| `Cmd + P` | `Ctrl + P` | Quick Open (Search/Go to File) |
| `Cmd + I` | `Ctrl + I` | Trigger Editor-Native Inline Chat |
| `Cmd + ,` | `Ctrl + ,` | Open User Settings |
| `Cmd + K Cmd + S` | `Ctrl + K Ctrl + S` | View and edit Keyboard Shortcuts |

---

## 🔗 Next Steps

* Set up and drive the AI agent in the [[AI Agent|AI-Agent]] guide.
* Learn about portable settings and PATH setup in the [[Usage Guide|Usage]].
* Explore how Black IDE removes telemetry in [[Telemetry-Free Design|Telemetry]].
* Understand extension licensing and alternatives in [[Extensions & Marketplace|Extensions]].
