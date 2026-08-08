# Phase 2 Agent Communication and MCP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable same-project session request/reply, recoverable inbox delivery,
bounded waits/timeouts, bridge simulation, and a thin stdio MCP adapter without weakening
Phase 1.

**Architecture:** Redis Functions atomically mutate authoritative message projections,
indexes, inbox Streams, and global/project Runtime events. The daemon is the sole Redis
owner; CLI, bridges, and MCP use validated loopback HTTP only. Per-session consumer groups
provide at-least-once recovery while existing realtime delivery remains a non-authoritative
wake-up path.

**Tech Stack:** Node.js 22+, TypeScript ESM, pnpm workspaces, Zod 4, Fastify 5, Redis 7
Functions/Streams, Vitest, Commander, official `@modelcontextprotocol/sdk` 1.29.x.

## Global constraints

- Preserve Phase 1 APIs, Redis Functions, lifecycle, loopback security, and realtime relay.
- Use only standard Redis and no Pub/Sub or additional datastore.
- Keep messaging modules inside existing packages; add only `apps/mcp-server`.
- Add no production dependency except the official MCP SDK in the MCP application.
- Use tests first and observe the focused test fail before production implementation.
- Do not commit, tag, push, or touch `temp/alice-shell-bridge-legacy`.
- Never log message bodies, complete responses, prompts, secrets, memory, or environment
  dumps.

---

### Task 1: Protocol message and inbox contracts

**Files:**

