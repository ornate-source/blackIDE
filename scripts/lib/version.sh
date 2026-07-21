#!/usr/bin/env bash

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ -z "${RELEASE_VERSION}" ]]; then
  QUALITY="${VSCODE_QUALITY:-stable}"
  UPSTREAM_JSON="${PROJECT_ROOT}/config/upstream/${QUALITY}.json"
  if [[ -f "${UPSTREAM_JSON}" ]]; then
    MS_TAG=$( jq -r '.tag' "${UPSTREAM_JSON}" )
    if [[ "${QUALITY}" == "insider" ]]; then
      RELEASE_VERSION="${MS_TAG}-insider"
    else
      RELEASE_VERSION="${MS_TAG}"
    fi
  else
    RELEASE_VERSION="1.90.0"
  fi
  export RELEASE_VERSION
  echo "RELEASE_VERSION not set in environment. Determined fallback: ${RELEASE_VERSION}"
fi

if [[ -z "${BUILD_SOURCEVERSION}" ]]; then

    if type -t "sha1sum" &> /dev/null; then
      BUILD_SOURCEVERSION=$( echo "${RELEASE_VERSION/-*/}" | sha1sum | cut -d' ' -f1 )
    else
      npm install -g checksum

      BUILD_SOURCEVERSION=$( echo "${RELEASE_VERSION/-*/}" | checksum )
    fi

    echo "BUILD_SOURCEVERSION=\"${BUILD_SOURCEVERSION}\""

    # for GH actions
    if [[ "${GITHUB_ENV}" ]]; then
        echo "BUILD_SOURCEVERSION=${BUILD_SOURCEVERSION}" >> "${GITHUB_ENV}"
    fi
fi

export BUILD_SOURCEVERSION