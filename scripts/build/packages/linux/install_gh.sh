#!/usr/bin/env bash

set -ex

GH_ARCH="amd64"
if [[ "$(uname -m)" == "aarch64" || "$(uname -m)" == "arm64" ]]; then
  GH_ARCH="arm64"
fi

for i in {1..5}; do
  TAG=""

  # Method 1: Use GITHUB_TOKEN if available to avoid rate limiting
  if [[ -n "${GITHUB_TOKEN}" ]]; then
    TAG=$( curl -H "Authorization: Bearer ${GITHUB_TOKEN}" --retry 12 --retry-delay 30 -sSL "https://api.github.com/repos/cli/cli/releases/latest" 2>/dev/null | jq --raw-output '.tag_name' )
  fi

  # Method 2: If TAG is still empty or null, try getting it via redirect to avoid rate limiting
  if [[ -z "${TAG}" || "${TAG}" == "null" ]]; then
    URL=$( curl -Ls -o /dev/null -w "%{url_effective}" "https://github.com/cli/cli/releases/latest" )
    if [[ "${URL}" == */tag/* ]]; then
      TAG="${URL##*/}"
    fi
  fi

  # Method 3: Fallback to unauthenticated API request
  if [[ -z "${TAG}" || "${TAG}" == "null" ]]; then
    TAG=$( curl --retry 12 --retry-delay 30 -sSL "https://api.github.com/repos/cli/cli/releases/latest" 2>/dev/null | jq --raw-output '.tag_name' )
  fi

  if [[ -n "${TAG}" && "${TAG}" != "null" ]]; then
    break
  fi

  if [[ $i == 5 ]]; then
    echo "GH install failed too many times" >&2
    exit 1
  fi

  echo "GH install failed $i, trying again..."

  sleep $(( 15 * (i + 1)))
done

VERSION="${TAG#v}"

curl --retry 12 --retry-delay 120 -sSL "https://github.com/cli/cli/releases/download/${TAG}/gh_${VERSION}_linux_${GH_ARCH}.tar.gz" -o "gh_${VERSION}_linux_${GH_ARCH}.tar.gz"

tar xf "gh_${VERSION}_linux_${GH_ARCH}.tar.gz"

cp "gh_${VERSION}_linux_${GH_ARCH}/bin/gh" /usr/local/bin/

gh --version
