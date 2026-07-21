#!/usr/bin/env bash
# shellcheck disable=SC1091,SC2129

### Windows
# to run with Bash: "C:\Program Files\Git\bin\bash.exe" ./scripts/dev/build.sh
###

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

export APP_NAME="Black IDE"
export ASSETS_REPOSITORY="ornate-source/blackIDE"
export BINARY_NAME="black-ide"
export CI_BUILD="no"
export GH_REPO_PATH="ornate-source/blackIDE"
export ORG_NAME="ornate-source"
export SHOULD_BUILD="yes"
export SKIP_ASSETS="yes"
export SKIP_BUILD="no"
export SKIP_SOURCE="no"
export VSCODE_LATEST="no"
export VSCODE_QUALITY="stable"
export VSCODE_SKIP_NODE_VERSION_CHECK="yes"

while getopts ":ilops" opt; do
  case "$opt" in
    i)
      export ASSETS_REPOSITORY="ornate-source/blackIDE-insiders"
      export BINARY_NAME="black-ide-insiders"
      export VSCODE_QUALITY="insider"
      ;;
    l)
      export VSCODE_LATEST="yes"
      ;;
    o)
      export SKIP_BUILD="yes"
      ;;
    p)
      export SKIP_ASSETS="no"
      ;;
    s)
      export SKIP_SOURCE="yes"
      ;;
    *)
      ;;
  esac
done

case "${OSTYPE}" in
  darwin*)
    export OS_NAME="osx"
    ;;
  msys* | cygwin*)
    export OS_NAME="windows"
    ;;
  *)
    export OS_NAME="linux"
    ;;
esac

UNAME_ARCH=$( uname -m )

if [[ "${UNAME_ARCH}" == "aarch64" || "${UNAME_ARCH}" == "arm64" ]]; then
  export VSCODE_ARCH="arm64"
elif [[ "${UNAME_ARCH}" == "ppc64le" ]]; then
  export VSCODE_ARCH="ppc64le"
elif [[ "${UNAME_ARCH}" == "riscv64" ]]; then
  export VSCODE_ARCH="riscv64"
elif [[ "${UNAME_ARCH}" == "loongarch64" ]]; then
  export VSCODE_ARCH="loong64"
elif [[ "${UNAME_ARCH}" == "s390x" ]]; then
  export VSCODE_ARCH="s390x"
else
  export VSCODE_ARCH="x64"
fi

export NODE_OPTIONS="--max-old-space-size=8192"

echo "OS_NAME=\"${OS_NAME}\""
echo "SKIP_SOURCE=\"${SKIP_SOURCE}\""
echo "SKIP_BUILD=\"${SKIP_BUILD}\""
echo "SKIP_ASSETS=\"${SKIP_ASSETS}\""
echo "VSCODE_ARCH=\"${VSCODE_ARCH}\""
echo "VSCODE_LATEST=\"${VSCODE_LATEST}\""
echo "VSCODE_QUALITY=\"${VSCODE_QUALITY}\""

if [[ "${SKIP_SOURCE}" == "no" ]]; then
  rm -rf "${PROJECT_ROOT}"/vscode* "${PROJECT_ROOT}"/VSCode*

  . "${PROJECT_ROOT}/scripts/ci/get_repo.sh"
  . "${PROJECT_ROOT}/scripts/lib/version.sh"

  # save variables for later
  echo "MS_TAG=\"${MS_TAG}\"" > "${PROJECT_ROOT}/scripts/dev/build.env"
  echo "MS_COMMIT=\"${MS_COMMIT}\"" >> "${PROJECT_ROOT}/scripts/dev/build.env"
  echo "RELEASE_VERSION=\"${RELEASE_VERSION}\"" >> "${PROJECT_ROOT}/scripts/dev/build.env"
  echo "BUILD_SOURCEVERSION=\"${BUILD_SOURCEVERSION}\"" >> "${PROJECT_ROOT}/scripts/dev/build.env"
else
  if [[ "${SKIP_ASSETS}" != "no" ]]; then
    rm -rf "${PROJECT_ROOT}"/vscode-* "${PROJECT_ROOT}"/VSCode-*
  fi

  . "${PROJECT_ROOT}/scripts/dev/build.env"

  echo "MS_TAG=\"${MS_TAG}\""
  echo "MS_COMMIT=\"${MS_COMMIT}\""
  echo "RELEASE_VERSION=\"${RELEASE_VERSION}\""
  echo "BUILD_SOURCEVERSION=\"${BUILD_SOURCEVERSION}\""
fi

if [[ "${SKIP_BUILD}" == "no" ]]; then
  if [[ "${SKIP_SOURCE}" != "no" ]]; then
    cd "${PROJECT_ROOT}/vscode" || { echo "'vscode' dir not found"; exit 1; }

    git add .
    git reset -q --hard HEAD

    while [[ -n "$( git log -1 | grep "VSCODIUM HELPER" )" ]]; do
      git reset -q --hard HEAD~
    done

    rm -rf .build out*

    cd "${PROJECT_ROOT}"
  fi

  if [[ -f "${PROJECT_ROOT}/include_${OS_NAME}.gypi" ]]; then
    echo "Installing custom ~/.gyp/include.gypi"

    mkdir -p ~/.gyp

    if [[ -f "${HOME}/.gyp/include.gypi" ]]; then
      mv ~/.gyp/include.gypi ~/.gyp/include.gypi.pre-black-ide
    else
      echo "{}" > ~/.gyp/include.gypi.pre-black-ide
    fi

    cp "${PROJECT_ROOT}/scripts/build/packages/osx/include.gypi" ~/.gyp/include.gypi
  fi

  . "${PROJECT_ROOT}/scripts/build/build.sh"

  if [[ -f "${PROJECT_ROOT}/include_${OS_NAME}.gypi" ]]; then
    mv ~/.gyp/include.gypi.pre-black-ide ~/.gyp/include.gypi
  fi

  if [[ "${VSCODE_LATEST}" == "yes" ]]; then
    jsonTmp=$( cat "${PROJECT_ROOT}/config/upstream/${VSCODE_QUALITY}.json" | jq --arg 'tag' "${MS_TAG/\-insider/}" --arg 'commit' "${MS_COMMIT}" '. | .tag=$tag | .commit=$commit' )
    echo "${jsonTmp}" > "${PROJECT_ROOT}/config/upstream/${VSCODE_QUALITY}.json" && unset jsonTmp
  fi
fi

if [[ "${SKIP_ASSETS}" == "no" ]]; then
  if [[ "${OS_NAME}" == "windows" ]]; then
    rm -rf "${PROJECT_ROOT}/scripts/build/packages/windows/msi/releasedir"
  fi

  if [[ "${OS_NAME}" == "osx" && -f "${PROJECT_ROOT}/scripts/dev/osx/codesign.env" ]]; then
    . "${PROJECT_ROOT}/scripts/dev/osx/codesign.env"

    echo "CERTIFICATE_OSX_APPLE_ID: ${CERTIFICATE_OSX_APPLE_ID}"
  fi

  . "${PROJECT_ROOT}/scripts/prepare/prepare_assets.sh"
fi
