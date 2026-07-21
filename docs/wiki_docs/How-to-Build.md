# Building Black IDE from Source

This guide explains how to compile and bundle Black IDE on your local machine.

Black IDE is not a plain extension — it is a full fork of VS Code. A build clones the
upstream `microsoft/vscode` repository at a pinned tag, overlays Black IDE's own sources
(including the `black-ide-agent` extension), applies the patch set, and packages an
Electron application.

---

## 📋 Prerequisites & Dependencies

Before building Black IDE, make sure you have the following installed:

* **Node.js**: the exact version is pinned in [`.nvmrc`](file:///.nvmrc) — currently **22.22.1**. Run `nvm use` in the repo root.
* **npm**: Node Package Manager.
* **Git**: to clone upstream and apply build patches.
* **jq**: command-line JSON processor (used heavily by the prepare scripts to rewrite `product.json`).
* **Python 3**: required by the VS Code build system for node-gyp, and by `scripts/dev/update_patches.sh`.
* **Rust**: required to compile the CLI / tunnel components.

### Platform-Specific Tools

* **macOS**: Xcode Command Line Tools (`xcode-select --install`).
* **Linux**: `gcc`, `g++`, `make`, `pkg-config`, `libx11-dev`, `libxkbfile-dev`, `libsecret-1-dev`, `libkrb5-dev`, `fakeroot`, `rpm`, `dpkg`.
* **Windows**: run the build scripts in Git Bash. Install [Git for Windows](https://gitforwindows.org/) and the C++ build tools (via the Visual Studio Installer).

### Upstream Version Pin

The upstream VS Code tag and commit are pinned in `config/upstream/stable.json` and
`config/upstream/insider.json` — both currently at tag **1.121.0**. Bumping these is what
starts a rebase of the patch set onto a new upstream release; see
[Patch Update Process](#patch-update-process-semiauto).

### Environment Variables

Release and signing automation reads its configuration from `.env`. Copy the committed
template and fill in only what you need:

```bash
cp .env.example .env
```

`.env` is gitignored — never commit real values. A plain local build needs none of these;
they matter for the `release` target and for CI publishing.

---

## <a id="build-scripts"></a>🛠️ Build Scripts

Black IDE ships a `Makefile` that wraps the scripts under `scripts/`.

| Target | Script | What it does |
|---|---|---|
| `make dev` | `scripts/dev/build.sh` | Full developer build: fetch upstream, apply patches, compile, package |
| `make build` | `scripts/build/build.sh` | Core build; requires `OS_NAME` and `VSCODE_ARCH` to be exported |
| `make build-mac` | `scripts/build/build_mac.sh` | Local macOS build |
| `make build-linux` | `scripts/build/build_linux.sh` | Local Linux build |
| `make build-windows` | `scripts/build/build_windows.sh` | Local Windows build |
| `make icons` | `scripts/build/build_icons.sh` | Regenerate application and file-type icons |
| `make prepare-assets` | `scripts/prepare/prepare_assets.sh` | Package artifacts and compute `sha1`/`sha256` checksums into `assets/` |
| `make release` | `scripts/release/release.sh` | Upload packaged assets to a GitHub Release |
| `make clean` | — | Remove `vscode*`, `VSCode*`, `assets/`, `sourcemaps/` |
| `make ci-lint` | `zizmor .` | Lint GitHub Actions workflows for security issues |
| `make ci-lint-fix` | `zizmor . --fix=all` | Auto-fix zizmor findings |
| `make ci-update` | `pinact run --update` | Update pinned GitHub Action SHAs (minimum age 7 days) |

Run `make help` for the same list from the terminal.

### 1. Developer Build

```bash
make dev
```

This clones the upstream `vscode` repository at the pinned tag, copies `src/stable/` over
it, installs and compiles the `black-ide-agent` extension and its React webview, rewrites
`product.json` with Black IDE branding, applies every patch in `config/patches/`, and
builds the application.

`scripts/dev/build.sh` accepts flags for less common cases:

| Flag | Effect |
|---|---|
| `-i` | Build the **insider** quality (`black-ide-insiders`, published to `ornate-source/blackIDE-insiders`) |
| `-l` | Track the latest upstream release instead of the pinned tag |
| `-o` | Skip the build step (source preparation only) |
| `-p` | Also package assets (`SKIP_ASSETS=no`) |
| `-s` | Skip source preparation (reuse the existing `vscode/` tree) |

```bash
# Insiders build, packaged
./scripts/dev/build.sh -i -p
```

### 2. Compile and Package for a Platform

* **macOS** — `make build-mac` (produces `.dmg` and `.zip` under `assets/`)
* **Linux** — `make build-linux`
* **Windows** — `make build-windows`

### 3. Clean Build Files

```bash
make clean
```

---

## 🧩 Working on the Agent Extension

The AI agent lives at `src/stable/extensions/black-ide-agent/` and is a normal TypeScript
extension with its own React webview. You do not need a full Electron build to work on it:

```bash
cd src/stable/extensions/black-ide-agent

npm ci
npm ci --prefix webview

npm run compile            # tsc -b
npm run build-webview      # build the React webview bundle
npm run watch              # incremental rebuild

npm test                   # core harness (mock LLM over HTTP, no VS Code needed)
npm run test:integration   # extension-host tests (launches a real VS Code)
npm run lint:css           # stylelint over webview CSS
npm run lint:dead-code     # knip
```

Both test layers are gated in CI — see [[Development Workflow|Development-Workflow]].

---

## <a id="patch-update-process-semiauto"></a>🩹 Patch Update Process (Semi-Automated)

When upstream VS Code moves, patches drift. To rebase the set:

1. Bump the tag and commit in `config/upstream/stable.json` (and `insider.json`).
2. Run the updater:
   ```bash
   ./scripts/dev/update_patches.sh        # stable
   ./scripts/dev/update_patches.sh -i     # insider
   ```
   It re-applies each patch in order and generates `.rej` reject files for the chunks that
   no longer apply cleanly.
3. Resolve each rejected chunk by hand, then re-record the patch (see below).

### Adding or Editing a Patch

```bash
./scripts/dev/patch.sh <patch-name>
```

The script resets the `vscode/` tree, applies the helper settings patch plus any patches
you name, then pauses. While it is paused:

1. Open the `vscode` directory in Black IDE.
2. Run `npm run watch`.
3. Run `./scripts/code.sh` to launch the patched build.
4. Make your changes.
5. Press any key to let `patch.sh` record the result back into `config/patches/`.

See [[Patches]] for how the patch set is organized and named.
