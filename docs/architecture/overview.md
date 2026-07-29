# LUWI Runtime architecture

## Scope and sources of truth

LUWI Runtime is a local-first, single-user coordination layer around existing coding agents.
The daemon runs only on `127.0.0.1`.

Git and the local filesystem are canonical for project code and configuration, including
LUWI/native-agent configuration, skills, hooks, policies, MCP definitions, documentation,
and test evidence.

Redis is the only runtime datastore and owns all operational state: events, project/session
projections, indexes, presence, heartbeat deadlines, relay delivery state, and cached or
derived operational views. It is the operational database, event bus, coordination fabric,
and projection store—not a cache in front of another database.

## Conceptual planes

### Control plane

The control plane identifies filesystem/Git-backed projects and configuration. Phase 1
persists a runtime project registration in Redis, while the project directory remains the
source of its code. Duplicate canonical local paths are rejected atomically rather than
merged.

### Coordination plane

IRIS coordination currently covers registered sessions, opaque agent IDs, heartbeats,
presence, status transitions, normalized project/runtime events, and realtime delivery.
These are modules within `@luwi/runtime`, `@luwi/redis`, and the daemon; IRIS is not a
separate package.

### Execution plane

Codex, Claude Code, Gemini CLI, Kimi, Git, worktrees, test runners, and build tools execute
work. LUWI coordinates them and never becomes the coding-agent process.

## Package boundaries

- `@luwi/protocol` owns strict Zod wire schemas, normalized Runtime events, HTTP responses,
  and WebSocket wrappers.
- `@luwi/runtime` owns Redis-independent path canonicalization, status policy, readiness,
  in-flight mutation tracking, and typed errors.
- `@luwi/redis` owns the official Redis client, key construction, stored representations,
  Redis Functions, repositories, ownership mechanics, Streams, retention, and dead-letter
  persistence. Redis data is validated before crossing this boundary.
- `@luwi/daemon` composes security, lifecycle, HTTP routes, the presence sweeper, the
  consumer-group relay, and bounded WebSocket queues. It is the only process with Redis
  credentials.
- `@luwi/cli` is an HTTP/WebSocket client. Its simulations model a future Session Bridge
  without direct Redis access.

Metrics, lifecycle, memory, graph, session routing, and IRIS do not have speculative package
boundaries.

## Runtime lifecycle and ownership

The explicit states are:

```text
starting -> recovering -> ready -> degraded -> recovering
                         ready -> draining -> stopped
```

Only `ready` accepts state mutations.

Startup uses separate Redis connections for commands/Functions, blocking relay reads, and
administrative bootstrap:

1. connect command and administrative clients;
2. acquire `luwi:v1:runtime:daemon-owner` with a token containing `runtimeInstanceId`;
3. inspect and safely load/replace `luwi_v1` only when its version/content hash differs;
4. verify all expected Functions and the content hash;
5. ensure `luwi:v1:events:global` and `luwi-realtime-v1`;
6. create consumer `daemon-{runtimeInstanceId}` and the internal WebSocket hub;
7. recover stale pending entries;
8. start continuous relay processing, presence sweeping, and retention;
9. mark `ready`, then open Fastify on `127.0.0.1:4782`.

If another valid owner exists, startup returns `DAEMON_ALREADY_RUNNING` before Function,
consumer, or listener mutation. The owner lease is renewed periodically. Ownership loss or
Redis loss makes the runtime degraded and rejects new mutations.

Recovery uses bounded exponential backoff. After Redis returns, the daemon revalidates
ownership, Functions, Stream/group state, and stale pending work before returning to ready.
Read-only requests never label unavailable Redis state as current.

Shutdown changes to `draining`, rejects new mutations, immediately stops scheduling new
sweeps/retention, boundedly waits for tracked background and accepted work, and lets the
relay catch up within the same drain deadline. A blocked relay read is disconnected at the
deadline. If an accepted HTTP mutation is still blocked at the deadline, its command
connection is aborted; Fastify close is bounded and force-closes remaining transport
connections. The daemon then closes Redis clients, compare-and-deletes the owner token if
still owned, and marks `stopped`. Only fully processed events are acknowledged.

## Atomic transition flow

```text
HTTP validation
    -> filesystem canonicalization
    -> Redis Function preflight
    -> projection mutation
    -> global + project Stream persistence
    -> consumer-group relay
    -> bounded WebSocket queues
    -> XACK
```

Redis Functions use Redis server time so projection and event timestamps agree. Product
policy and path inspection happen before invocation. Before their first write, event-emitting
Functions verify both Stream types and that neither has exhausted Redis's maximum Stream ID.
Global and project Streams receive independent Redis-generated IDs. Once a Function begins
mutation, its writes and the required event appends form one Redis atomic transition.

The production library and functions are:

