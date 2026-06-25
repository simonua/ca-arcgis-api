# Refactoring Plan

Audited: 2026-06-25

## Scope

Repository scaffolding, customization ownership, Deno validation, CNSL alignment, and the offline
harvester scheduling, snapshot, semantic freshness, bounded representation-cache, injected runtime,
read-only HTTP API, and generated OpenAPI boundaries were reviewed. Production process composition,
container packaging, and Azure infrastructure are not yet implemented.

## Active Recommendations

There are no active refactoring recommendations. Remaining implementation work must continue to
satisfy the proposal gates and repository guardrails rather than treating this empty-state plan as
authorization for live source access or deployment.

## Guardrails

- Do not contact ArcGIS from tests, health checks, browser requests, or outside approved operating
  windows.
- Do not edit generated artifacts or introduce secrets, source snapshots, attendance history, or
  production resource identifiers.
- Keep production infrastructure Bicep-only and the version 1 deployment at exactly one replica.
- Preserve focused verification and remove completed findings rather than retaining audit history in
  this plan.
