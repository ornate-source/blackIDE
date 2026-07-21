# Extensions Compatibility

Several Microsoft-authored extensions check for the official VS Code build and restrict their execution on non-Microsoft builds (such as VSCodium or Black IDE) via licensing constraints or proprietary checks.

Here is a list of known incompatible extensions and their fully functional open-source replacements.

---

## ❌ Incompatible Extensions

The following extensions are designed for or restricted to official Microsoft builds:

* **C/C++** (`ms-vscode.cpptools`)
* **Python** (`ms-python.python`)
* **Live Share** (`ms-vsliveshare.vsliveshare`)
* **Remote - Containers** (`ms-vscode-remote.remote-containers`)
* **Remote - SSH** (`ms-vscode-remote.remote-ssh`)
* **Remote - WSL** (`ms-vscode-remote.remote-wsl`)
* **LaTeX Workshop** (Not officially supported on VS Code OSS forks)

---

## 🎯 Open Source Replacements

Use the following open-source alternatives available on the Open VSX Registry:

### 1. C & C++
* **Language Support**: [clangd](https://open-vsx.org/extension/llvm-vs-code-extensions/vscode-clangd) provides fast code completion, formatting, and diagnostics.
* **Debugging**: [Native Debug](https://open-vsx.org/extension/webfreak/debug) provides support for GDB/LLDB.

### 2. Python
* **Language Support**: [BasedPyright](https://open-vsx.org/extension/detachhead/basedpyright) provides advanced type-checking and analysis.

### 3. Remote Development
* **SSH**: [Open Remote - SSH](https://open-vsx.org/extension/jeanp413/open-remote-ssh) provides remote development over SSH. *(Note: Ensure `AllowTcpForwarding yes` is enabled in your server's `sshd_config`)*.
* **WSL**: [Open Remote - WSL](https://open-vsx.org/extension/jeanp413/open-remote-wsl) provides WSL environment editing.
