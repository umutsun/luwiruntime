# Phase 1 Projects and Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved Redis-native Phase 1 vertical slice for projects, sessions,
presence, recoverable realtime events, CLI simulations, and the two-session demo.

**Architecture:** Keep schemas in `@luwi/protocol`, Redis-independent rules in
`@luwi/runtime`, Redis Functions/storage/consumer mechanics in `@luwi/redis`, composition
and local transport in `@luwi/daemon`, and daemon-only client behavior in `@luwi/cli`.
Mutation Functions preflight all failure conditions, mutate projections, and append one
identical event to global/project Streams before the relay can broadcast it.

**Tech Stack:** Node.js 22+, strict TypeScript ESM, pnpm workspaces, Fastify 5, the compatible
official Fastify WebSocket plugin, official `redis` client, Zod 4, Pino, Commander, Vitest,
ESLint, Prettier, standard Redis 7.

## Global Constraints

- Treat `docs/superpowers/specs/2026-07-28-phase-1-projects-sessions-design.md`,
  `AGENTS.md`, ADR 0004, and ADR 0005 as binding.
- The daemon accepts only `127.0.0.1`; Redis credentials remain daemon-only.
- Redis is the only runtime datastore; filesystem/Git remain canonical for code/config.
- Add no production dependency except the compatible official Fastify WebSocket plugin.
- Do not touch `temp/alice-shell-bridge-legacy`.
- Do not implement deferred Phase 2/product features.
- Do not commit or push.
- Every production behavior follows red-green-refactor.
- Integration tests use explicit `LUWI_TEST_REDIS_URL`, run-specific keys and Functions, and
  never flush Redis or replace/delete production `luwi_v1`.

---

### Task 1: Protocol schemas and event contracts

**Files:**

- Create: `packages/protocol/src/project.ts`
- Create: `packages/protocol/src/session.ts`
- Create: `packages/protocol/src/runtime-api.ts`
- Create: `packages/protocol/src/realtime.ts`
- Create: `packages/protocol/src/project.test.ts`
- Create: `packages/protocol/src/session.test.ts`
- Create: `packages/protocol/src/runtime-api.test.ts`
- Create: `packages/protocol/src/realtime.test.ts`
- Modify: `packages/protocol/src/runtime-event.ts`
- Modify: `packages/protocol/src/runtime-event.test.ts`
- Modify: `packages/protocol/src/runtime-http.ts`
- Modify: `packages/protocol/src/runtime-http.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**

- Produce `projectSchema`, `projectRegistrationRequestSchema`, and project collection
  response schemas.
- Produce `agentIdSchema`, `sessionStatusSchema`, `sessionStatusTargetSchema`,
  `agentSessionSchema`, `sessionViewSchema`, and session request/response schemas.
- Produce `runtimeStateSchema`, `eventListResponseSchema`, `publicErrorResponseSchema`, and
  `realtimeEventMessageSchema`.
- Extend Runtime event types with `session.completed`.

- [ ] Write focused failing schema tests, including the exact agent ID regex, metadata
      16-KiB bound, event wrapper, runtime states, event list limits, and safe error details.

```ts
expect(agentIdSchema.safeParse('codex-sim').success).toBe(true);
expect(agentIdSchema.safeParse('../codex').success).toBe(false);
expect(realtimeEventMessageSchema.parse({ streamId: '1-0', event }).streamId).toBe('1-0');
```

- [ ] Run `pnpm test packages/protocol/src` and verify RED because the new exports do not
      exist.
- [ ] Implement the schemas with `z.strictObject`, bounded strings/records, and inferred
      public types. Keep Redis field layouts out of this package.
- [ ] Run `pnpm test packages/protocol/src` and verify GREEN.
- [ ] Run `pnpm typecheck` and keep the workspace compiling.

### Task 2: Runtime path, status, readiness, and sweeper rules

**Files:**

- Create: `packages/runtime/src/project-path.ts`
- Create: `packages/runtime/src/project-path.test.ts`
- Create: `packages/runtime/src/session-status.ts`
- Create: `packages/runtime/src/session-status.test.ts`
- Create: `packages/runtime/src/runtime-readiness.ts`
- Create: `packages/runtime/src/runtime-readiness.test.ts`
- Create: `packages/runtime/src/presence-sweeper.ts`
- Create: `packages/runtime/src/presence-sweeper.test.ts`
- Modify: `packages/runtime/src/application-error.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**