- Create: `packages/protocol/src/message.ts`
- Create: `packages/protocol/src/message.test.ts`
- Create: `packages/protocol/src/mcp.ts`
- Create: `packages/protocol/src/mcp.test.ts`
- Modify: `packages/protocol/src/runtime-event.ts`
- Modify: `packages/protocol/src/runtime-event.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Produces:** Strict public schemas for message states/kinds, evidence, response, create/list/
wait/transition inputs and outputs, inbox envelopes/claim results, MCP inputs/outputs, and all
Phase 2 event names.

- [ ] Add failing schema tests for valid values, exclusive target selectors, UTF-8 size
      limits, evidence count, confidence, strict objects, and safe errors.
- [ ] Run `pnpm test packages/protocol/src/message.test.ts packages/protocol/src/mcp.test.ts`
      and confirm missing exports fail.
- [ ] Implement the smallest strict schemas and exported inferred types.
- [ ] Add all eight message event types and validate representative envelopes.
- [ ] Run the focused protocol tests and existing protocol regression tests.

### Task 2: Runtime state, routing, fingerprint, and timeout policy

**Files:**

- Create: `packages/runtime/src/message-state.ts`
- Create: `packages/runtime/src/message-state.test.ts`
- Create: `packages/runtime/src/message-routing.ts`
- Create: `packages/runtime/src/message-routing.test.ts`
- Create: `packages/runtime/src/message-policy.ts`
- Create: `packages/runtime/src/message-policy.test.ts`
- Create: `packages/runtime/src/message-timeout-sweeper.ts`
- Create: `packages/runtime/src/message-timeout-sweeper.test.ts`
- Modify: `packages/runtime/src/index.ts`

**Produces:** `evaluateMessageTransition`, `selectTargetSession`,
`createMessageRequestFingerprint`, UTF-8 policy helpers, and a fake-clock-testable timeout
sweeper.

- [ ] Write the complete transition matrix tests, including unchanged and terminal results.
- [ ] Verify RED, implement the explicit adjacency policy, and verify GREEN.
- [ ] Write deterministic routing/same-project/online tests, verify RED, implement, verify
      GREEN.
- [ ] Write canonical fingerprint and byte-policy tests, verify RED, implement, verify GREEN.
- [ ] Write timeout candidate/race-result tests around a repository interface, verify RED,
      implement, verify GREEN.

### Task 3: Redis taxonomy and Function registry

**Files:**

- Modify: `packages/redis/src/redis-keys.ts`
- Modify: `packages/redis/src/redis-keys.test.ts`
- Modify: `packages/redis/src/function-registry.ts`
- Modify: `packages/redis/src/function-registry.test.ts`
- Modify: `packages/redis/src/function-library.ts`
- Modify: `packages/redis/src/function-loader.test.ts`

**Produces:** Central constructors for message/index/deadline/inbox/terminal keys and registry
names for eight Phase 2 Functions while retaining every Phase 1 name.

- [ ] Add failing key/registry tests for every required taxonomy entry and safe key part.
- [ ] Implement key and registry extensions; run focused tests.
- [ ] Add a failing Function-loader compatibility test for the upgraded expected function
      set/hash.
- [ ] Increment the Function library version while retaining Phase 1 registrations.

### Task 4: Atomic message creation and idempotency

**Files:**

- Create: `packages/redis/src/message-repository.ts`
- Create: `packages/redis/src/message-repository.test.ts`
- Create: `packages/redis/src/message-request.integration.test.ts`
- Modify: `packages/redis/src/function-library.ts`
- Modify: `packages/redis/src/index.ts`

**Produces:** `MessageRepository.createMessage/getMessage/listMessages` and
`luwi_message_request_v1`.

- [ ] Write unit parsing/command-shape tests and Redis integration tests for projection,
      indexes, inbox append, correlation, idempotent retry, conflict, routing revalidation,
      Redis TIME, event identity, and preflight failure.
- [ ] Run focused tests and confirm RED.
- [ ] Implement strict stored parsing and the request Function with all key/state/type
      preflight before first write.
- [ ] Verify focused unit/integration tests and Phase 1 Function compatibility.

### Task 5: Inbox bootstrap, claim, and pending recovery

**Files:**

- Create: `packages/redis/src/session-inbox.ts`
- Create: `packages/redis/src/session-inbox.test.ts`
- Create: `packages/redis/src/session-inbox.integration.test.ts`
- Modify: `packages/redis/src/function-library.ts`
- Modify: `packages/redis/src/runtime-repository.ts`

**Produces:** Session inbox group creation at `0-0`, recovered-before-new claim, strict
envelope validation, terminal request skipping, response notification delivery, and safe
pending semantics.

- [ ] Add failing tests for registration bootstrap, no cursor reset, XAUTOCLAIM order,
      XREADGROUP order, malformed entries, terminal skip/ACK, and pending requests.
- [ ] Implement the inbox command boundary and session-registration bootstrap.
- [ ] Verify focused tests and all Phase 1 session-registration tests.

### Task 6: Message delivery and non-terminal transitions

**Files:**

- Modify: `packages/redis/src/message-repository.ts`
- Modify: `packages/redis/src/message-repository.test.ts`
- Create: `packages/redis/src/message-transitions.integration.test.ts`
- Modify: `packages/redis/src/function-library.ts`

**Produces:** delivered, acknowledged, and processing transitions that preserve inbox
pending state and emit no duplicate event when unchanged.

- [ ] Add failing unit/integration tests for allowed, invalid, idempotent, terminal, responder,
      and pending-count behavior.
- [ ] Implement the three Functions and repository methods.
- [ ] Verify focused unit/integration tests.

### Task 7: Terminal response, reject, and fail transitions

**Files:**

- Modify: `packages/redis/src/message-repository.ts`
- Modify: `packages/redis/src/message-repository.test.ts`
- Modify: `packages/redis/src/message-transitions.integration.test.ts`
- Modify: `packages/redis/src/function-library.ts`

**Produces:** Atomic response/reject/fail, source notification, deadline removal, target
XACK, bounded response storage, and event persistence.

- [ ] Add failing tests for correct responder, mismatch, terminal idempotence, source inbox,
      target XACK, event IDs, and preflight atomicity.
- [ ] Implement terminal Functions and strict result parsing.
- [ ] Verify focused tests.

### Task 8: Timeout race and message/inbox retention

**Files:**

- Create: `packages/redis/src/message-retention.ts`
- Create: `packages/redis/src/message-retention.test.ts`
- Create: `packages/redis/src/message-timeout.integration.test.ts`
- Modify: `packages/redis/src/message-repository.ts`
- Modify: `packages/redis/src/function-library.ts`
- Modify: `packages/redis/src/index.ts`

**Produces:** Redis-authoritative timeout, response/timeout race safety, source notification,
target XACK, terminal cleanup selection, idempotency TTL, and pending/lag-aware inbox trim.

- [ ] Add failing timeout race/Redis TIME tests and retention command-policy tests.
- [ ] Implement timeout Function/repository method and retention service.
- [ ] Verify focused tests.

### Task 9: Daemon services and configuration

**Files:**

- Create: `apps/daemon/src/message-service.ts`
- Create: `apps/daemon/src/message-service.test.ts`
- Create: `apps/daemon/src/inbox-service.ts`
- Create: `apps/daemon/src/inbox-service.test.ts`
- Create: `apps/daemon/src/message-waiters.ts`
- Create: `apps/daemon/src/message-waiters.test.ts`
- Modify: `apps/daemon/src/config.ts`
- Modify: `apps/daemon/src/config.test.ts`

**Produces:** Target discovery, message orchestration, bounded Redis-authoritative waits,
claim orchestration, and all Phase 2 environment defaults.

- [ ] Write failing service/config tests for routing, limits, wait wake/timeout/abort, claim
      limits, and safe error mapping.
- [ ] Implement services behind narrow repository interfaces.
- [ ] Verify focused tests.

### Task 10: HTTP routes and lifecycle integration

**Files:**

- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/src/app-phase1.test.ts`
- Create: `apps/daemon/src/app-messages.test.ts`
- Modify: `apps/daemon/src/runtime.ts`
- Modify: `apps/daemon/src/runtime.test.ts`
- Modify: `apps/daemon/src/runtime.integration.test.ts`

