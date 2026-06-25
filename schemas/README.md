# Schema Boundary

This directory owns generated JSON Schemas for the fixed source response, normalized snapshot, and
public API responses. Future reviewed configuration artifacts will add their schemas here. Schemas
are reviewable contract artifacts and CI inputs; they do not replace explicit runtime
trust-boundary validation.

Run `deno task schemas:generate` after changing a code-owned schema contract. CI and
`deno task verify` run `deno task schemas:check` and fail when a generated artifact is missing or
stale. Do not edit generated schema JSON by hand.

Schema changes require representative positive, negative, boundary, and hostile fixtures. Do not
loosen a schema to accept a newly observed source value until authoritative evidence and the
corresponding normalization decision are reviewed.