```ts
canonicalizeProjectPath(input: string, deps?: PathDependencies): Promise<CanonicalPath>;
canonicalizeWorkingDirectory(input: string, deps?: PathDependencies): Promise<CanonicalPath>;
evaluateSessionStatusTransition(current: SessionStatus, target: SessionStatusTarget):
  | { status: "updated" }
  | { status: "unchanged" }
  | { status: "terminal" }
  | { status: "invalid_transition" };
createRuntimeReadiness(initial: RuntimeState): RuntimeReadiness;
createPresenceSweeper(options: PresenceSweeperOptions): PresenceSweeper;
```

- [ ] Write failing tests for relative/absolute paths, root trailing separators, Windows
      case identity, missing directories, optional junction aliases, the complete status
      matrix, atomic mutation slots, drain behavior, and fake-clock deadline batches.
- [ ] Run the focused runtime tests and verify RED for missing modules.
- [ ] Implement path identity with `resolve`, `realpath`, directory `stat`, `/` separators,
      SHA-256, Windows display drive normalization, and Windows-only lowercase identity.
- [ ] Implement the exact matrix from the spec and a readiness object whose
      `tryAcquireMutation()` rechecks state and returns a `release()` callback.
- [ ] Implement a sweeper loop that selects candidates from an injected clock/repository and
      delegates authoritative disconnect decisions to Redis.
- [ ] Run focused tests, then `pnpm typecheck`, and verify GREEN.

### Task 3: Redis keys, Function registry, and safe test namespace

**Files:**

- Create: `packages/redis/src/redis-keys.ts`
- Create: `packages/redis/src/redis-keys.test.ts`
- Create: `packages/redis/src/function-registry.ts`
- Create: `packages/redis/src/function-registry.test.ts`
- Create: `packages/redis/src/function-library.ts`
- Create: `packages/redis/src/function-loader.ts`
- Create: `packages/redis/src/function-loader.test.ts`
- Modify: `packages/redis/src/index.ts`
- Modify: `packages/redis/src/redis-gateway.ts`
- Modify: `packages/redis/src/redis-gateway.test.ts`

**Interfaces:**

```ts
createRedisKeys(namespace = "luwi:v1"): RedisKeys;
createFunctionRegistry(suffix?: string): RedisFunctionRegistry;
buildFunctionLibrary(registry: RedisFunctionRegistry): RedisFunctionLibrary;
verifyOrLoadFunctionLibrary(admin, expected, ownership): Promise<void>;
```

- [ ] Write failing tests asserting every approved key, injectable test namespaces,
      run-specific Function names, source hash stability, Redis 7 rejection, missing load,
      compatible no-op, incompatible owned replace, and replacement denial without
      ownership.
- [ ] Run focused tests and verify RED.
- [ ] Implement the centralized key factory and Function registry.
- [ ] Implement the versioned Lua library with all seven registered Function names and
      shared preflight/time/event helpers.
- [ ] Expand the Redis client boundary to expose command, blocking, and admin clients
      without exposing them outside `@luwi/redis`.
- [ ] Implement `FUNCTION LIST`, owned `FUNCTION LOAD [REPLACE]`, and post-load verification.
- [ ] Run focused tests and `pnpm typecheck`.

### Task 4: Project registration vertical slice

**Files:**

