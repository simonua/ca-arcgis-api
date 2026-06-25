---
name: ca-arcgis-api-code-retirement
description: 'Retire obsolete CA ArcGIS API code and compatibility paths during refactors, schema changes, route replacements, configuration migrations, dependency cleanup, and technical-debt work.'
argument-hint: 'Describe the replacement and legacy surface to retire.'
user-invocable: false
---

# CA ArcGIS API Code Retirement

Use this workflow whenever a new implementation supersedes old behavior. The goal is one current
contract plus only temporary compatibility boundaries with verified consumers and objective removal
conditions.

## Classification

- **Current contract:** Used by the active service, reviewed configuration, published API, current
  deployment, or a documented approved consumer.
- **Temporary migration:** A verified current consumer needs the old contract during an explicit
  transition.
- **Obsolete:** No verified consumer remains, or retention is supported only by tests, fixtures,
  comments, historical possibility, unused exports, or speculative future use.

A temporary migration must name its consumer, owner, supported scope, removal condition, and focused
coverage. If those facts cannot be established, remove it.

## Procedure

1. Name the replacement and every superseded route, payload, field, state, flag, environment value,
   cache key, schema, or fallback.
2. Search definitions and references across source, alternate paths, tests, fixtures, configuration,
   schemas, OpenAPI, Bicep, container files, dependencies, documentation, monitoring, and deployment
   examples.
3. Use history only when needed to distinguish a supported contract from an abandoned
   implementation. Current runtime and published contracts outweigh old implementation history.
4. Classify each surface. A test does not prove a production compatibility requirement unless it
   represents a verified consumer.
5. Define the deletion boundary before editing, including support code and operational registrations
   that exist only for the legacy path.
6. Isolate any temporary migration at one narrow input boundary. Do not spread two representations
   through normalization, snapshots, routing, or caching.
7. Remove obsolete surfaces in the same change. Update tests to the current contract and
   intentionally test legacy migration or rejection where it matters.
8. Search again for retired symbols, values, fields, routes, variables, and dependency names.
   Investigate every remaining match.
9. Run the narrowest complete verification for all affected contracts and materially different
   paths.
10. Report removed surfaces and every intentionally retained compatibility path with its evidence
    and removal condition.

## Guardrails

- Do not remove source rate, operating-window, circuit, one-replica, freshness, privacy, security,
  or API contracts without explicit migration evidence and regression coverage.
- Do not keep permissive validators, aliases, no-op flags, commented code, or production hooks
  solely for tests.
- Do not add an abstraction merely to hide old and new paths. Migrate callers and delete the
  obsolete owner.
- Do not rewrite historical audit or deployment evidence to make retirement appear complete.
