# Patches

Documentation for Black IDE patches applied on top of VS Code.

---

## fix-policies

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