- Create: `packages/redis/src/runtime-repository.ts`
- Create: `packages/redis/src/runtime-repository.test.ts`
- Create: `packages/redis/src/runtime-repository.integration.test.ts`
- Create: `apps/daemon/src/project-service.ts`
- Create: `apps/daemon/src/project-service.test.ts`
- Modify: `packages/redis/src/function-library.ts`
- Modify: `packages/redis/src/index.ts`

**Interfaces:**

```ts
RuntimeRepository.registerProject(input: RegisterProjectTransition):
  Promise<CreatedProjectResult | DuplicateProjectResult | PathHashCollisionResult>;
RuntimeRepository.getProject(projectId: string): Promise<Project | null>;
RuntimeRepository.listProjects(): Promise<Project[]>;
ProjectService.register(input: ProjectRegistrationRequest): Promise<Project>;
```

- [ ] Write RED unit/integration tests for valid registration, unknown/missing path,
      same/relative/absolute/trailing/case/junction duplicates, concurrent duplicates, hash
      collision, key-type preflight failure, no partial state, and one identical event in
      global/project Streams.
- [ ] Implement `luwi_project_register_v1` preflight, Redis `TIME`, projection/index writes,
      event serialization once, and structured outcomes.
- [ ] Implement validated project reads and deterministic list ordering.
- [ ] Implement bounded local Git metadata detection with no GitHub calls.
- [ ] Run focused unit and explicit Redis integration tests; verify exactly one concurrent
      create and no conflict event.

### Task 5: Session registration and status transitions

**Files:**

- Create: `apps/daemon/src/session-service.ts`
- Create: `apps/daemon/src/session-service.test.ts`
- Modify: `packages/redis/src/function-library.ts`
- Modify: `packages/redis/src/runtime-repository.ts`
- Modify: `packages/redis/src/runtime-repository.integration.test.ts`

**Interfaces:**

```ts
RuntimeRepository.registerSession(input: RegisterSessionTransition): Promise<SessionResult>;
RuntimeRepository.changeSessionStatus(input: ChangeSessionStatusTransition):
  Promise<SessionTransitionResult>;
RuntimeRepository.getSession(sessionId: string): Promise<SessionView | null>;
RuntimeRepository.listSessions(projectId?: string): Promise<SessionView[]>;
```

- [ ] Write RED tests for unseen agent IDs, multiple sessions per agent, unknown project,
      invalid agent IDs, canonical working directories, project/agent indexes, no
      AgentDefinition hash, all status matrix outcomes, terminal state, and preserved
      historical `agentId`.
- [ ] Implement `luwi_session_register_v1` and `luwi_session_status_v1` with full preflight,
      Redis time, projection/index/presence/deadline writes, and identical cross-Stream event.
- [ ] Implement session reads that derive `presence` from TTL and terminal state.
- [ ] Run focused unit/integration tests and typecheck.

### Task 6: Heartbeat, graceful close, presence, and sweeper

**Files:**

- Modify: `packages/redis/src/function-library.ts`
- Modify: `packages/redis/src/runtime-repository.ts`
- Modify: `packages/redis/src/runtime-repository.integration.test.ts`
- Modify: `apps/daemon/src/session-service.ts`
- Modify: `apps/daemon/src/session-service.test.ts`
- Modify: `packages/runtime/src/presence-sweeper.ts`
- Modify: `packages/runtime/src/presence-sweeper.test.ts`

**Interfaces:**

```ts
RuntimeRepository.heartbeatSession(input: HeartbeatTransition): Promise<HeartbeatResult>;
RuntimeRepository.closeSession(input: CloseSessionTransition): Promise<SessionTransitionResult>;
RuntimeRepository.disconnectExpiredSession(input: DisconnectExpiredTransition):
  Promise<DisconnectResult>;
RuntimeRepository.findExpiredHeartbeatDeadlines(nowMs: number, limit: number):
  Promise<HeartbeatDeadline[]>;
```

