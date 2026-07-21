#!/usr/bin/env bash
set -ex

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ -f "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
  nvm use || nvm use $(cat "${PROJECT_ROOT}/config/.nvmrc") || true
fi

export OS_NAME="osx"
export VSCODE_ARCH="${VSCODE_ARCH:-arm64}" # Default to Apple Silicon arm64
export SHOULD_BUILD="yes"
export SHOULD_BUILD_REH="no"
export SHOULD_BUILD_REH_WEB="no"
export CI_BUILD="no"
export APP_NAME="Black IDE"
export BINARY_NAME="black-ide"

rm -rf "${PROJECT_ROOT}/assets"

. "${PROJECT_ROOT}/scripts/lib/version.sh"

echo "MS_COMMIT=\"${MS_COMMIT}\""

if [[ -z "${GITHUB_TOKEN}" ]] && command -v gh &> /dev/null; then
  export GITHUB_TOKEN=$(gh auth token 2>/dev/null)
fi


. "${PROJECT_ROOT}/scripts/prepare/prepare_vscode.sh"

cd "${PROJECT_ROOT}/vscode" || { echo "'vscode' dir not found"; exit 1; }

export NODE_OPTIONS="--max-old-space-size=8192"
export VSCODE_PUBLISH_COUNTER=1

npm run gulp vscode-min-prepack

# remove win32 node modules
rm -f .build/extensions/ms-vscode.js-debug/src/win32-app-container-tokens.*.node

# generate Group Policy definitions
npm run copy-policy-dto --prefix build
node build/lib/policies/policyGenerator.ts build/lib/policies/policyData.jsonc darwin

npm run gulp "vscode-darwin-${VSCODE_ARCH}-min-packing"

find "${PROJECT_ROOT}/VSCode-darwin-${VSCODE_ARCH}" -print0 | xargs -0 touch -c

. "${PROJECT_ROOT}/scripts/build/build_cli.sh"

cd "${PROJECT_ROOT}"

if [[ "${CI_BUILD}" == "no" ]]; then
  "${PROJECT_ROOT}/scripts/prepare/prepare_assets.sh"

  if command -v gh &> /dev/null; then
    echo "Publishing built assets to the latest release on GitHub..."
    LATEST_TAG=$(gh release view --json tagName --jq .tagName)
    if [[ -n "${LATEST_TAG}" ]]; then
      echo "Latest release tag found: ${LATEST_TAG}"
      
      # Find all files in assets directory, excluding checksum files
      FILES_TO_UPLOAD=()
      while IFS= read -r -d '' file; do
        if [[ "${file}" != *.sha1 && "${file}" != *.sha256 ]]; then
          FILES_TO_UPLOAD+=("$file")
        fi
      done < <(find "${PROJECT_ROOT}/assets" -maxdepth 1 -type f -print0)
      
      if [[ ${#FILES_TO_UPLOAD[@]} -gt 0 ]]; then
        echo "Uploading files: ${FILES_TO_UPLOAD[*]}"
        gh release upload "${LATEST_TAG}" "${FILES_TO_UPLOAD[@]}" --clobber
      else
        echo "No assets found in ${PROJECT_ROOT}/assets to upload."
      fi
    else
      echo "Error: Could not determine latest release tag on GitHub."
    fi
  else
    echo "Warning: GitHub CLI (gh) not found. Skipping automatic upload."
  fi
fi
