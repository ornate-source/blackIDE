#!/usr/bin/env bash
# shellcheck disable=SC1091,2154

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ -z "${RELEASE_VERSION}" ]]; then
  . "${PROJECT_ROOT}/scripts/lib/version.sh"
fi

if [[ ! -d "${PROJECT_ROOT}/vscode/.git" ]]; then
  echo "vscode repository not found or incomplete. Retrieving upstream repository..."
  . "${PROJECT_ROOT}/scripts/ci/get_repo.sh"
else
  echo "Resetting vscode repository to clean state..."
  cd "${PROJECT_ROOT}/vscode"
  git reset --hard HEAD
  git clean -fd
  cd "${PROJECT_ROOT}"
fi

# 1. Copy quality-specific source files to vscode directory
if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  # For insider: copy src/insider, then overlay custom extensions from stable
  cp -rp "${PROJECT_ROOT}/src/insider/"* "${PROJECT_ROOT}/vscode/" 2>/dev/null || true
  mkdir -p "${PROJECT_ROOT}/vscode/extensions"
  cp -rp "${PROJECT_ROOT}/src/stable/extensions/"* "${PROJECT_ROOT}/vscode/extensions/" 2>/dev/null || true
else
  cp -rp "${PROJECT_ROOT}/src/stable/"* "${PROJECT_ROOT}/vscode/" 2>/dev/null || true
fi

# 2. Clean black-ide-agent node_modules so npm install runs fresh (avoids broken symlinks on Windows and stale .bin issues)
rm -rf "${PROJECT_ROOT}/vscode/extensions/black-ide-agent/node_modules"
rm -rf "${PROJECT_ROOT}/vscode/extensions/black-ide-agent/webview/node_modules"

# 3. Build the agent extension directly inside the target directory
echo "Building agent extension webview assets and compiling extension..."
cd "${PROJECT_ROOT}/vscode/extensions/black-ide-agent"
npm install
cd webview
npm install
npm run build
cd ..
npm run compile
cd "${PROJECT_ROOT}"

cp -f "${PROJECT_ROOT}/docs/LICENSE" "${PROJECT_ROOT}/vscode/LICENSE.txt"

cd "${PROJECT_ROOT}/vscode" || { echo "'vscode' dir not found"; exit 1; }

# rm -rf extensions/copilot

{ set +x; } 2>/dev/null

# {{{ product.json
cp product.json{,.bak}

setpath() {
  local jsonTmp
  { set +x; } 2>/dev/null
  jsonTmp=$( jq --arg 'value' "${3}" "setpath(path(.${2}); \$value)" "${1}.json" )
  echo "${jsonTmp}" > "${1}.json"
  set -x
}

setpath_json() {
  local jsonTmp
  { set +x; } 2>/dev/null
  jsonTmp=$( jq --argjson 'value' "${3}" "setpath(path(.${2}); \$value)" "${1}.json" )
  echo "${jsonTmp}" > "${1}.json"
  set -x
}

setpath "product" "checksumFailMoreInfoUrl" "https://go.microsoft.com/fwlink/?LinkId=828886"
setpath "product" "documentationUrl" "https://go.microsoft.com/fwlink/?LinkID=533484#vscode"
setpath_json "product" "extensionsGallery" '{"serviceUrl": "https://open-vsx.org/vscode/gallery", "itemUrl": "https://open-vsx.org/vscode/item", "latestUrlTemplate": "https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest", "controlUrl": "https://raw.githubusercontent.com/EclipseFdn/publish-extensions/refs/heads/master/extension-control/extensions.json"}'

setpath "product" "introductoryVideosUrl" "https://go.microsoft.com/fwlink/?linkid=832146"
setpath "product" "keyboardShortcutsUrlLinux" "https://go.microsoft.com/fwlink/?linkid=832144"
setpath "product" "keyboardShortcutsUrlMac" "https://go.microsoft.com/fwlink/?linkid=832143"
setpath "product" "keyboardShortcutsUrlWin" "https://go.microsoft.com/fwlink/?linkid=832145"
setpath "product" "licenseUrl" "https://github.com/ornate-source/blackIDE/blob/main/LICENSE"
setpath_json "product" "linkProtectionTrustedDomains" '["https://open-vsx.org"]'
setpath "product" "releaseNotesUrl" "https://go.microsoft.com/fwlink/?LinkID=533483#vscode"
setpath "product" "reportIssueUrl" "https://github.com/ornate-source/blackIDE/issues/new"
setpath "product" "requestFeatureUrl" "https://go.microsoft.com/fwlink/?LinkID=533482"
setpath "product" "tipsAndTricksUrl" "https://go.microsoft.com/fwlink/?linkid=852118"
setpath "product" "twitterUrl" "https://go.microsoft.com/fwlink/?LinkID=533687"

