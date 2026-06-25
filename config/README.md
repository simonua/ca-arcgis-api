# Configuration Boundary

This directory will own reviewed, non-secret service inputs:

- `operating-windows.json`: generated exact UTC source-access windows derived from CNSL's active
  annual schedules.
- `pool-registry.json`: reviewed ArcGIS `AssetID` to API identity mappings.
- `source-contract.json`: fixed source host, path, field allowlist, limits, and schema expectations.
- `status-mapping.json`: reviewed ArcGIS coded-domain to API semantic mappings.

Do not add placeholder records or infer production values. Every committed configuration artifact
must have a schema, deterministic validation, provenance, and focused tests before it becomes
active.
