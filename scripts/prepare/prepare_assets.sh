#!/usr/bin/env bash
# shellcheck disable=SC1091

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

APP_NAME_LC="$( echo "${APP_NAME}" | awk '{print tolower($0)}' | tr ' ' '-' )"

mkdir -p "${PROJECT_ROOT}/assets"

if [[ "${OS_NAME}" == "osx" ]]; then
  . "${PROJECT_ROOT}/scripts/build/packages/osx/prepare_assets.sh"

  VSCODE_PLATFORM="darwin"
elif [[ "${OS_NAME}" == "windows" ]]; then
  . "${PROJECT_ROOT}/scripts/build/packages/windows/prepare_assets.sh"

  VSCODE_PLATFORM="win32"
else
  . "${PROJECT_ROOT}/scripts/build/packages/linux/prepare_assets.sh"

  VSCODE_PLATFORM="linux"
fi

if [[ "${SHOULD_BUILD_REH}" != "no" ]]; then
  echo "Building and moving REH"
  cd "${PROJECT_ROOT}/vscode-reh-${VSCODE_PLATFORM}-${VSCODE_ARCH}"
  tar czf "${PROJECT_ROOT}/assets/${APP_NAME_LC}-reh-${VSCODE_PLATFORM}-${VSCODE_ARCH}-${RELEASE_VERSION}.tar.gz" .
  cd "${PROJECT_ROOT}"
fi

if [[ "${SHOULD_BUILD_REH_WEB}" != "no" ]]; then
  echo "Building and moving REH-web"
  cd "${PROJECT_ROOT}/vscode-reh-web-${VSCODE_PLATFORM}-${VSCODE_ARCH}"
  tar czf "${PROJECT_ROOT}/assets/${APP_NAME_LC}-reh-web-${VSCODE_PLATFORM}-${VSCODE_ARCH}-${RELEASE_VERSION}.tar.gz" .
  cd "${PROJECT_ROOT}"
fi

set -ex

if [[ "${SHOULD_BUILD_CLI}" != "no" ]]; then
  echo "Building and moving CLI"

  APPLICATION_NAME="$( node -p "require(\"${PROJECT_ROOT}/vscode/product.json\").applicationName" )"
  NAME_SHORT="$( node -p "require(\"${PROJECT_ROOT}/vscode/product.json\").nameShort" )"
  TUNNEL_APPLICATION_NAME="$( node -p "require(\"${PROJECT_ROOT}/vscode/product.json\").tunnelApplicationName" )"

  mkdir -p "${PROJECT_ROOT}/vscode-cli"

  cd "${PROJECT_ROOT}/vscode-cli"

  if [[ "${OS_NAME}" == "osx" ]]; then
    cp "${PROJECT_ROOT}/VSCode-${VSCODE_PLATFORM}-${VSCODE_ARCH}/${NAME_SHORT}.app/Contents/Resources/app/bin/${TUNNEL_APPLICATION_NAME}" "${APPLICATION_NAME}"
  elif [[ "${OS_NAME}" == "windows" ]]; then
    cp "${PROJECT_ROOT}/VSCode-${VSCODE_PLATFORM}-${VSCODE_ARCH}/bin/${TUNNEL_APPLICATION_NAME}.exe" "${APPLICATION_NAME}.exe"
  else
    cp "${PROJECT_ROOT}/VSCode-${VSCODE_PLATFORM}-${VSCODE_ARCH}/bin/${TUNNEL_APPLICATION_NAME}" "${APPLICATION_NAME}"
  fi

  tar czf "${PROJECT_ROOT}/assets/${APP_NAME_LC}-cli-${VSCODE_PLATFORM}-${VSCODE_ARCH}-${RELEASE_VERSION}.tar.gz" .

  cd "${PROJECT_ROOT}"
fi

if [[ "${OS_NAME}" != "windows" ]]; then
  "${PROJECT_ROOT}/scripts/prepare/prepare_checksums.sh"
fi