- [ ] Write RED tests for Redis-time TTL/deadline, heartbeat sampling, metadata changes,
      completed/disconnected rejection, close cleanup/idempotence, stale disconnect, active
      preservation, expected-deadline race, and PTTL reconciliation.
- [ ] Implement `luwi_session_heartbeat_v1`, `luwi_session_close_v1`, and
      `luwi_session_disconnect_v1` with all preflight before writes.
- [ ] Wire the fake-clock candidate sweeper to the authoritative Function.
- [ ] Run focused unit/integration tests with small test TTLs and verify GREEN.

### Task 7: Ownership lease and daemon lifecycle

**Files:**

- Create: `packages/redis/src/daemon-ownership.ts`
- Create: `packages/redis/src/daemon-ownership.test.ts`
- Create: `packages/redis/src/daemon-ownership.integration.test.ts`
- Create: `apps/daemon/src/runtime-controller.ts`
- Create: `apps/daemon/src/runtime-controller.test.ts`
- Modify: `apps/daemon/src/runtime.ts`
- Modify: `apps/daemon/src/runtime.test.ts`
- Modify: `apps/daemon/src/config.ts`
- Modify: `apps/daemon/src/config.test.ts`

**Interfaces:**

```ts
DaemonOwnership.acquire(): Promise<OwnershipLease | AlreadyOwned>;
OwnershipLease.renew(): Promise<boolean>;
OwnershipLease.release(): Promise<boolean>;
RuntimeController.bootstrap(): Promise<void>;
RuntimeController.recover(): Promise<void>;
RuntimeController.drain(): Promise<void>;
```

- [ ] Write RED tests for validated lifecycle settings, SET-NX acquisition, conflict,
      renewal, compare-token release, ownership loss, startup ordering, explicit states,
      bounded reconnect, and mutation-slot draining.
- [ ] Implement lease scripts and the ordered lifecycle coordinator using separate Redis
      connections.
- [ ] Change live startup from Phase 0 degraded-listen behavior to bootstrap-before-listen.
- [ ] Run lifecycle unit/integration tests and typecheck.

### Task 8: Event history and conservative retention

**Files:**

- Create: `packages/redis/src/event-store.ts`
- Create: `packages/redis/src/event-store.test.ts`
- Create: `packages/redis/src/event-store.integration.test.ts`
- Create: `packages/redis/src/retention-service.ts`
- Create: `packages/redis/src/retention-service.test.ts`
- Modify: `packages/redis/src/index.ts`

**Interfaces:**

```ts
EventStore.ensureGlobalStream(): Promise<void>;
EventStore.listRecent(limit: number): Promise<RealtimeEventMessage[]>;
RetentionService.runOnce(): Promise<RetentionResult>;
```

- [ ] Write RED tests for `XREVRANGE` latest/ascending behavior, stored-event validation,
      project/dead-letter bounds, global pending/lag/metadata/relay-health deferral, and
      safe approximate trim.
- [ ] Implement event reads and the periodic retention service outside transition Functions.
- [ ] Run focused unit/integration tests.

### Task 9: Consumer-group relay and dead-letter recovery

**Files:**

- Create: `packages/redis/src/event-consumer.ts`
- Create: `packages/redis/src/event-consumer.test.ts`
- Create: `packages/redis/src/event-consumer.integration.test.ts`
- Create: `packages/redis/src/dead-letter.ts`
- Create: `packages/redis/src/dead-letter.test.ts`
- Modify: `packages/redis/src/index.ts`

**Interfaces:**

```ts
EventConsumer.ensureGroup(): Promise<"created" | "existing">;
EventConsumer.recoverPending(handler: EventHandler): Promise<void>;
EventConsumer.start(handler: EventHandler): Promise<void>;
EventConsumer.stop(): Promise<void>;
DeadLetterStore.persist(input: MalformedEventDiagnostic): Promise<void>;
```

