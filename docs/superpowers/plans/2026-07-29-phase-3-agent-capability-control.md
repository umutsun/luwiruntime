# Phase 3 Agent and Capability Control Implementation Plan

> Binding inputs: root `AGENTS.md`, ADRs 0004–0006, Phase 1 and Phase 2 designs,
> and the approved Phase 3 specification supplied on 2026-07-29.

**Goal:** Add a filesystem-canonical, Redis-projected local control plane for agent
definitions, project bindings, capabilities, native configuration planning/apply/rollback,
and static context inventory without weakening the Phase 1/2 runtime.

**Architecture:** Public contracts remain in `@luwi/protocol`; deterministic merge, policy,
and state-machine logic stays in `@luwi/runtime`; all Redis layouts stay in `@luwi/redis`;
native format knowledge is isolated in the single new `@luwi/adapters` package; filesystem
mutation, operation locks, snapshots, receipts, and reconciliation are composed by the
daemon. CLI and MCP remain daemon clients.

**Dependencies:** Reuse Node filesystem/crypto APIs and Zod. Add a maintained TOML parser
only if official Codex configuration fixtures prove TOML parsing is required. Do not add a
YAML parser unless an adapter fixture proves a supported native YAML surface.

## Slice 1 — Protocol contracts

- Add `packages/protocol/src/control-plane.ts` and tests.
- Define AgentDefinition, ProjectAgentBinding, CapabilityPackage/Binding/Profile,
  provenance, effective config, native inspection, ConfigPlan/Change/Snapshot,
  operation receipt, drift, context source/footprint, filters, payloads, and safe errors.
- Extend RuntimeEvent types with Phase 3 events and bounded payload validation.
- Run focused protocol tests.

## Slice 2 — Runtime compilation and policy

- Add `packages/runtime/src/capability-resolution.ts` and tests.
- Implement deterministic precedence, tombstones, stable ordering, dependency/version/
  compatibility conflicts, profile expansion, and provenance.
- Add config-plan, management-mode, operation, rollback, reconciliation, and context
  estimation modules with fake-clock tests.
- Run focused runtime tests.

## Slice 3 — Canonical manifests

- Add daemon filesystem abstractions and `canonical-manifests.ts`.
- Validate global/project roots, manifest hashes, scope, IDs, timestamps, and path
  containment.
- Use temporary fake homes/projects in tests; reject symlink/junction escape.

## Slice 4 — Adapter package and fixtures

- Create `packages/adapters` with one public `src/index.ts`.
- Define injected filesystem, executable resolver, command runner, detection/inspection,
  support-matrix, import, render-plan, and validation contracts.
- Add fixture-only Codex, Claude Code, Gemini CLI, and Kimi adapters.
- Passive inspection must not execute scripts/hooks/plugins/MCP servers.

## Slice 5 — Agent, binding, capability, and profile repositories

- Extend Redis key registry for all Phase 3 projections/indexes.
- Add repository read/write projection code with protocol validation.
- Add event persistence through the existing global/project Streams.
- Keep canonical manifests on disk; Redis records hashes/metadata only.
- Add isolated Redis integration tests.

## Slice 6 — Effective configuration and context inventory

- Compose canonical manifests and Redis operational metadata into deterministic effective
  configurations.
- Add context scanning for approved roots and adapter-discovered instruction sources.
- Label all token counts `estimated` / `generic-character-estimate`.
- Detect exact hash duplicates only.

## Slice 7 — Config engine

- Add inspection/import/render planning with redacted stable diffs.
- Add TTL plan projection and one-time approval-token hash.
- Add per-target process/file operation locks.
- Add snapshot, sibling temporary writes, fsync where supported, atomic rename, operation
  receipt, rollback-plan, drift scan, and startup/doctor reconciliation.
- Test failures before rename, after file commit, and during Redis projection update.

## Slice 8 — Daemon HTTP and lifecycle

- Add bounded Phase 3 routes and services.
- Guard mutations with existing readiness/in-flight tracking.
- Keep filesystem canonical when Redis update fails and transition to
  `reconciliation_required`/degraded where consistency is not provable.
- Reconcile incomplete receipts during owned startup before readiness.

## Slice 9 — CLI

- Add the approved agent, project-agent, capability, profile, config, and context commands.
- Apply requires plan ID, one-time approval token, and confirmation/`--yes`.
- Validate every response through protocol schemas.

## Slice 10 — MCP

- Preserve all Phase 2 tools.
- Add the eight approved read-only Phase 3 tools and optional plan-create/get only.
- Do not expose apply, rollback apply, Redis, credentials, or filesystem writes.
- Use bounded structured output contracts.

## Slice 11 — Documentation and demonstrations

- Add design, ADR 0007, ADR 0008, and sandbox demo guide.
- Update root contract, README, architecture overview, environment example, CLI/MCP docs,
  and roadmap.
- Run the complete Phase 1/2/3 demos against local Redis using only temporary fixture homes.

## Slice 12 — Completion gates

- Run `pnpm format`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
  `pnpm test:integration`, and `pnpm build`.
- Audit secrets, logs, tracked generated state, real agent homes, Redis contents,
  unsupported-feature claims, and deferred Smart Context Optimization wording.
- Request independent review; remediate every Critical/Important finding.
- Leave changes uncommitted and unpushed.
