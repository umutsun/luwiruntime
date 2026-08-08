# Phase 5 Dashboard Realtime Contract

Date: 2026-08-05

## Endpoint and preconditions

The endpoint is `GET /api/v1/realtime` with a WebSocket upgrade
(`apps/daemon/src/app.ts:1200`). The daemon must be listening on `127.0.0.1`. The exact Host,
loopback remote address, and optional Origin are checked against configured loopback
allowlists (`apps/daemon/src/websocket-hub.ts:160`). `Origin: null`, remote addresses,
unexpected Hosts, and unexpected Origins are rejected. Clients sending messages are closed
with policy code 1008; the channel is server-to-client only.

## Wire envelope

The server serializes one strict envelope per message:

```ts
type RealtimeEventMessage = {
  streamId: string; // /^\d+-\d+$/
  event: {
    id: string;
    version: 1;
    type: string;
    occurredAt: string; // UTC ISO 8601
    workspaceId: string;
    projectId?: string;
    agentId?: string;
    sessionId?: string;
    correlationId?: string;
    causationId?: string;
    payload: unknown;
  };
};
```

Protocol evidence is `packages/protocol/src/realtime.ts:5` and
`packages/protocol/src/runtime-event.ts:7`. The server currently validates event types
against the implemented enum before relay. The browser uses the same structural contract
with a bounded string for `type` so a future server event can render safely during a rolling
frontend upgrade.

`streamId` is the canonical deduplication identity. Event timestamps and event IDs are not
ordering/deduplication substitutes.

## Persistence, ordering, and duplicates

Events are persisted in the global Redis Stream before the relay reads them. The relay uses
consumer group `luwi-realtime-v1`, acknowledges only after the bounded WebSocket hub accepts
the message, and continuously recovers pending entries with `XPENDING`/`XAUTOCLAIM`
(`packages/redis/src/event-streams.ts`, `apps/daemon/src/realtime-relay.ts`). Processing is
at least once, so pending recovery can redeliver a stream ID.

Within one connected client, the hub keeps FIFO send order. Its queue, buffered-byte limit,
and send timeout are bounded; a slow client is closed with code 1013. There is no global
exactly-once or client receipt guarantee.

The REST event history endpoint returns the latest retained entries in ascending stream
order after a bounded reverse read. It is the reconnect/activity seed, not an infinite log.

## Reconnect and snapshot expectations

The WebSocket handshake has no cursor parameter and sends no backlog to a newly connected
client. Therefore both the interval before the first connection and a later disconnect can
miss events. Every transition into `live`, including the first one and each reconnect,
requests one coalesced authoritative refresh of every snapshot resource and the Activity
seed. Repeated `live` notifications without an intervening state change do not request
another refresh. The dashboard retains its last safe REST snapshot and never tries to
rebuild Redis projections from missed events.

When a safe snapshot exists, beginning that request publishes `refreshing` without clearing
any retained resource. Success returns to `current`. A failed or partial authoritative result
preserves successful resources and marks failed resources `stale`; when no safe resource
exists, freshness is `unavailable`. Aborted or obsolete generations cannot overwrite a newer
generation.

The visible Retry action is routed through this same refresh controller and coalescing path;
it does not create a second freshness owner or rerun bootstrap while a safe snapshot is
visible. Bootstrap derives `current` only when at least one validated resource is ready and
uses `unavailable` when no safe resource exists.

Duplicate stream IDs after recovery/reconnect are ignored by a 512-entry client cache. The
visible activity buffer retains 200 events. Invalid envelopes are dropped and counted with
bounded diagnostics; they never enter activity or trigger refresh.

## Event-to-snapshot invalidation

| Implemented event family                                                   | Dashboard invalidation                              |
| -------------------------------------------------------------------------- | --------------------------------------------------- |
| `runtime.*`                                                                | health; full overview after runtime start/reconnect |
| `project.*`                                                                | projects                                            |
| `session.*`                                                                | sessions                                            |
| `agent.definition.*`, `project.agent.*`                                    | agents                                              |
| `usage.*`                                                                  | usage summary                                       |
| `context.*`                                                                | context contributions                               |
| `optimization.finding.*`, `optimization.analysis.*`                        | optimization findings                               |
| message/config/capability/profile/Git/package/technology/graph/attribution | Activity only                                       |
| unknown future type                                                        | Activity only, unsupported details label            |

Invalidations coalesce for 250 ms and produce at most one trailing batch while a refresh is
running. An initial or reconnecting `live` edge requests one full batch. No event directly
mutates the Pulse projection.

## Stale and failure behavior

- WebSocket failure does not clear a valid snapshot.
- An in-flight REST refresh keeps retained data visible and labels it as refreshing.
- A failed REST refresh preserves the last successful resource and marks the snapshot stale
  with its last-success time.
- Redis-degraded health remains distinct from transport failure.
- User pause affects only visual following; the socket remains live.
- Unknown valid events remain inspectable; malformed messages do not.

## Unsupported classes and security

Phase 5B has no frontend projection logic for tasks, leases, lifecycle/release, GitHub, ACP,
Goose, graph visualization, configuration apply/rollback, or agent execution. Event payloads
are untrusted: the UI uses text nodes and an 8 KiB structured preview, never HTML. Redis
credentials, URLs, environment variables, and backend field representations are absent.
