# Black IDE Usage Guide

This page covers advanced usage topics for Black IDE, including portable mode, macOS press-and-hold settings, terminal access, and GitHub login integration.

---

## 🔑 Sign in with GitHub

Black IDE allows you to connect certain extensions (like Git integration helpers) to GitHub. Since Black IDE does not include Microsoft's proprietary authentication service:

1. Create a **Personal Access Token (Classic)** on GitHub by visiting your [GitHub Developer Settings](https://github.com/settings/tokens).
2. Assign the scopes necessary for your extensions (e.g., `repo` scope is required for advanced Git details or push/pull features).
3. Copy the token.
4. When prompted by Black IDE or an extension to sign in to GitHub, paste this token as the password/token input.

*Note for Linux users: If you see an error about `Writing login information to the keychain failed`, make sure you have `gnome-keyring` installed on your system.*

---

## 📦 Running in Portable Mode

Black IDE supports **Portable Mode**, which stores all configuration, extensions, and user data inside a folder next to the application binary. This is useful for running Black IDE from a USB drive or keeping multiple versions separate.

* **Windows / Linux**: Create a folder named `data` in the folder where the Black IDE binary/files are extracted.
* **macOS**: Create a folder named `black-ide-portable-data` in the same directory as the `Black IDE.app` bundle.

---

## ⌨️ Press and Hold Key Repeat (macOS)

By default, macOS displays an accent menu when you press and hold a key instead of repeating the character. To enable character repeating in Black IDE, execute the following command in your terminal:

```bash
defaults write com.electron.black-ide ApplePressAndHoldEnabled -bool false
```

After running the command, restart Black IDE for the changes to take effect.

---

## 🖥️ Opening Black IDE from the Terminal

You can open files, directories, or launch the editor directly from your terminal using the `black-ide` command-line tool.

### Setup (macOS / Windows):
1. Launch Black IDE.
2. Open the Command Palette (`Cmd + Shift + P` or `Ctrl + Shift + P`).
3. Search for and execute the command: **`Shell Command: Install 'black-ide' command in PATH`**.

Once installed, you can use the command:

```bash
# Open the current directory
black-ide .

# Open a specific file
black-ide index.js
```

You can also create an alias in your shell configuration (`~/.zshrc` or `~/.bashrc`) if you prefer a shorter command:
```bash
alias black="black-ide"
```
