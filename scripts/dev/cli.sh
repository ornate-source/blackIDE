export CARGO_NET_GIT_FETCH_WITH_CLI="true"
export VSCODE_CLI_APP_NAME="black-ide"
export VSCODE_CLI_BINARY_NAME="black-ide-server-insiders"
export VSCODE_CLI_DOWNLOAD_URL="https://github.com/ornate-source/blackIDE-insiders/releases"
export VSCODE_CLI_QUALITY="insider"
export VSCODE_CLI_UPDATE_URL="https://raw.githubusercontent.com/VSCodium/versions/refs/heads/master"

cargo build --release --target aarch64-apple-darwin --bin=code

cp target/aarch64-apple-darwin/release/code "../../VSCode-darwin-arm64/Black IDE - Insiders.app/Contents/Resources/app/bin/black-ide-tunnel-insiders"

"../../VSCode-darwin-arm64/Black IDE - Insiders.app/Contents/Resources/app/bin/black-ide-insiders" serve-web
