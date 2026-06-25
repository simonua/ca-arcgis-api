---
applyTo: 'infra/**/*.{bicep,bicepparam,json,md}'
description: 'Use when creating or changing Azure Bicep, environment parameters, resource naming, or deployment documentation.'
---

# Bicep Infrastructure Conventions

- Bicep is the only production infrastructure source. Do not add Terraform, imperative creation
  scripts, or portal-only configuration as a second owner.
- Keep resource-group placement and naming configurable and follow the Cloud Adoption Framework
  abbreviation source checked into `infra/` when implemented.
- Preserve the approved baseline: Consumption workload profile, one `0.25 vCPU / 0.5 GiB` replica,
  `minReplicas: 1`, `maxReplicas: 1`, single-revision mode, external HTTPS ingress, no Dapr, and
  least-cost compliant monitoring.
- Do not add ACR, API Management, Front Door, Redis, a database, storage, private networking, or
  another paid service without measured need, an explicit priced decision, and an update to the
  architecture plan.
- Use managed identity and least privilege where Azure access is needed. Do not put secrets or
  credentials in Bicep, parameters, outputs, or deployment logs.
- Pin the container image by digest in production and keep registry visibility and authentication
  explicit.
- Parameter files may contain non-secret environment choices only. Keep subscription IDs, tenant
  IDs, resource IDs, DNS validation values, and production endpoints out of committed defaults
  unless they are intentionally public contracts.
- Format, lint, and build every changed Bicep file. Run `what-if` only against an explicitly
  approved scope, report replacements and deletes, and never deploy without a separate explicit
  request.
