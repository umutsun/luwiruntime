# LUWI Runtime

LUWI Runtime is a local-first, single-user control and coordination runtime for developers
who use multiple AI coding agents across local projects. It coordinates tools such as Codex,
Claude Code, Gemini CLI, and Kimi; it does not replace or impersonate them.

> See every project. Coordinate every agent. Ship without collisions.

## Current status

Phase 1 — Projects and Sessions is implemented:

- strict TypeScript/ESM pnpm workspace with `protocol`, `runtime`, and `redis` packages;
- Fastify daemon bound to `127.0.0.1` with an owned lifecycle and explicit readiness states;
- Redis 7 Functions for atomic project/session projection and event transitions;
- canonical local-path project registration with atomic duplicate detection;
- opaque agent IDs, concurrent sessions, heartbeat sampling, TTL presence, and expiry;
- bounded global/project event Streams and a bounded dead-letter Stream;
- consumer-group recovery with continuous `XPENDING`/`XAUTOCLAIM` reinspection, validation,
  poison-entry retries, and post-acceptance acknowledgement;
- persistence-first, server-to-client WebSocket delivery with bounded per-client queues;
- CLI project, session, simulation, event-list, and event-watch commands;
- unit and opt-in Redis integration tests.

The dashboard, MCP server, request/reply messaging, tasks, leases, agent adapters, metrics,
lifecycle analysis, knowledge graph, GitHub integration, and authentication are not
implemented.

## Architecture and security

Redis is the only runtime datastore. It is the operational database, durable event bus,
coordination fabric, and projection store. Git and the local filesystem are canonical only
for source code and configuration.

Only the daemon receives Redis credentials. HTTP and WebSocket clients use the versioned
local API. The daemon:

- accepts only `HOST=127.0.0.1`;
- validates exact loopback `Host` and browser/WebSocket `Origin` values;
- rejects wildcard origins and `Origin: null`;
- does not log Redis URLs, secrets, complete prompts, or unbounded payloads;
- acquires a TTL-backed single-daemon owner lease before bootstrap mutation.

Redis Streams are durable and recoverable. WebSocket delivery is best-effort realtime
delivery: an `XACK` confirms validated relay processing and queue acceptance, not browser
rendering or network receipt. Clients obtain current project/session snapshots after
connecting.

See [the architecture overview](docs/architecture/overview.md), [ADR
0004](docs/decisions/0004-redis-only-local-runtime.md), and [ADR
0005](docs/decisions/0005-redis-native-operational-core.md).

## Prerequisites

- Node.js 22 or newer;
- pnpm 11;
- Git;
- standard Redis 7 or newer through `REDIS_URL`.

Docker is optional. `compose.yaml` provides standard Redis with AOF and a persistent volume.

## Install

```text
pnpm install --frozen-lockfile
```

The daemon reads environment variables directly; it does not load a real `.env` file. Copy
the relevant values from `.env.example` into your shell or process manager.

Defaults:

```text
HOST=127.0.0.1
PORT=4782
REDIS_URL=redis://127.0.0.1:6379
LOG_LEVEL=info
WORKSPACE_ID=local
```

Remote binding is intentionally unsupported in local mode.

## Start Redis

With Docker:

```text
docker compose up -d redis
docker compose ps
```

The service publishes only `127.0.0.1:6379`, enables `appendonly yes` with
`appendfsync everysec`, and stores `/data` in `luwi-redis-data`. `docker compose down` keeps
the volume.

An existing standard Redis server also works:

```text
REDIS_URL=redis://127.0.0.1:6379
```

Do not expose Redis on a non-loopback interface.

## Run on Windows PowerShell

Terminal 1:

```powershell
$env:REDIS_URL = "redis://127.0.0.1:6379"
pnpm --filter @luwi/daemon dev
```

Terminal 2:

```powershell
Invoke-RestMethod http://127.0.0.1:4782/health
pnpm --filter @luwi/cli dev runtime
```

## Run on macOS or Linux

Terminal 1:

```sh
export REDIS_URL=redis://127.0.0.1:6379
pnpm --filter @luwi/daemon dev
```

Terminal 2:

```sh
curl --fail-with-body http://127.0.0.1:4782/health
pnpm --filter @luwi/cli dev runtime
```

## CLI examples

