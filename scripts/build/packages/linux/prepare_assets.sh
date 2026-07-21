#!/usr/bin/env bash

cd vscode || { echo "'vscode' dir not found"; exit 1; }

if [[ -z "${VSCODE_SYSROOT_REPOSITORY}" ]]; then
  unset VSCODE_SYSROOT_REPOSITORY
fi

if [[ -z "${VSCODE_SYSROOT_VERSION}" ]]; then
  unset VSCODE_SYSROOT_VERSION
fi

if [[ -z "${VSCODE_SYSROOT_PREFIX}" ]]; then
  unset VSCODE_SYSROOT_PREFIX
fi

if [[ "${SHOULD_BUILD_APPIMAGE}" != "no" && "${VSCODE_ARCH}" != "x64" ]]; then
  SHOULD_BUILD_APPIMAGE="no"
fi

if [[ "${SHOULD_BUILD_DEB}" != "no" || "${SHOULD_BUILD_APPIMAGE}" != "no" ]]; then
  npm run gulp "vscode-linux-${VSCODE_ARCH}-prepare-deb"
  npm run gulp "vscode-linux-${VSCODE_ARCH}-build-deb"
fi

if [[ "${SHOULD_BUILD_RPM}" != "no" ]]; then
  npm run gulp "vscode-linux-${VSCODE_ARCH}-prepare-rpm"
  npm run gulp "vscode-linux-${VSCODE_ARCH}-build-rpm"
fi

if [[ "${SHOULD_BUILD_APPIMAGE}" != "no" ]]; then
  . ../scripts/build/packages/linux/appimage/build.sh
fi

cd ..

if [[ "${CI_BUILD}" == "no" ]]; then
  . ./config/stores/snapcraft/build.sh

  if [[ "${SKIP_ASSETS}" == "no" ]]; then
    mv config/stores/snapcraft/build/*.snap assets/
  fi
fi

if [[ "${SHOULD_BUILD_TAR}" != "no" ]]; then
  echo "Building and moving TAR"
  cd "VSCode-linux-${VSCODE_ARCH}"
  tar czf "../assets/${APP_NAME}-linux-${VSCODE_ARCH}-${RELEASE_VERSION}.tar.gz" .
  cd ..
fi

if [[ "${SHOULD_BUILD_DEB}" != "no" ]]; then
  echo "Moving DEB"
  mv vscode/.build/linux/deb/*/deb/*.deb assets/
fi

if [[ "${SHOULD_BUILD_RPM}" != "no" ]]; then
  echo "Moving RPM"
  mv vscode/.build/linux/rpm/*/*.rpm assets/
fi

if [[ "${SHOULD_BUILD_APPIMAGE}" != "no" ]]; then
  echo "Moving AppImage"
  if ls scripts/build/packages/linux/appimage/*${APP_NAME// /*}*.AppImage* >/dev/null 2>&1; then
    mv scripts/build/packages/linux/appimage/*${APP_NAME// /*}*.AppImage* assets/
  elif ls scripts/build/packages/linux/appimage/out/*${APP_NAME// /*}*.AppImage* >/dev/null 2>&1; then
    mv scripts/build/packages/linux/appimage/out/*${APP_NAME// /*}*.AppImage* assets/
  else
    echo "No AppImage found in scripts/build/packages/linux/appimage/ or its out/ directory!"
    echo "Directory listing of scripts/build/packages/linux/appimage/:"
    ls -la scripts/build/packages/linux/appimage/
    if [ -d scripts/build/packages/linux/appimage/out ]; then
      echo "Directory listing of scripts/build/packages/linux/appimage/out/:"
      ls -la scripts/build/packages/linux/appimage/out/
    fi
    exit 1
  fi

  find assets -name '*.AppImage*' -exec bash -c 'mv $0 ${0/_-_/-}' {} \;
fi