**Produces:** All message/list/get/wait/transition and inbox claim routes, readiness guards,
timeout/retention scheduling, reconnect/recovery, waiter interruption, and bounded draining.

- [ ] Add failing route tests for validation, target selection, errors, bounded wait, and
      responder ownership.
- [ ] Add failing lifecycle tests for sweeper scheduling, degradation, recovery, and drain.
- [ ] Implement routes and runtime composition without a second relay.
- [ ] Verify focused daemon tests and Phase 1 daemon regression tests.

### Task 11: CLI message and inbox commands

**Files:**

- Create: `apps/cli/src/message-client.ts`
- Create: `apps/cli/src/message-client.test.ts`
- Modify: `apps/cli/src/cli.ts`
- Modify: `apps/cli/src/cli.test.ts`

**Produces:** `message ask/list/get/await/acknowledge/processing/respond/reject/fail` and
`inbox claim`.

- [ ] Add failing command generation, response validation, idempotency header, wait, and
      safe-error tests.
- [ ] Implement commands using daemon HTTP only.
- [ ] Verify focused CLI and Phase 1 CLI tests.

### Task 12: Recoverable bridge simulator

**Files:**

- Create: `apps/cli/src/bridge-simulator.ts`
- Create: `apps/cli/src/bridge-simulator.test.ts`
- Modify: `apps/cli/src/cli.ts`
- Modify: `apps/cli/src/cli.test.ts`

**Produces:** `session bridge simulate` manual/echo/status-responder modes with restart-safe
claim, duplicate handling, explicit simulated evidence, and signal handling that does not
close the registered coding session by default.

- [ ] Add failing tests for each mode, pending recovery, duplicates, signal behavior, shared
      agent IDs, and evidence labels.
- [ ] Implement the simulator over daemon APIs.
- [ ] Verify focused and Phase 1 simulation tests.

### Task 13: Thin stdio MCP server

**Files:**

- Create: `apps/mcp-server/package.json`
- Create: `apps/mcp-server/tsconfig.json`
- Create: `apps/mcp-server/src/client.ts`
- Create: `apps/mcp-server/src/tools.ts`
- Create: `apps/mcp-server/src/server.ts`
- Create: `apps/mcp-server/src/main.ts`
- Create: `apps/mcp-server/src/index.ts`
- Create: `apps/mcp-server/src/client.test.ts`
- Create: `apps/mcp-server/src/tools.test.ts`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`
- Modify: `pnpm-lock.yaml`

**Produces:** Official-SDK `McpServer` over `StdioServerTransport`, bound-session startup
validation, eleven approved tools, structured safe errors, and no Redis dependency.

- [ ] Add the stable official SDK with pnpm and no other framework.
- [ ] Write failing client/tool tests for startup binding, schema validation, source
      non-overridability, routing, waits, inbox ownership, response mismatch, and errors.
- [ ] Implement testable daemon client and tool handlers.
- [ ] Register tools with Zod input/output schemas and bounded structured results.
- [ ] Verify focused MCP tests and package build.

### Task 14: Documentation and ADR

**Files:**

- Create: `docs/decisions/0006-session-inbox-request-reply.md`
- Create: `docs/guides/phase-2-agent-communication-demo.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/architecture/overview.md`
- Modify: `.env.example`

**Produces:** Accurate public setup/API/CLI/MCP/inbox/recovery/retention documentation and a
reproducible three-session demo with all simulated behavior labelled.

- [ ] Document durable inbox versus realtime wake-up, ownership, idempotency, timeout races,
      conservative retention, MCP configuration, and limitations.
- [ ] Add exact PowerShell and macOS/Linux demo commands.
- [ ] Scan for deferred features falsely described as implemented.
- [ ] Run `pnpm format`.

### Task 15: Full verification, demos, and review

**Files:** No planned production changes; review fixes require their own failing regression
tests.

- [ ] Run `pnpm format`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
      `pnpm test:integration`, and `pnpm build`.
- [ ] Run the Phase 1 two-session regression demo.
- [ ] Run the complete Phase 2 three-session/MCP/recovery/timeout demo.
- [ ] Verify no Pub/Sub, datastore, direct MCP Redis dependency, secrets, prompts, or native
      integration claims were added.
- [ ] Request independent review against the approved Phase 2 design and fix every Critical
      or Important issue through red-green-refactor.
- [ ] Rerun the complete verification suite and report final Git status without committing.
