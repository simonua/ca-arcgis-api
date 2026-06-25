# Live Pool Status Harvester And API Plan

Status: Offline implementation authorized; live ArcGIS access and deployment remain unapproved.

Reviewed: 2026-06-25

## Purpose

Define the containerized service that will periodically read Columbia Association's public ArcGIS pool-status layer, validate and normalize the records, and expose a small read-only API for the CNSL web app and other approved consumers.

The container would be the only CNSL-owned component that contacts ArcGIS. Browsers would query the CNSL-owned API instead of querying ArcGIS directly. This centralizes request pacing, protects the web app from source-contract changes, and prevents one ArcGIS request per visitor.

Implementation in this repository does not authorize live ArcGIS access, API publication, browser integration, deployment, annual-data changes, or source-schema changes without their applicable approvals.

## Goals

- Poll ArcGIS on a configurable, bounded interval without creating visitor-driven source traffic.
- Contact ArcGIS only during the same schedule-derived daily window used by the weather banner: one hour before the first published pool activity through the final activity close.
- Make one collection request per poll rather than one request per pool.
- Expose normalized information for all pools, one pool, and active closures.
- Preserve the last known-good snapshot in memory through short ArcGIS outages.
- Retain the last accepted in-memory snapshot across closed hours and extended source failures without presenting expired values as current.
- Distinguish the time the container checked ArcGIS from the time CA last updated each pool.
- Treat all ArcGIS values as untrusted, even though the source is official and public.
- Keep the service in this separate API repository and use this document as the CNSL-side contract and integration handoff.
- Host the production API at `https://api.pools.longreachmarlins.org` on a cost-bounded Azure deployment.
- Provision Azure resources only through Bicep with configurable resource-group placement and Cloud Adoption Framework naming.
- Leave annual schedules and existing schedule-derived pool status as the web app's independent fallback.
- Avoid storing attendance history or creating a visitor-tracking surface.

## Non-Goals

- Do not predict closures from forecasts, radar, air quality, or National Weather Service data.
- Do not write to ArcGIS or test its editing endpoints.
- Do not scrape the rendered ArcGIS Experience page when the Feature Service query is available.
- Do not mirror the complete ArcGIS feature, geometry, attachments, editor fields, or form links.
- Do not make the API authoritative for published schedules.
- Do not replace Columbia Association's Pool Guide as the official visitor destination.
- Do not put container code under `src/`, copy it into `out/`, or include it in the PWA cache.
- Do not retain a time series, calculate crowd trends, or expose raw historical snapshots in the first version.
- Do not persist ArcGIS results, normalized snapshots, HTTP validators, or response caches to disk in the first version.
- Do not implement a general ArcGIS proxy or accept a caller-supplied upstream URL, query, field list, or SQL expression.

## Current Source Findings

The following findings were verified against live official sources on 2026-06-25.

| Finding | Current evidence | Design consequence |
| --- | --- | --- |
| Source | Public `Columbia Association Pools` layer in the `CA_Ammenities` Feature Service | Use the Feature Service query endpoint, not HTML scraping |
| Ownership | ArcGIS item is owned by a `columbiaassociation.org` account and marked `public_authoritative` | Treat it as the first-party operational source, subject to explicit reuse approval |
| Records | One field-limited query returned 27 pools: 23 outdoor and 4 indoor | Fetch the complete collection in one request |
| Refresh intent | ArcGIS web-map data requests a five-minute refresh | Default to five minutes and enforce five minutes as the minimum interval unless CA approves otherwise |
| Stable candidate identity | Every observed pool had an `AssetID`; names contain punctuation and spelling differences | Use a reviewed `AssetID` registry as the source identity |
| Operational status | `Status` has a 20-value coded domain | Map source codes to a smaller API-owned semantic vocabulary |
| Partial maintenance | `Status2` has an 8-value coded domain | Model affected facilities separately from whole-pool status |
| Attendance | `Pool_Attendance` is a nullable number | Publish only when finite, nonnegative, within bounds, and fresh |
| Maximum capacity | `Pool_Capacity` is a nullable number | Call it maximum capacity, not current attendance or guaranteed legal occupancy |
| Published utilization | `Pool_usage_percentage` can remain nonzero after attendance resets to zero | Ignore it for API calculations and derive utilization from accepted attendance and capacity |
| Freshness | `EditDate` is an ArcGIS UTC epoch timestamp | Preserve it as `reportedAt`; never substitute the poll time |
| Conditional retrieval | The query response included an `ETag` and `Last-Modified`, with `Cache-Control: max-age=0` | Test conditional requests; use validators to reduce bytes, not to reduce scheduled checks |
| Query scale | Layer limit is 2,000 records, far above the observed 27 | Still detect `exceededTransferLimit` and reject a truncated response |
| Trust boundary | Source service allows anonymous query, update, and delete operations | Use only fixed `GET` query URLs; never include credentials or editing code |
| Read-only view | The service reports that views exist, but no pool-specific read-only view was discovered; the related public view is for lake activities | Continue to seek a CA-owned read-only pool view; otherwise document acceptance of the editable-source risk |
| Reuse terms | ArcGIS `licenseInfo` is blank | Obtain written reuse and attribution guidance before production use |

### Reviewed Sources