```text
pnpm --filter @luwi/cli dev project register --name "LUWI Runtime" --path .
pnpm --filter @luwi/cli dev project list
pnpm --filter @luwi/cli dev project get <projectId>

pnpm --filter @luwi/cli dev session register --project <projectId> --agent codex-sim --working-directory .
pnpm --filter @luwi/cli dev session list --online
pnpm --filter @luwi/cli dev session heartbeat <sessionId>
pnpm --filter @luwi/cli dev session status <sessionId> tool_running
pnpm --filter @luwi/cli dev session close <sessionId>

pnpm --filter @luwi/cli dev events list --limit 100
pnpm --filter @luwi/cli dev events watch
```

`agentId` is a validated opaque logical identifier. Session registration does not require or
create an AgentDefinition record.

The complete two-session acceptance walkthrough is in [the Phase 1 demo
guide](docs/guides/phase-1-demo.md).

## HTTP and WebSocket API

```text
GET  /health
GET  /api/v1/runtime

GET  /api/v1/projects
POST /api/v1/projects
GET  /api/v1/projects/:projectId

GET  /api/v1/sessions
POST /api/v1/sessions
GET  /api/v1/sessions/:sessionId
POST /api/v1/sessions/:sessionId/heartbeat
POST /api/v1/sessions/:sessionId/status
POST /api/v1/sessions/:sessionId/close
GET  /api/v1/projects/:projectId/sessions

GET  /api/v1/events?limit=100
GET  /api/v1/realtime  (WebSocket upgrade)
```

`POST /api/v1/projects` returns `409 PROJECT_ALREADY_REGISTERED` and a `Location` header
when the same canonical local path already exists. It never merges metadata on conflict.

Only runtime state `ready` accepts mutations. Redis or ownership loss changes the runtime to
`degraded`; health returns 503 and mutations return `RUNTIME_NOT_READY` until owned recovery
finishes. Projection/history reads also return 503 while current Redis state is unavailable.

## Development and verification

```text
pnpm build
pnpm dev
pnpm lint
pnpm format
pnpm typecheck
pnpm test
pnpm test:integration
pnpm clean
```

Integration tests never choose a developer Redis implicitly. Use a dedicated Redis server
when possible. A dedicated database on a disposable local server can be enabled explicitly:

PowerShell:

```powershell
$env:LUWI_TEST_REDIS_URL = "redis://127.0.0.1:6379/15"
$env:LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS = "true"
pnpm test:integration
```

macOS/Linux:

```sh
LUWI_TEST_REDIS_URL=redis://127.0.0.1:6379/15 \
LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS=true \
pnpm test:integration
```

Redis Function libraries are server-scoped rather than database-scoped. The override is
therefore required when the test server is shared. Tests use run-specific keys and Function
names, never call `FLUSHDB`/`FLUSHALL`, and clean only their own state.

## Persistence and retention

The global Stream is `luwi:v1:events:global`; each project has
`luwi:v1:events:project:{projectId}`. Transition Functions do not trim Streams. A periodic
retention service applies configurable approximate limits.

For standard Redis versions before 8.2, global trimming occurs only when the realtime group
reports valid metadata, zero pending entries, zero lag, and a healthy relay. Otherwise LUWI
defers trimming so recoverable entries are not destroyed. Project and dead-letter Streams
have independent bounds.

AOF with `everysec` improves local durability but is not a backup and may lose roughly the
most recent second during a host failure.

## Package boundaries

- `@luwi/protocol`: validated versioned wire schemas and event envelopes.
- `@luwi/runtime`: Redis-independent paths, status policy, errors, and readiness.
- `@luwi/redis`: Redis client boundary, keys, Functions, repositories, Streams, ownership,
  retention, and recovery primitives.
- `@luwi/daemon`: lifecycle, security, HTTP/WebSocket transport, relay, and sweeper.
- `@luwi/cli`: local HTTP/WebSocket client and simulations.

No separate packages exist for IRIS, sessions, lifecycle, metrics, memory, or knowledge
graphs. Those boundaries remain deferred until real consumers prove them.

## Roadmap disclaimer

Phase 2 may add asynchronous session request/reply with inbox delivery, acknowledgement,
correlation, timeout, and evidence metadata. It must build on the tested daemon protocol and
must not bypass daemon-owned Redis access.
