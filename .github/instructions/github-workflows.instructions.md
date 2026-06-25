---
applyTo: '.github/workflows/**/*.yml'
description: 'Use when creating or modifying GitHub Actions workflows. Covers immutable actions, permissions, and workflow security.'
---

# GitHub Workflows

## Action Pinning

- Pin every action to the full 40-character commit SHA of a vetted release.
- Retain a trailing release comment, such as `# v2.0.4`, so Dependabot can update the immutable
  reference.
- Never use a version tag, branch name, or `latest` as a `uses:` reference.

## Security

- Declare only required permissions and use `persist-credentials: false` unless a reviewed step must
  push.
- Do not interpolate untrusted event values into `run:` scripts.
- Use GitHub-hosted runners and fixture-backed checks. CI must never enable live ArcGIS polling or
  production deployment.
- Keep deployment in a separate explicitly authorized workflow and environment with the minimum
  elevated permissions.

## Maintenance

- Keep `.github/dependabot.yml` configured for `github-actions` updates.
- Update the pinned Deno patch consistently across setup actions, documentation, compilation, and
  container builders.
- Run the same local verification task used by the workflow before completing workflow changes.
