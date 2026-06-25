# CA ArcGIS API

`ca-arcgis-api` is the proposed read-only service boundary between Columbia Association's public
ArcGIS pool-status layer and approved consumers such as the
[CNSL web app](https://github.com/simonua/cnsl).

The repository currently contains the reviewed integration plan and implementation scaffolding. It
does not yet contain an authorized harvester, public API, container image, or Azure deployment.

## Current Status

- The architecture and source-safety contract are documented in
  [the live pool status integration plan](docs/live-pool-status-integration-plan.md).
- Repository conventions, agents, skills, editor settings, and validation follow `simonua/cnsl`
  closely; see [repository alignment](docs/repository-alignment.md).
- The runtime target is Deno 2 with strict TypeScript, native Web APIs, built-in formatting,
  linting, type checking, and testing.
- Production infrastructure will be Bicep-only when implementation and deployment are authorized.

## Repository Layout

```text
config/             Reviewed source mappings and generated operating windows
deploy/local/       Secret-free local deployment examples
docs/               Architecture, operations, and repository governance
infra/              Bicep infrastructure and environment parameters
schemas/            Source, snapshot, and API JSON Schemas
src/                Deno service source; index.ts owns process composition
tests/              Deno tests and sanitized ArcGIS fixtures
.github/agents/      Repository-specific Copilot agents
.github/instructions/Path-scoped implementation instructions
.github/skills/      Reusable repository workflows
```

Directories that do not yet contain implementation artifacts have boundary READMEs. Do not add
speculative production configuration or source data merely to fill the layout.

## Development

Install the Deno version pinned in [the CI workflow](.github/workflows/ci.yml), then use:

| Command | Purpose |
| --- | --- |
| `deno task fmt:check` | Verify formatting |
| `deno task lint` | Run the Deno linter |
| `deno task check` | Type-check the service and tests |
| `deno task test` | Run deterministic tests with no ambient permissions |
| `deno task verify` | Run the complete current repository gate |

Tests must use fixtures and injected dependencies. They must not contact ArcGIS, Azure, CNSL
production, or any other live service.

## Implementation Gate

The planning document remains proposal-only. Before service implementation begins, resolve its
explicit approval gates, including source reuse and attribution, the reviewed pool registry and
status mapping, freshness policy, operating-window artifact ownership, and Azure deployment
authorization.
