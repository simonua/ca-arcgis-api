---
applyTo: '{src,tests}/**/*.ts'
description: 'Use when creating or changing TypeScript source or tests. Covers strict typing, side-effect boundaries, semantic ownership, and Deno conventions.'
---

# TypeScript Conventions

- Keep `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` enabled.
- Use explicit domain types for source candidates, normalized records, snapshots, freshness, circuit
  states, and API representations. Keep source and API models separate.
- Prefer discriminated unions and immutable data over boolean combinations or mutable state bags.
- Give application-owned states, actions, error codes, routes, durations, limits, and status values
  one semantic owner. Do not repeat behavior literals across modules and tests.
- Inject clocks, monotonic time, timers, randomness, fetch, and configuration. Concentrate
  `Deno.env`, signals, network access, and process lifecycle in composition boundaries.
- Use `Date` or epoch values only for civil instants and source timestamps; use injected monotonic
  time for permit spacing, elapsed time, and uptime.
- Prefer pure functions for parsing, validation, normalization, freshness calculation, cache-key
  construction, and response descriptors.
- Use `unknown` at external boundaries. Avoid `any`, non-null assertions, broad casts, and
  exceptions as ordinary control flow.
- Name modules for one cohesive responsibility. Add an abstraction only when it owns a stable
  contract or removes demonstrated duplication.
- Export only supported module boundaries. Keep helpers private unless another module has a current,
  tested need.
- Keep comments for non-obvious intent and invariants. Document exported contracts and observable
  errors without narrating implementation steps.
