# CLI-First MVP Lifecycle Implementation Plan

> **Execution note:** Follow the approved CLI-first MVP design and implement each task test-first. Keep every test fixture and generated artifact inside the repository while this plan is executed.

**Goal:** Add a bounded, idempotent `doctor -> setup -> start -> status -> stop` path that starts the existing Compose Redis service, owns exactly one daemon instance, and never stops an unverified process or removes Redis data.

**Architecture:** `@luwi/cli` receives one lifecycle module with injected filesystem, command, process, network, clock, and confirmation collaborators. It stores a small secret-free runtime configuration plus a private daemon ownership token under `LUWI_HOME/runtime`; the token authorizes a single loopback-only graceful-stop endpoint in `@luwi/daemon`. The daemon remains the only Redis client. Docker Compose is invoked directly with fixed arguments and the repository's existing `compose.yaml`; no service, package, datastore, supervisor, or production dependency is added.

**Technology:** Node.js 22 standard library, Commander, existing Zod protocol schemas, Vitest, Docker Compose, existing daemon HTTP API.

---

## Binding decisions

- Default LUWI home remains `LUWI_HOME` or `~/.luwi`; tests inject a repository-local root.
- `setup` writes only `runtime/config.json` beneath LUWI home, atomically, after showing the exact target and receiving confirmation (`--yes` is the scoped non-interactive approval).
- The persisted configuration is versioned and contains only loopback daemon/Redis URLs plus the canonical installation/Compose locations. It contains no Redis credential and does not edit `.env` or native-agent files.
- A CLI-started daemon receives a random lifecycle token in its environment. After the daemon is healthy, the CLI atomically writes `runtime/daemon-owner.json` containing that token, PID, runtime instance ID, daemon URL, and installation root. The token is never returned by HTTP, printed, or logged.
- `POST /api/v1/runtime/stop` exists only as a loopback mutation and succeeds only when its bounded header matches the in-memory lifecycle token. It schedules the existing graceful shutdown path and returns before closing the listener.
- `stop` verifies the live `runtimeInstanceId` against ownership metadata, then presents the token to the daemon. It never sends a signal or kills a PID. Missing, corrupt, foreign, or mismatched ownership evidence produces a safe refusal. A stale file may be removed only after the configured daemon endpoint is proven closed.
- `stop` leaves Redis running. `stop --with-redis` runs `docker compose stop redis`, never `down`, `rm`, or a volume/image deletion command.
- `start` uses Compose only for the exact default `redis://127.0.0.1:6379` configuration. External Redis is never started or stopped by LUWI.
- Redis reachability and Function compatibility are established through daemon readiness; the CLI never opens a Redis protocol connection. `doctor` may report a TCP listener and Compose health as evidence, but it labels Function compatibility unavailable until a compatible healthy daemon has verified it.
- A healthy compatible daemon makes `start` succeed idempotently. If it does not match stored ownership it is reported as unmanaged and is never adopted.
- Partial startup rolls back only a daemon authorized by the current lifecycle token and a Compose Redis service that this invocation observed as stopped before starting.

## Task 1: Version the graceful-stop protocol

**Files:**

- Modify: `packages/protocol/src/runtime-http.ts`
- Modify: `packages/protocol/src/runtime-http.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/src/app.test.ts`
- Modify: `apps/daemon/src/runtime.ts`
- Modify: `apps/daemon/src/runtime.test.ts`
- Modify: `apps/daemon/src/main.ts`

1. Add failing protocol tests for a strict `{ status: "stopping" }` response.
2. Add failing daemon tests proving absent/wrong lifecycle tokens are refused, the correct token schedules one shutdown, and the token is absent from responses/log payloads.
3. Add `lifecycleStopResponseSchema` and exports.
4. Extend `BuildDaemonOptions` with an optional lifecycle-stop collaborator and register the route with bounded header validation and JSON-only mutation semantics.
5. Pass `LUWI_LIFECYCLE_TOKEN` from `main.ts` into `startDaemon`; wire the authorized request to the existing idempotent `shutdownRuntime` path without adding a second shutdown implementation.
6. Run focused protocol, app, and runtime tests.

## Task 2: Build the lifecycle core and safe local files

**Files:**

- Create: `apps/cli/src/lifecycle.ts`
- Create: `apps/cli/src/lifecycle.test.ts`

