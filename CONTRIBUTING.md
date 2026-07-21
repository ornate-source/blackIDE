# Contributing

:+1::tada: First off, thanks for taking the time to contribute! :tada::+1:

#### Table Of Contents

- [Code of Conduct](#code-of-conduct)
- [Reporting Bugs](#reporting-bugs)
- [Making Changes](#making-changes)

## Code of Conduct

This project and everyone participating in it is governed by the [Black IDE Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Use of AI

We welcome use of AI tools to help draft discussions, issues, or code, but please follow these rules:

- Use AI tools responsibly and disclose their use.
- Ensure all content passes a human review for authenticity and quality.
- Be concise. Do not write verbose discussions, issues or PR.

Discussions, issues or PR that consist solely of unvetted AI outputs may be closed at the maintainer's discretion.

## Reporting Bugs

### Before Submitting an Issue

Before creating bug reports, please check existing issues and [the Troubleshooting page](https://github.com/ornate-source/blackIDE/wiki/Troubleshooting) as you might find out that you don't need to create one.
When you are creating a bug report, please include as many details as possible. Fill out [the required template](https://github.com/ornate-source/blackIDE/issues/new?&labels=bug&&template=bug_report.md), the information it asks for helps us resolve issues faster.

## Making Changes

If you want to make changes, please read [the Build page](https://github.com/ornate-source/blackIDE/wiki/How-to-Build).

### Building Black IDE

To build Black IDE, please follow the command found in the section [`Build Scripts`](https://github.com/ornate-source/blackIDE/wiki/How-to-Build#build-scripts).

### Updating patches

If you want to update the existing patches, please follow the section [`Patch Update Process - Semi-Automated`](https://github.com/ornate-source/blackIDE/wiki/How-to-Build#patch-update-process-semiauto).

### Add a new patch

- first, you need to build Black IDE
- then use the command `./scripts/dev/patch.sh <your patch name>`, to initiate a new patch
- when the script pauses at `Press any key when the conflict have been resolved...`, open `vscode` directory in **Black IDE**
- run `npm run watch`
- run `./scripts/code.sh`
- make your changes
- press any key to continue the script `patch.sh`
