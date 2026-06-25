---
name: arcgis-source-review
description: 'Perform a bounded, evidence-led review of the Columbia Association ArcGIS pool source contract, fields, domains, identities, metadata, validators, reuse terms, or drift.'
argument-hint: 'State the exact source-contract question and whether modeled file changes are requested.'
user-invocable: false
---

# ArcGIS Source Review

This workflow supports deliberate manual review. It does not authorize recurring collection or
replace the runtime source budget.

## Preflight

1. Read the current integration plan, relevant configuration or schema, and prior evidence before
   making a request.
2. State the exact question, minimum official destinations, expected request count, and whether the
   work is report-only.
3. Confirm the request is permitted by the current operating-window and source-approval policy. If
   permission or reuse authority is unclear, stop and report the blocker.
4. Use only the fixed official host and paths documented in the plan. Never exercise editing or
   administrative capabilities.

## Collection

1. Make requests sequentially and stop as soon as the question is resolved.
2. Prefer metadata or a field-limited fixed query over full payloads.
3. Record retrieval time in `America/New_York`, status, content type, validators, and relevant
   source ownership.
4. Reject redirects to unapproved origins, non-JSON content where JSON is expected, oversized
   responses, ArcGIS error envelopes, and truncated feature results.
5. Do not commit raw response bodies or retain unrelated fields.

## Evaluation

- Compare authoritative metadata, observed values, and application mappings separately.
- Seek corroborating official evidence when available.
- Classify conclusions as `High`, `Moderate`, or `Unresolved`.
- A changed observed record does not by itself authorize a schema, registry, or status-mapping
  change.
- Preserve the current model when evidence conflicts or remains ambiguous.

## Modeled Changes

When explicitly requested and supported by high-confidence evidence:

1. Update the canonical configuration or schema owner.
2. Add or adjust the smallest sanitized fixture and focused tests.
3. Record provenance, normalization rationale, conflicts considered, and residual uncertainty in the
   owning documentation.
4. Run focused validation plus `deno task verify` when shared contracts change.

## Report

Include the source set, exact request count, observations, confidence, accepted or deferred
decisions, files changed, and checks run. Identify reuse, attribution, read-only-view, or product
approvals that remain open.