if [[ "${DISABLE_UPDATE}" != "yes" ]]; then
  setpath "product" "updateUrl" "https://raw.githubusercontent.com/VSCodium/versions/refs/heads/master"

  if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
    setpath "product" "downloadUrl" "https://github.com/ornate-source/blackIDE-insiders/releases"
  else
    setpath "product" "downloadUrl" "https://github.com/ornate-source/blackIDE/releases"
  fi

  # if [[ "${OS_NAME}" == "windows" ]]; then
  #   setpath_json "product" "win32VersionedUpdate" "true"
  # fi
fi

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  setpath "product" "nameShort" "Black IDE - Insiders"
  setpath "product" "nameLong" "Black IDE - Insiders"
  setpath "product" "applicationName" "black-ide-insiders"
  setpath "product" "dataFolderName" ".black-ide-insiders"
  setpath "product" "linuxIconName" "black-ide-insiders"
  setpath "product" "quality" "insider"
  setpath "product" "urlProtocol" "black-ide-insiders"
  setpath "product" "serverApplicationName" "black-ide-server-insiders"
  setpath "product" "serverDataFolderName" ".black-ide-server-insiders"
  setpath "product" "darwinBundleIdentifier" "com.blackide.insiders"
  setpath "product" "win32AppUserModelId" "BlackIDE.BlackIDEInsiders"
  setpath "product" "win32DirName" "Black IDE Insiders"
  setpath "product" "win32MutexName" "blackideinsiders"
  setpath "product" "win32NameVersion" "Black IDE Insiders"
  setpath "product" "win32RegValueName" "BlackIDEInsiders"
  setpath "product" "win32ShellNameShort" "Black IDE Insiders"
  setpath "product" "win32AppId" "{{EF35BB36-FA7E-4BB9-B7DA-D1E09F2DA9C9}"
  setpath "product" "win32x64AppId" "{{B2E0DDB2-120E-4D34-9F7E-8C688FF839A2}"
  setpath "product" "win32arm64AppId" "{{44721278-64C6-4513-BC45-D48E07830599}"
  setpath "product" "win32UserAppId" "{{ED2E5618-3E7E-4888-BF3C-A6CCC84F586F}"
  setpath "product" "win32x64UserAppId" "{{20F79D0D-A9AC-4220-9A81-CE675FFB6B41}"
  setpath "product" "win32arm64UserAppId" "{{2E362F92-14EA-455A-9ABD-3E656BBBFE71}"
  setpath "product" "tunnelApplicationName" "black-ide-insiders-tunnel"
  setpath "product" "win32TunnelServiceMutex" "blackideinsiders-tunnelservice"
  setpath "product" "win32TunnelMutex" "blackideinsiders-tunnel"
  setpath "product" "win32ContextMenu.x64.clsid" "90AAD229-85FD-43A3-B82D-8598A88829CF"
  setpath "product" "win32ContextMenu.arm64.clsid" "7544C31C-BDBF-4DDF-B15E-F73A46D6723D"
else
  setpath "product" "nameShort" "Black IDE"
  setpath "product" "nameLong" "Black IDE"
  setpath "product" "applicationName" "black-ide"
  setpath "product" "dataFolderName" ".black-ide"
  setpath "product" "linuxIconName" "black-ide"
  setpath "product" "quality" "stable"
  setpath "product" "urlProtocol" "black-ide"
  setpath "product" "serverApplicationName" "black-ide-server"
  setpath "product" "serverDataFolderName" ".black-ide-server"
  setpath "product" "darwinBundleIdentifier" "com.blackide"
  setpath "product" "win32AppUserModelId" "BlackIDE.BlackIDE"
  setpath "product" "win32DirName" "Black IDE"
  setpath "product" "win32MutexName" "blackide"
  setpath "product" "win32NameVersion" "Black IDE"
  setpath "product" "win32RegValueName" "BlackIDE"
  setpath "product" "win32ShellNameShort" "Black IDE"
  setpath "product" "win32AppId" "{{763CBF88-25C6-4B10-952F-326AE657F16B}"
  setpath "product" "win32x64AppId" "{{88DA3577-054F-4CA1-8122-7D820494CFFB}"
  setpath "product" "win32arm64AppId" "{{67DEE444-3D04-4258-B92A-BC1F0FF2CAE4}"
  setpath "product" "win32UserAppId" "{{0FD05EB4-651E-4E78-A062-515204B47A3A}"
  setpath "product" "win32x64UserAppId" "{{2E1F05D1-C245-4562-81EE-28188DB6FD17}"
  setpath "product" "win32arm64UserAppId" "{{57FD70A5-1B8D-4875-9F40-C5553F094828}"
  setpath "product" "tunnelApplicationName" "black-ide-tunnel"
  setpath "product" "win32TunnelServiceMutex" "blackide-tunnelservice"
  setpath "product" "win32TunnelMutex" "blackide-tunnel"
  setpath "product" "win32ContextMenu.x64.clsid" "D910D5E6-B277-4F4A-BDC5-759A34EEE25D"
  setpath "product" "win32ContextMenu.arm64.clsid" "4852FC55-4A84-4EA1-9C86-D53BE3DF83C0"
