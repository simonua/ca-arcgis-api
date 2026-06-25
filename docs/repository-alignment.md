# CNSL Repository Alignment

Reviewed: 2026-06-25

## Reference

This repository treats [`simonua/cnsl`](https://github.com/simonua/cnsl) as its continuing reference
for repository governance, engineering discipline, GitHub Copilot customization structure, editor
behavior, and maintenance practices.

The initial alignment was reviewed against CNSL `main` commit
`d3d8f69808791133968b784e4fbb56bdab5543e5`. That commit is a comparison baseline, not a vendored
dependency or a permanently pinned standard.

## Alignment Policy

- Preserve the same customization hierarchy: repository-wide instructions, path-scoped instructions,
  custom agents, reusable skills, an agent catalog, Dependabot, editor recommendations, and
  SHA-pinned GitHub Actions.
- Adopt CNSL's evidence-led testing, focused local verification, code-retirement,
  customization-normalization, documentation-linting, and audit-plan practices unless this service
  has a stronger boundary.
- Adapt runtime-specific rules to Deno, strict TypeScript, a server process, ArcGIS source safety,
  immutable in-memory snapshots, and Bicep infrastructure.
- Do not copy CNSL-only PostHTML, browser, PWA, annual-season, analytics, SEO, Cloudflare, or
  release-note workflows into this service.
- Keep shared policy with one canonical owner. Path-scoped instructions and skills should link to
  repository-wide rules instead of restating them.

## Initial Mapping

| CNSL reference | This repository | Alignment |
| --- | --- | --- |
| `.editorconfig`, `.gitattributes` | Same files | Mirrored text-file policy |
| `.markdownlint.jsonc` | Same file | Mirrored rule set |
| `.vscode/` | `.vscode/` | Same editor hygiene, adapted for Deno and Bicep |
| `.github/copilot-instructions.md` | Same path | Same policy role, service-specific invariants |
| `.github/instructions/` | Same path | Same focused attachment model, adapted scopes |
| `.github/agents/README.md` | Same path | Same routing-catalog role |
| `refactoring-auditor.agent.md` | Same agent name | Adapted assessment dimensions and plan-only boundary |
| `cnsl-code-retirement` | `ca-arcgis-api-code-retirement` | Same retirement workflow, adapted surfaces |
| pnpm and ESLint gates | Deno tasks | Equivalent format, lint, check, and test gate |
| SHA-pinned workflows | `ci.yml` | Same immutable-action requirement |

## Refresh Procedure

Use the `cnsl-alignment` repository skill when asked to sync, compare, refresh, or align repository
conventions with CNSL. The workflow must:

1. Record the current CNSL `main` commit.
2. Compare the shared surfaces named above.
3. Classify differences as reusable policy, runtime-specific adaptation, CNSL-only behavior, or
   intentional local divergence.
4. Update canonical local owners and this mapping in the same change.
5. Validate changed customization files and run `deno task verify` when executable or Deno
   configuration changes.

Do not mechanically overwrite local files from CNSL. Alignment means preserving the shared
engineering model while keeping this service's stricter source, privacy, runtime, and deployment
boundaries.
