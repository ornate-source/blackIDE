#!/usr/bin/env bash
# Black IDE Wiki Sync Script
# This script automates publishing the prepared documentation to the GitHub Wiki.

set -e

# Define paths — this script lives in docs/, so the repo root is one level up.
DOCS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${DOCS_DIR}/.." && pwd)"
WIKI_DOCS_DIR="${DOCS_DIR}/wiki_docs"
TEMP_WIKI_DIR="${PROJECT_ROOT}/.blackide_wiki_temp"

# Print banner
echo "=============================================="
echo "         Black IDE Wiki Sync Tool"
echo "=============================================="
echo ""
echo "This helper script will sync the documentation files from"
echo "'docs/wiki_docs/' to your GitHub Repository Wiki."
echo ""
echo "⚠️ IMPORTANT: Make sure you have enabled the 'Wikis' feature in"
echo "   your GitHub repository settings before running this script."
echo "   (Settings > General > Features > Check 'Wikis')"
echo ""

# Ask to proceed
read -p "Have you enabled the Wiki on GitHub? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborting. Please enable the Wiki feature on GitHub first, then run this script again."
    exit 1
fi

# Clean up any old temp directories
if [ -d "${TEMP_WIKI_DIR}" ]; then
    rm -rf "${TEMP_WIKI_DIR}"
fi

echo "Cloning the Wiki repository..."
git clone https://github.com/ornate-source/blackIDE.wiki.git "${TEMP_WIKI_DIR}"

echo "Copying documentation pages..."
cp -rp "${WIKI_DOCS_DIR}/"* "${TEMP_WIKI_DIR}/"

cd "${TEMP_WIKI_DIR}"

# Check for changes
if [[ -z $(git status --porcelain) ]]; then
    echo "No documentation changes detected. Wiki is already up-to-date."
    cd "${PROJECT_ROOT}"
    rm -rf "${TEMP_WIKI_DIR}"
    exit 0
fi

echo "Committing wiki changes..."
git add .
git commit -m "Update wiki pages with comprehensive Black IDE documentation"

echo "Pushing changes to GitHub Wiki..."
git push origin master || git push origin main

cd "${PROJECT_ROOT}"
rm -rf "${TEMP_WIKI_DIR}"

echo ""
echo "🎉 Wiki synchronization completed successfully!"
echo "Check your wiki live at: https://github.com/ornate-source/blackIDE/wiki"
echo "=============================================="
