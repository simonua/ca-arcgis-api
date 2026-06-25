# Schema Boundary

This directory will own JSON Schemas for source responses, normalized snapshots, configuration
artifacts, and API responses. Schemas are reviewable contract artifacts and CI inputs; they do not
replace explicit runtime trust-boundary validation.

Schema changes require representative positive, negative, boundary, and hostile fixtures. Do not
loosen a schema to accept a newly observed source value until authoritative evidence and the
corresponding normalization decision are reviewed.
