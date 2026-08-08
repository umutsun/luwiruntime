# ADR 0006: Session inbox request/reply

- Status: Accepted
- Date: 2026-07-29

## Context

LUWI Runtime needs one recoverable same-project communication primitive for independent
coding-agent sessions. WebSocket delivery alone cannot survive bridge disconnects, and
Redis Pub/Sub cannot provide durable delivery, pending inspection, replay, or atomic
coordination with the authoritative message projection.

The daemon remains the sole Redis client. CLI simulations and the MCP adapter must use the
versioned loopback HTTP API.

## Decision

Each message has an authoritative Redis hash projection and a stable correlation ID. A
Redis Function atomically creates the projection and indexes, appends the request to the
target session inbox Stream, and persists the normalized event to global and project
Streams.

Each registered session has:

```text
luwi:v1:inbox:session:{sessionId}
```

The persistent consumer group is `luwi-session-inbox-v1`. Bridge consumers are named
`bridge-{bridgeInstanceId}` and delivery is at least once.

Claim processing performs `XAUTOCLAIM` before `XREADGROUP`. Requests remain pending through
delivered, acknowledged, and processing states. A terminal response, rejection, failure, or
timeout acknowledges the original target entry. Terminal work delivered again is
acknowledged and skipped after the authoritative projection is checked.

Inbox Redis reads are non-blocking. The bounded HTTP wait uses short readiness-aware daemon
polls so the normal Redis command connection remains available to heartbeats, transitions,
timeout processing, and other bridges.

Routing is limited to online non-terminal sessions in the source project. Opaque
`targetAgentId` selection is deterministic. An optional `Idempotency-Key` is hashed and
scoped to the source session; the same normalized request returns the existing message,
while a different request returns `IDEMPOTENCY_KEY_CONFLICT`.

The application clock selects timeout candidates, but the timeout Redis Function uses Redis
server time and verifies the stored deadline and current projection atomically. A response
that wins makes timeout unchanged; a timeout that wins prevents a late response from
overwriting it.

The existing global Stream consumer-group relay is the only WebSocket event path. Realtime
events may wake a bridge, but durable delivery always comes from inbox claim.

The stdio MCP server is a thin official-SDK client of daemon HTTP. It binds to one online
session, derives source/responder identity from that binding, validates every daemon
response, and never connects to Redis.

## Consequences

- Disconnects and process restarts can recover pending inbox work with `XAUTOCLAIM`.
- Message processing must be idempotent because delivery is at least once.
- Pending and lagged inboxes may temporarily grow beyond configured retention limits;
  recoverability takes priority over aggressive trimming.
- Terminal projections must remain while their idempotency index is live.
- Redis Functions and the protocol carry more explicit transition states and compatibility
  tests.
- WebSocket clients cannot treat realtime delivery as durable inbox acknowledgement.
- Native coding-agent adapters, terminal injection, task delegation, leases, and dashboard
  UI remain deferred.

## Rejected alternatives

- Redis Pub/Sub as the delivery source: it loses work across disconnects and has no pending
  recovery.
- Direct Redis access from bridges or MCP: it bypasses daemon validation, readiness,
  ownership, and safe errors.
- Holding HTTP requests indefinitely: it prevents bounded draining/recovery and is
  operationally fragile.
- A separate message datastore or queue package: Redis already provides the required
  operational database, Streams, indexes, TTL, and atomic Functions.
