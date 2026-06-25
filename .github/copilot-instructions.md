---
applyTo: '**'
---

# Project Overview

`ca-arcgis-api` is the Deno service boundary between Columbia Association's public ArcGIS
pool-status layer and approved consumers, including the CNSL web app. It will poll one fixed
upstream query on a bounded schedule, validate and normalize untrusted records, retain one immutable
in-memory snapshot, and expose a small read-only API.

Offline service implementation is authorized under
`docs/live-pool-status-integration-plan.md`. Implementation work does not authorize live ArcGIS
access, a public API, container publication, Azure resources, DNS changes, or production deployment.

## Continuing Reference

- Treat `https://github.com/simonua/cnsl` as the continuing reference for repository governance,
  focused verification, evidence standards, code retirement, customization structure, and workflow
  security.
- Follow `docs/repository-alignment.md` and the `cnsl-alignment` skill when comparing or syncing
  conventions.
- Adapt CNSL patterns to this Deno service. Do not copy its PostHTML, PWA, browser analytics, SEO,
  seasonal-data publication, or GitHub Pages behavior.

## Architecture

- Runtime: the exact Deno 2 patch used by CI, with strict TypeScript and native Web APIs.
- Composition: `src/index.ts` owns configuration loading, dependency construction, server startup,
  one scheduler, and idempotent shutdown.
- Domain boundaries: configuration, source validation, normalization, caching, HTTP, and telemetry
  remain independently testable and side-effect-light.
- State: one immutable in-memory snapshot; no database, result file, history store, or persistent
  volume in version 1.
- Infrastructure: Bicep only; one Azure Container App replica in version 1.
- Tests: `Deno.test` with injected clocks, fetchers, timers, and sanitized fixtures; no live network
  traffic.

## Critical Rules

- Keep text files UTF-8 with LF endings and exactly one final LF. Follow `.editorconfig` and
  `.gitattributes`.
- Use Deno tasks and built-in tooling. Do not add Node.js, npm scripts, a web framework, an ArcGIS
  SDK, or a general validation dependency without a reviewed need.
- Treat ArcGIS responses, configuration files, environment values, paths, query values, and request
  headers as untrusted at their boundary.
- The ArcGIS request must use one fixed HTTPS host, path, query expression, field allowlist, and
  response-size limit. Never accept a caller-supplied upstream URL, field list, SQL expression, or
  refresh request.
- No public request, health check, readiness check, cache miss, startup probe, documentation route,
  or diagnostic may bypass the scheduler and source-send gates.
- Validate the operating window before every ArcGIS operation and again immediately before send.
  Outside an approved window, perform no ArcGIS DNS lookup or HTTP request.
- Put one monotonic permit gate and one shared no-overlap lock immediately in front of all approved
  ArcGIS sends. Failures consume permits; no automatic retries or hidden resilience handlers.
- Tests and routine agent verification must never contact ArcGIS, Azure, CNSL production, or the
  deployed API. Use injected fixture fetchers.
- Emit at most one bounded structured event per actual ArcGIS HTTP attempt. Preserve stable failure
  evidence without URLs, query strings, headers, payloads, source values, exception messages, or
  stack traces; telemetry failures must never affect source-request decisions.
- Never persist ArcGIS snapshots, validators, attendance history, request history, or visitor data
  in version 1.
- Do not expose raw source records, geometry, editor identities, global IDs, form links,
  attachments, or fields outside the approved normalized contract.
- Preserve the distinction between `lastCheckedAt` and each record's `sourceReportedAt`. A
  successful poll must not make old source data appear newly reported.
- Keep exactly one replica until polling and snapshot ownership are redesigned around shared
  coordination and storage.
- Provision and modify production infrastructure only through Bicep. Do not add imperative
  production resource creation.
- Keep secrets, credentials, real environment files, source snapshots, and production resource
  identifiers out of the repository.
- Pin GitHub Actions to full commit SHAs with release comments and give workflows only required
  permissions.
- Run only change-scoped tests locally. Expand by naming affected modules or contracts, not by
  running broad suites for reassurance. CI owns the complete current gate.
- Make retirement part of every replacement. Remove obsolete code, tests, fixtures, configuration,
  schemas, dependencies, registrations, and documentation in the same change unless a verified
  consumer and removal condition justify a temporary boundary. Use the
  `ca-arcgis-api-code-retirement` skill.
- Normalize customizations whenever instructions, agents, or skills change. Keep each shared policy
  in one canonical owner, update `.github/agents/README.md` when routing changes, and remove stale
  duplicated text.
- For refactoring audits, update only `docs/refactoring-plan.md`, use the CNSL-style
  red/orange/green impact-effort matrix and phased roadmap when findings exist, and remove completed
  findings.

## Verification

- Documentation/customization-only changes: run focused Markdown validation and check links and
  frontmatter; no service test is required unless commands or executable configuration changed.
- TypeScript changes: run exact affected tests, `deno task lint`, and `deno task check`.
- Deno configuration, shared contracts, or release candidates: run `deno task verify`.
- Bicep changes: format, lint, build, and run a deployment what-if against an explicitly approved
  non-production scope before any deployment request.
- Container changes: build the image, inspect its permissions and user, and run fixture-backed
  health/readiness checks. Do not enable live ArcGIS access for routine verification.

Report exact commands and test files executed. Disclose checks that could not run; do not claim
live-source, Azure, security, or deployment validation without evidence.