1. Define versioned runtime config, owner metadata, doctor report, and status result schemas/types local to the CLI; validate every file read as untrusted input.
2. Add failing tests for loopback URL enforcement, canonical containment, corrupt/oversized file refusal, atomic setup writes, explicit confirmation, idempotent setup, and no native config writes.
3. Implement injected bounded filesystem operations. Atomic writes use a same-directory temporary file, exclusive creation, rename, restrictive mode where supported, and best-effort temporary cleanup.
4. Add `setup` and `status` services. Status combines validated daemon HTTP state, verified ownership metadata, fixed-argument Compose state, and Redis evidence without interpreting a PID file as live ownership.
5. Run the lifecycle unit tests.

## Task 3: Add bounded diagnostics

**Files:**

- Modify: `apps/cli/src/lifecycle.ts`
- Modify: `apps/cli/src/lifecycle.test.ts`

1. Add failing tests for `ok`, `warning`, and `error` checks, stable JSON output data, redacted hints, missing Docker/Compose/agent executables, occupied daemon/Redis ports, compatible daemon evidence, and bounded command/network timeouts.
2. Implement `doctor` using injected version commands, PATH resolution, TCP probes, Compose state, daemon health/runtime schemas, and canonical LUWI/native roots.
3. Treat healthy daemon readiness as proof that standard Redis Functions were accepted; otherwise report compatibility as unknown rather than guessing or opening Redis directly.
4. Ensure all command argument arrays are fixed or separately validated and no environment dump, config content, token, or connection credential enters output.
5. Run lifecycle unit tests.

## Task 4: Start and stop owned resources

**Files:**

- Modify: `apps/cli/src/lifecycle.ts`
- Modify: `apps/cli/src/lifecycle.test.ts`

1. Add failing tests for an already healthy daemon, foreign port conflict, Compose start, external Redis behavior, detached daemon spawn, readiness timeout, metadata-write rollback, stale ownership, token mismatch, graceful stop, default Redis preservation, `--with-redis`, and rollback limited to resources started by the current invocation.
2. Implement a bounded command runner with captured output limits for diagnostic/Compose commands and a detached daemon spawner that uses `process.execPath`, the canonical built daemon entry, `shell: false`, and LUWI-owned log files.
3. Implement `start`: validate config, inspect current daemon/port, conditionally run `docker compose up -d --wait redis`, spawn the daemon with the lifecycle token, wait for validated health/runtime readiness, and write owner metadata last.
4. Implement `stop`: validate metadata, verify the live runtime instance, call the authorized graceful-stop route, wait until the endpoint closes, remove only the generated owner record, and optionally run `docker compose stop redis`.
5. Ensure error paths preserve safe codes and never print the token, full environment, Redis URL credentials, or daemon stack traces.
6. Run lifecycle unit tests.

## Task 5: Register the CLI surface

**Files:**

- Modify: `apps/cli/src/cli.ts`
- Modify: `apps/cli/src/cli.test.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/index.ts`

1. Add failing CLI tests for `doctor [--json]`, `setup [--yes] [--print-hooks]`, `start`, `status [--json]`, and `stop [--with-redis]` argument fidelity and output/error behavior.
2. Add one optional lifecycle dependency to `CliDependencies`, with the Node implementation in defaults so existing focused tests remain lightweight.
3. Register the five top-level commands without removing or renaming expert commands.
4. Keep human output concise while preserving stable JSON modes for doctor/status and printing exact ownership/endpoint state.
5. Run CLI and lifecycle tests, then inspect `luwi --help` and each command's help from the built CLI.

## Task 6: Document and verify the lifecycle slice

**Files:**

- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/architecture/overview.md`
- Create: `docs/guides/cli-lifecycle.md`

1. Document prerequisites, setup/start/status/stop, default Redis preservation, `--with-redis`, AOF limits, external Redis behavior, ownership refusal/recovery, log/metadata locations, loopback boundary, and the fact that CLI never accesses Redis directly.
2. Document `LUWI_CAPABILITY_ROOTS` while editing the environment reference.
3. Run focused tests, `pnpm format`, `pnpm typecheck`, `pnpm lint`, `pnpm test` with repository-local `TEMP`/`TMP` and `GIT_CEILING_DIRECTORIES`, and `pnpm build`.
4. Run applicable Redis integration tests only with an explicit dedicated `LUWI_TEST_REDIS_URL`; otherwise report them as not run.
5. Inspect `git diff --check`, changed files, and the final command surface. Do not run live `setup` or create state outside the repository during this implementation session.
