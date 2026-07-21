#!/usr/bin/env bash
# shellcheck disable=SC1091

set -ex

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ -z "${GH_TOKEN}" ]] && [[ -z "${GITHUB_TOKEN}" ]] && [[ -z "${GH_ENTERPRISE_TOKEN}" ]] && [[ -z "${GITHUB_ENTERPRISE_TOKEN}" ]]; then
  echo "Will not release because no GITHUB_TOKEN defined"
  exit
fi


. "${PROJECT_ROOT}/scripts/lib/utils.sh"

# Ensure release_notes.md template is copied to the root before making replacements
cp "${PROJECT_ROOT}/docs/release_notes.md" "${PROJECT_ROOT}/release_notes.md"

APP_NAME_LC="$( echo "${APP_NAME}" | awk '{print tolower($0)}' | tr ' ' '-' )"
VERSION="${RELEASE_VERSION%-insider}"

if [[ $( gh release view "${RELEASE_VERSION}" --repo "${ASSETS_REPOSITORY}" 2>&1 ) =~ "release not found" ]]; then
  echo "Creating release '${RELEASE_VERSION}'"
  IS_NEW_RELEASE="yes"
else
  echo "Release '${RELEASE_VERSION}' already exists. Updating release notes."
  IS_NEW_RELEASE="no"
fi

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  NOTES="update vscode to [${MS_COMMIT}](https://github.com/microsoft/vscode/tree/${MS_COMMIT})"

  replace "s|@@APP_NAME@@|${APP_NAME}|g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@APP_NAME_LC@@|${APP_NAME_LC}|g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@APP_NAME_QUALITY@@|${APP_NAME}-Insiders|g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@ASSETS_REPOSITORY@@|${ASSETS_REPOSITORY}|g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@BINARY_NAME@@|${BINARY_NAME}|g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@MS_TAG@@|${MS_COMMIT}|g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@MS_URL@@|https://github.com/microsoft/vscode/tree/${MS_COMMIT}|g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@QUALITY@@|-insider|g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@RELEASE_NOTES@@||g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@VERSION@@|${VERSION}|g" "${PROJECT_ROOT}/release_notes.md"

  if [[ "${IS_NEW_RELEASE}" == "yes" ]]; then
    gh release create "${RELEASE_VERSION}" --repo "${ASSETS_REPOSITORY}" --title "${RELEASE_VERSION}" --notes-file "${PROJECT_ROOT}/release_notes.md"
  else
    gh release edit "${RELEASE_VERSION}" --repo "${ASSETS_REPOSITORY}" --notes-file "${PROJECT_ROOT}/release_notes.md"
  fi
else
  replace "s|@@APP_NAME@@|${APP_NAME}|g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@APP_NAME_LC@@|${APP_NAME_LC}|g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@APP_NAME_QUALITY@@|${APP_NAME}|g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@ASSETS_REPOSITORY@@|${ASSETS_REPOSITORY}|g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@BINARY_NAME@@|${BINARY_NAME}|g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@MS_TAG@@|${MS_TAG}|g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@MS_URL@@|https://code.visualstudio.com/updates/v$( echo "${MS_TAG//./_}" | cut -d'_' -f 1,2 )|g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@QUALITY@@||g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@RELEASE_NOTES@@||g" "${PROJECT_ROOT}/release_notes.md"
  replace "s|@@VERSION@@|${VERSION}|g" "${PROJECT_ROOT}/release_notes.md"

  if [[ "${IS_NEW_RELEASE}" == "yes" ]]; then
    gh release create "${RELEASE_VERSION}" --repo "${ASSETS_REPOSITORY}" --title "${RELEASE_VERSION}" --notes-file "${PROJECT_ROOT}/release_notes.md"
  else
    gh release edit "${RELEASE_VERSION}" --repo "${ASSETS_REPOSITORY}" --notes-file "${PROJECT_ROOT}/release_notes.md"
  fi
fi

cd assets

set +e

for FILE in *; do
  if [[ -f "${FILE}" ]]; then
    # Skip checksums, CLI, REH, and utility packages
    if [[ "${FILE}" == *.sha1 ]] || [[ "${FILE}" == *.sha256 ]]; then
      continue
    fi
    if [[ "${FILE}" == *"-cli-"* ]] || [[ "${FILE}" == *"-reh-"* ]] || [[ "${FILE}" == *"-reh-web-"* ]] || [[ "${FILE}" == "pkg2appimage.AppImage" ]]; then
      continue
    fi

    echo "::group::Uploading '${FILE}' at $( date "+%T" )"
    # Use --clobber to overwrite existing assets (GitHub converts spaces to dots
    # in asset names, which caused github-release delete to fail matching them)
    gh release upload --repo "${ASSETS_REPOSITORY}" "${RELEASE_VERSION}" "${FILE}" --clobber

    EXIT_STATUS=$?
    echo "exit: ${EXIT_STATUS}"

    if (( "${EXIT_STATUS}" )); then
      for (( i=0; i<10; i++ )); do
        sleep $(( 15 * (i + 1)))

        echo "RE-Uploading '${FILE}' at $( date "+%T" )"
        gh release upload --repo "${ASSETS_REPOSITORY}" "${RELEASE_VERSION}" "${FILE}" --clobber

        EXIT_STATUS=$?
        echo "exit: ${EXIT_STATUS}"

        if ! (( "${EXIT_STATUS}" )); then
          break
        fi
      done
      echo "exit: ${EXIT_STATUS}"

      if (( "${EXIT_STATUS}" )); then
        echo "'${FILE}' hasn't been uploaded!"

        exit 1
      fi
    fi

    echo "::endgroup::"
  fi
done

cd ..
