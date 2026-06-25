---
applyTo: '{config,schemas,tests/fixtures}/**/*.{json,jsonc,md}'
description: 'Use when changing source contracts, mappings, registries, operating windows, schemas, or ArcGIS-derived test fixtures.'
---

# Data and Source Contract Conventions

- Configuration files are reviewed source inputs, not implementation conveniences. Each active JSON
  artifact needs a schema, deterministic validation, provenance, and focused tests.
- Increase evidence certainty before changing modeled values or schemas. Inspect the current
  authoritative first-party source that owns the field and corroborate it with another official
  representation when one exists.
- Resolve source conflicts by ownership, specificity, explicit scope, and currency. Do not decide by
  majority vote or search-result prominence.
- Accept a modeled change only with high confidence and no unresolved contradiction. Otherwise
  preserve the current model, record the uncertainty, and identify the clarification needed.
- `AssetID` is the source identity candidate. API IDs and display names belong to the reviewed
  registry, not to unvalidated ArcGIS presentation fields.
- Unknown identities, status codes, maintenance values, missing expected records, duplicates, and
  transfer truncation are drift signals. Do not automatically publish them.
- Never add unapproved fields, geometry, attachments, editor identities, global IDs, form links, or
  complete live source snapshots to configuration or fixtures.
- `operating-windows.json` must be generated from the same CNSL annual schedule interpretation as
  the web app, with exact UTC boundaries. Runtime code must not independently reinterpret annual
  schedules.
- Generated artifacts must be byte-deterministic and checked against their source owner in CI once
  generation is implemented.
- Use the `arcgis-source-review` skill for deliberate live source-contract or coded-domain reviews.
  Routine tests and agent validation remain offline.
