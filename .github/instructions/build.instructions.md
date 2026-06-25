---
description: 'Use when working with Deno configuration, local development, formatting, linting, type checking, testing, CI, compilation, or container builds.'
---

# Build and Development Conventions

## Toolchain

- Use the exact Deno version in `.github/workflows/ci.yml`; update local development, CI,
  documentation, builder images, and compiled artifacts together.
- Prefer Deno and Web platform APIs. Do not add a package manager or Node.js compatibility solely
  for tooling convenience.
- Keep dependency resolution frozen in CI once imports exist, and commit `deno.lock` whenever
  dependency metadata changes.

## Commands

| Command | Purpose |
| --- | --- |
| `deno task fmt` | Format repository-owned files |
| `deno task fmt:check` | Verify formatting without edits |
| `deno task lint` | Run Deno's recommended lint rules |
| `deno task check` | Type-check service and tests |
| `deno task test` | Run deterministic tests with ambient permissions denied |
| `deno task verify` | Run the current complete repository gate |

Before adding a new task, prefer composing a deterministic Deno command. Keep tasks platform-neutral
and suitable for PowerShell and GitHub-hosted Linux runners.

## Scope

- During iteration, run the exact changed test file or the smallest affected group with
  `deno test --no-prompt <paths>`. Deno denies permissions unless a command explicitly grants them.
- Run `deno task lint` and `deno task check` after executable TypeScript changes.
- Run `deno task verify` after shared configuration, contract, task, or CI changes and when the user
  requests the complete gate.
- Do not grant network, environment, filesystem, subprocess, FFI, or system permissions to tests
  merely to make them pass. Inject the dependency.

## Generated Output

- Keep compiled binaries, coverage, test results, container exports, Bicep build output, and
  deployment results out of source control.
- Never edit generated OpenAPI, schema, operating-window, or compiled artifacts by hand after
  generators exist. Change the source owner and regenerate deterministically.