```text
library: luwi_v1

luwi_project_register_v1
luwi_session_register_v1
luwi_session_heartbeat_v1
luwi_session_status_v1
luwi_session_close_v1
luwi_session_disconnect_v1
luwi_function_version_v1
```

## Phase 1 Redis taxonomy

```text
luwi:v1:events:global
luwi:v1:events:project:{projectId}
luwi:v1:events:dead-letter

luwi:v1:project:{projectId}
luwi:v1:session:{sessionId}

luwi:v1:index:projects
luwi:v1:index:project:path:{pathIdentityHash}
luwi:v1:index:project:{projectId}:sessions
luwi:v1:index:agent:{agentId}:sessions

luwi:v1:presence:session:{sessionId}
luwi:v1:deadline:heartbeats
luwi:v1:runtime:daemon-owner
```

The agent session index is derived membership, not an AgentDefinition. Phase 1 never creates
`luwi:v1:agent:{agentId}`.

Session inbox/outbox Streams and message projections are deferred to Phase 2.

## Projects and path identity

Project registration resolves an absolute path, resolves symlinks/junctions where possible,
normalizes separators and roots, and derives an identity path. Windows identity comparison
is case-insensitive while the canonical display path preserves filesystem casing.

`SHA-256(identityPath)` selects the path-index key. `luwi_project_register_v1` checks the
index and project projection before any write. A duplicate returns
`409 PROJECT_ALREADY_REGISTERED`, safe existing ID/path details, and a `Location` header.
It creates neither an update nor a duplicate event. Hash collisions are a separate safe
error.

## Sessions, presence, and events

`agentId` is a required opaque identifier supplied by the caller. It is not looked up and
does not create an AgentDefinition. Multiple sessions may share an agent ID.

A session is online only when it is non-terminal and its TTL presence key exists.
Heartbeats renew presence and the deadline sorted set on every call. Durable
`session.heartbeat` events are sampled by interval unless metadata changes, while the
projection heartbeat timestamp is always renewed. The sweeper transitions expired sessions
to `disconnected` through a race-aware Redis Function.

Phase 1 events are:

```text
project.registered
session.registered
session.heartbeat
session.status.changed
session.completed
session.disconnected
```

Every event uses the validated version 1 envelope and is written to the global and applicable
project Stream.

## Relay, recovery, and WebSocket guarantees

The authoritative realtime source is `luwi:v1:events:global`; Phase 1 does not use Pub/Sub.
The persistent group is `luwi-realtime-v1`, with a daemon-specific consumer.

Startup recovery inspects pending entries, claims stale work with `XAUTOCLAIM`, validates
each event, dead-letters malformed entries, accepts valid events into the internal
broadcaster, and then acknowledges. Failed processing remains pending. Startup never waits
for WebSocket clients or replays recovered history to future clients.

Continuous delivery reinspects `XPENDING` and runs `XAUTOCLAIM` before each blocking
`XREADGROUP`, so entries younger than the claim threshold at startup are not stranded.
Poison entries are retried through the pending path; after three dead-letter failures they
keep recovery degraded until safely persisted and acknowledged. Delivery is at least once.
Each healthy WebSocket client has a bounded FIFO queue and at most one send in flight. Slow,
overflowed, invalid, or over-buffered clients are disconnected. With no clients, validated
events can be acknowledged immediately.

WebSocket transport is best effort. `XACK` means validated relay processing and queue
acceptance, not remote receipt. A client reconnects, fetches current project/session
snapshots, and resumes realtime events. Phase 1 has no history cursor/catch-up endpoint.

The route is exactly `/api/v1/realtime`, server-to-client only. Browser origins must exactly
match configured loopback origins. A native no-Origin client is allowed only with loopback
remote address, exact loopback Host/port, and exact path.

Malformed entries go to the independently bounded dead-letter Stream with issue codes,
runtime version, consumer/source identity, content hash, and a redacted 2 KiB diagnostic
preview. If dead-letter persistence fails, the source remains pending; three consecutive
poison failures degrade the runtime.

## Persistence and retention

Local Compose Redis uses:

```text
appendonly yes
appendfsync everysec
```

`/data` is a named persistent volume and port 6379 is exposed only on loopback. AOF is a
durability improvement, not a backup.

Transition Functions do not trim. The periodic retention service applies approximate
`MAXLEN` limits. On Redis versions before 8.2, global trimming requires valid group metadata,
zero pending, zero lag, and a healthy relay. Otherwise it is deferred. Project Streams and
the dead-letter Stream have independent bounds. Temporary growth is preferred to destroying
recoverable pending work.

## Future Session Bridge and MCP adapter

A future Session Bridge will accompany an external coding-agent process and use only the
daemon protocol to register, heartbeat, update status, receive and acknowledge messages,
respond, request leases, and close. Terminal injection remains out of scope.

A future MCP server may adapt the stable daemon protocol. It will not receive Redis
credentials and is not required by Phase 1.
