#!/usr/bin/env bash

set -e

PUBLISHER_LETTER=$(echo "${APP_IDENTIFIER:0:1}" | tr '[:upper:]' '[:lower:]')
VERSIONS=$( curl --silent "https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/${PUBLISHER_LETTER}/${APP_IDENTIFIER//.//}" )

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  RELEASE_VERSION="${RELEASE_VERSION/\-insider/}"
fi

WINGET_VERSION=$( echo "${VERSIONS}" | jq -r 'if type == "array" then map(select(.name | startswith("1."))) | map(.name) | last // empty else empty end' )

echo "RELEASE_VERSION=\"${RELEASE_VERSION}\""
echo "WINGET_VERSION=\"${WINGET_VERSION}\""

if [[ -z "${WINGET_VERSION}" ]]; then
  echo "Package ${APP_IDENTIFIER} not found in winget-pkgs. Skipping deployment (manual initial submission required)."
  export SHOULD_DEPLOY="no"
elif [[ "${RELEASE_VERSION}" == "${WINGET_VERSION}" ]]; then
  export SHOULD_DEPLOY="no"
else
  export SHOULD_DEPLOY="yes"
fi

if [[ "${GITHUB_ENV}" ]]; then
  echo "RELEASE_VERSION=${RELEASE_VERSION}" >> "${GITHUB_ENV}"
	echo "SHOULD_DEPLOY=${SHOULD_DEPLOY}" >> "${GITHUB_ENV}"
fi
