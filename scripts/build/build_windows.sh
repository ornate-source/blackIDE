#!/usr/bin/env bash
set -ex

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

export OS_NAME="windows"
export VSCODE_ARCH="${VSCODE_ARCH:-x64}"
export SHOULD_BUILD="yes"
export SHOULD_BUILD_REH="no"
export SHOULD_BUILD_REH_WEB="no"
export CI_BUILD="no"
export APP_NAME="Black IDE"
export BINARY_NAME="black-ide"

. "${PROJECT_ROOT}/scripts/lib/version.sh"

echo "MS_COMMIT=\"${MS_COMMIT}\""

. "${PROJECT_ROOT}/scripts/prepare/prepare_vscode.sh"

cd "${PROJECT_ROOT}/vscode" || { echo "'vscode' dir not found"; exit 1; }

export NODE_OPTIONS="--max-old-space-size=8192"
export VSCODE_PUBLISH_COUNTER=1

npm run gulp vscode-min-prepack

. "${PROJECT_ROOT}/scripts/build/packages/windows/rtf/make.sh"

# generate Group Policy definitions
npm run copy-policy-dto --prefix build
node build/lib/policies/policyGenerator.ts build/lib/policies/policyData.jsonc win32

npm run gulp "vscode-win32-${VSCODE_ARCH}-min-packing"

. "${PROJECT_ROOT}/scripts/build/build_cli.sh"

cd "${PROJECT_ROOT}"
