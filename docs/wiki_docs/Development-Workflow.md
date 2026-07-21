# Development Workflow

How changes get from a local edit to a published Black IDE release: branches, CI gates,
tests, and the automation that runs around them.

---

## 🌿 Branches

| Branch | Role |
|---|---|
| `main` | Stable line. Publishes stable releases. |
| `dev` | Insider line. Publishes insider releases. |

---

## ✅ CI Gates

All workflows live in `.github/workflows/`. Actions are pinned to commit SHAs, and
Dependabot bumps them weekly (targeting the `insider` branch, with a 7-day cooldown).

### Agent Extension

Both gates are scoped to `src/stable/extensions/black-ide-agent/**`, so unrelated changes
don't pay for them.

| Workflow | What it runs |
|---|---|
| `ci-agent-tests.yml` | `npm test` — the core harness — plus a webview typecheck |
| `ci-agent-integration.yml` | `npm run test:integration` under `xvfb-run` |

**Why two layers:** the core harness (`test/harness.js`) is a plain Node process driving
the vscode-free core against a mock LLM server over HTTP — no display server, no Electron —
so it runs on a stock ubuntu runner in under a minute. The integration suite launches a real
VS Code with the extension loaded, which is the only layer that can exercise `extension.ts`
activation glue, command registration, and the first-run workspace scan; the harness stubs
`vscode` and structurally cannot reach them. It is slower (downloads ~270MB of VS Code) and
needs a virtual display, so it is kept separate — a unit regression still fails fast.

The webview is a **separate tsc project and is not covered by `npm test`**, which is why
`ci-agent-tests.yml` runs `npx tsc -p ./webview --noEmit` as its own step.

### Editor Build

| Workflow | Target |
|---|---|
| `ci-build-linux.yml` | Linux build |
| `ci-build-windows.yml` | Windows build |
| `ci-build-macos.yml` | macOS build — **currently disabled** (pinned to a non-existent `disabled-mac-build` branch) |

All three also accept `workflow_dispatch` with `generate_assets` and `checkout_pr` inputs
for manual runs.

### Workflow Linting

`lint-zizmor.yml` runs [zizmor](https://github.com/woodruffw/zizmor) over the workflow files
and uploads findings to GitHub code scanning. Run it locally with:

```bash
make ci-lint        # report
make ci-lint-fix    # auto-fix
make ci-update      # refresh pinned action SHAs (pinact, min age 7 days)
```

> [!NOTE]
> The build and lint workflows are triggered on pushes to `master` / `insider`, while this
> repository uses `main` / `dev`. Push-triggered runs therefore do not fire on the active
> branches; pull requests still match (`branches: "**"`). Several of these workflows also
> still set `APP_NAME: VSCodium`. Both are known upstream-inherited leftovers.

---

## 🚀 Publishing

| Workflow | Trigger |
|---|---|
| `publish-stable-linux.yml`, `publish-stable-windows.yml` | `main` / `publish-stable` |
| `publish-insider-linux.yml`, `publish-insider-windows.yml` | `dev` / `publish-insider` |
| `publish-*-macos.yml` | disabled |
| `publish-*-spearhead.yml` | manual |

Release automation reads credentials from repository secrets, mirrored for local use by
`.env` (see [[Building from Source|How-to-Build]]). Signing and store-publishing secrets
(macOS notarization, SignPath, GPG, AUR, Snap Store) are referenced by the workflows;
`.env.example` marks which ones are not currently configured.

> GitHub Actions secrets are **write-only** — their values cannot be read back by anyone,
> including the repo owner. They must come from your own records or be regenerated at the
> source.

---

## 🤖 Repository Moderation

| Workflow | Schedule | Behavior |
|---|---|---|
| `mod-stale-issue-pr.yml` | daily, 01:00 UTC | Marks issues stale after 180 days, closes after 30 more. Exempt labels: `discussion`, `never-stale`. |
| `mod-lock-closed-threads.yml` | daily, 02:00 UTC | Locks closed issues, PRs, and discussions after 90 days of inactivity. |

---

## 🧾 Contributing

See [`CONTRIBUTING.md`](https://github.com/ornate-source/blackIDE/blob/main/CONTRIBUTING.md)
and the [Code of Conduct](https://github.com/ornate-source/blackIDE/blob/main/CODE_OF_CONDUCT.md).

Note on AI-assisted contributions: their use is welcome but must be **disclosed**, and all
content must pass human review. Discussions, issues, or PRs consisting solely of unvetted AI
output may be closed at the maintainers' discretion. Keep them concise.

For bug reports, check the [[Troubleshooting]] page and existing issues first, then fill out
the bug report template.