- [ ] Write RED tests for first `$` creation, preserved cursor, ACK, failed processing,
      pending inspection, `XAUTOCLAIM`, recovered-before-new ordering, at-least-once
      identity, malformed redaction/hash/size, dead-letter-before-ACK, and poison failure
      degradation.
- [ ] Implement the minimal consumer around `XGROUP`, `XREADGROUP`, `XPENDING`, `XAUTOCLAIM`,
      and `XACK`.
- [ ] Implement bounded safe dead-letter diagnostics.
- [ ] Run focused unit/integration tests.

### Task 10: WebSocket hub and handshake security

**Files:**

- Modify: `apps/daemon/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/daemon/src/realtime-hub.ts`
- Create: `apps/daemon/src/realtime-hub.test.ts`
- Create: `apps/daemon/src/realtime-security.ts`
- Create: `apps/daemon/src/realtime-security.test.ts`
- Create: `apps/daemon/src/realtime-route.ts`
- Create: `apps/daemon/src/realtime-route.test.ts`

**Interfaces:**

```ts
RealtimeHub.accept(message: RealtimeEventMessage): Promise<void>;
RealtimeHub.add(client: RealtimeClient): () => void;
RealtimeHub.closeAll(): Promise<void>;
validateRealtimeHandshake(request: HandshakeRequest, config: RealtimeSecurityConfig): void;
```

- [ ] Verify the official plugin version supports Fastify 5 using current primary
      documentation; add only that production dependency with pnpm.
- [ ] Write RED tests for FIFO order, stable client snapshots, queue/buffer overflow,
      send timeout, disconnected-client removal, no-client acceptance, exact Origin,
      `Origin: null`, no-Origin loopback/Host/path checks, incoming-frame rejection, and max
      payload.
- [ ] Implement bounded per-client writers and the server-only route.
- [ ] Run focused tests, typecheck, and lockfile validation.

### Task 11: Versioned HTTP routes

**Files:**

- Create: `apps/daemon/src/routes/projects.ts`
- Create: `apps/daemon/src/routes/projects.test.ts`
- Create: `apps/daemon/src/routes/sessions.ts`
- Create: `apps/daemon/src/routes/sessions.test.ts`
- Create: `apps/daemon/src/routes/events.ts`
- Create: `apps/daemon/src/routes/events.test.ts`
- Create: `apps/daemon/src/mutation-guard.ts`
- Create: `apps/daemon/src/mutation-guard.test.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/src/app.test.ts`
- Modify: `apps/daemon/src/index.ts`

**Interfaces:**

- Implement every approved project/session/event route.
- Duplicate project responds 409 with safe details and `Location`.
- Mutation routes acquire/release readiness slots.
- Redis-backed reads return `RUNTIME_NOT_READY` when unavailable.

- [ ] Write RED Fastify injection tests for all success/error routes, boundary validation,
      no mutation when unready, persistence failure/no broadcast, and exact list responses.
- [ ] Register focused route plugins with injected services; keep key construction out of
      handlers.
- [ ] Wire Runtime state into health/runtime responses.
- [ ] Run daemon unit tests and typecheck.

### Task 12: CLI HTTP commands and simulations

**Files:**

