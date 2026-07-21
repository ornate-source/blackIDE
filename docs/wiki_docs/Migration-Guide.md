# Migration Guide

This guide explains how to migrate your existing settings, keybindings, and extensions from Visual Studio Code or VSCodium to Black IDE.

---

## 📂 Settings and Configuration Paths

Visual Studio Code and VSCodium store their settings files (`settings.json` and `keybindings.json`) in platform-specific user folders. You can copy these files directly to the Black IDE directories to restore your configuration.

### 1. Source Settings Paths:
* **Visual Studio Code**:
  * macOS: `~/Library/Application Support/Code/User`
  * Windows: `%APPDATA%\Code\User`
  * Linux: `~/.config/Code/User`
* **VSCodium**:
  * macOS: `~/Library/Application Support/VSCodium/User`
  * Windows: `%APPDATA%\VSCodium\User`
  * Linux: `~/.config/VSCodium/User`

### 2. Black IDE Settings Paths:
Copy your configuration files into these target folders:
* **macOS**: `~/Library/Application Support/Black IDE/User/`
* **Windows**: `%APPDATA%\Black IDE\User\`
* **Linux**: `~/.config/Black IDE/User/`

---

## 🔌 Migrating Extensions

VS Code OSS-based distributions store their extension files in the `~/.vscode-oss/extensions` directory.

To copy your extensions from official VS Code to Black IDE:
1. Locate your VS Code extensions folder at `~/.vscode/extensions`.
2. Copy its contents into `~/.vscode-oss/extensions` (or your custom portable data folder if running in portable mode).

Alternatively, you can manually reinstall extensions via the Extensions pane in Black IDE using the Open VSX search bar.
