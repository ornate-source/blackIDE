# Troubleshooting Common Issues

Find solutions and workarounds for common issues encountered when running Black IDE on Linux, macOS, and Windows.

---

## 🐧 Linux Issues

### 1. Text or Interface Elements Not Appearing (Rendering Glitches)
This is a known upstream Electron/Chromium bug related to compiling Mesa shaders. You can resolve this by deleting the GPU cache folder:

```bash
rm -rf ~/.config/Black\ IDE/GPUCache
```

### 2. Fonts Rendering as Rectangles / Blocks
Clear and rebuild your system font cache by running:

```bash
rm -rf ~/.cache/fontconfig
fc-cache -r
```

### 3. Wayland Window Failing to Launch
If running under Wayland and the application does not display:
* Run the binary from terminal with `black-ide --verbose` to inspect logs.
* If you see an EGL Context creation error, force X11 fallback:
  ```bash
  black-ide --ozone-platform=x11
  ```

---

## 🏁 Windows Issues

### 1. Adding "Open with Black IDE" to the Explorer Context Menu
If the context menu entry is missing, you can add it manually using the Registry Editor:

1. Press `Win + R`, type `regedit`, and press Enter.
2. Navigate to `HKEY_CLASSES_ROOT\*\shell\` and create a key named `Open with Black IDE`.
3. Set the default string value of that key to `"Open with Black IDE"`.
4. Create a subkey under it named `command`.
5. Set the default string value of the `command` key to the path of your installation, for example:
   ```text
   "C:\Program Files\Black IDE\Black IDE.exe" "%1"
   ```

### 2. Windows Defender False Positives
Since Black IDE builds may be unsigned, Windows Defender may occasionally flag installer packages as threats.
* Verify the cryptographic hashes (`.sha256`) of the files downloaded from the official GitHub Releases page.
* Add a temporary scan exclusion in Windows Security to complete installation.
