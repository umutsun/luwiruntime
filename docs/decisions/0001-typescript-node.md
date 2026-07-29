# ADR 0001: TypeScript on Node.js

- Status: Accepted
- Date: 2026-07-28

## Context

LUWI needs a cross-platform local daemon, CLI, shared protocol types, strict
boundary validation, and one developer workflow for Windows, macOS, and Linux.

## Decision

Use Node.js 22 or newer, TypeScript in strict mode, ESM, and pnpm workspaces. Keep
the repository as normal workspace projects without Turborepo until workspace
scripts prove insufficient.

## Consequences

Daemon, CLI, protocol, and domain packages share one language and build graph.
Runtime validation is still required because TypeScript types are erased. Users
must install a supported Node.js and pnpm version.
