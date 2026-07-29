# Redis-native Architecture Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan inline and verify each task
> before continuing. Do not begin Phase 1 behavior.

**Goal:** Make LUWI Runtime a strict-loopback, single-user, Redis-native runtime with only
`protocol`, `runtime`, and `redis` packages.

**Architecture:** Git and the filesystem remain canonical for source and configuration.
Standard Redis is the only runtime datastore and owns operational state, durable events,
delivery, coordination, and rebuildable projections. The daemon is the sole Redis client.

**Tech Stack:** Node.js 22+, TypeScript, ESM, pnpm workspaces, Fastify, Zod, official Redis
client, Vitest, standard Redis 7 features, and Docker Compose.

## Global Constraints

- Do not implement Phase 1 project, session, heartbeat, WebSocket, task, message, lease,
  projection-worker, consumer-group, or Redis Function behavior.
- Do not add or upgrade third-party dependencies.
- Do not retain compatibility packages for `@luwi/core` or `@luwi/iris`.
- Bind only to `127.0.0.1`; reject all other daemon host values.
- Do not add login, account, authentication, authorization, or tenancy subsystems.
- Do not add another datastore or require Redis Stack modules.
- Do not modify `temp/alice-shell-bridge-legacy`.
- Do not commit because the user has not requested a commit.

---

### Task 1: Consolidate runtime package boundaries

**Files:**

- Create: `packages/runtime/package.json`
- Create: `packages/runtime/tsconfig.json`
- Create: `packages/runtime/src/index.ts`
- Create: `packages/runtime/src/application-error.ts`
- Create: `packages/runtime/src/runtime-state.ts`
- Create: `packages/runtime/src/runtime-state.test.ts`
- Create: `packages/runtime/src/runtime-lifecycle.ts`
- Create: `packages/runtime/src/runtime-lifecycle.test.ts`
- Delete: `packages/core/**`
- Delete: `packages/iris/**`
- Modify: `apps/daemon/package.json`
- Modify: `apps/daemon/tsconfig.json`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/tsconfig.json`
- Modify: `apps/cli/src/cli.ts`
- Modify: `apps/cli/src/cli.test.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`
- Modify: `vitest.integration.config.ts`

**Interfaces:**

- `@luwi/runtime` exports `ApplicationError`, `toPublicError`, `createRuntimeState`,
  `getRuntimeUptimeMs`, and `createRuntimeLifecycleEvent` plus their public types.
- `@luwi/runtime` depends only on `@luwi/protocol`.
- Applications import runtime behavior only from `@luwi/runtime`.

- [ ] **Step 1: Change test and application imports to the desired package name**

Replace `@luwi/core` and `@luwi/iris` imports with `@luwi/runtime`, and point Vitest aliases
at `packages/runtime/src/index.ts`.

- [ ] **Step 2: Run tests to verify the new package boundary is absent**

Run:

```powershell
pnpm test
```

Expected: FAIL because `packages/runtime/src/index.ts` does not exist.

- [ ] **Step 3: Create the runtime package and move behavior without changing it**

Create one `@luwi/runtime` manifest and TypeScript project. Preserve the current error,
runtime-state, and lifecycle implementations and tests. Export all public APIs from
`src/index.ts`.

- [ ] **Step 4: Remove obsolete packages and update project references**

Delete only `packages/core` and `packages/iris`. Replace their workspace dependencies and
TypeScript references with `packages/runtime`.

- [ ] **Step 5: Run unit tests**

Run:

```powershell
pnpm test
```

Expected: all existing behavior tests pass under the new package boundary.

### Task 2: Enforce strict loopback binding

**Files:**

- Modify: `apps/daemon/src/config.test.ts`
- Modify: `apps/daemon/src/config.ts`

**Interfaces:**

- `loadDaemonConfig({})` returns `host: "127.0.0.1"`.
- `loadDaemonConfig({ HOST: "127.0.0.1" })` succeeds.
- Every other `HOST` value throws a Zod validation error.

- [ ] **Step 1: Write the failing remote-bind test**

Add:

```ts
it('rejects non-loopback binding', () => {
  expect(() => loadDaemonConfig({ HOST: '0.0.0.0' })).toThrow();
});
```

Keep the valid override test on `HOST: "127.0.0.1"`.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
pnpm exec vitest run apps/daemon/src/config.test.ts
```

Expected: FAIL because `0.0.0.0` is currently accepted.

- [ ] **Step 3: Restrict the environment schema**

Define `HOST` as the literal value `127.0.0.1` with the same default. Do not add a remote
override flag.

- [ ] **Step 4: Run the focused test and verify success**

Run:

```powershell
pnpm exec vitest run apps/daemon/src/config.test.ts
```

Expected: all daemon configuration tests pass.

### Task 3: Record the Redis-native architecture

**Files:**

- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/decisions/0002-redis-streams.md`
- Modify: `docs/decisions/0003-daemon-owned-redis-access.md`
- Create: `docs/decisions/0004-redis-only-local-runtime.md`
- Create: `docs/decisions/0005-redis-native-operational-core.md`
- Modify: `.env.example`
- Create: `compose.yaml`

**Interfaces:**

- ADR 0004 records the high-level local, Redis-only source-of-truth decision.
- ADR 0005 records key taxonomy, event/projection flow, consumer groups, AOF, retention,
  recovery, and the Redis Functions boundary.
- Compose exposes Redis only on `127.0.0.1:6379`, enables AOF with `appendfsync everysec`,
  and mounts a named volume at `/data`.

- [ ] **Step 1: Rewrite repository instructions around the binding decisions**

Remove database and account plans, replace `core`/`iris` package boundaries with `runtime`,
make Redis the operational database, document standard Redis structures, and preserve the
Phase 1/Phase 2 scope gates.

- [ ] **Step 2: Update public architecture documentation**

Update README and the architecture overview so current Phase 0 behavior remains honest while
Redis-native Streams, projections, Functions, origin checks, and retention remain clearly
identified as architecture for later implementation.

- [ ] **Step 3: Update existing Redis ADRs**

Keep ADRs 0002 and 0003 accepted, reference ADRs 0004 and 0005, and clarify bounded Streams,
persistence-first fan-out, and daemon-only credentials.

- [ ] **Step 4: Create ADR 0004**

State that Redis is the only runtime datastore, Git/filesystem are canonical for code and
configuration, projections derive from events, local mode has no account/authentication
subsystem, and future external storage requires a demonstrated requirement plus an adapter.

- [ ] **Step 5: Create ADR 0005**

Document exact `luwi:v1:*` key families, Stream/consumer-group recovery, hash/set/sorted-set
projections, TTL presence, Pub/Sub limits, approximate `MAXLEN` retention, AOF settings, and
versioned Redis Functions for atomic mutation-plus-event persistence.

- [ ] **Step 6: Add environment examples and Compose**

Add documented Phase 1 retention defaults without claiming they are already consumed. Create
standard Redis Compose configuration with no Redis Stack image or module.

### Task 4: Synchronize the workspace graph without upgrades

**Files:**

- Modify mechanically: `pnpm-lock.yaml`
- Regenerate: ignored `node_modules` links

- [ ] **Step 1: Update only workspace importers**

Run:

```powershell
pnpm install --lockfile-only --offline
```

Expected: lockfile removes `packages/core` and `packages/iris`, adds `packages/runtime`, and
does not change external dependency versions.

- [ ] **Step 2: Rebuild workspace links from the updated frozen lockfile**

Run:

```powershell
pnpm install --frozen-lockfile
```

Expected: install succeeds without dependency upgrades.

- [ ] **Step 3: Inspect the lockfile diff**

Confirm only workspace importer names and links changed.

### Task 5: Documentation and architecture checks

**Files:**

- Modify only if checks expose an error in files already in scope.

- [ ] **Step 1: Run formatting**

Run:

```powershell
pnpm format
```

Expected: pass.

- [ ] **Step 2: Check obsolete package references**

Run:

```powershell
rg -n "@luwi/(core|iris)|packages/(core|iris)" . -g "!node_modules/**" -g "!.pnpm-store/**" -g "!temp/**"
```

Expected: no active references.

- [ ] **Step 3: Classify datastore and authentication references**

Search active documentation for PostgreSQL, SQLite, Neo4j, other databases, login, signup,
OAuth, JWT, RBAC, authentication, and multi-tenancy. Remaining matches must be explicit
prohibitions, ADR rationale, or the historical legacy review.

- [ ] **Step 4: Validate Compose when possible**

Run:

```powershell
docker compose config
```

Expected in the current environment: unavailable because Docker is not installed. Report this
without claiming semantic Compose validation.

### Task 6: Run the current verification suite

**Files:**

- No source changes unless a verification failure identifies an in-scope defect.

- [ ] **Step 1: Run typecheck**

```powershell
pnpm typecheck
```

- [ ] **Step 2: Run lint**

```powershell
pnpm lint
```

- [ ] **Step 3: Run unit tests**

```powershell
pnpm test
```

- [ ] **Step 4: Run Redis integration tests against the explicit test database**

```powershell
$env:LUWI_TEST_REDIS_URL = "redis://127.0.0.1:6379/15"
pnpm test:integration
```

- [ ] **Step 5: Run build**

```powershell
pnpm build
```

- [ ] **Step 6: Smoke-test daemon and CLI**

Start:

```powershell
pnpm --filter @luwi/daemon dev
```

Verify:

```powershell
Invoke-WebRequest http://127.0.0.1:4782/health
pnpm --filter @luwi/cli dev -- runtime
```

Expected: HTTP 200 with Redis connected and a validated protocol version 1 runtime response.

- [ ] **Step 7: Recheck safety boundaries**

Confirm no daemon remains listening, no source outside scope changed, the legacy fingerprint
is unchanged, and Git status contains only intended architecture-cleanup changes.
