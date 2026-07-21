#!/usr/bin/env bash

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

npm install -g checksum

sum_file() {
  if [[ -f "${1}" ]]; then
    echo "Calculating checksum for ${1}"
    checksum -a sha256 "${1}" > "${1}".sha256
    checksum "${1}" > "${1}".sha1
  fi
}

cd "${PROJECT_ROOT}/assets"

for FILE in *; do
  if [[ -f "${FILE}" ]]; then
    sum_file "${FILE}"
  fi
done

cd "${PROJECT_ROOT}"
