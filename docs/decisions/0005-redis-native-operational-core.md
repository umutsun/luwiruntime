# ADR 0005: Redis-native operational core

- Status: Accepted
- Date: 2026-07-28
- Updated: 2026-07-29

## Context

ADR 0004 selects Redis as LUWI's only runtime datastore. LUWI needs atomic current-state
transitions, durable ordered events, recoverable realtime processing, bounded history, local
durability, and rebuildable projections without Redis Stack modules or another database.

Phase 1 also requires single-daemon authority: Function bootstrap and consumer recovery must
not race between local daemon processes.

## Decision

### Sources of truth

Redis is the only runtime datastore and is the operational database, event bus, coordination
fabric, delivery system, and projection store.

Git and the filesystem are canonical only for source code and configuration. Metrics,
lifecycle views, rankings, and knowledge-graph relations must be rebuildable projections of
normalized Runtime events.

There is no authentication, account, RBAC, or tenant subsystem in local mode. Optional
external storage may be introduced only through adapters after a demonstrated requirement.

### Phase 1 key taxonomy

All keys use `luwi:v1:` and are constructed only by `@luwi/redis`:

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

Hashes store project/session projections. Sets store membership and secondary indexes. The
heartbeat sorted set stores expiration deadlines. Presence and daemon ownership use TTL
keys. The agent session index does not represent an AgentDefinition.

At the time of this Phase 1 decision, session inbox/outbox Streams, task delivery, messages,
leases, metrics, lifecycle, and graph projections were deferred. ADR 0006 subsequently
implements session inbox request/reply; outboxes, tasks, leases, metrics, lifecycle, and
graph features remain deferred.

### Event and projection model

Every Phase 1 transition writes a versioned normalized event to
`luwi:v1:events:global` and the applicable project Stream in the same Redis Function that
mutates its projection/indexes. Redis server time authors both projection and event
timestamps.

The global Stream is authoritative for realtime relay and history. Project Streams provide
bounded project-local history. Pub/Sub is not used in Phase 1 and must never become a source
of truth.

### Single-daemon ownership

After connecting, a daemon acquires `luwi:v1:runtime:daemon-owner` with an owner token
containing its `runtimeInstanceId` and a TTL. Renewal and release compare the exact token
atomically.

An existing valid owner produces `DAEMON_ALREADY_RUNNING` before Function mutation,
consumer creation/recovery, or listener startup. Ownership loss degrades the runtime and
stops mutation authority. Recovery revalidates ownership before returning to ready.

### Redis Functions boundary

The production library is `luwi_v1`:

```text
luwi_project_register_v1
luwi_session_register_v1
luwi_session_heartbeat_v1
luwi_session_status_v1
luwi_session_close_v1
luwi_session_disconnect_v1
luwi_function_version_v1
```

Functions preflight all known domain conflicts, both Stream types, and exhausted maximum
Stream IDs before their first write. Global/project appends use independent Redis-generated
IDs. Functions then mutate projections and indexes, maintain TTL/deadline state, and append
required events atomically.

Product policy, path inspection, transport validation, and status-transition decisions
remain outside Lua. Function deployment, invocation, and result validation remain in
`@luwi/redis`.

During owned startup/recovery the daemon uses `FUNCTION LIST`; it executes
`FUNCTION LOAD REPLACE` only when the expected version/content hash differs, then verifies
the library, hash, and function names before readiness. It never replaces `luwi_v1` while a
different valid owner exists.

### Consumer group and failure recovery

The global relay group is `luwi-realtime-v1`; each daemon uses
`daemon-{runtimeInstanceId}`.

The group is created at `$` only when absent, preserving existing cursor and pending state.
Startup inspects `XPENDING`, claims stale entries with `XAUTOCLAIM`, validates stored events,
dead-letters malformed entries, completes broadcaster acceptance, and acknowledges only
successful processing. Failed entries remain pending.

Continuous processing reinspects pending state and runs `XAUTOCLAIM` before `XREADGROUP`
with `>`, preventing initially young pending entries from being stranded. Poison entries are
retried through the pending path; three dead-letter failures keep the runtime degraded until
the entry can be safely persisted and acknowledged. Delivery is at least once. WebSocket
delivery is best effort: `XACK` proves validated relay processing and queue acceptance, not
remote receipt.

Recovered startup events are processed without waiting for clients. New clients fetch
current projections and receive events emitted after the running connection state; Phase 1
does not expose a history cursor.

### Persistence

Local Redis enables:

```text
appendonly yes
appendfsync everysec
```

Compose mounts `/data` to `luwi-redis-data` and publishes Redis only on
`127.0.0.1:6379`. AOF may lose roughly the latest second during a host failure and is not a
backup.

### Bounded retention

Transition Functions never trim Streams. A periodic service applies these configurable
defaults:

```text
LUWI_STREAM_MAXLEN_GLOBAL=100000
LUWI_STREAM_MAXLEN_PROJECT=50000
LUWI_STREAM_MAXLEN_DEAD_LETTER=10000
LUWI_RETENTION_INTERVAL_MS=60000
LUWI_CONSUMER_CLAIM_IDLE_MS=30000
```

On standard Redis versions before 8.2, the global Stream is trimmed only when group metadata
is valid, pending is zero, lag is zero, and the relay is healthy. Otherwise trimming is
deferred. This conservative fallback avoids blindly removing recoverable pending entries.
Project Streams and the dead-letter Stream have independent bounds.

### Redis loss and draining

Redis loss makes health, mutations, and current projection/history reads return 503 rather
than presenting unavailable state as current. The daemon reconnects with bounded exponential
backoff, revalidates ownership, Functions, Stream/group state, and pending recovery, then
returns to ready only after success.

Shutdown enters `draining`, rejects new mutations, stops scheduling sweeps/retention, and
boundedly waits for tracked background and accepted in-flight work. It lets the relay process
persisted events within the shared drain deadline and disconnects a blocked relay read at
that deadline. A still-blocked accepted mutation has its command connection aborted, and
Fastify close is bounded before remaining transports are force-closed. Shutdown acknowledges
only fully processed entries, closes Redis clients, and releases ownership only if the token
still matches.

## Consequences

LUWI has one operational consistency boundary and recoverable coordination using standard
Redis 7 features. Current queries are efficient through hashes, sets, TTL keys, and sorted
sets; Streams preserve ordered history.

The design requires careful Function versioning, Redis-data validation, at-least-once
consumer behavior, conservative retention, owner-lease monitoring, and tested recovery.
Redis availability is required for mutations; LUWI must never report an unpersisted success
or fall back to an in-memory source of truth.
