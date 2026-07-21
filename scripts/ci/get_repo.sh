#!/usr/bin/env bash
# shellcheck disable=SC2129

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

export VSCODE_QUALITY="${VSCODE_QUALITY:-stable}"

# git workaround
if [[ "${CI_BUILD}" != "no" ]]; then
  git config --global --add safe.directory "/__w/$( echo "${GITHUB_REPOSITORY}" | awk '{print tolower($0)}' )"
fi

if [[ -z "${RELEASE_VERSION}" ]]; then
  if [[ "${VSCODE_LATEST}" == "yes" ]] || [[ ! -f "${PROJECT_ROOT}/config/upstream/${VSCODE_QUALITY}.json" ]]; then
    echo "Retrieve lastest version"
    UPDATE_INFO=$( curl --silent --fail "https://update.code.visualstudio.com/api/update/darwin/${VSCODE_QUALITY}/0000000000000000000000000000000000000000" )
  else
    echo "Get version from ${VSCODE_QUALITY}.json"
    MS_COMMIT=$( jq -r '.commit' "${PROJECT_ROOT}/config/upstream/${VSCODE_QUALITY}.json" )
    MS_TAG=$( jq -r '.tag' "${PROJECT_ROOT}/config/upstream/${VSCODE_QUALITY}.json" )
  fi

  if [[ -z "${MS_COMMIT}" ]]; then
    MS_COMMIT=$( echo "${UPDATE_INFO}" | jq -r '.version' )
    MS_TAG=$( echo "${UPDATE_INFO}" | jq -r '.name' )

    if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
      MS_TAG="${MS_TAG/\-insider/}"
    fi
  fi

  TIME_PATCH=$( printf "%04d" $(($(date +%-j) * 24 + $(date +%-H))) )
  SUFFIX="${TIME_PATCH}"

  if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
    REPO_LATEST_TAG=$( git ls-remote --tags origin 2>/dev/null | grep -o "refs/tags/${MS_TAG}[0-9]*-insider" | cut -d'/' -f3 | sort -V | tail -n1 || echo "" )
  else
    REPO_LATEST_TAG=$( git ls-remote --tags origin 2>/dev/null | grep -o "refs/tags/${MS_TAG}[0-9]*" | grep -v "\-insider" | cut -d'/' -f3 | sort -V | tail -n1 || echo "" )
  fi

  if [[ -n "${REPO_LATEST_TAG}" ]]; then
    LATEST_TAG_NO_QUALITY="${REPO_LATEST_TAG/-insider/}"
    pattern="^${MS_TAG}([0-9]+)$"
    if [[ "${LATEST_TAG_NO_QUALITY}" =~ ${pattern} ]]; then
      PREV_SUFFIX="${BASH_REMATCH[1]}"
      PREV_NUM=$(( 10#${PREV_SUFFIX} ))
      CURR_NUM=$(( 10#${SUFFIX} ))
      if (( CURR_NUM <= PREV_NUM )); then
        NEXT_NUM=$(( PREV_NUM + 1 ))
        SUFFIX=$( printf "%0${#PREV_SUFFIX}d" "${NEXT_NUM}" )
      fi
    fi
  fi

  if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
    RELEASE_VERSION="${MS_TAG}${SUFFIX}-insider"
  else
    RELEASE_VERSION="${MS_TAG}${SUFFIX}"
  fi
else
  if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
    if [[ "${RELEASE_VERSION}" =~ ^([0-9]+\.[0-9]+\.[0-5])[0-9]*-insider$ ]];
    then
      MS_TAG="${BASH_REMATCH[1]}"
    else
      echo "Error: Bad RELEASE_VERSION: ${RELEASE_VERSION}"
      exit 1
    fi
  else
    if [[ "${RELEASE_VERSION}" =~ ^([0-9]+\.[0-9]+\.[0-5])[0-9]*$ ]];
    then
      MS_TAG="${BASH_REMATCH[1]}"
    else
      echo "Error: Bad RELEASE_VERSION: ${RELEASE_VERSION}"
      exit 1
    fi
  fi

  if [[ "${MS_TAG}" == "$( jq -r '.tag' "${PROJECT_ROOT}/config/upstream/${VSCODE_QUALITY}.json" )" ]]; then
    MS_COMMIT=$( jq -r '.commit' "${PROJECT_ROOT}/config/upstream/${VSCODE_QUALITY}.json" )
  else
    echo "Error: No MS_COMMIT for ${RELEASE_VERSION}"
    exit 1
  fi
fi

echo "RELEASE_VERSION=\"${RELEASE_VERSION}\""

mkdir -p "${PROJECT_ROOT}/vscode"
cd "${PROJECT_ROOT}/vscode" || { echo "'vscode' dir not found"; exit 1; }

git init -q
git remote add origin https://github.com/Microsoft/vscode.git

# figure out latest tag by calling MS update API
if [[ -z "${MS_TAG}" ]]; then
  UPDATE_INFO=$( curl --silent --fail "https://update.code.visualstudio.com/api/update/darwin/${VSCODE_QUALITY}/0000000000000000000000000000000000000000" )
  MS_COMMIT=$( echo "${UPDATE_INFO}" | jq -r '.version' )
  MS_TAG=$( echo "${UPDATE_INFO}" | jq -r '.name' )
elif [[ -z "${MS_COMMIT}" ]]; then
  REFERENCE=$( git ls-remote --tags | grep -x ".*refs\/tags\/${MS_TAG}" | head -1 )

  if [[ -z "${REFERENCE}" ]]; then
    echo "Error: The following tag can't be found: ${MS_TAG}"
    exit 1
  elif [[ "${REFERENCE}" =~ ^([[:alnum:]]+)[[:space:]]+refs\/tags\/([0-9]+\.[0-9]+\.[0-5])$ ]]; then
    MS_COMMIT="${BASH_REMATCH[1]}"
    MS_TAG="${BASH_REMATCH[2]}"
  else
    echo "Error: The following reference can't be parsed: ${REFERENCE}"
    exit 1
  fi
fi

echo "MS_TAG=\"${MS_TAG}\""
echo "MS_COMMIT=\"${MS_COMMIT}\""

git fetch --depth 1 origin "${MS_COMMIT}"
git checkout FETCH_HEAD

cd "${PROJECT_ROOT}"

# for GH actions
if [[ "${GITHUB_ENV}" ]]; then
  echo "MS_TAG=${MS_TAG}" >> "${GITHUB_ENV}"
  echo "MS_COMMIT=${MS_COMMIT}" >> "${GITHUB_ENV}"
  echo "RELEASE_VERSION=${RELEASE_VERSION}" >> "${GITHUB_ENV}"
fi

export MS_TAG
export MS_COMMIT
export RELEASE_VERSION
