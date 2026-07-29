# Redis-native local runtime design

## Status

Approved on 2026-07-28 for architecture cleanup before Phase 1.

## Goal

Simplify LUWI Runtime into a single-user, loopback-only developer runtime where
Git and the local filesystem are canonical for code and configuration, while
standard Redis is the only runtime datastore and owns all operational state.

## Scope

This cleanup changes architecture documentation, package boundaries, local
configuration, and the daemon's binding guard. It does not implement Phase 1
projects, sessions, heartbeats, event persistence, WebSockets, messages, tasks,
leases, projections, consumer workers, or Redis Functions.

## Package boundaries

The workspace has two applications and three packages:

```text
apps/
  daemon/
  cli/

packages/
  protocol/
  runtime/
  redis/
```

- `@luwi/protocol` owns versioned Zod schemas and wire types.
- `@luwi/runtime` owns Redis-independent runtime behavior, typed errors,
  lifecycle events, and future project, session, task, message, lease, and
  projection modules until additional package boundaries are proven.
- `@luwi/redis` owns the official Redis client and all Redis-specific
  representations and operations.
- `@luwi/daemon` composes protocol, runtime, and Redis behavior. It is the only
  process allowed to receive Redis credentials.
- `@luwi/cli` communicates with the daemon over versioned HTTP and never imports
  the Redis package.

The existing `@luwi/core` and `@luwi/iris` packages are physically consolidated
into `@luwi/runtime`; compatibility packages are not retained.

## Sources of truth

Git and the local filesystem are canonical for:

- project source code;
- LUWI configuration;
- native coding-agent configuration;
- skills;
- hooks;
- policies;
- profiles;
- MCP definitions.

Redis is canonical for runtime and operational state:

- normalized events and audit history;
- sessions, presence, and heartbeats;
- messages, tasks, and leases;
- current-state projections;
- cached metrics, lifecycle views, and graph relations derived from events.

Metrics, lifecycle state, and knowledge-graph relations must be rebuildable from
normalized Runtime events. No analytics, relational, embedded, graph, search, or
module-specific datastore is part of the initial architecture.

## Redis-native model

LUWI uses standard Redis features only:

- Streams for ordered durable events, audit history, session inboxes and
  outboxes, and task delivery;
- hashes for current project, agent, session, task, message, and lease state;
- sets for relationships and secondary indexes;
- sorted sets for deadlines, expiry scheduling, task priority, activity,
  lifecycle progress, and rankings;
- TTL keys for presence and temporary ownership;
- Redis Functions for atomic state transitions that must mutate projections and
  persist an event together;
- Pub/Sub only for disposable fan-out or UI invalidation after durable
  persistence.

Consumer groups acknowledge work only after successful processing. Pending
entries are inspected and stale work is recovered with `XAUTOCLAIM`. Consumers
must be idempotent because delivery is at least once.

All Streams use configurable approximate `MAXLEN` trimming. Initial defaults are
documented by stream class and may be tuned through environment configuration
without changing event schemas.

Redis AOF is enabled with `appendfsync everysec` for local development. Docker
Compose stores Redis data in a named persistent volume.

No Redis Stack module is required.

## Local security boundary

LUWI is a single-user local runtime, not an account platform:

- there is no login, signup, account, OAuth, JWT, RBAC, tenant, or organization
  subsystem;
- the daemon binds to `127.0.0.1` by default;
- configuration rejects every non-loopback bind address;
- no remote-binding override is provided in local mode;
- wildcard CORS is prohibited;
- browser and WebSocket origins must be checked against an explicit loopback
  allowlist when those transports are introduced;
- Redis is never exposed to coding agents, Session Bridges, browsers, or remote
  networks;
- secrets, complete prompts, environment dumps, and full memory documents are
  excluded from default logs.

## Data flow

```text
Git and filesystem
  source + configuration
          |
          v
CLI / future local clients
          |
          | versioned HTTP/WebSocket on 127.0.0.1
          v
      LUWI daemon
       |        |
       |        +--> @luwi/runtime state transitions
       |
       +--> @luwi/redis
               |
               +--> Redis Functions for atomic transitions
               +--> Streams for durable events and delivery
               +--> hashes/sets/sorted sets/TTL for projections
               +--> Pub/Sub for disposable fan-out only
```

## Failure handling

- Redis-unavailable health remains non-2xx.
- A state transition that requires durable persistence is not reported as
  successful unless its Redis Function completes.
- Consumers acknowledge only after processing and projection updates succeed.
- Pending messages are visible through consumer-group inspection and recoverable
  through `XAUTOCLAIM`.
- Event consumers and projection rebuilds validate stored envelopes because
  Redis data is untrusted across runtime versions.
- AOF durability reduces local data loss but is not described as zero-loss
  persistence.
- Bounded Stream retention prevents unbounded history growth; retention limits
  are operational policy, not authorization or tenant isolation.

## Verification

The cleanup is accepted only when:

- all imports and TypeScript references use `@luwi/runtime`;
- `packages/core` and `packages/iris` no longer exist;
- the frozen dependency graph contains no version upgrades;
- formatting, typecheck, lint, unit tests, and build pass;
- documentation checks find no obsolete package-boundary claims;
- the daemon rejects non-loopback binding and retains its `127.0.0.1` default;
- the daemon health and CLI runtime smoke checks still pass;
- Docker Compose configuration is formatted and, when Docker is available,
  validates through `docker compose config`.

Docker is unavailable in the current environment, so Compose execution is
reported as unverified rather than inferred.
