#!/usr/bin/env bash
set -ex
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
gh release edit 1.121.04566 --repo ornate-source/blackIDE --notes-file "${PROJECT_ROOT}/scripts/release/latest_release_notes.md"
