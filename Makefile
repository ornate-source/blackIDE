.PHONY: build build-mac build-linux build-windows dev icons prepare-assets release clean help ci-lint ci-lint-fix ci-update

PROJECT_ROOT := $(shell pwd)

build:
	./scripts/build/build.sh

build-mac:
	./scripts/build/build_mac.sh

build-linux:
	./scripts/build/build_linux.sh

build-windows:
	./scripts/build/build_windows.sh

dev:
	./scripts/dev/build.sh

icons:
	./scripts/build/build_icons.sh

prepare-assets:
	./scripts/prepare/prepare_assets.sh

release:
	./scripts/release/release.sh

clean:
	rm -rf vscode* VSCode* assets/ sourcemaps/

ci-lint:
	zizmor .

ci-lint-fix:
	zizmor . --fix=all

ci-update:
	PINACT_MIN_AGE=7 pinact run --update

help:
	@echo "BlackIDE Build System"
	@echo "====================="
	@echo "  make build          - Core build (requires OS_NAME, VSCODE_ARCH)"
	@echo "  make build-mac      - Local macOS build"
	@echo "  make build-linux    - Local Linux build"
	@echo "  make build-windows  - Local Windows build"
	@echo "  make dev            - Developer build (get repo + build)"
	@echo "  make icons          - Generate icons"
	@echo "  make prepare-assets - Package build artifacts"
	@echo "  make release        - Upload to GitHub Release"
	@echo "  make ci-lint        - Lint workflow files with zizmor"
	@echo "  make ci-lint-fix    - Automatically fix zizmor lint findings"
	@echo "  make ci-update      - Update GitHub action versions with pinact"
	@echo "  make clean          - Remove all build artifacts"

