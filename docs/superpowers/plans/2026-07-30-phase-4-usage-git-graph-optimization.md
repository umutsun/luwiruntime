# Phase 4 Usage, Git, Graph, and Optimization Implementation Plan

> Execute with red-green-refactor. Run the listed focused test after each
> behavioral increment. Do not commit, tag, or push without explicit
> authorization.

**Goal:** Deliver local, Redis-derived usage intelligence, read-only Git and
package observation, a provenance-preserving operational graph, and a
human-approved context optimization loop that reuses Phase 3 ConfigPlans.

**Architecture:** Keep schemas in `@luwi/protocol`, deterministic policy in
`@luwi/runtime`, projections in `@luwi/redis`, execution/orchestration in the
daemon, and HTTP-only clients in CLI/MCP. Extend the owned Redis Function
library only where record/index/aggregate/event atomicity is required.

**Dependencies:** Use the existing Node.js standard library, Zod, Redis client,
Fastify, Commander, MCP SDK, Vitest, and `smol-toml`. Add no production
dependency unless an implementation blocker is proven.

## Slice 1 — Protocol contracts

- Add `packages/protocol/src/intelligence.ts`.
- Add `packages/protocol/src/intelligence.test.ts`.
- Export all Phase 4 schemas/types from `packages/protocol/src/index.ts`.
- Extend `packages/protocol/src/runtime-event.ts` and its tests with the
  approved normalized events.
- Cover source/confidence labels, optional values, total consistency, context
  contributions, Git/package/technology/attribution records, graph bounds,
  proposal/evaluation state, collections, route params, and safe errors.
- Run `pnpm test -- packages/protocol/src/intelligence.test.ts
packages/protocol/src/runtime-event.test.ts`.

## Slice 2 — Runtime usage policy

- Add `packages/runtime/src/usage-intelligence.ts`.
- Add `packages/runtime/src/usage-intelligence.test.ts`.
- Implement normalization, record identity, compatible totals, source
  composition, UTC day buckets, static/observed separation, and summary
  aggregation without missing-as-zero behavior.
- Export from `packages/runtime/src/index.ts`.
- Run `pnpm test -- packages/runtime/src/usage-intelligence.test.ts`.

## Slice 3 — Context contribution policy

- Add `packages/runtime/src/context-intelligence.ts`.
- Add `packages/runtime/src/context-intelligence.test.ts`.
- Implement loading-mode normalization, assigned/effective/loaded/invoked
  distinctions, static estimate conversion, and evidence-window summaries.
- Run `pnpm test -- packages/runtime/src/context-intelligence.test.ts`.

## Slice 4 — Read-only Git observer

- Add `apps/daemon/src/git-observer.ts`.
- Add `apps/daemon/src/git-observer.test.ts`.
- Implement argument-array allowlist, timeout/output bounds, credential
  redaction, porcelain status, branch/HEAD/default, worktrees, tags, recent
  commits, changed paths, and LUWI trailer parsing.
- Tests use temporary repositories and prove no mutation/network command.
- Run `pnpm test -- apps/daemon/src/git-observer.test.ts`.

## Slice 5 — Package and technology inventory

- Add `apps/daemon/src/package-inventory.ts`.
- Add fixtures beneath `apps/daemon/src/fixtures/intelligence/`.
- Add `apps/daemon/src/package-inventory.test.ts`.
- Parse the approved ecosystems from bounded files without executing package
  managers or scripts; derive evidence-backed technologies.
- Run `pnpm test -- apps/daemon/src/package-inventory.test.ts`.

## Slice 6 — Attribution and module mapping

- Add `packages/runtime/src/git-attribution.ts`.
- Add `packages/runtime/src/git-attribution.test.ts`.
- Add `packages/runtime/src/module-mapping.ts`.
- Add `packages/runtime/src/module-mapping.test.ts`.
- Implement exact/correlated/estimated/unknown policy and deterministic
  repository-relative file/module IDs.
- Run `pnpm test -- packages/runtime/src/git-attribution.test.ts
packages/runtime/src/module-mapping.test.ts`.

## Slice 7 — Redis taxonomy and atomic usage ingestion

- Extend `packages/redis/src/redis-keys.ts` and tests.
- Extend `packages/redis/src/function-registry.ts`,
  `packages/redis/src/function-library.ts`, and loader/registry tests without
  weakening Phase 1–3 Functions.
- Add `packages/redis/src/intelligence-repository.ts`.
- Add `packages/redis/src/intelligence-repository.test.ts`.
- Add `packages/redis/src/intelligence-repository.integration.test.ts`.
- Atomically persist immutable usage records, indexes, compatible aggregates,
  and global/project events. Add validated CRUD/projection operations for Git,
  packages, technologies, contributions, attributions, findings, proposals,
  evaluations, and rebuild operations.
