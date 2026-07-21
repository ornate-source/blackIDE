# Extensions and Marketplace

Because Black IDE is built on top of the open-source VS Code core, it supports the installation of extensions. However, in compliance with Microsoft's terms of use, Black IDE does not connect to the proprietary Visual Studio Marketplace by default.

---

## 🌐 The Open VSX Registry

By default, Black IDE connects to the community-driven, open-source [Open VSX Registry](https://open-vsx.org/) to search, install, and update extensions.

If you cannot find an extension you need on Open VSX:
1. **Request the authors**: You can ask extension maintainers to publish their extensions to the Open VSX Registry.
2. **Community publication**: Submit a pull request to the [open-vsx/publish-extensions](https://github.com/open-vsx/publish-extensions) repository to request automated publishing.
3. **Manual VSIX Installation**: Download the `.vsix` file from the extension's Github releases page, click the three dots `...` in Black IDE's Extensions view, and choose **Install from VSIX...**.

---

## ⚙️ Switching Extension Galleries

If you want to use a different extension registry, you can define these custom environment variables before launching Black IDE:

* `VSCODE_GALLERY_SERVICE_URL`
* `VSCODE_GALLERY_ITEM_URL`
* `VSCODE_GALLERY_EXTENSION_URL_TEMPLATE`

Alternatively, you can write a custom `product.json` file to override the `extensionsGallery` parameters. The config file should be placed at:
* **macOS**: `~/Library/Application Support/Black IDE/product.json`
* **Windows**: `%APPDATA%\Black IDE\product.json`
* **Linux**: `~/.config/Black IDE/product.json`

---

## 🚫 Proprietary Extensions and Debuggers

Some extensions developed by Microsoft (such as Remote Development extensions or official C# and C++ debuggers) have licensing terms that restrict them to running only on official Microsoft VS Code builds. They may also perform runtime checks that fail when running inside Black IDE.

Please see the [[Extensions Compatibility|Extensions-Compatibility]] guide for functional open-source alternatives and compatibility notes.
