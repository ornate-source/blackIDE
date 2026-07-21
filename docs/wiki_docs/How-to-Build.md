# Building Black IDE from Source

This guide explains how to compile and bundle Black IDE on your local machine.

---

## 📋 Prerequisites & Dependencies

Before building Black IDE, make sure you have the following installed:

* **Node.js**: The exact version required is defined in the [`.nvmrc`](file:///.nvmrc) file.
* **npm**: Node Package Manager.
* **Git**: To clone submodules and apply build patches.
* **jq**: Command-line JSON processor (used by prepare scripts).
* **Python 3**: Required by the VS Code build system for node-gyp compilation.
* **Rust**: Required to compile native components.

### Platform-Specific Tools:
* **macOS**: Xcode Command Line Tools (`xcode-select --install`).
* **Linux**: `gcc`, `g++`, `make`, `pkg-config`, `libx11-dev`, `libxkbfile-dev`, `libsecret-1-dev`, `libkrb5-dev`, `fakeroot`, `rpm`, `dpkg`.
* **Windows**: Run build scripts in Git Bash. Install [Git for Windows](https://gitforwindows.org/) and the C++ build tools (via Visual Studio Installer).

---

## 🛠️ Build Commands

Black IDE contains a `Makefile` to simplify build procedures.

### 1. Initialize and Dev Environment Setup
Before doing a build, run:
```bash
make dev
```
*This command clones the upstream vscode repository, applies custom patches (branding, telemetry removal, font adjustments), and sets up the node modules.*

### 2. Compile and Package Binary
Build Black IDE for your specific operating system:

* **macOS**:
  ```bash
  make build-mac
  ```
  *(Packages the app into a DMG and zip file under the `assets` folder.)*

* **Linux**:
  ```bash
  make build-linux
  ```

* **Windows**:
  ```bash
  make build-windows
  ```

### 3. Clean Build Files
To clean intermediate build folders and build artifacts:
```bash
make clean
```
