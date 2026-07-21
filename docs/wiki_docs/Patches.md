# Patches

Documentation for Black IDE patches applied on top of VS Code.

For the mechanics of creating and rebasing patches, see
[[Building from Source|How-to-Build]].

---

## 📁 How the Patch Set Is Organized

Patches live in `config/patches/`. The top level holds the ~46 cross-platform patches;
subdirectories hold patches that only apply to a specific target:

| Directory | Applies to |
|---|---|
| `config/patches/` | All builds (cross-platform) |
| `linux/` | Linux builds |
| `windows/` | Windows builds |
| `osx/` | macOS builds |
| `alpine/` | Alpine / musl builds |
| `insider/` | Insider quality only |
| `user/` | Windows user-installer build |
| `helper/` | `settings.patch`, applied by `patch.sh` as a scaffold — not a product change |

### Naming Convention

Files are named `<order>-<area>-<what-it-does>.patch` and applied in lexical order, so the
numeric prefix controls sequencing when one patch depends on another landing first:

* `00-*` — the bulk of the set: branding, telemetry removal, build fixes, UI tweaks
* `10-*`–`12-*` — versioning and the update channel
* `20-*`/`21-*` — swapping in Black IDE's forked native libs (keymap, policy watcher)
* `30-*`–`61-*` — build dependencies, CLI packaging, gulp tasks, extension security

The `<area>` segment groups related patches: `brand`, `build`, `telemetry`, `ui`,
`update`, `remote`, `ext-*`, `security`, `policy`, `cli`.

### Disabled Patches

Two extensions mark a patch as parked rather than deleting it:

* `.patch.no` — disabled (e.g. `00-build-update-electron.patch.no`)
* `.patch.yet` — not applied yet (e.g. `00-update-disable.patch.yet`)

Neither is picked up by the apply step. A companion `.json` file (e.g.
`51-ext-copilot-remove-it.json`, `80-ui-disable-onboarding.json`) carries the JSON-merge
half of a change whose other half is a `.patch`.

---

## 🔐 `21-policy-use-custom-lib.patch`

**Replace `@vscode/policy-watcher` with `@black-ide/policy-watcher`**

VS Code uses `@vscode/policy-watcher` to enforce Group Policy Objects (GPOs) on
Windows. That package reads from:

```
HKLM\SOFTWARE\Policies\Microsoft\<productName>
```

Black IDE forks this into `@black-ide/policy-watcher`, which takes a separate
`vendorName` argument. The `createWatcher()` call becomes:

```ts
createWatcher('Black IDE', this.productName, ...)
```

Because Black IDE sets `product.nameLong = 'Black IDE'` (via `prepare_vscode.sh`),
`this.productName` resolves to `'Black IDE'` at runtime. Therefore, the final
Windows registry key that Black IDE reads policies from is:

```
HKLM\SOFTWARE\Policies\Black IDE\Black IDE\<PolicyName>
```

(or `HKCU\SOFTWARE\Policies\Black IDE\Black IDE\<PolicyName>` for per-user policies)

This differs from VS Code's path (`Microsoft\VSCode`) and is the root cause of
[issue #2714](https://github.com/VSCodium/vscodium/issues/2714) where users mirror
VS Code's registry structure and find their GPOs ignored. Enterprise admins must
use the Black IDE-specific registry path.

### References

- [VSCodium issue #2714](https://github.com/VSCodium/vscodium/issues/2714)
- [VSCodium/policy-watcher — RegistryPolicy.hh](https://github.com/VSCodium/policy-watcher/blob/main/src/windows/RegistryPolicy.hh)
