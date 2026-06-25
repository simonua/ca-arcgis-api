# CA ArcGIS API

`ca-arcgis-api` is the developing read-only service boundary between Columbia Association's public
ArcGIS pool-status layer and approved consumers such as the
[CNSL web app](https://github.com/simonua/cnsl).

The repository contains the reviewed integration plan and the first offline harvester trust
boundary. It does not yet contain a network client, scheduler, public API, container image, or Azure
deployment.

## Current Status

- The architecture and source-safety contract are documented in
  [the live pool status integration plan](docs/live-pool-status-integration-plan.md).
- Repository conventions, agents, skills, editor settings, and validation follow `simonua/cnsl`
  closely; see [repository alignment](docs/repository-alignment.md).
- The runtime target is Deno 2 with strict TypeScript, native Web APIs, built-in formatting,
  linting, type checking, and testing.
- The fixed ArcGIS collection URL and source-response validator are implemented and tested with
  synthetic fixtures; routine development performs no live source requests.
- Production infrastructure will be Bicep-only when deployment is authorized.

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

## Remaining Approval Gates

Offline service implementation is underway. Before live ArcGIS access, public API publication,
container publication, or deployment, resolve the applicable approval gates, including source
reuse and attribution, the reviewed pool registry and status mapping, freshness policy,
operating-window artifact ownership, and Azure deployment authorization.