- [Columbia Association Pool Guide](https://experience.arcgis.com/experience/ac58c73ab9bd4640a880c8ddf46bf198)
- [Columbia Association Pools layer](https://services8.arcgis.com/Qah4YRlnA96tI4X9/arcgis/rest/services/CA_Ammenities/FeatureServer/0?f=pjson)
- [Feature Service metadata](https://services8.arcgis.com/Qah4YRlnA96tI4X9/arcgis/rest/services/CA_Ammenities/FeatureServer?f=pjson)
- [ArcGIS item metadata](https://www.arcgis.com/sharing/rest/content/items/2af336eb205e4c19b627a2a19ca10040?f=pjson)
- [ArcGIS item data](https://www.arcgis.com/sharing/rest/content/items/2af336eb205e4c19b627a2a19ca10040/data?f=json)
- [Columbia Association Pools Status page](https://columbiaassociation.org/sports-recreation/pools/pool-locations/status/)

## Recommended Architecture

```text
CA ArcGIS Feature Service
          |
          | one fixed, field-limited GET per interval
          v
+-----------------------------------------------+
| pool-status-api container                     |
|                                               |
| scheduler -> ArcGIS client -> validator       |
|                         -> normalizer          |
|                         -> snapshot publisher |
|                                  |            |
|                   immutable memory snapshot  |
|                                  |            |
|                         read-only HTTP API    |
+-----------------------------------------------+
          |
          | cacheable normalized JSON
          v
Azure Container Apps managed ingress
          |
          | api.pools.longreachmarlins.org
          v
CNSL web app and approved consumers
```

### Azure Hosting Choice

Use one Azure Container App in a Consumption workload-profile environment. Configure exactly one `0.25 vCPU / 0.5 GiB` replica with `minReplicas: 1`, `maxReplicas: 1`, single-revision mode, external HTTPS ingress, and no Dapr sidecar. This is the smallest suitable baseline that preserves the process-owned scheduler, outbound rate gate, ArcGIS validators, and immutable snapshot.

Do not scale this design to zero. Scale-to-zero would discard the snapshot and stop the background scheduler; the next visitor request could then cause a cold start without restoring scheduler-owned collection. Splitting collection into an Azure Container Apps job would require durable shared state and a second deployment unit, contradicting the approved in-memory-only design. During closed hours the one replica should sleep until its next scheduled boundary and qualify for Container Apps' reduced idle rate when it stays below the platform's idle CPU and network thresholds.

Keep the baseline deliberately small:

- Do not provision a dedicated workload profile, virtual network, NAT Gateway, private endpoint, Azure Firewall, Front Door, API Management, Redis, database, storage account, or Key Vault.
- Use Azure Container Apps managed external ingress, its generated endpoint, and its free managed certificate for the custom subdomain.
- Publish the immutable image by digest to GitHub Container Registry from the separate repository, avoiding a standing Azure Container Registry charge. Prefer a public package containing no secrets; if policy requires a private registry, add the least-cost compliant registry as an explicit priced change rather than hiding it in the baseline.
- Use the existing authoritative DNS provider for `longreachmarlins.org`; do not create or migrate an Azure DNS zone solely for this API.
- Add a paid edge service only after measured traffic, abuse, latency, or security evidence justifies it. The API's own bounded representation cache and Container Apps ingress are sufficient for launch.

#### Azure Container Apps Express Evaluation

Azure Container Apps express is the preferred future simplification target, but it is not the production target while its current preview constraints conflict with this service. Express uses the same Container Apps Consumption vCPU, memory, request billing, and subscription-level free grant; it does not introduce a separate cheaper compute rate. Its main advantages are nearly instant environment provisioning, subsecond scale-from-zero, and fewer infrastructure decisions.

Those advantages fit request-driven HTTP applications, but this service intentionally is not request-driven. Its scheduler must remain resident, poll independently of visitors, and preserve its in-memory snapshot, validators, and monotonic rate-gate state. Configuring Express with `minReplicas: 1` is technically supported through the existing Container Apps resource model, but doing so gives up Express's principal scale-to-zero savings while retaining the same Consumption billing model.

As of the official preview documentation reviewed on 2026-06-25, Express also lacks capabilities required by this proposal:

- Custom domains with managed certificates are in development, so it cannot serve the required `api.pools.longreachmarlins.org` endpoint directly.
- Health probes, single-revision management, Azure Monitor metrics, and OpenTelemetry integration are in development.
- The preview is available only in West Central US and East Asia.
- Preview workloads have no SLA.

Express does preserve the environment resource for compatibility, and Microsoft states that existing infrastructure-as-code, SDK, and CLI commands continue to work. The CLI creates an Express environment with `--environment-mode express`; the future Bicep implementation must verify the corresponding stable ARM property and API version rather than wrapping an imperative CLI command. Do not make the production template depend on a preview-only property whose Bicep contract, region behavior, or lifecycle is not validated by `what-if`.

Use Express now only for an optional, time-bounded, fixture-backed demonstration with polling disabled and the generated Azure hostname. It can scale to zero safely when it owns no scheduler state and makes no ArcGIS request. Do not call that environment a production-equivalent test because it lacks the production domain, probes, revision controls, and telemetry path.

Reevaluate Express as the production target before implementation and again before launch. Adopt it only when all of these gates pass in the selected region:

- General availability or an explicitly accepted preview and no-SLA risk.
- Direct custom-domain binding with a free managed certificate.
- `minReplicas: 1`, `maxReplicas: 1`, health probes, and single-revision behavior represented and validated through Bicep.
- The approved `lean` observability signals, plus the optional `full` OpenTelemetry path when selected.
- A measured monthly estimate no worse than standard Container Apps Consumption for the required always-resident replica.
- A documented rollback or migration path that preserves the image, configuration, DNS, and source-safety invariants.

Until every gate passes, retain the standard Container Apps Consumption environment described above. See the official [Express overview](https://learn.microsoft.com/azure/container-apps/express-overview) and [Express FAQ](https://learn.microsoft.com/azure/container-apps/express-faq) for the current feature matrix, regions, pricing model, and SLA status.

### Runtime Choice

Use Deno 2 and strict TypeScript. This matches the owner's established Deno operating model while keeping the service small: native `Deno.serve`, Web APIs, built-in formatting, linting, type checking, testing, auditing, and compilation are sufficient without a general web framework or Node.js runtime.

Follow the applicable patterns demonstrated by [`simonkurtz-MSFT/drawio-mcp-server`](https://github.com/simonkurtz-MSFT/drawio-mcp-server): a narrow `src/index.ts` lifecycle boundary, pure deterministic configuration parsing, committed Deno manifest and lockfile, graceful signal handling, a multi-stage compiled image, and a non-root distroless final stage. Do not copy its MCP, diagram, filesystem, stdio, Hono, or broad-permission requirements into this smaller HTTP service.

- Keep `src/index.ts` as the narrow lifecycle owner: read validated configuration, construct dependencies, start `Deno.serve`, start one scheduler, and coordinate idempotent shutdown.
- Keep configuration parsing, source validation, normalization, routing, and response construction in pure or explicitly injected modules. Concentrate `Deno.env`, signals, timers, and network side effects at composition boundaries.
- Use native `fetch` with `AbortSignal.timeout` or a composed `AbortController` for the fixed ArcGIS request. Reject redirects and do not add an HTTP retry package.
- Use explicit TypeScript types plus application validators at the trust boundary. Keep JSON Schemas as generated contract artifacts and CI checks, not general runtime validation dependencies.
- Use an injected clock and scheduler interface backed by `Date.now()` for civil instants and `performance.now()` for monotonic permit spacing so tests remain deterministic.
- Implement the small fixed router, health handlers, bounded inbound limiter, RFC 9457 responses, and representation cache with Web-standard primitives. Add a framework only if measured complexity justifies its dependency and runtime cost.
- Use Deno's built-in OpenTelemetry integration only after its Azure export path and volume controls pass the observability cost gate below. Keep telemetry outside source-request decisions.
- Generate OpenAPI 3.1 deterministically from code-owned endpoint descriptors and the same JSON Schemas used by contract tests. Do not infer it through runtime reflection.
- Use `Deno.test` and `@std/assert` or the smallest reviewed standard-library test helpers. Tests must receive fake clocks, fixture fetchers, and in-memory handlers rather than broad runtime permissions.
- No ArcGIS SDK. The service needs one REST query and should not take on mapping or editing capabilities.
- No database, result file, or persistent volume in version 1. One immutable in-memory snapshot is sufficient for 27 records and one enforced replica.

Pin one supported Deno 2 patch in development, CI, compilation, and the builder image. Commit `deno.json` and `deno.lock`, require frozen dependency resolution, enable strict compiler options, and keep production imports to reviewed JSR or npm packages only when native APIs are insufficient. The initial target should need at most `@std/assert` for tests and `@opentelemetry/api` if custom instruments are approved. Compile configuration, schemas, OpenAPI, and optional Swagger assets into the executable so production needs no filesystem permission.

Compile with an explicit environment-variable allowlist and network access limited to the listener, `services8.arcgis.com:443`, and the local or approved OpenTelemetry endpoint when enabled. Grant no write, subprocess, FFI, system-information, or broad read permission. Because `deno compile` embeds permissions, CI must inspect the compile command and prove that denied filesystem, subprocess, FFI, environment, and network operations fail in the final container.

## Separate Repository Layout

This repository is the separate service boundary. Do not add the service or its infrastructure to the CNSL repository:

```text
pool-status-api/
├── README.md
├── deno.json
├── deno.lock
├── Dockerfile
├── .dockerignore
├── config/
│   ├── operating-windows.json
│   ├── pool-registry.json
│   ├── source-contract.json
│   └── status-mapping.json
├── infra/
│   ├── main.bicep
│   ├── abbreviations.json
│   ├── environments/
│   │   └── prod.bicepparam
│   └── modules/
│       ├── container-app-environment.bicep
│       ├── container-app.bicep
│       ├── monitoring.bicep
│       ├── alerts.bicep
│       └── custom-domain.bicep
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── clock.ts
│   ├── contracts/
│   ├── documentation/
│   ├── harvesting/
│   ├── normalization/
│   ├── caching/
│   ├── http/
│   └── telemetry/
├── schemas/
│   ├── source-response.schema.json
│   ├── snapshot.schema.json
│   └── api-response.schema.json
├── tests/
│   ├── fixtures/
│   ├── arcgis-client.test.ts
│   ├── source-validator.test.ts
│   ├── arcgis-rate-gate.test.ts
│   ├── operating-window-gate.test.ts
│   ├── pool-normalizer.test.ts
│   ├── snapshot-cache.test.ts
│   ├── scheduler.test.ts
│   └── endpoint.test.ts
├── swagger-ui/
│   ├── LICENSE
│   └── dist/
└── deploy/
  └── local/
    ├── compose.example.yaml
    └── container-env.example
```

The folder boundaries are intentional:

- `config/` owns reviewed source mappings and pool identities.
- `config/operating-windows.json` is a generated, reviewed service input derived from the same annual pool schedules and overrides as the weather banner. Runtime code must not reinterpret annual schedule records.
- `src/index.ts` owns process lifecycle and composition; the remaining `src/` modules own side-effect-light domain and HTTP behavior.
- `schemas/` owns machine-checkable trust and API contracts.
- `tests/fixtures/` owns sanitized deterministic payloads; tests must not call ArcGIS.
- `infra/` is the only production infrastructure source and contains modular Bicep plus reviewed environment parameters.
- `deploy/local/` contains local examples, not environment-specific secrets or production credentials.
- `swagger-ui/` contains only a pinned, integrity-verified Swagger UI distribution and its license. It is compiled into the executable and served only when the documentation UI is enabled; it is not a runtime package.
- The CNSL repository keeps only this proposal and the later browser integration. The API repository owns service code, Bicep, image publication, deployment, and operations.

## Upstream Query Contract

The ArcGIS client should build a fixed request from constants, not from caller input.

```text
GET https://services8.arcgis.com/Qah4YRlnA96tI4X9/
    arcgis/rest/services/CA_Ammenities/FeatureServer/0/query
    ?where=1%3D1
    &outFields=Name,AssetID,Pool_Name,pool_location,Status,Status2,
               Pool_Attendance,Pool_Capacity,EditDate
    &returnGeometry=false
    &orderByFields=AssetID
    &f=json
```

Required behavior:

- Use `GET`, HTTPS, a fixed hostname, a fixed service path, and a fixed `where=1=1` expression.
- Request only the nine fields above. Do not request `Editor`, `Creator`, `Team_Member`, global IDs, object IDs, form links, attachments, schedules, descriptions, or geometry.
- Send `Accept: application/json` and a descriptive, stable `User-Agent` with a public contact URL if CA approves it.
- Send the prior `ETag` in `If-None-Match` after confirming ArcGIS honors conditional query requests.
- Treat `304 Not Modified` as a successful poll that advances `lastCheckedAt` but does not alter any pool's `reportedAt`.
- Apply a configurable timeout, default 10 seconds and bounded between 2 and 30 seconds.
- Reject redirects to an unapproved host.
- Reject non-JSON content, ArcGIS `{ "error": ... }` payloads, non-2xx responses other than an expected `304`, oversized bodies, truncated results, and unsupported schema versions.
- Set a response-size ceiling, such as 256 KiB, well above the projected response but low enough to contain an upstream accident.
- Fetch layer metadata on a separate low-frequency schedule for schema and coded-domain drift detection. Delay the first metadata request until at least one hour of continuous process uptime, allow at most one every 24 hours, and defer it until an approved pool operating window is active. Metadata checks must not occur at every startup or once per API request.

## Scheduling And Request Budget

### Schedule-Derived Operating Window

Apply the same operating-window contract as the weather banner before every ArcGIS operation:

- Use the Eastern calendar date represented by `APP_TIMEZONE` and the active annual pool schedules.
- Include every published pool activity accepted by the existing schedule rules, including `scheduleOverrides`.
- Start the source-access window 60 minutes before that day's earliest activity, clamped to midnight.
- End the window at that day's latest activity close. The start is inclusive and the close is exclusive.
- Treat a missing, invalid, closed-day, or out-of-season window as closed. Fail closed and alert on an invalid operating-window artifact.
- Gate collection, metadata, restricted diagnostics, and every future ArcGIS route. No ArcGIS DNS lookup or HTTP request is allowed outside the window.

Do not duplicate the browser's schedule interpretation in TypeScript. Extend the existing deterministic build-time generator that creates `WEATHER_OPERATING_WINDOWS` so it also emits a versioned `config/operating-windows.json` service artifact. Include exact UTC `sourceAccessStartsAt` and `sourceAccessEndsAt` instants for each active date, calculated from the same `[openMinutes, closeMinutes]` result and the 60-minute lead. Exact instants preserve Eastern daylight-saving behavior without requiring the service to parse annual schedules or independently calculate civil-time transitions.

CI must regenerate the artifact from the active annual data, compare it byte-for-byte with the checked-in service input, and verify semantic equivalence with `WeatherAlertService.createOperatingWindowSchedule`. A season rollover or schedule correction cannot ship while the service artifact is stale. The artifact is operational configuration, not an ArcGIS result and not runtime persistence.

### Default Policy

- `POLL_INTERVAL_SECONDS=300`.
- Enforce `MIN_POLL_INTERVAL_SECONDS=300` in code so a bad setting cannot exceed the reviewed request rate.
- Add 0 to 30 seconds of startup jitter so restarts and multiple environments do not align exactly.
- Start the first poll after startup jitter only when the operating window is active. Before the window, schedule one wakeup at its opening boundary; after close, schedule one wakeup for the next configured date.
- Schedule the next attempt after the current attempt completes. Never overlap polls.
- Expose an internal single-flight guard so manual diagnostics cannot start a second request.
- Do not poll in response to public API traffic, an empty or expired cache, cache misses, health checks, readiness checks, metrics requests, filters, or a requested pool ID.
- Do not expose a public refresh endpoint. Any restricted diagnostic trigger must use the same single-flight gate and request budget as the scheduler and must not reset the next scheduled interval earlier.
- Do not make up missed closed-hours polls. At the next opening boundary, permit at most one jittered attempt and resume normal completion-based scheduling.

### Hard Outbound Rate Gate

Put one application-owned gate immediately in front of every approved ArcGIS `HttpClient` send. Scheduling delays are not themselves a rate limiter; the client must be unable to send unless both the operating-window gate and this rate gate grant permission.

- Give collection queries a token bucket with capacity one, no burst accumulation, and one replacement permit after the greater of `POLL_INTERVAL_SECONDS` or the hard-coded 300-second floor.
- Consume the permit immediately before starting the network attempt. Timeouts, transport failures, non-2xx responses, invalid content, and canceled attempts still consume it.
- Measure permit spacing with injected monotonic time backed by `performance.now()`. Do not use adjustable wall-clock time for enforcement.
- Use native `fetch` with no automatic application retry. All retry decisions belong to the scheduler and must reacquire a permit.
- Share one no-overlap source-operation lock across collection, metadata, and restricted diagnostics so the service never sends concurrent ArcGIS requests.
- Give metadata requests an independent bucket with capacity one, no accumulated burst, a one-hour initial uptime delay, and a 24-hour replacement interval. If its deadline occurs while closed, defer it to an active window without accumulating permits.
- A restricted diagnostic collection request consumes the collection permit. If no permit is available, return a deferred or rate-limited diagnostic result with `nextAllowedAt`; never borrow from the future or bypass the gate.
- Record the next eligible monotonic deadline after every attempt. Scheduler wakeups, clock changes, delayed tasks, and process pauses must not cause catch-up requests.

At the default interval, a continuously running production process sends no more than one collection attempt every 300 seconds during configured operating windows, plus no more than one metadata request per 24 hours during a window. The hard daily ceiling must be calculated from the actual configured source-access windows, not a 24-hour polling assumption. Conditional `304` responses save bytes but still count as attempts. Development and staging environments should default to polling disabled and use fixtures unless live access is explicitly enabled.

The in-process gate cannot remember attempts across a restart because version 1 intentionally has no persistent state. Configure the deployment for exactly one replica, rolling replacement rather than overlapping pollers, and exponential crash-restart backoff with jitter. If CA requires a strict service-wide rolling limit that survives arbitrary restarts, enforce the same one-per-five-minute permit at a durable egress gateway or shared coordinator before production; do not claim the in-memory limiter provides that guarantee.

### Failure Backoff

- After a timeout, network error, `429`, or `5xx`, retain the last known-good snapshot.
- Use exponential backoff beginning at the configured interval and capped at 30 minutes, with jitter.
- Honor a valid `Retry-After` value when it is longer than the computed delay. Never shorten an ArcGIS-requested delay to the local backoff cap; if the value is implausibly long, stop polling and alert for operator review.
- Calculate the next attempt as the latest of the outbound permit time, exponential-backoff time, and valid `Retry-After` time.
- Reset backoff after the next successful `200` or `304`.
- Treat validation and schema-drift failures as nontransient. Retain the snapshot, raise a high-signal alert, and continue at a slower diagnostic cadence rather than hammering the same bad payload.
- Never retry immediately in a tight loop.

### Circuit Breaker And Fail-Safe Order

Use an explicit scheduler-owned circuit breaker in addition to backoff. Do not use an automatic retry or resilience handler that can issue hidden requests.

- Count consecutive transport failures, `429`, `5xx`, invalid content, and whole-cycle validation rejection by fixed failure class.
- Open the collection circuit after a reviewed threshold, initially proposed as five consecutive failures. While open, send no collection request and retain the last accepted snapshot.
- Set the next probe to the latest of the circuit cooldown, outbound permit deadline, `Retry-After`, backoff deadline, and next active operating-window instant.
- Allow exactly one half-open probe. Concurrent scheduler wakeups or diagnostics observe the open or half-open state and cannot send another request.
- Close the circuit only after a valid `200` candidate or expected `304`. A failed half-open probe reopens it with a longer bounded cooldown.
- Open immediately for an unapproved redirect, authentication or authorization response, oversized body, persistent schema drift, invalid operating-window artifact, or response pattern suggesting the fixed source contract is unsafe. These states require operator review rather than repeated probing.
- Apply a separate metadata circuit so metadata failure cannot block collection, while the shared no-overlap and operating-window gates still apply.
- Put a hard daily attempt ceiling, derived from the configured windows and minimum interval, above the normal scheduler budget. Crossing it disables ArcGIS egress until the next Eastern date and raises a critical alert.
- Keep API demand, readiness probes, OpenAPI requests, and Swagger UI use completely outside circuit and polling decisions.

The source-send order is fixed: validate configured operating window, check emergency disable and daily ceiling, check circuit state, acquire the shared no-overlap lock, acquire the operation's monotonic permit, recheck the operating window immediately before send, then issue one HTTP request. A denied check schedules future work and performs no network access.

### Replica Invariant

Version 1 must run exactly one replica because each replica would otherwise create its own ArcGIS traffic and snapshot. Enforce this operationally in deployment examples and document it in health output.

If high availability later requires multiple API replicas, split polling into one elected worker and place the snapshot in shared object storage or another small shared store. Do not scale the combined container horizontally without that redesign.

## Identity And Pool Registry

Use `AssetID` as the official source key because all 27 observed records had one and it is less presentation-sensitive than `Name` or `Pool_Name`.

Create a reviewed registry entry for every expected pool:

```json
{
  "sourceAssetId": "WL-PL01",
  "apiId": "wl-pl01",
  "displayName": "Bryant Woods Pool",
  "locationType": "outdoor",
  "webAppPoolId": "bwp"
}
```

Rules:

- `apiId` is the lowercase `AssetID` and is the stable path key for `/v1/pools/{poolId}`.
- `webAppPoolId` connects the 23 outdoor records to the active annual web-app identity without changing annual JSON through this runtime path.
- Indoor facilities may have `webAppPoolId: null` until the web app has a use for them.
- Names are output owned by the registry, not blindly copied from ArcGIS. ArcGIS names are used only as secondary drift checks.
- Reject duplicate, missing, or malformed `AssetID` values.
- Quarantine unknown ArcGIS `AssetID` values and alert; do not automatically publish a new facility.
- Mark an expected but missing source record unavailable; do not silently delete it from the API.
- Validate the registry against active annual outdoor pool IDs during CI and every season rollover. The test should assert relationships and uniqueness, not pin a mutable annual count.
- Review known spelling differences, including `Running Brooke Pool`, as source drift rather than copying them into web-app identity.

## Normalized Data Model

### Operating State

Map the 20-value source `Status` domain to API-owned semantic fields:

| API field | Example values | Purpose |
| --- | --- | --- |
| `access` | `open-public`, `restricted-program`, `partial`, `closed`, `unknown` | Coarse public-access behavior |
| `activity` | `rec-swim`, `adult-laps`, `swim-lessons`, `aqua-fit`, `senior-swim`, `special-event`, `none` | Current reported use when relevant |
| `closureKind` | `inclement-weather`, `air-quality`, `maintenance`, `unplanned`, `off-hours`, `season`, `swim-team`, `summer-camp`, `private-event`, `none` | Reason for a whole-pool or public closure |
| `sourceReportedAt` | ISO 8601 UTC timestamp | CA's `EditDate`, preserved exactly after validation |

Important mappings include:

- `Closed (Inclement Weather)` to `access: closed`, `closureKind: inclement-weather`.
- `Closed (Air Quality)` to `access: closed`, `closureKind: air-quality`.
- `Closed (Maintenance)` to `access: closed`, `closureKind: maintenance`.
- `Closed (Unplanned)` to `access: closed`, `closureKind: unplanned`.
- `CNSL Only` to `access: restricted-program`, `closureKind: swim-team`; it is closed to general public use, not necessarily closed to the team.
- `Main Pool Only`, `Baby Pool Only`, and `Program Pool Only` to `access: partial` with an explicit available-area value.
- An unknown status to `access: unknown`; hide attendance and do not guess from wording.

Keep the complete source-to-semantic mapping in `config/status-mapping.json`. A metadata drift check must compare the live coded domain with that allowlist and alert on additions, removals, or changed labels.

### Maintenance State

Map `Status2` to an array of affected components:

- `wading-pool`
- `spa`
- `slide`
- `splashpad`
- `non-pool-amenities`
- `main-pool`

Treat both `None` and `No Ongoing Maintenance` as an empty array. An unknown maintenance value makes the maintenance portion unavailable without forcing a guessed whole-pool closure.

### Capacity And Attendance

Normalize only accepted numeric fields:

```json
{
  "attendance": 120,
  "maximumCapacity": 384,
  "remainingCapacity": 264,
  "utilizationPercent": 31.25
}
```

Rules:

- `Pool_Capacity` means the published maximum capacity. It is not current attendance and should not be described as a guaranteed fire-code limit.
- Attendance must be finite, integral unless CA confirms fractional values, and greater than or equal to zero.
- Maximum capacity must be finite and greater than zero.
- Use registry-owned plausible bounds per pool after reviewing representative values. A global emergency ceiling may catch gross corruption, but it must not replace per-pool review.
- Attendance greater than maximum capacity is invalid unless CA documents temporary over-capacity semantics. Do not clamp it.
- Calculate `remainingCapacity = maximumCapacity - attendance`.
- Calculate utilization from accepted values and round only at the API presentation boundary.
- Never use `Pool_usage_percentage` in the normalized contract.
- Hide attendance, remaining capacity, and utilization whenever attendance freshness expires, even if operating status remains visible.

## Freshness Model

Freshness has two independent clocks and the API must expose both.

| Clock | Field | Meaning |
| --- | --- | --- |
| Harvester freshness | `lastCheckedAt` | Most recent successful ArcGIS `200` or `304` check |
| Record freshness | `sourceReportedAt` | Most recent CA edit for that pool |

Do not label a pool report current merely because the container checked ArcGIS recently.

Initial policy values should be configuration with reviewed defaults, not promises embedded in labels:

- A snapshot is `current` while `lastCheckedAt` is no older than two normal poll intervals.
- A snapshot is `degraded` after two intervals and `unavailable` after the maximum service-stale window.
- Attendance has the shortest record-freshness window, proposed at 15 minutes while initially evaluating real update behavior.
- Operating and maintenance status may use a longer proposed current window, such as 30 minutes, and a bounded stale window, such as two hours.
- Capacity is relatively static but remains source-attributed and should not make stale attendance look live.
- A `304` refreshes harvester freshness but does not refresh record freshness.
- Closed hours do not delete the snapshot or advance either freshness clock. Retain the generation in memory and report its age honestly; the future web app continues to derive off-hours state from its published schedule.
- Outside the source-access window, expose `collectionState: paused-closed-hours` and the next configured source-access instant. Do not describe the absence of expected closed-hours polling as a source failure.
- Attendance becomes unavailable at its semantic expiry even though the underlying accepted record remains in the immutable snapshot. Operating and maintenance fields follow their independently approved stale limits.
- A restart begins with no live snapshot. No record may be served until a successful source check completes.

The exact attendance, status, degraded, and unavailable thresholds require a short observation period and product approval before launch.

## In-Memory Caching And Failure Semantics

### In-Memory Snapshot

Serve every request from one immutable in-memory snapshot. API requests must never wait for ArcGIS, start a refresh, or acquire the poller's network lock.

Use two required in-process cache layers and standards-based client revalidation:

1. **Normalized snapshot cache:** hold one current immutable snapshot behind an atomic reference. Readers take the reference without copying the collection or locking against one another.
2. **API representation cache:** when a new snapshot is accepted, generate or lazily memoize serialized UTF-8 response bodies and API `ETag` values by snapshot generation, route, pool ID, canonical allowlisted filters, and semantic-state epoch. Bound entries and total bytes, reject noncanonical keys, coalesce concurrent fills for the same key, and discard the prior generation only when the atomic snapshot changes. At a freshness transition, invalidate or replace only representations whose output changes; do not evict the normalized snapshot or unrelated representations merely because time passed.

Return cache headers and API `ETag` values so browsers and any future justified edge cache can revalidate successful anonymous `GET` and `HEAD` responses. Do not provision a paid edge cache for the baseline.

Do not cache errors, health, readiness, metrics, arbitrary query strings, or caller-controlled keys. The API representation cache is an optimization over the normalized memory snapshot; a miss or semantic transition performs only in-process filtering and serialization. It never reaches ArcGIS. Keep the most useful collection and per-pool representations warm across closed hours and outages. Use bounded least-recently-used eviction only under entry or byte pressure, not short absolute TTLs. With 27 records, conservative retention is inexpensive; correctness and a hard memory bound matter more than aggressive expiration.

A successful cycle should:

1. Download or confirm the source response.
2. Validate the envelope, fields, types, transfer-limit flag, and identities.
3. Normalize records into a complete registry-shaped candidate.
4. Calculate semantic status, accepted capacity fields, and freshness.
5. Validate the normalized candidate against `snapshot.schema.json`.
6. Build the immutable candidate, assign its monotonically increasing in-process generation, and calculate its collection `ETag`.
7. Atomically swap the snapshot reference and invalidate all cached API representations from the prior generation.

If validation or candidate construction fails, leave both the active snapshot and its representation cache unchanged. Never expose a partially built generation.

### Startup

- Start the HTTP server after configuration and registry validation.
- If startup occurs inside an active window, begin the first scheduled poll after jitter while coalescing all startup work through the same single-flight poller. If startup occurs outside all active windows, wait until the next opening boundary without contacting ArcGIS.
- Report readiness only after the first successful live poll produces a valid in-memory snapshot.
- Before that success, health remains live, readiness fails, and data endpoints return `503` with a stable Problem Details code. During a closed-hours startup, include the next source-access instant so the unavailable state is understandable. API requests do not accelerate the startup poll.
- Accept that a restart creates this short unavailable window. Add persistence only after measured restart behavior demonstrates a visitor need that outweighs its storage, stale-data, and recovery complexity.

### Partial Bad Data

Use two levels of rejection:

- Reject the whole cycle for an invalid envelope, truncated response, duplicate identity, implausible record-count collapse, unsupported schema, or broad mapping failure.
- For one known pool with an invalid optional field, publish the valid portions and mark the rejected portion unavailable.
- For one known pool with an invalid identity, timestamp, or status, retain its prior accepted record in the snapshot but serve only fields still permitted by their semantic stale policies; otherwise publish that configured pool with `dataState: unavailable`.
- Never silently combine a new attendance value with an old status timestamp or vice versa.

## Public API Contract

Version the contract from its first release under `/v1`. Define each route once in a typed endpoint descriptor that binds its method, path, parameters, response schemas, and handler. Generate OpenAPI 3.1 from those descriptors and the code-owned JSON Schemas; expose the resulting document at `GET /openapi/v1.json`. Generate the same document during CI and retain it as a build artifact for contract diffing rather than maintaining a second handwritten specification.

Use discriminated TypeScript response unions and exhaustive handler tests so every success and Problem Details response has matching schema metadata. Add stable operation IDs, summaries, parameter descriptions, examples, cache headers, and all documented response codes. OpenAPI generation must be a deterministic, network-free build task and must not start `src/index.ts` or the scheduler.

Provide a Swagger-compatible interactive testing page at `GET /swagger` that reads `/openapi/v1.json`. Prefer a pinned, checksum-verified static Swagger UI distribution over a reflection-based document generator or runtime package. Enable the UI by default only in local development and controlled staging. If production discovery is approved, expose the OpenAPI JSON publicly but keep the interactive UI disabled in the production application unless a later authenticated management boundary is approved. Review and update the pinned UI independently for security fixes and license obligations.

### Endpoints

| Endpoint | Purpose | Expected result |
| --- | --- | --- |
| `GET /v1/pools` | All configured pools | Complete registry-shaped collection with per-record data state |
| `GET /v1/pools/{poolId}` | One known pool by lowercase API ID | `200` even when its live data is unavailable; `404` only for an unknown ID |
| `GET /v1/closures` | Pools with a current or explicitly stale closure | Filterable operational subset, including weather, air-quality, maintenance, and unplanned closures |
| `GET /healthz` | Process liveness | No ArcGIS call; `200` while the process can serve |
| `GET /readyz` | Snapshot and scheduler readiness | `200` when serviceable, otherwise `503` |
| `GET /openapi/v1.json` | Generated OpenAPI 3.1 contract | Cacheable discovery document; no ArcGIS call |
| `GET /swagger` | Swagger-compatible interactive API tester | Local or protected staging only by default; no ArcGIS call |

Optional collection filters may include allowlisted exact values for `locationType`, `access`, `closureKind`, and `dataState`. Reject unknown query parameters instead of passing them upstream.

### Example Pool Response

```json
{
  "apiVersion": "1",
  "snapshot": {
    "lastCheckedAt": "2026-06-25T15:05:00.000Z",
    "state": "current",
    "nextScheduledCheckAt": "2026-06-25T15:10:00.000Z"
  },
  "pool": {
    "id": "wl-pl01",
    "webAppPoolId": "bwp",
    "name": "Bryant Woods Pool",
    "locationType": "outdoor",
    "dataState": "current",
    "reportedAt": "2026-06-25T15:02:18.757Z",
    "operating": {
      "access": "open-public",
      "activity": "rec-swim",
      "closureKind": "none",
      "availableAreas": []
    },
    "maintenance": {
      "affectedComponents": []
    },
    "occupancy": {
      "attendance": 120,
      "maximumCapacity": 384,
      "remainingCapacity": 264,
      "utilizationPercent": 31.25
    }
  }
}
```

Do not expose raw ArcGIS values, source URLs, ArcGIS IDs other than the reviewed `AssetID`-derived API ID, editor information, or validation diagnostics in public responses.

### HTTP Behavior

- Return `Content-Type: application/json; charset=utf-8`.
- Generate an API `ETag` from the normalized representation, independent of ArcGIS's validator, and retain it only with that in-memory snapshot generation.
- Honor `If-None-Match` and return `304` when the normalized response has not changed.
- Calculate public cache headers per representation. Cap `max-age` at 60 seconds and at the earliest included freshness transition; permit `stale-if-error` only while every included value remains within its approved stale window.
- Add `Vary: Origin` when CORS varies by approved origin. Keep filter ordering canonical so semantically identical requests share one representation-cache key.
- Include enough normalized timestamps for clients to calculate age; do not depend on a proxy-generated `Age` header.
- Allow only `GET`, `HEAD`, and `OPTIONS`; return `405` for other methods.
- Set a narrow CORS allowlist for the production and approved preview origins. Do not use reflected arbitrary origins with credentials.
- Do not use cookies, authorization headers, visitor identifiers, or personalized output.
- Apply conservative request-header and URL-size limits.
- Apply a bounded fixed-partition inbound rate limiter in process and return semantic `429` responses. Add an edge abuse-control service only after measured need justifies its standing cost.
- Return errors as `application/problem+json` using RFC 9457 Problem Details. Include only stable `type`, `title`, `status`, `detail`, `instance`, and an extension `code`; never include exceptions, source payloads, internal paths, or caller-supplied text in `detail`.

### Semantic Status And Error Matrix

| Condition | Status | Stable code and response rule |
| --- | --- | --- |
| Valid collection or known pool, including explicitly stale fields | `200 OK` | Return the normalized representation with honest snapshot and per-field state |
| Matching `If-None-Match` | `304 Not Modified` | No body; retain the representation's cache and freshness headers |
| Malformed or unknown query parameter or invalid filter value | `400 Bad Request` | `invalid_filter`; identify the rejected parameter by fixed name only |
| Unknown pool ID or route | `404 Not Found` | `pool_not_found` or `route_not_found` |
| Unsupported method on a known route | `405 Method Not Allowed` | `method_not_allowed` with an accurate `Allow` header |
| Unacceptable response media type | `406 Not Acceptable` | `not_acceptable`; the public API supports JSON only |
| Request body or unsupported media type sent where none is accepted | `415 Unsupported Media Type` | `unsupported_media_type` |
| Inbound client rate limit exceeded | `429 Too Many Requests` | `client_rate_limited` with `Retry-After`; never affects ArcGIS scheduling |
| No accepted in-memory snapshot yet or no serviceable data remains | `503 Service Unavailable` | `snapshot_unavailable` with bounded `Retry-After` and `nextSourceAccessAt` when known |
| Unexpected internal failure | `500 Internal Server Error` | `internal_error`; generic detail and correlated server-side log only |

A retained but stale snapshot normally remains a `200` because the body explicitly carries data state and may still contain useful nonexpired fields. Return `503` only when no response can satisfy the documented contract. Source `429`, `5xx`, circuit-open, and closed-hours states are operational facts, not statuses to proxy directly to visitors.

## Security And Privacy

- Run as a non-root user with a read-only root filesystem and no writable volume.
- Drop Linux capabilities, enable `no-new-privileges`, and set memory and CPU limits.
- Pin the official Deno builder image and distroless C-runtime image by digest.
- Copy only production files into the final image through a multi-stage build.
- Scan dependencies and the final image in CI.
- Restrict egress to DNS and the approved ArcGIS HTTPS host where the deployment platform permits it.
- Never store ArcGIS credentials; the reviewed source is public and read-only use requires none.
- Never log full source payloads, editor fields, response bodies, visitor IPs, or query strings.
- Log structured event codes, timing, HTTP status, byte count, validator result, accepted/rejected record counts, and snapshot state.
- Keep attendance and closure details out of Google Analytics. They are operational data, not visitor analytics.
- Confirm CA's permission, attribution, and acceptable polling rate before production use.
- Add a contact and responsible-disclosure path to the service README.

## Observability And Operations

### ArcGIS Request Events

In the default `lean` mode, emit exactly one structured JSON event after each actual ArcGIS HTTP
attempt. Successful `200` and expected `304` attempts use `info`; transient failures use `warn`;
source-safety failures that open a circuit or require operator review use `error`. A denied
operating window, unavailable permit, open circuit, or daily ceiling performs no HTTP attempt and
must not be represented as one, though a bounded state-transition event may describe the deferral.

Each attempt event uses a versioned schema and fixed values for operation, result, failure class,
and validator result. It may include duration, HTTP status, response byte count, accepted and
rejected record counts, and consecutive failures. It must never include the source URL, query
string, request or response headers, validators, response body, pool IDs, source field values,
exception messages, or stack traces. Logging is best-effort and must never change permit, circuit,
backoff, snapshot, or scheduler decisions.

Write these events as one JSON object per console line and let the deployment log sink own durable
retention. Configure the ArcGIS operational-log table through Bicep for seven days of interactive
retention with no long-term or archive retention. Seven days is a revolving diagnostic window and
a data-minimization choice; Azure includes up to 31 days in ingestion pricing, so reducing retention
does not itself reduce ingestion cost. Validate the selected Analytics-plan table supports the
seven-day setting before deployment. See the official
[Azure Monitor retention guidance](https://learn.microsoft.com/azure/azure-monitor/logs/data-retention-configure).

Do not enable automatic ArcGIS request traces in `lean` mode. Full dependency traces remain an
explicit `full`-mode upgrade after exporter, sampling, volume, and cost validation; any enabled
ArcGIS trace table should use the same seven-day diagnostic window unless Azure requires a longer
minimum.

### Metrics

Define the following low-cardinality operational signals without exposing a public metrics endpoint. In `lean` mode, represent safety-critical states through Azure platform metrics, bounded structured transition events, and health state; do not emit one log per metric sample. In approved `full` mode, export the applicable counters, gauges, and histograms through OpenTelemetry:

- `arcgis_poll_total{result}`
- `arcgis_poll_duration_seconds`
- `arcgis_response_bytes`
- `arcgis_consecutive_failures`
- `arcgis_outbound_attempt_total{operation,result}` with fixed operation and result values
- `arcgis_rate_gate_deferred_total{operation}`
- `arcgis_next_allowed_seconds{operation}`
- `arcgis_operating_window_active`
- `arcgis_next_window_seconds`
- `arcgis_circuit_state{operation,state}` with one active fixed state per operation
- `arcgis_daily_attempts{operation}`
- `arcgis_schema_drift_total`
- `pool_records_accepted`
- `pool_records_rejected`
- `snapshot_age_seconds`
- `snapshot_generation`
- `api_representation_cache_entries`
- `api_representation_cache_bytes`
- `api_representation_cache_total{result}` with bounded `hit`, `miss`, and `eviction` results
- `api_requests_total{route,status}` without pool IDs or visitor identifiers
- `api_request_duration_seconds{route}`

### Alerts

Alert on sustained conditions rather than one transient error:

- No successful source check for more than two expected intervals.
- Snapshot older than the approved maximum service-stale window.
- ArcGIS coded-domain or field-schema drift.
- Missing or duplicate expected identities.
- A sharp record-count decrease.
- Persistent validation rejection for any configured pool.
- Repeated `429`, authorization, redirect, or content-type failures.
- Any observed ArcGIS request spacing below its configured hard floor.
- Sustained rate-gate deferrals, which indicate a scheduler, diagnostic, or replica-control defect.
- Representation-cache growth beyond its configured entry or byte budget.
- More than one poller replica detected.
- Any ArcGIS attempt outside the configured operating window or above the daily ceiling.
- A circuit remaining open beyond its reviewed recovery period.

### Operational Endpoints

`/readyz` should summarize only machine-safe state:

```json
{
  "status": "degraded",
  "snapshotState": "degraded",
  "collectionState": "paused-closed-hours",
  "lastCheckedAt": "2026-06-25T15:05:00.000Z",
  "consecutiveFailures": 2,
  "nextSourceAccessAt": "2026-06-26T10:00:00.000Z"
}
```

Detailed rejected values belong in restricted logs, not health responses.

### Azure Monitor Telemetry

Use a two-level observability design so telemetry does not quietly cost more than the service.

- `lean` is the launch default: Azure platform metrics, structured ArcGIS attempt, state-transition, and failure logs, one pay-as-you-go Log Analytics workspace with seven-day table-level retention for ArcGIS operational events, and narrowly scoped log alerts for source-safety conditions. Do not provision Application Insights or enable Deno automatic request tracing in this mode.
- `full` is an approved upgrade: add workspace-based Application Insights and the Container Apps managed OpenTelemetry agent, then enable Deno's built-in OpenTelemetry export. Deno automatically instruments `Deno.serve` and `fetch`, while `npm:@opentelemetry/api@1` is needed only for reviewed custom instruments.

The full-mode implementation spike must prove protocol compatibility with the selected Deno version and Container Apps agent, route normalization, correlation, shutdown flushing, and bounded ingestion before production approval. Current Deno OpenTelemetry documentation states that automatic traces are always sampled, so do not enable full automatic tracing on the assumption that successful requests can be sampled in process. Either prove supported signal-level controls and an acceptable measured volume, place a sampling collector in an explicitly priced design, or remain in `lean` mode. In both modes, telemetry stays outside source-request decisions, structured console logs remain the diagnostic fallback, and HTTP ingress logs remain disabled unless an incident or measured gap justifies them.

Telemetry must answer these operational questions:

- Is the process available, and is the one expected replica healthy?
- Is the source-access window open or paused, and when is the next access instant?
- When did the last successful ArcGIS check and snapshot publication occur?
- Are permits, backoff, `Retry-After`, the circuit breaker, or the daily ceiling suppressing collection?
- Are source validation, schema drift, cache pressure, API failures, or latency degrading service?
- Did a deployment change request volume, memory, CPU, telemetry volume, or monthly cost?

Use fixed low-cardinality dimensions only. Never attach pool IDs, visitor addresses, arbitrary routes, query strings, source payloads, exception messages, or user-agent strings to metric dimensions. Normalize routes before telemetry leaves the process, retain failure and source-operation evidence, and emit state-transition events rather than repeated closed-hours heartbeat logs. Metric instruments should aggregate in process; do not turn every five-minute poll or health probe into multiple verbose log records. Enable request traces only when the selected Deno exporter path can meet the approved ingestion envelope.

Configure the Log Analytics workspace for pay-as-you-go ingestion and set the ArcGIS operational-log table's interactive retention to seven days through Bicep. Set a conservative daily ingestion cap and a warning below that cap after measuring normal telemetry; treat the cap as a cost circuit breaker, not as the only alert. Create a small Azure Monitor workbook only if built-in Azure Monitor views and committed KQL queries prove insufficient. Do not add Sentinel, a dedicated Log Analytics cluster, data export, long-term retention, or commitment tiers for this workload.

Use one Azure Monitor action group with reviewed email recipients and the smallest actionable alert set:

- Container App has no healthy replica or repeated restarts.
- No successful ArcGIS check for more than two expected in-window intervals.
- Circuit remains open, schema validation fails, or any out-of-window attempt is detected.
- API `5xx` rate or latency exceeds a sustained threshold.
- Log ingestion reaches its warning threshold or forecasted Azure spend exceeds the approved monthly budget.

Prefer platform metric alerts where possible and use narrowly scoped scheduled-query alerts only when no metric represents the condition. Alert evaluation and notification can incur charges, so every alert needs an owner, runbook link, severity, evaluation frequency, and removal criterion.

## Container And Deployment Plan

### Image

- Build with a multi-stage Dockerfile using an official patch-pinned `denoland/deno` builder image, pinned by digest when implementation begins.
- Copy `deno.json` and `deno.lock` before source files, resolve with the frozen lockfile, and fail on dependency drift or unapproved lifecycle scripts.
- Run format, lint, type, test, audit, and OpenAPI generation gates before `deno compile`. Compile one `linux/amd64` executable initially with required configuration, schemas, OpenAPI, and optional Swagger assets embedded.
- Use `gcr.io/distroless/cc-debian12:nonroot`, or its current reviewed successor, as the digest-pinned final base because a Deno-compiled executable still requires the C runtime.
- Copy only the compiled executable into the final stage. Do not copy Deno, source, dependency caches, a shell, package manager, compiler, test files, symbols, or standalone configuration files.
- Use the image's built-in `nonroot` user and port `8080`; declare `USER nonroot` explicitly in the final stage.
- Embed only the narrow runtime permissions approved above. Set the listener host and port through allowlisted environment variables, and set `DENO_NO_UPDATE_CHECK=1` and `DENO_NO_PROMPT=1` where applicable to build or development commands.
- Use the executable directly as `ENTRYPOINT`; do not add a shell script or init package.
- Handle `SIGTERM` by stopping new polls, aborting the active source request, finishing in-flight API responses within a bound, and closing cleanly.
- Prefer deployment-platform HTTP probes against `/healthz` and `/readyz`. Do not add a shell, `curl`, or another utility solely for Docker `HEALTHCHECK`; if the selected platform cannot probe HTTP, implement and test a bounded application health-check command without expanding the image's package surface.

Do not run `strip` against the Deno-compiled executable. Deno appends its eszip payload to the native executable, and stripping can truncate or corrupt that payload, including a documented ARM64 failure in the reference repository. Treat unexplained binary-size reduction as an integrity failure, not an optimization.

Rebuild and republish promptly for supported Deno and base-image security releases. Digest pinning makes builds reproducible but does not patch a running image, so dependency and image update automation must open a reviewed change for each new digest. Add `linux/arm64` only when a real deployment or portability requirement justifies the extra CI time and smoke-test surface.

### Ephemeral State

Keep the normalized snapshot, ArcGIS `ETag` and `Last-Modified` validators, scheduler state, and serialized API representations only in process memory. A restart discards all of them and the first successful poll rebuilds them. The first post-restart source request is therefore an unconditional collection request; later scheduled polls may use the in-memory ArcGIS validators.

Do not store raw ArcGIS payloads or normalized results. If a source incident requires evidence capture, make it an explicit restricted diagnostic action with a retention policy outside normal service behavior.

### Azure Resource Inventory

Provision this baseline and nothing more:

| Azure resource | SKU or mode | Purpose and cost boundary |
| --- | --- | --- |
| Resource group | Configurable existing or new group | Lifecycle and cost scope for the API |
| Container Apps environment | Consumption workload profile, public network | Managed ingress and replica hosting; managed OpenTelemetry agent only in `full` mode |
| Container App | `0.25 vCPU`, `0.5 GiB`, `min=1`, `max=1` | API, scheduler, and in-memory snapshot in one process |
| Log Analytics workspace | Pay-as-you-go, shortest practical retention | Bounded operational logs; Application Insights backing store only in `full` mode |
| Application Insights | Optional workspace-based `full` mode | Requests, dependencies, traces, exceptions, and metrics after a measured telemetry gate |
| Azure Monitor action group | Email notifications | Routes the small reviewed alert set |
| Azure Monitor alerts | Platform metrics first; few log alerts | Detects availability, source, error, and cost failures |
| Container Apps managed certificate | Free managed certificate | TLS for `api.pools.longreachmarlins.org` |

The baseline uses no managed identity because the container reads a public ArcGIS endpoint, pulls a public digest-pinned image, and receives its telemetry endpoint from platform configuration. Add an identity only when a concrete Azure authorization boundary requires it. Do not create an empty Key Vault or registry merely to appear enterprise-ready.

### Cloud Adoption Framework Naming

Use the Cloud Adoption Framework pattern `<resource-type>-<workload>-<environment>-<region>-<instance>` with official abbreviations and lowercase invariant components. The initial components are `workload=poolstatus`, `environment=prod`, a selected CAF region code such as `eastus2`, and `instance=001`.

| Resource | CAF abbreviation | Example name |
| --- | --- | --- |
| Resource group | `rg` | `rg-poolstatus-prod-eastus2-001` |
| Container Apps environment | `cae` | `cae-poolstatus-prod-eastus2-001` |
| Container App | `ca` | `ca-poolstatus-prod-eastus2-001` |
| Log Analytics workspace | `log` | `log-poolstatus-prod-eastus2-001` |
| Application Insights | `appi` | `appi-poolstatus-prod-eastus2-001` |
| Action group | `ag` | `ag-poolstatus-prod-eastus2-001` |

Derive these names in one Bicep naming object and validate each resource's character, length, and uniqueness constraints. If a future globally unique resource disallows hyphens, remove delimiters and append a deterministic `uniqueString` suffix while preserving the CAF component order. Apply common tags for `workload`, `environment`, `owner`, `managed-by=bicep`, `data-classification=public`, `cost-center`, and repository URL; keep mutable facts in tags rather than immutable names.

### Bicep Deployment Design

Use a subscription-scope `infra/main.bicep` so the resource group is an explicit deployment parameter rather than a hard-coded assumption. Accept at least:

| Parameter | Requirement |
| --- | --- |
| `resourceGroupName` | Required; validated CAF-compliant name of the new or existing target group |
| `createResourceGroup` | Defaults to `true`; when `false`, target the named existing group |
| `location` | Required approved Azure region with Container Apps Consumption availability |
| `environment` | Allowed values such as `dev`, `test`, and `prod` |
| `instance` | Three-digit naming component, default `001` |
| `imageDigestReference` | Required immutable `ghcr.io/...@sha256:...` reference; tags are rejected for production |
| `customDomainName` | Defaults to `api.pools.longreachmarlins.org` |
| `alertEmailReceivers` | Secure or deployment-time notification configuration; never committed with personal addresses |
| `monthlyBudgetAmount` | Required approved currency amount used for a resource-group budget and forecast alert |
| `logDailyCapGb` | Conservative bounded ingestion cap validated against Azure's supported minimum |
| `operationalLogRetentionDays` | Defaults to `7`; allowed range `4` to `30`, applied at table level with no archive retention |
| `observabilityMode` | Allowed `lean` or `full`; defaults to `lean` and conditionally provisions Application Insights and managed OpenTelemetry |

Use modules for monitoring, the Container Apps environment, the app, alerts, and the custom-domain binding. Pin stable resource API versions, enable the Bicep linter, fail warnings in CI, and run `bicep build`, `bicep lint`, and subscription-scope what-if before production. Store reviewed nonsecret production values in `prod.bicepparam`; never commit subscription IDs, personal email addresses, credentials, or registry tokens.

Create an Azure Cost Management budget at the configurable resource-group scope through Bicep. Notify at actual 50%, 80%, and 100% consumption and at a forecast threshold early enough to act. Budgets alert but do not stop resources; the runbook must identify which telemetry controls can be tightened without disabling safety signals.

All Azure resource changes, role assignments, diagnostic settings, alerts, budgets, and domain bindings belong in Bicep. A deployment workflow may execute Bicep and perform DNS preflight checks, but it must not create parallel imperative infrastructure. Keep local Docker Compose outside the Azure production path.

### Configuration

| Variable | Default | Guardrail |
| --- | --- | --- |
| `HTTP_HOST` | `0.0.0.0` | Fixed container listener; not caller-controlled routing |
| `HTTP_PORT` | `8080` | Fixed unprivileged container port |
| `POLL_ENABLED` | `true` in production | `false` for fixture-driven local development |
| `POLL_INTERVAL_SECONDS` | `300` | Minimum `300` |
| `POLL_TIMEOUT_SECONDS` | `10` | Between `2` and `30` |
| `MAX_BACKOFF_SECONDS` | `1800` | Must be at least the poll interval |
| `METADATA_INTERVAL_SECONDS` | `86400` | Minimum reviewed low-frequency interval |
| `CIRCUIT_FAILURE_THRESHOLD` | proposed `5` | Bounded reviewed range; cannot disable fail-safe behavior |
| `CIRCUIT_INITIAL_BREAK_SECONDS` | proposed `1800` | Later of this, backoff, permit, and operating-window boundary applies |
| `ARCGIS_EMERGENCY_DISABLED` | `false` | Operator kill switch; startup validates boolean syntax |
| `RESPONSE_CACHE_MAX_ENTRIES` | proposed `128` | Hard upper bound; reject invalid or excessive values |
| `RESPONSE_CACHE_MAX_BYTES` | proposed `2097152` | Hard upper bound across serialized representations |
| `ALLOWED_ORIGINS` | none | Required explicit list before browser use |
| `LOG_LEVEL` | `info` | Never enable payload logging |
| `ATTENDANCE_CURRENT_SECONDS` | proposed `900` | Product-approved range required |
| `STATUS_CURRENT_SECONDS` | proposed `1800` | Product-approved range required |
| `STATUS_MAX_STALE_SECONDS` | proposed `7200` | Must exceed current threshold |
| `OPENAPI_ENABLED` | `true` | Generated document only; does not enable Swagger UI |
| `SWAGGER_UI_ENABLED` | `true` only in development | `false` in production unless explicitly protected and approved |
| `OTEL_DENO` | unset in `lean`; `true` only in approved `full` mode | Automatic instrumentation is not enabled before its volume gate passes |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Platform-provided | Never points telemetry back to the public API |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Agent-compatible protocol | Must be supported by both the pinned Deno version and managed agent |
| `OTEL_SERVICE_NAME` | `pool-status-api` | Fixed low-cardinality service identity |

The ArcGIS host, path, layer, SQL expression, and out-field list should be code-owned constants, not environment variables. This prevents configuration from turning the service into an open proxy.

### Domain, TLS, And Network Placement

Preferred flow:

```text
Internet -> api.pools.longreachmarlins.org -> Azure Container Apps ingress -> pool-status-api:8080
pool-status-api -> services8.arcgis.com:443
```

Bind `api.pools.longreachmarlins.org` directly to the Container App generated domain with a DNS `CNAME`, plus the required `asuid.api.pools` TXT ownership record. Use a free Azure Container Apps managed certificate and terminate TLS at managed ingress. If the DNS provider offers proxying, keep this record DNS-only during issuance and renewal because the managed certificate requires the CNAME to resolve directly to the generated Container Apps hostname. Review any root-domain CAA policy and allow DigiCert when necessary.

Use a two-phase Bicep deployment because external DNS validation is not controlled by this repository:

1. Deploy the resource group, monitoring, Container Apps environment, and app; output the generated hostname and verification ID.
2. Create or verify the CNAME and TXT records at the authoritative DNS provider.
3. Run the custom-domain Bicep module to create and bind the managed certificate only after DNS preflight succeeds.

The container never manages certificates. Allow only HTTPS externally, redirect HTTP to HTTPS, keep port `8080` internal to ingress, configure the exact CNSL and approved preview CORS origins, and use the Container Apps generated hostname only for deployment verification. Cache only successful `GET` and `HEAD` responses and preserve API `ETag` behavior.

Do not add a VNet merely for outbound IP stability or theoretical egress restriction. The source is a public ArcGIS endpoint, and a VNet plus NAT Gateway or Firewall would dominate this workload's cost. Compensate with the fixed HTTPS host and path, redirect rejection, DNS and certificate validation, response validation, and the application-owned rate and operating-window gates. Revisit network egress controls only if CA requires source IP allowlisting or a formal threat review requires it.

### Cost Envelope And Guardrails

Azure Container Apps Consumption includes monthly subscription-level grants for vCPU-seconds, GiB-seconds, and requests, but those grants might be shared with other workloads and must not be treated as guaranteed project capacity. At public US-dollar rates reviewed on 2026-06-25, one continuously idle `0.25 vCPU / 0.5 GiB` replica is roughly a low-single-digit monthly compute charge after the full free grant, while a replica billed as active for the entire month is roughly in the low teens. Actual cost varies by region, agreement, active time, traffic, platform behavior, and other subscription usage; record an Azure Pricing Calculator estimate before approval and compare the first full month with it.

Azure Functions Consumption could reduce idle compute, but only by replacing the process-owned scheduler and in-memory snapshot with durable external state and event-driven execution. Linux App Service Basic carries a larger standing plan cost. Deno Deploy may be inexpensive and supports custom domains, but it changes the approved Azure, Bicep, observability, SLA, and operational boundary; evaluate it only as a separately approved non-Azure architecture, not as a drop-in host.

Rank cost optimizations by value and architectural safety:

1. Keep standard Container Apps Consumption at exactly one `0.25 vCPU / 0.5 GiB` replica until Express passes every production adoption gate. Preserve enough resident capacity for the scheduler and snapshot.
2. Keep closed-hours and between-poll work timer-driven and quiet so the replica remains below Container Apps' idle CPU and network thresholds whenever possible. Measure active and idle billed seconds after deployment.
3. Launch with `lean` observability. Add Application Insights and Deno automatic tracing only after a controlled observation proves the extra signals answer an approved operational question within the ingestion budget.
4. Keep direct Container Apps ingress, the free managed certificate, DNS-only CNAME, and public digest-pinned GHCR image. Do not add a paid proxy, gateway, registry, or DNS migration without evidence.
5. Emit state changes and failures rather than heartbeat logs, disable HTTP ingress logs by default, use the shortest practical retention, set a conservative daily cap, and prefer platform metric alerts over scheduled-query alerts.
6. Build only `linux/amd64` initially because that is the selected Azure target. Add multi-architecture publication only for an approved consumer, while retaining source-level cross-platform tests where they add value.
7. Do not keep a paid staging replica running. Use fixtures locally and create a time-bounded manual nonproduction deployment for source observation, TLS, Bicep, and telemetry validation; remove it after evidence is captured.
8. Keep one production service, one region, one revision, and no warm standby until measured availability requirements justify duplication and a durable-state redesign.

The main avoidable cost risk is telemetry ingestion, not API compute. Enforce these guardrails:

- Keep one replica and reject any Bicep parameter that sets `maxReplicas` above one.
- Request the minimum supported CPU and memory; raise either only after measured throttling, out-of-memory restarts, or latency evidence.
- Keep logs event-based and low-cardinality, leave automatic traces off in `lean` mode, disable verbose HTTP ingress logs by default, and cap daily ingestion.
- Use pay-as-you-go Log Analytics, not a commitment tier or dedicated cluster.
- Avoid ACR, Front Door, API Management, NAT Gateway, Firewall, VNet, Key Vault, storage, and availability tests unless a measured requirement pays for their standing cost.
- Review Cost Analysis, telemetry ingestion, replica active/idle time, and alert charges weekly during observation and monthly after stabilization.
- Treat an unexplained cost increase as an operational incident with a named owner and runbook.

## Future Web-App Integration Boundary

The static web app is a later phase and is not part of the container implementation.

When authorized, it should:

1. Render annual pool summaries and schedule-derived status exactly as it does now.
2. Start one API collection request only after `summary-visible`.
3. Query `/v1/pools?locationType=outdoor`, not one endpoint per card.
4. Validate the API version and response shape in a DOM-free browser service.
5. Join records by reviewed `webAppPoolId` or an explicit annual-ID-to-API-ID map.
6. Update only the existing live-status regions and expanded details.
7. Preserve focus, card disclosure state, filters, sort order, and scroll position.
8. Settle `optional-enrichment-settled` on success, timeout, invalid data, or failure.
9. Hide stale attendance and clearly distinguish reported CA status from schedule-derived status.
10. Continue linking to CA's Pool Guide for official confirmation.

The browser must not fall back to direct ArcGIS access if the API fails. That would defeat the request budget and trust boundary.

The API endpoint should be a reviewed web-app configuration value. The service should not be precached by the PWA, and the service worker must not present an old live response as current after an offline restart.

## Testing Strategy

### Service Unit Tests

Use deterministic fixtures for:

- Valid complete response.
- `304 Not Modified`.
- Timeout, DNS failure, `429`, `5xx`, redirect, HTML response, and ArcGIS error object.
- Oversized and truncated responses.
- Missing, duplicate, unknown, and malformed `AssetID`.
- Missing expected record and implausible record-count collapse.
- Every known status and maintenance mapping.
- Unknown status and new coded-domain value.
- Null, negative, fractional, non-finite, over-capacity, and implausible numeric values.
- Future, invalid, missing, current, stale, and expired timestamps.
- Stale published utilization that disagrees with attendance and capacity.
- Atomic snapshot publication, generation invalidation, bounded representation-cache hit, miss, eviction, and concurrent-read behavior.
- Single-flight polling, monotonic permit spacing, no burst accumulation, jitter bounds, backoff, `Retry-After`, and graceful shutdown.
- Failed, timed-out, canceled, metadata, and restricted diagnostic attempts consuming the correct permit without automatic retry.
- Long scheduler pauses and wall-clock jumps producing no catch-up burst.
- Eastern operating-window boundaries, closed days, season boundaries, overrides, midnight clamping, exact close exclusion, and daylight-saving dates using the generated artifact.
- Collection, metadata, and diagnostic paths making zero ArcGIS attempts before lead-in, at or after close, or when the artifact is missing or invalid.
- Closed-hours restart, next-window wakeup, and opening resumption issuing at most one jittered request with no catch-up burst.
- Circuit open, half-open single probe, emergency disable, daily ceiling, failure-class isolation, and gate rechecks immediately before send.
- Snapshot and useful representation retention across closed hours and prolonged outages, with attendance and status changing output only at their semantic boundaries.
- Empty startup behavior proving that concurrent API requests return `503` without triggering or duplicating ArcGIS retrievals.

### API Contract Tests

Invoke the composed `Request => Response` handler directly with an in-memory fixture snapshot, fake clock, and disabled poller; add a small real `Deno.serve` loopback suite for listener and shutdown wiring. Verify:

- Collection, single-pool, closure, unknown-pool, unavailable-snapshot, health, readiness, and telemetry boundaries.
- Exact semantic relationships rather than full serialized snapshots.
- JSON Schema and generated OpenAPI 3.1 compatibility for every response class.
- `ETag`, conditional `304`, cache, content negotiation, CORS, method, semantic status, RFC 9457 Problem Details, and stable error-code behavior.
- `/openapi/v1.json` describes every route, typed success, Problem Details response, parameter, example, and cache header without starting the poller.
- `/swagger` loads the pinned UI and can exercise fixture-backed endpoints in development while remaining unavailable when disabled.
- Unknown filters, oversized URLs, hostile path values, and unsupported methods.
- No raw ArcGIS fields or private operational values cross the public contract.

### Container Tests

- Build the image from the service directory.
- Assert the final image uses the `nonroot` user, contains no shell or package manager, and has only the compiled executable and expected C-runtime files.
- Run as the declared non-root user with all capabilities dropped, a read-only filesystem, and no writable volume.
- Verify health, readiness, signal shutdown, empty restart behavior, and no filesystem writes.
- Verify the executable has only the approved Deno environment and network permissions and cannot read files, write files, spawn subprocesses, use FFI, or contact an unapproved host.
- Flood all public routes during startup, normal operation, cache misses, and source failure; assert ArcGIS request counts remain scheduler-owned and bounded.
- Simulate source failures, `429`, manual diagnostics, task delays, clock changes, and container restart policy; verify the documented request ceilings and no-overlap invariant.
- Run across closed and opening boundaries and assert zero out-of-window DNS or HTTP attempts, one opening attempt at most, circuit behavior, and retained snapshot service.
- Verify polling disabled mode uses fixtures and makes no external request.
- Run `deno audit` against the frozen dependency graph and scan the final image for known vulnerabilities and unintended files.
- Verify the compiled executable was not stripped and starts successfully from the distroless image.
- Record compressed image size and fail when unexplained growth exceeds an approved budget.
- Verify image architecture for the intended host platform before deployment.

### Bicep And Azure Contract Tests

- Run `bicep build`, `bicep lint`, and a subscription-scope what-if with nonproduction parameters.
- Assert all names derive from the CAF naming object, the configurable resource group is honored, required tags exist, and production image references require a digest.
- Assert the Container App uses Consumption, `0.25 vCPU / 0.5 GiB`, single-revision mode, external HTTPS ingress, Dapr disabled, and exactly one minimum and maximum replica.
- Assert no unapproved high-standing-cost resource type appears in the compiled template.
- Verify workspace retention, diagnostic categories, telemetry cap, action group, focused alerts, and resource-group budget match reviewed bounds.
- Verify the first deployment outputs the generated hostname and verification ID, while the domain-binding module fails safely until external DNS is correct.
- After an authorized test deployment, verify managed-certificate renewal prerequisites, CORS, health probes, selected-mode telemetry flow and ingestion volume, and zero public `/metrics` or production `/swagger` exposure.
- In `lean` mode, verify Application Insights and the managed OpenTelemetry agent are absent; in `full` mode, verify they are conditionally present and remain under the measured ingestion envelope.

### Future Browser Tests

Only after web-app integration is authorized, add focused tests for:

- Primary pool summaries remain usable while the API is paused.
- One collection request enriches all matching cards.
- Current, stale, unavailable, malformed, and timeout paths.
- Weather, air quality, maintenance, unplanned, partial-facility, and team-only semantics.
- Focus, disclosures, filters, sorting, and scroll survive a targeted update.
- Keyboard behavior and automated accessibility checks across affected states.
- Offline startup does not show an old live response as current.
- Performance phases, request count, bytes, and PWA behavior remain within reviewed bounds.

## CI And Repository Integration

When implementation begins:

- Create a separate `pool-status-api` repository with its own ownership, branch protection, dependency policy, release process, and Azure environment approvals.
- Commit `deno.json` and `deno.lock`, pin one Deno 2 patch across local development, CI, and the builder image, and resolve dependencies with the frozen lockfile.
- Run `deno fmt --check`, `deno lint`, `deno check src/ tests/`, permission-minimized `deno test`, focused coverage, `deno audit`, OpenAPI generation and validation, `deno compile`, image build, container smoke tests, and image scan on each API pull request.
- Use `denoland/setup-deno` with dependency caching keyed by `deno.lock`; pin every GitHub Action by full commit SHA and keep the Deno version explicit rather than floating on `v2.x`.
- Generate OpenAPI 3.1 at build time, fail on an unreviewed contract diff, validate it with a current standards-aware validator, and archive the generated document. Ensure document generation cannot start background harvesting.
- Import the versioned operating-window artifact from this repository through a pinned release or reviewed automation contract; verify its provenance and semantic equivalence without granting the API repository write access to CNSL.
- Pin Swagger UI by immutable release and checksum, preserve its license, scan its static assets, and fail if the configured distribution differs from the reviewed version.
- Run Bicep lint, build, policy tests, and what-if; require human approval of production what-if output and cost-impacting resource changes.
- Generate an SBOM and signed provenance, publish to GitHub Container Registry, sign the immutable image digest, and pass only that digest to Bicep.
- Use GitHub Actions OpenID Connect federation for Azure deployment rather than a stored client secret. Grant the deployment principal only the subscription or configurable resource-group permissions required by the approved Bicep scope.
- Deploy infrastructure and the image from the API repository only after Azure environment approval. Keep the existing GitHub Pages workflow completely independent.
- Validate `https://api.pools.longreachmarlins.org/healthz`, certificate state, telemetry flow, and one-replica enforcement after deployment without issuing an out-of-window ArcGIS request.
- Pin GitHub Actions by full commit SHA under the repository's workflow policy.

## Implementation Phases

### Impact And Effort

| Workstream | Visitor and operational impact | Estimated effort | Main risk or dependency |
| --- | --- | --- | --- |
| Source approval and observation | High | Medium | CA permission, attribution, cadence, and field semantics remain external decisions |
| Shared operating-window artifact | High | Medium | Browser and service scheduling must remain equivalent across annual changes and daylight-saving boundaries |
| Identity and semantic contracts | High | Medium | A wrong mapping could publish a valid value for the wrong pool or audience |
| Harvester and validation | High | High | The publicly editable source requires strict failure boundaries and drift detection |
| In-memory caching and freshness | High | Medium | Cached data must remain useful during an outage without appearing newer than CA reported it |
| Read-only API | High | Medium | Contract stability, caching, and CORS determine whether later clients can rely on it |
| Azure Bicep and domain | High | Medium | Configurable scope, CAF names, DNS validation, TLS, and one-replica enforcement must remain repeatable |
| Observability and cost controls | High | Medium | Telemetry must detect source failures without becoming the main monthly expense |
| Container hardening and deployment | Medium | Medium | Compiled-binary integrity, Deno permission scope, telemetry compatibility, and rollback need an operational owner |
| Nonproduction observation | High | Medium | Real update timing must validate the proposed freshness windows before launch |
| Future web-app enrichment | High | High | Accessibility, offline behavior, performance, and fallback semantics cross existing pool workflows |

The highest-risk work is the source trust boundary, identity mapping, and freshness model. Complete those contracts before investing in public UI. Container packaging is necessary but should follow, rather than lead, the data-semantics work.

| Phase | Scope | Exit evidence |
| --- | --- | --- |
| 0. Source and product approval | Obtain CA reuse, attribution, polling, and read-only endpoint guidance; observe update cadence; approve freshness and visitor semantics | Written decisions with no unresolved source-authority or request-budget question |
| 1. Contract fixtures | Capture sanitized representative fixtures; define registry, semantic mappings, JSON Schemas, generated operating-window artifact, and OpenAPI contract | Reviewed fixtures and equivalence tests fail on source, schedule, or contract drift |
| 2. Harvester core | Implement fixed ArcGIS client, operating-window and hard outbound rate gates, timeout, conditional requests, validation, normalization, scheduler, circuit breaker, and backoff | Focused tests prove no closed-hours calls, request spacing, no bursts, no overlap, and safe success and failure paths |
| 3. In-memory caches | Implement atomic immutable snapshots, conservatively retained bounded generation-scoped response caching, conditional API responses, and semantic-state transitions | Concurrency and request-count tests prove expiration and cache misses never retrieve from ArcGIS |
| 4. Read-only API | Implement versioned pool, single-pool, closure, health, readiness, internal metrics, generated OpenAPI 3.1, Problem Details, and controlled Swagger UI endpoints | OpenAPI, Swagger, and HTTP contract tests pass with no raw-source leakage |
| 5. Container hardening | Add rootless multi-stage image, read-only filesystem support, health probes, signal handling, resource limits, and scan | Container smoke, restart, shutdown, and security checks pass |
| 6. Azure infrastructure | Implement modular Bicep for configurable resource-group scope, CAF naming, Container Apps Consumption, monitoring, budget, alerts, and two-phase domain binding | Lint, compiled-template policy tests, what-if, and authorized test deployment pass |
| 7. Nonproduction observation | Run one controlled poller, compare normalized output with CA's guide, tune freshness and telemetry, and verify request and cost estimates | Observation log demonstrates bounded traffic, telemetry ingestion, and acceptable semantics |
| 8. Production API launch | Deploy the signed digest to `api.pools.longreachmarlins.org` with managed TLS, CORS, monitoring, alerting, budget, and rollback | Operational owner accepts certificate, dashboards, alerts, runbook, request budget, and monthly cost envelope |
| 9. Optional web-app integration | Add the separate browser consumer after API stability is proven | Focused unit, browser, accessibility, PWA, and performance evidence passes |

## Pre-Implementation Decisions

- [ ] Ask CA whether a public query-only hosted feature view exists or can be created.
- [ ] Obtain written permission for reuse, attribution wording, and a five-minute minimum interval between collection attempts.
- [ ] Confirm whether `AssetID` is intended to remain stable across pool renames and service migrations.
- [ ] Confirm the meaning and update behavior of `Pool_Attendance`, `Pool_Capacity`, and `EditDate`.
- [ ] Confirm whether attendance may validly exceed capacity or contain fractions.
- [ ] Observe updates across opening, normal operation, weather closure, maintenance, and nightly close.
- [ ] Approve the weather-banner operating-window contract and generated service artifact as the sole source-access schedule.
- [ ] Approve attendance, operating-status, degraded-snapshot, and maximum-stale thresholds.
- [ ] Approve the semantic mapping for all 20 status values and 8 maintenance values.
- [ ] Approve whether the public API includes all 27 pools or exposes indoor facilities only through an explicit filter.
- [ ] Approve Azure Container Apps Consumption, one `0.25 vCPU / 0.5 GiB` replica, the selected region, and the operational owner.
- [ ] Reevaluate Azure Container Apps Express against its current feature matrix, region availability, SLA, Bicep contract, custom-domain support, probes, revision controls, observability, and always-resident cost; use standard Consumption until every adoption gate passes.
- [ ] Approve the configurable production resource-group name, CAF naming components, tags, Azure deployment principal, and Bicep what-if approvers.
- [ ] Confirm control of `api.pools.longreachmarlins.org`, its CNAME and TXT records, CAA compatibility, and the free managed-certificate owner.
- [ ] Approve GitHub Container Registry visibility and retention; if the package must be private, approve and price the replacement authentication or registry design.
- [ ] Decide whether CA's approved limit must survive arbitrary process restarts; if so, approve a durable egress rate gate or shared coordinator before launch.
- [ ] Approve `lean` or `full` observability; if `full`, verify the pinned Deno version, compiled executable, and Container Apps agent export correlated logs, metrics, traces, and dependencies within the measured ingestion envelope.
- [ ] Approve telemetry signal controls, shortest practical retention, daily cap, action-group recipients, alert thresholds, and the initial monthly budget amount.
- [ ] Approve the public CORS origins and in-process client rate limits.
- [ ] Approve whether production exposes `/openapi/v1.json` and whether `/swagger` remains disabled or is access-controlled.
- [ ] Decide whether nonproduction environments may ever make live ArcGIS calls.

## Acceptance Criteria For Future Implementation

- [ ] Exactly one scheduled collection query is possible at a time, independent of API traffic.
- [ ] Every ArcGIS path is start-inclusive and close-exclusive within the generated Eastern operating window; collection, metadata, and diagnostics make zero out-of-window calls.
- [ ] Missing, invalid, closed-day, and out-of-season operating-window configuration fails closed, and opening after an idle period cannot create a catch-up burst.
- [ ] Configuration cannot lower the ArcGIS interval below the approved minimum.
- [ ] Every ArcGIS send requires a monotonic outbound permit; failed and diagnostic attempts consume permits and no automatic HTTP retry exists.
- [ ] Collection permits cannot accumulate, source operations cannot overlap, and delayed work cannot create catch-up bursts.
- [ ] Metadata waits for one hour of continuous uptime, runs no more than once per 24 hours, and is deferred into an active operating window.
- [ ] The source request uses a fixed HTTPS host, path, query, field allowlist, and no geometry.
- [ ] No editing method, credential, ArcGIS SDK, or caller-controlled upstream query exists.
- [ ] Every configured pool has one unique reviewed source identity and one stable API identity.
- [ ] Unknown, duplicate, missing, truncated, malformed, and hostile source data fails closed.
- [ ] Published utilization is ignored and occupancy calculations use only accepted attendance and capacity.
- [ ] Poll time and CA report time remain separate throughout in-memory caching and API output.
- [ ] Attendance expires sooner than operating status and is never made current by a `304` or restart.
- [ ] API requests are served from an immutable snapshot without waiting for ArcGIS.
- [ ] Last known-good data survives a short outage and becomes visibly degraded or unavailable on schedule.
- [ ] The normalized snapshot remains in memory across closed hours and outages; only semantically changed representations are replaced, and no short TTL aggressively clears useful state.
- [ ] A restart begins unavailable and only a successful scheduled source check creates the first live snapshot.
- [ ] Cache misses, expiration, filtering, health, readiness, metrics, and concurrent demand cannot trigger ArcGIS retrievals.
- [ ] Snapshot publication is atomic, response caches are generation-scoped and bounded, and failed candidates leave the active generation unchanged.
- [ ] Public responses expose only normalized allowlisted fields and stable machine-readable errors.
- [ ] Semantic statuses and RFC 9457 Problem Details distinguish invalid requests, missing resources, client throttling, and true service unavailability without proxying source failures.
- [ ] Collection, single-pool, closure, health, readiness, caching, CORS, method, OpenAPI 3.1, and controlled Swagger UI behavior match the generated contract.
- [ ] Circuit, backoff, `Retry-After`, emergency disable, daily ceiling, replica, and restart safeguards prevent repeated or concurrent source pressure.
- [ ] The image runs non-root with a read-only filesystem and no writable volume.
- [ ] The compiled Deno executable is unstripped, embeds only approved assets, and grants only allowlisted environment and network permissions with no filesystem, subprocess, FFI, or broad system access.
- [ ] Logs and metrics contain no raw payloads, editor data, visitor identifiers, or pool-level request labels.
- [ ] Modular Bicep provisions the configurable resource group, CAF-compliant names, one Consumption replica, managed domain certificate, monitoring, alerts, and budget with no unapproved fixed-cost services.
- [ ] `api.pools.longreachmarlins.org` serves valid managed TLS through a direct CNAME, while the generated hostname is not the documented client endpoint.
- [ ] The approved observability mode answers the operational questions with low-cardinality telemetry and remains below the approved cap and budget; `full` mode additionally proves Deno-to-Application-Insights correlation and measured trace volume.
- [ ] Separate-repository CI proves unit, contract, container, Bicep, dependency, image, provenance, what-if, and post-deployment checks without coupling deployment to GitHub Pages.
- [ ] A runbook covers closed-hours behavior, ArcGIS outage, circuit-open recovery, emergency disable, daily ceiling, `429` handling, rate-gate deferrals, crash-loop backoff, schema drift, bad records, stale snapshot, cache pressure, restart unavailability, duplicate pollers, certificate renewal, telemetry cap, cost alert, rollback, and source retirement.
- [ ] The future web app performs one API collection request, never falls back to ArcGIS, and preserves existing schedule-derived behavior when enrichment is unavailable.

## Rollback And Retirement

- The container can be rolled back independently because the static web app does not depend on it until a later release.
- Preserve at least the prior known-good image and API contract during rollout.
- If the source changes incompatibly, open the circuit, stop publishing new snapshots, retain the existing in-memory generation, serve only fields still allowed by their semantic stale policies, then return `snapshot_unavailable` when no serviceable representation remains.
- If CA revokes permission or retires the service, disable polling and remove the live web-app integration while preserving annual schedule behavior.
- Do not leave a browser fallback to ArcGIS, a dormant editing client, an unowned API hostname, or an indefinitely stale snapshot after retirement.
