---
applyTo: 'src/**/*.ts'
description: 'Use when changing request handling, URL construction, remote data, caching, or any trust boundary in service TypeScript.'
---

# Secure Code Quality Conventions

## Trust Boundaries

- Validate environment values and reviewed JSON configuration before constructing dependencies or
  starting the server.
- Treat every ArcGIS envelope, feature, field, header, timestamp, domain code, and HTTP status as
  untrusted.
- Parse JSON into `unknown`; narrow it through explicit validators before normalization. Do not use
  unchecked type assertions to turn source data into domain types.
- Build API output from normalized application-owned models. Never spread source feature attributes
  into a response.

## Source Requests

- Construct the source URL from fixed constants with `URL` and `URLSearchParams`.
- Require the approved HTTPS origin and exact service path before send and after any response URL
  normalization. Reject redirects.
- Request only the approved fields and set `returnGeometry=false`.
- Enforce timeout and byte ceilings while reading the body. Reject truncated results, ArcGIS error
  envelopes, unsupported content types, non-finite numbers, invalid timestamps, duplicate
  identities, and unknown contract changes.
- Keep validation, circuit, no-overlap, permit, and operating-window decisions outside generic HTTP
  helpers so no caller can silently bypass them.

## HTTP Responses

- Use allowlisted routes, methods, filters, and canonical cache keys.
- Return RFC 9457 Problem Details with stable application-owned error codes. Do not expose source
  payloads, stack traces, configuration values, or internal destinations.
- Build headers with structured APIs. Reject control characters and do not reflect arbitrary request
  headers or query values.
- Keep data endpoints read-only and independent of source collection. A response-cache miss may
  serialize the current snapshot but may never call ArcGIS.

## Regression Coverage

- Add focused accepted, rejected, boundary, timeout, oversize, redirect, hostile-input, and
  stale-data tests when a trust boundary changes.
- Assert semantic outcomes and side effects: no source send occurred, a prior snapshot remained
  active, unsafe data was omitted, or a stable error code was returned.
- Keep security fixtures small and synthetic. Do not copy live source records into tests.