fi

setpath_json "product" "tunnelApplicationConfig" '{}'

jsonTmp=$( jq -s '.[0] * .[1]' product.json "${PROJECT_ROOT}/config/product.json" )
echo "${jsonTmp}" > product.json && unset jsonTmp

cat product.json
# }}}

# include common functions
. "${PROJECT_ROOT}/scripts/lib/utils.sh"

# {{{ apply patches

echo "APP_NAME=\"${APP_NAME}\""
echo "APP_NAME_LC=\"${APP_NAME_LC}\""
echo "ASSETS_REPOSITORY=\"${ASSETS_REPOSITORY}\""
echo "BINARY_NAME=\"${BINARY_NAME}\""
echo "GH_REPO_PATH=\"${GH_REPO_PATH}\""
echo "GLOBAL_DIRNAME=\"${GLOBAL_DIRNAME}\""
echo "ORG_NAME=\"${ORG_NAME}\""
echo "TUNNEL_APP_NAME=\"${TUNNEL_APP_NAME}\""

if [[ "${DISABLE_UPDATE}" == "yes" ]]; then
  mv "${PROJECT_ROOT}/config/patches/00-update-disable.patch.yet" "${PROJECT_ROOT}/config/patches/00-update-disable.patch"
fi

for file in "${PROJECT_ROOT}/config/patches/"*.json; do
  if [[ -f "${file}" ]]; then
    apply_actions "${file}"
  fi
done

for file in "${PROJECT_ROOT}/config/patches/"*.patch; do
  if [[ -f "${file}" ]]; then
    apply_patch "${file}"
  fi
done

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  for file in "${PROJECT_ROOT}/config/patches/insider/"*.patch; do
    if [[ -f "${file}" ]]; then
      apply_patch "${file}"
    fi
  done
fi

if [[ -n "${OS_NAME}" && -d "${PROJECT_ROOT}/config/patches/${OS_NAME}/" ]]; then
  for file in "${PROJECT_ROOT}/config/patches/${OS_NAME}/"*.patch; do
    if [[ -f "${file}" ]]; then
      apply_patch "${file}"
    fi
  done
fi

for file in "${PROJECT_ROOT}/config/patches/user/"*.patch; do
  if [[ -f "${file}" ]]; then
    apply_patch "${file}"
  fi
done
# }}}

# Sync remote/package-lock.json after patches modify remote/package.json
# (e.g. cpu-features override change requires lockfile update)
if [[ -f "remote/package.json" ]]; then
  pushd remote
  npm install --package-lock-only --ignore-scripts 2>/dev/null || true
  popd
fi

set -x

# {{{ install dependencies
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

if [[ "${OS_NAME}" == "linux" ]]; then
  export VSCODE_SKIP_NODE_VERSION_CHECK=1

   if [[ "${npm_config_arch}" == "arm" ]]; then
    export npm_config_arm_version=7
  fi
elif [[ "${OS_NAME}" == "windows" ]]; then
  if [[ "${npm_config_arch}" == "arm" ]]; then
    export npm_config_arm_version=7
  fi
else
  if [[ "${CI_BUILD}" != "no" ]]; then
    clang++ --version
  fi
fi

node build/npm/preinstall.ts

if [[ -f .npmrc && ! -f .npmrc.bak ]]; then
  mv .npmrc .npmrc.bak
fi
cp "${PROJECT_ROOT}/config/npmrc" .npmrc

