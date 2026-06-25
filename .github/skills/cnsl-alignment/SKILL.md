---
name: cnsl-alignment
description: "Compare and align this repository's structure, Copilot agents, skills, instructions, editor settings, linters, CI, and governance with the current simonua/cnsl repository. Use for sync, refresh, parity, or continued-reference requests."
argument-hint: 'Name a specific CNSL surface to compare, or request a complete governance refresh.'
user-invocable: true
---

# CNSL Alignment

Use `simonua/cnsl` as a continuing engineering reference, not a source tree to copy mechanically.
Preserve shared governance while adapting every imported convention to this Deno service's
architecture and stricter source-safety boundaries.

## Comparison Scope

Review only surfaces relevant to the request, beginning with:

- `.editorconfig`, `.gitattributes`, `.gitignore`, and Markdown lint configuration.
- `.vscode/` recommendations, settings, and tasks.
- `.github/copilot-instructions.md` and path-scoped instructions.
- `.github/agents/`, its routing catalog, and reusable `.github/skills/`.
- Dependabot, workflow pinning, permissions, validation gates, and maintenance schedules.
- Documentation practices for refactoring plans, release gates, evidence, and generated artifacts.

## Procedure

1. Record the current CNSL default-branch commit and the current local commit or working-tree
   baseline.
2. Inspect the requested CNSL surfaces and their local counterparts. Read canonical owners rather
   than inferring policy from duplicated text.
3. Classify each difference:
   - **Reusable policy:** adopt or refresh locally.
   - **Runtime adaptation:** preserve intent using Deno, TypeScript, Bicep, server, or ArcGIS
     equivalents.
   - **CNSL-only behavior:** do not copy.
   - **Intentional local divergence:** retain and document why this service needs a different or
     stronger rule.
4. Update the smallest canonical local files. Remove superseded duplicates and refresh
   `.github/agents/README.md` when routing changes.
5. Update `docs/repository-alignment.md` with the reviewed CNSL commit, material mapping changes,
   and intentional divergences.
6. Validate frontmatter, links, Markdown, commands, and workflow SHAs. Run `deno task verify` when
   executable configuration or source changes.

## Guardrails

- Never weaken ArcGIS operating-window, request-budget, trust-boundary, privacy, fixture-only test,
  one-replica, or Bicep-only rules for parity.
- Do not import CNSL's PostHTML, PWA, client analytics, SEO, browser, Cloudflare, annual
  publication, or GitHub Pages machinery unless this repository gains a verified equivalent
  requirement.
- Do not introduce pnpm, ESLint, Node.js, or browser tooling when Deno's built-ins satisfy the same
  purpose.
- Do not overwrite local changes or broad-format unrelated files.
- Keep each policy in one canonical owner and use links or concise references from consumers.

## Report

Report the CNSL commit reviewed, surfaces compared, reusable changes adopted, adaptations made,
CNSL-only items excluded, intentional divergences retained, files changed, and exact validation
results.
