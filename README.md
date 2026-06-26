# CA ArcGIS API

`ca-arcgis-api` is the developing read-only service boundary between Columbia Association's public
ArcGIS pool-status layer and approved consumers such as the
[CNSL web app](https://github.com/simonua/cnsl).

The repository contains the reviewed integration plan, offline harvester trust boundary, an
injected read-only HTTP runtime, and a hardened container build. It does not yet contain executable
production composition, a published container image, or an Azure deployment, and routine
development does not enable live ArcGIS access.

## Current Status

- The architecture and source-safety contract are documented in
  [the live pool status integration plan](docs/live-pool-status-integration-plan.md).
- Repository conventions, agents, skills, editor settings, and validation follow `simonua/cnsl`
  closely; see [repository alignment](docs/repository-alignment.md).
- The runtime target is Deno 2.9.0 with strict TypeScript, native Web APIs, built-in formatting,
  linting, type checking, and testing.
- The fixed ArcGIS collection URL, strict runtime configuration parser, injected HTTP client,
  source-response validator, operating-window gate, monotonic five-minute permit, shared no-overlap
  source-operation lock, completion-based backoff, collection circuit, daily attempt ceiling, and
  injected single-timer scheduler runner are implemented and tested with synthetic inputs. A strict
  normalization boundary now maps validated records through injected registry and domain policy to
  one immutable, consumer-owned in-memory snapshot. Source presentation fields and validators are
  not retained in that snapshot, failed publication leaves the prior snapshot untouched, and a `304`
  advances only harvester freshness. A pure semantic projection now applies injected, validated
  snapshot, attendance, and status freshness policy; reports closed-hours collection state; hides
  expired values without mutating retained data; and exposes exact transition instants. A bounded
  in-memory representation cache now owns canonical success-route keys, UTF-8 bodies, strong API
  ETags, concurrent-fill coalescing, generation retirement, selective semantic invalidation, and
  least-recently-used eviction under injected entry and byte limits. The runner uses bounded startup
  jitter, separate wall and monotonic deadlines, long-wait chunking, and no catch-up polling. Polling
  is disabled by default, and routine development performs no live source requests.
- The injected HTTP runtime serves normalized pool, single-pool, closure, health, readiness, and
  generated OpenAPI routes without any request-to-source path. The deterministic OpenAPI 3.1
  document binds canonical paths, methods, filters, response schemas, headers, and Problem Details
  metadata to the same code-owned contract used by request validation. The runtime enforces bounded
  request inputs, exact filters, RFC 9457 errors, CORS allowlisting, strong conditional ETags,
  semantic cache transitions, and bounded per-client quotas using ACA's trusted forwarding hop.
  Server startup and scheduler shutdown ordering are independently tested. A private in-process
  collector aggregates bounded source, cache, snapshot, and API metrics using fixed dimensions; it
  has no public route and telemetry failures cannot alter source or request outcomes. Swagger
  remains unavailable until reviewed, integrity-verified assets are added.
- Deterministic JSON Schemas for the fixed ArcGIS response, normalized snapshot, and public API
  responses are generated from code-owned contracts. Synthetic accepted, rejected, boundary, and
  hostile fixtures exercise the explicit runtime source validator; schemas do not replace it.
- The Linux/amd64 container build compiles one permission-bounded executable into a digest-pinned
  Distroless C-runtime image. The final image runs as UID/GID `65532`, has no shell or package
  manager, declares no writable volume or utility-based health check, and supports read-only root
  operation. Its bounded security-check mode reports permission states without starting the API or
  performing source, filesystem, subprocess, or FFI operations.
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
| `deno task schemas:generate` | Regenerate reviewable JSON Schema artifacts |
| `deno task schemas:check` | Fail when generated schemas are missing or stale |
| `deno task test` | Run deterministic tests with only build-contract file reads |
| `deno task compile:container` | Compile the Linux/amd64 executable with embedded permissions |
| `deno task container:build` | Build the local digest-pinned Linux/amd64 image |
| `deno task container:verify` | Inspect and harden-run `ca-arcgis-api:local` without network access |
| `deno task verify` | Run the complete current repository gate |

Tests must use fixtures and injected dependencies. They must not contact ArcGIS, Azure, CNSL
production, or any other live service.

The container verifier checks architecture, image size, UID/GID, direct entrypoint, exposed port,
absent health check and volumes, forbidden runtime paths, and the executable's embedded Deno
permissions. Normal startup, health/readiness, and shutdown smoke checks remain blocked until the
reviewed static configuration artifacts required by `src/index.ts` exist; the image must continue
to fail closed in the meantime.

CI repeats the image build and hardened verification on Linux, then uses a commit-pinned Trivy
action to fail on high or critical OS/library vulnerabilities and detected secrets. It does not
publish the image.

## Remaining Approval Gates

Offline service implementation is underway. Before live ArcGIS access, public API publication,
container publication, or deployment, resolve the applicable approval gates, including source
reuse and attribution, the reviewed pool registry and status mapping, freshness policy,
operating-window artifact ownership, and Azure deployment authorization.
