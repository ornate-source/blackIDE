---
name: github-actions-ci
description: GitHub Actions workflow structure, caching and secret hygiene
roles: [devops]
stacks: [github-actions]
triggers: [github actions, workflow, .github/workflows, jobs, runs-on, actions/checkout]
priority: 8
---
# Github Actions Ci

## Conventions
- Pin third-party actions to a full commit SHA, not a tag — a tag can be moved under you.
- Cache the dependency store keyed on the lockfile hash; a cache keyed on the branch is a cache that never hits.
- `permissions:` least-privilege at the workflow level; the default token is broader than most jobs need.
- Matrix for versions/platforms, `fail-fast: false` when you want the whole picture.
- `concurrency:` with `cancel-in-progress` on PR workflows so pushes do not queue up.

## Pitfalls
- `pull_request_target` with a checkout of the PR head runs untrusted code with secrets. Almost never what you want.
- Secrets are not available to workflows triggered from a fork — design the pipeline around it.
- A step that fails silently because it lacks `set -e`; use `shell: bash` and fail loudly.