- Run the focused Redis unit tests, then the integration file with
  `LUWI_TEST_REDIS_URL` and shared-Function opt-in.

## Slice 8 — Graph identity, projection, and bounded queries

- Add `packages/runtime/src/operational-graph.ts`.
- Add `packages/runtime/src/operational-graph.test.ts`.
- Implement deterministic node/edge IDs and traversal limit policy.
- Add Redis generation-scoped node/edge/adjacency operations and projection
  failure health.
- Test node lookup, incoming/outgoing filters, shortest path, subgraph, hard
  limits, and provenance.
- Run runtime and Redis graph-focused tests.

## Slice 9 — Shadow graph rebuild

- Add `packages/redis/src/graph-rebuild.integration.test.ts`.
- Add daemon rebuild orchestration to the intelligence service.
- Build into a unique shadow generation, validate, atomically swap the active
  pointer, retain the old graph until cleanup, and record bounded failure
  diagnostics.
- Run graph rebuild integration tests.

## Slice 10 — Structural findings and proposals

- Add `packages/runtime/src/context-optimization.ts`.
- Add `packages/runtime/src/context-optimization.test.ts`.
- Implement approved structural finding rules, evidence minimums, action
  allowlist, state machine, and non-causal evaluation wording.
- Run `pnpm test -- packages/runtime/src/context-optimization.test.ts`.

## Slice 11 — Daemon intelligence service

- Add `apps/daemon/src/intelligence-service.ts`.
- Add `apps/daemon/src/intelligence-service.test.ts`.
- Compose usage ingestion, contribution analysis, scans, attribution, graph
  projection/rebuild, analysis/proposals, and evaluation.
- Integrate accepted deterministic actions with
  `apps/daemon/src/config-control-service.ts`; acceptance alone must not write.
- Add configuration defaults and tests to `apps/daemon/src/config.ts`.
- Wire repositories and lifecycle in `apps/daemon/src/runtime.ts`.
- Run service/config/runtime focused tests.

## Slice 12 — HTTP routes

- Add the approved Phase 4 routes to `apps/daemon/src/app.ts`.
- Add `apps/daemon/src/app-phase4.test.ts`.
- Validate all body/path/query bounds, readiness, project/session relations,
  safe errors, realtime summaries, Redis loss, and draining behavior.
- Run `pnpm test -- apps/daemon/src/app-phase4.test.ts`.

## Slice 13 — CLI

- Add `apps/cli/src/intelligence-cli.ts`.
- Add `apps/cli/src/intelligence-cli.test.ts`.
- Register all approved usage/context/Git/package/technology/graph/optimization
  commands from `apps/cli/src/cli.ts`.
- Label exact, reported, estimated, unavailable, correlated, and simulated
  values.
- Run CLI focused tests.

## Slice 14 — MCP read-only intelligence

- Add Phase 4 MCP schemas to protocol.
- Extend `apps/mcp-server/src/daemon-client.ts`, `tools.ts`, and `server.ts`.
- Extend MCP tests for project/session scope, graph bounds, read-only tools,
  optional analysis request, and absence of accept/apply/rebuild/Git mutation.
- Run `pnpm test -- apps/mcp-server/src`.

## Slice 15 — Retention and recovery

- Add configurable retention keys/settings and bounded cleanup.
- Add Redis integration coverage for earliest retained observation,
  authoritative provenance preservation, projection failure, and Phase 1–3
  Function compatibility.
- Extend daemon recovery/draining tests for intelligence projection health.
- Run focused retention and lifecycle integration tests.

## Slice 16 — Demonstration and documentation

- Add `examples/phase4-demo.mjs`.
- Add the `demo:phase4` root script.
- Add `docs/guides/phase-4-intelligence-demo.md`.
- Add ADR 0009, ADR 0010, and ADR 0011.
- Update `AGENTS.md`, `README.md`, `docs/architecture/overview.md`,
  `.env.example`, CLI/MCP documentation, and roadmap status.
- The demo must use temporary repositories/fake telemetry and execute every
  required Phase 4 observation and Phase 3 approval/apply/evaluate step.

## Slice 17 — Verification and review

- Run `pnpm format`.
- Run `pnpm typecheck`.
- Run `pnpm lint`.
- Run `pnpm test`.
- Run Redis integration tests with the explicit dedicated URL.
- Run `pnpm build`.
- Run complete Phase 1, Phase 2, Phase 3, and Phase 4 demos.
- Audit Redis for source/prompt/credential leakage and the diff for generated
  files, secrets, deferred features, second datastores, Pub/Sub, Git mutation,
  and dependency creep.
- Request an independent code review, address findings with focused tests,
  rerun the full suite, and report final Git status without committing.