for i in {1..5}; do # try 5 times
  if [[ "${CI_BUILD}" != "no" && "${OS_NAME}" == "osx" ]]; then
    CXX=clang++ npm ci && break
  else
    npm ci && break
  fi

  if [[ $i == 5 ]]; then
    echo "Npm install failed too many times" >&2
    exit 1
  fi
  echo "Npm install failed $i, trying again..."

  sleep $(( 15 * (i + 1)))
done

if [[ -f .npmrc.bak ]]; then
  mv -f .npmrc.bak .npmrc
fi
# }}}

# package.json
cp package.json{,.bak}

setpath "package" "version" "${RELEASE_VERSION%-insider}"

replace 's|Microsoft Corporation|Black IDE|' package.json

cp resources/server/manifest.json{,.bak}

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  setpath "resources/server/manifest" "name" "Black IDE - Insiders"
  setpath "resources/server/manifest" "short_name" "Black IDE - Insiders"
else
  setpath "resources/server/manifest" "name" "Black IDE"
  setpath "resources/server/manifest" "short_name" "Black IDE"
fi

# announcements
replace "s|\\[\\/\\* BUILTIN_ANNOUNCEMENTS \\*\\/\\]|$( tr -d '\n' < "${PROJECT_ROOT}/config/announcements-builtin.json" )|" src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.ts

"${PROJECT_ROOT}/scripts/telemetry/undo_telemetry.sh"

replace 's|Microsoft Corporation|Black IDE|' build/lib/electron.ts
replace 's|([0-9]) Microsoft|\1 Black IDE|' build/lib/electron.ts

if [[ "${OS_NAME}" == "linux" ]]; then
  # microsoft adds their apt repo to sources
  # unless the app name is code-oss
  # as we are renaming the application to black-ide
  # we need to edit a line in the post install template
  if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
    sed -i "s/code-oss/black-ide-insiders/" resources/linux/debian/postinst.template
  else
    sed -i "s/code-oss/black-ide/" resources/linux/debian/postinst.template
  fi

  # fix the packages metadata
  # code.appdata.xml
  sed -i 's|Visual Studio Code|Black IDE|g' resources/linux/code.appdata.xml
  sed -i 's|https://code.visualstudio.com/docs/setup/linux|https://github.com/ornate-source/blackIDE#download-install|' resources/linux/code.appdata.xml
  sed -i 's|https://code.visualstudio.com/home/home-screenshot-linux-lg.png|https://raw.githubusercontent.com/ornate-source/blackIDE/main/config/icons/corner_512.png|' resources/linux/code.appdata.xml
  sed -i 's|https://code.visualstudio.com|https://github.com/ornate-source/blackIDE|' resources/linux/code.appdata.xml

  # control.template
  sed -i 's|Microsoft Corporation <vscode-linux@microsoft.com>|Black IDE Team https://github.com/ornate-source/blackIDE/graphs/contributors|'  resources/linux/debian/control.template
  sed -i 's|Visual Studio Code|Black IDE|g' resources/linux/debian/control.template
  sed -i 's|https://code.visualstudio.com/docs/setup/linux|https://github.com/ornate-source/blackIDE#download-install|' resources/linux/debian/control.template
  sed -i 's|https://code.visualstudio.com|https://github.com/ornate-source/blackIDE|' resources/linux/debian/control.template

  # code.spec.template
  sed -i 's|Microsoft Corporation|Black IDE Team|' resources/linux/rpm/code.spec.template
  sed -i 's|Visual Studio Code Team <vscode-linux@microsoft.com>|Black IDE Team https://github.com/ornate-source/blackIDE/graphs/contributors|' resources/linux/rpm/code.spec.template
  sed -i 's|Visual Studio Code|Black IDE|' resources/linux/rpm/code.spec.template
  sed -i 's|https://code.visualstudio.com/docs/setup/linux|https://github.com/ornate-source/blackIDE#download-install|' resources/linux/rpm/code.spec.template
  sed -i 's|https://code.visualstudio.com|https://github.com/ornate-source/blackIDE|' resources/linux/rpm/code.spec.template

  # snapcraft.yaml
  sed -i 's|Visual Studio Code|Black IDE|' resources/linux/rpm/code.spec.template
elif [[ "${OS_NAME}" == "windows" ]]; then
  # code.iss
  sed -i 's|https://code.visualstudio.com|https://github.com/ornate-source/blackIDE|' build/win32/code.iss
  sed -i 's|Microsoft Corporation|Black IDE|' build/win32/code.iss
fi

cd "${PROJECT_ROOT}"
