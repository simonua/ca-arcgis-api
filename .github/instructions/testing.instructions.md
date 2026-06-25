---
applyTo: 'tests/**/*.ts'
description: 'Use when writing or changing Deno tests, fixtures, fakes, or contract assertions.'
---

# Testing Conventions

## Philosophy

- Tests must fail for broken semantic behavior, trust boundaries, source budgets, freshness, API
  contracts, or integration wiring, not for harmless logging prose or private implementation order.
- Assert the narrowest stable public boundary. Prefer normalized values, state transitions,
  source-send counts, timestamps, headers, problem codes, and relationships over snapshots of large
  objects.
- Cover representative positive, negative, boundary, fallback, stale, and hostile-input cases.

## Isolation

- Use `Deno.test` with ambient permissions denied. Tests must not contact live services, read real
  environment files, sleep, or depend on wall-clock time.
- Inject fake wall and monotonic clocks, timers, deterministic jitter, fixture fetchers, and
  in-memory handlers.
- Keep source fixtures under `tests/fixtures/`, sanitized and limited to approved fields.
- A test fixture is not evidence that a source value is current or approved. Source-contract changes
  require the separate evidence workflow.

## Scope

- Name the exact changed tests during local iteration:
  `deno test --no-prompt tests/<area>/<module>.test.ts`. Deno denies permissions unless the command
  explicitly grants them.
- Widen only to specific consumers or alternate paths demonstrated by imports, shared contracts,
  failures, or observed behavior.
- Run `deno task verify` for shared test infrastructure, Deno configuration, or release-candidate
  changes; CI owns routine complete-suite execution.

## Required Behaviors

- Prove denied operating windows, permits, open circuits, daily ceilings, and concurrent operations
  produce zero source sends.
- Prove failures leave the last accepted immutable snapshot unchanged.
- Prove a `304` advances harvester freshness without changing source report timestamps.
- Prove data endpoint traffic never initiates collection.
- Prove unknown identities and domain values are quarantined or made unavailable according to the
  reviewed contract, never guessed.
- Prove attendance disappears at its semantic expiry without deleting the retained snapshot.
