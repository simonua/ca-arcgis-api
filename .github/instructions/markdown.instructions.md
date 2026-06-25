---
applyTo: '**/*.md'
description: 'Use when creating or changing Markdown. Covers repository markdownlint and focused documentation validation.'
---

# Markdown Conventions

- Treat `.markdownlint.jsonc` as the shared Markdown style configuration and use the recommended
  `DavidAnson.vscode-markdownlint` extension for live diagnostics.
- Markdown linting is a design-time aid. Do not add Node.js or a package manager solely to lint
  Markdown in CI unless explicitly requested.
- Resolve markdownlint diagnostics in every changed Markdown file before completion.
- Preserve logical heading hierarchy, add language identifiers to fenced code blocks, and keep
  tables, lists, and links consistent with nearby documentation.
- Use task-list syntax for verification checklists, acceptance criteria, and pre-work approvals. Use
  plain bullets for descriptive lists and numbered lists for ordered procedures.
- Do not broaden a focused change solely to reformat unrelated documentation. Report a pre-existing
  diagnostic when fixing it would exceed the requested scope.
- Verify links and file references affected by the change. Domain correctness remains owned by the
  applicable plan, instruction, agent, or skill.
