# Repository Agents, Skills, and Instructions

This directory contains repository-specific GitHub Copilot agent profiles. Profiles are the source
of truth for each agent's workflow, boundaries, allowed edits, and verification. Update this catalog
whenever an agent or skill is added, removed, or materially re-scoped.

All agents follow the repository-wide [Copilot instructions](../copilot-instructions.md) and
path-specific files under [instructions](../instructions/).

## Agent Routing

| Agent | Primary responsibility | Use when | Do not use for | Repository skills |
| --- | --- | --- | --- | --- |
| [`refactoring-auditor`](refactoring-auditor.agent.md) | Audits engineering health and updates only the actionable refactoring plan. | Evidence-based architecture, maintainability, security, reliability, cost, testing, or retirement audits. | Implementing recommendations, changing source contracts, or deploying resources. | Consult [`ca-arcgis-api-code-retirement`](../skills/ca-arcgis-api-code-retirement/SKILL.md). |
| [`arcgis-source-reviewer`](arcgis-source-reviewer.agent.md) | Reviews the official ArcGIS contract and coded domains under the approved request budget. | Deliberate source-schema, field, identity, domain, freshness, or reuse-term review. | Routine tests, automatic monitoring, browser-triggered refresh, production data collection, or deployment. | Required: [`arcgis-source-review`](../skills/arcgis-source-review/SKILL.md). |

## Responsibility Boundaries

### Refactoring Auditor

- Owns assessment and prioritization, including code retirement, source safety, reliability,
  security, test strength, cost, observability, and measured performance.
- Updates only `docs/refactoring-plan.md`, removes completed findings, and keeps recommendations
  grounded in current evidence.
- Defaults to local working-tree review. Publication requires a separate explicit request.

### ArcGIS Source Reviewer

- Owns explicitly authorized live review of the fixed official source contract and supporting
  first-party evidence.
- Separates observations from accepted modeled changes and records uncertainty rather than guessing.
- Does not enable polling, publish source records, alter infrastructure, or turn review payloads
  into runtime persistence.
- Defaults to a report-only review. Configuration, schema, or fixture edits require explicit scope
  and high-confidence evidence.

## Repository Skills

| Skill | Invocation | Purpose | Used by |
| --- | --- | --- | --- |
| [`ca-arcgis-api-code-retirement`](../skills/ca-arcgis-api-code-retirement/SKILL.md) | Internal workflow | Removes obsolete implementation and its complete support surface during replacements. | Refactor implementations and `refactoring-auditor` planning. |
| [`arcgis-source-review`](../skills/arcgis-source-review/SKILL.md) | Internal workflow | Performs bounded, evidence-led ArcGIS contract review without authorizing runtime collection. | `arcgis-source-reviewer`. |
| [`cnsl-alignment`](../skills/cnsl-alignment/SKILL.md) | User-invocable | Compares repository governance with the current CNSL reference and applies deliberate adaptations. | Requests to sync, compare, refresh, or align with `simonua/cnsl`. |

## Instruction Routing

| Instruction | Attachment | Owns |
| --- | --- | --- |
| [`copilot-instructions.md`](../copilot-instructions.md) | Always | Architecture, source safety, verification scope, retirement, and repository invariants. |
| [`build.instructions.md`](../instructions/build.instructions.md) | Task-discovered | Deno tasks, toolchain, local verification, and generated output. |
| [`code-quality.instructions.md`](../instructions/code-quality.instructions.md) | `src/**/*.ts` | Trust boundaries, source requests, and HTTP response safety. |
| [`typescript.instructions.md`](../instructions/typescript.instructions.md) | Source and tests | Strict typing, side-effect boundaries, and semantic ownership. |
| [`testing.instructions.md`](../instructions/testing.instructions.md) | Tests | Deterministic fixtures, assertions, permissions, and scope. |
| [`data.instructions.md`](../instructions/data.instructions.md) | Config, schemas, and fixtures | Evidence authority, drift, provenance, and generated data. |
| [`bicep.instructions.md`](../instructions/bicep.instructions.md) | Infrastructure | Bicep-only Azure design, cost boundaries, and validation. |
| [`github-workflows.instructions.md`](../instructions/github-workflows.instructions.md) | Workflows | Action pinning, permissions, and CI safety. |
| [`markdown.instructions.md`](../instructions/markdown.instructions.md) | Markdown | Markdown authoring and focused lint validation. |

## Maintenance

1. Update the authoritative profile or `SKILL.md` first.
2. Update routing and responsibility summaries here when discovery or ownership changes.
3. Keep names, links, frontmatter, and referenced commands aligned.
4. Remove duplicated or superseded policy and validate every changed Markdown file.