- Create: `apps/cli/src/http-client.ts`
- Create: `apps/cli/src/http-client.test.ts`
- Create: `apps/cli/src/simulation.ts`
- Create: `apps/cli/src/simulation.test.ts`
- Modify: `apps/cli/src/cli.ts`
- Modify: `apps/cli/src/cli.test.ts`
- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/src/main.ts`

**Interfaces:**

- Implement approved `project`, `session`, and `events list` commands.
- `session simulate` sends heartbeats, closes exactly once normally, and never closes with
  `--ungraceful`.

- [ ] Write RED tests for every command URL/method/body/response, 409 Location/details,
      output validation, signals, timer cleanup, one close, no ungraceful close, and
      concurrent simulations.
- [ ] Implement a reusable validated HTTP client and Commander subcommands.
- [ ] Implement CLI-only simulation with injected timers/signals for deterministic tests.
- [ ] Run CLI tests and typecheck.

### Task 13: CLI event watch, reconnect, recovery, and shutdown composition

**Files:**

- Create: `apps/cli/src/event-watch.ts`
- Create: `apps/cli/src/event-watch.test.ts`
- Modify: `apps/cli/src/cli.ts`
- Modify: `apps/daemon/src/runtime-controller.ts`
- Modify: `apps/daemon/src/runtime-controller.test.ts`
- Modify: `apps/daemon/src/shutdown.ts`
- Modify: `apps/daemon/src/shutdown.test.ts`

**Interfaces:**

```ts
watchEvents(options: EventWatchOptions, deps: EventWatchDependencies): Promise<void>;
```

- [ ] Write RED tests for connect-then-snapshot, labeled output, ascending pre-snapshot
      flush, visible overflow, bounded 4,096-ID dedupe, invalid wrapper, gap warning,
      reconnect snapshot refresh, relay continuation during drain, and unfinished pending
      recovery.
- [ ] Implement observational watch with a 256-event pre-snapshot buffer and bounded
      reconnect.
- [ ] Finish runtime recovery/draining composition and graceful WebSocket cleanup.
- [ ] Run focused CLI/daemon tests and typecheck.

### Task 14: Full isolated integration suite

**Files:**

- Create: `packages/redis/src/test-redis.ts`
- Create: `packages/redis/src/test-redis.test.ts`
- Modify: `vitest.integration.config.ts`
- Modify: all `*.integration.test.ts` files added above

**Interfaces:**

- Produce a test harness that compares Redis server identities without database numbers,
  refuses unsafe shared Functions by default, creates run-specific namespaces/registries,
  and cleans only its own keys/library.

- [ ] Write a RED harness test proving production `luwi_v1` is never replaced/deleted and
      unsafe same-server tests are refused.
- [ ] Implement the harness without `FUNCTION FLUSH`, `FLUSHDB`, or `FLUSHALL`.
- [ ] Run
      `$env:LUWI_TEST_REDIS_URL='redis://127.0.0.1:6379/15'; $env:LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS='true'; pnpm test:integration`
      and resolve only evidence-backed failures.
- [ ] Verify cleanup leaves no run-specific keys or Function library.

### Task 15: Reproducible Phase 1 demonstration

**Files:**

- Create: `docs/guides/phase-1-demo.md`
- Create: `examples/phase-1-demo.ps1`

**Interfaces:**

- The script uses only daemon/CLI commands and loopback HTTP/WebSocket.
- It uses fast TTL/sweep/heartbeat overrides and prints IDs for later commands.

- [ ] Write the expected demo transcript and commands before the script.
- [ ] Implement the PowerShell orchestration with exact process IDs, bounded waits, safe
      cleanup, and no Redis flush.
- [ ] Run the complete demo against local Redis and capture observed behavior for the final
      report.

### Task 16: Documentation and final verification

**Files:**

- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/decisions/0005-redis-native-operational-core.md`
- Modify: `.env.example`

**Interfaces:**

- Documentation reflects only implemented behavior and the concrete
  `luwi:v1:events:*` taxonomy.

- [ ] Update current status, configuration defaults, ownership, Functions, presence,
      retention, relay/WebSocket guarantees, CLI commands, test isolation, demo, and
      limitations.
- [ ] Run `pnpm format`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
      `pnpm test:integration`, and `pnpm build`.
- [ ] Inspect `git status --short`, the complete diff/status set, ignored generated files,
      and secret-like patterns.
- [ ] Confirm the legacy reference tree was not modified.
- [ ] Report exact commands/results, demo output, limitations, Git status, and Phase 2
      recommendation without committing.
