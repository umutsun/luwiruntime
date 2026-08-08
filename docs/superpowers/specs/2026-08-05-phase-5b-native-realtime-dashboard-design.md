# Phase 5B Native Realtime Dashboard Design

Date: 2026-08-05

## Goal and scope

Phase 5B extends the Phase 5A read-only Pulse dashboard with product-independent realtime
snapshot invalidation, a bounded Activity route, and read-only Project, Session, and Event
inspectors. Redis and daemon projections remain authoritative. The browser never writes to
Redis, reproduces backend transitions, launches agents, mutates Git/configuration, or adds
ACP, Goose, cloud, task, lease, lifecycle, release, graph, search, chat, or account domains.

The subject is a local runtime operations console for a developer coordinating generic
agent sessions. Its single job is to show validated operational change without making
claims the event envelope cannot support.

## Considered approaches

1. **Direct frontend projection updates.** Apply each event to React state. This feels live
   but duplicates daemon policy and can diverge after missed or reordered events.
2. **Refresh every REST resource for every event.** This preserves authority but creates
   request storms and refreshes unrelated domains.
3. **Bounded event intake plus resource invalidation.** Validate and deduplicate an event,
   append it to a bounded activity buffer, map its type to affected REST resources, and
   coalesce authoritative refreshes. This is the selected approach.

No direct incremental projection exception is accepted in Phase 5B. Even session heartbeat
or project registration updates are reconciled through REST.

## Architecture

```text
GET /api/v1/* -------------------------------> Resource snapshot store
                                                      |
WS /api/v1/realtime -> validate -> dedupe -> activity | -> React views
                                      |               |
                                      +-> invalidation coordinator
                                               |
                                               +-> coalesced resource GETs
```

The implementation has five small boundaries:

- `api/resources.ts` owns independently refreshable, validated REST resources and merging;
- `realtime/schema.ts` owns a browser-safe, forward-compatible wire envelope;
- `realtime/controller.ts` owns connection/reconnect lifecycle and cancellation;
- `realtime/activity-store.ts` owns bounded stream-ID dedupe, activity retention, pause,
  filtering, selection, and bounded validation diagnostics;
- `realtime/invalidation.ts` maps event types to query keys and coalesces refresh requests.

React owns only route, filter, selection, follow/pause, inspector, and presentation state.
It does not become a second operational database.

## Connection and freshness model

Realtime connection states are `connecting`, `live`, `reconnecting`, `disconnected`, and
`unavailable`. Activity following is independently `following` or `paused`; pausing never
closes the socket or changes connection state. Snapshot freshness is independently
`current` or `stale` with a last-success timestamp.

Reconnect delays are bounded at 1, 2, 5, and 10 seconds, then remain at 10 seconds. A
successful reconnect resets the attempt counter and requests one coalesced authoritative
refresh. Unmount cancels timers, closes the active socket, and prevents future callbacks.
There is no infinite synchronous loop.

REST refresh failures retain each last successful resource and mark the snapshot stale.
An obsolete response cannot replace a newer resource generation. A complete initial failure
still uses the Phase 5A unavailable states.

## Validation, deduplication, and retention

The browser validates `streamId`, event ID, protocol version, timestamp, workspace, optional
project/agent/session/correlation/causation references, a bounded event-type string, and an
unknown payload. Unknown future event types remain valid for display but do not trigger an
unproven refresh. Invalid messages are not retained; only a capped failure count and safe
reason are exposed.

- activity buffer: newest 200 validated events;
- stream-ID dedupe memory: newest 512 IDs;
- pending paused count: capped at 200;
- event payload inspector preview: 8 KiB maximum serialized text;
- announcement: one summarized live-region update per accepted event batch.

The canonical Redis stream ID is the only deduplication identity. Timestamp, type, and event
ID are not used as substitutes.

## Invalidation and refresh

Invalidations are collected for 250 ms. At most one refresh batch runs at a time; arrivals
during a running batch create one trailing batch. Each resource has a monotonically
increasing generation so older responses are ignored.

| Event class                                                                       | Refreshed resources                                                               |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `runtime.*`                                                                       | health plus all overview resources after reconnect/start                          |
| `project.*`                                                                       | projects                                                                          |
| `session.*`                                                                       | sessions                                                                          |
| `agent.definition.*`, `project.agent.*`                                           | agents                                                                            |
| `usage.*`                                                                         | usage                                                                             |
| `context.*`                                                                       | context                                                                           |
| `optimization.finding.*`, `optimization.analysis.*`                               | findings                                                                          |
| all validated events                                                              | activity is appended locally; REST activity reload only on reconnect/manual retry |
| message/config/capability/profile/Git/package/technology/graph/attribution events | activity only in 5B                                                               |
| unknown future event                                                              | activity only, marked unsupported                                                 |

Project active-session counts are derived from refreshed sessions, so session events do not
needlessly refetch the unchanged project registry.

## Activity route

`#/activity` is the second active route. Its initial rows come from the bounded REST event
snapshot, then validated WebSocket messages append. Rows show timestamp, generic source
(agent/session/project/runtime), event type, project, and session. Controls provide
follow/pause, pending count, project/source/type filters, bounded local search, keyboard
row navigation, selection, and Event Inspector. The 200-row bound does not justify a
virtualization dependency.

Auto-follow occurs only while follow mode is enabled and the list is already at its newest
edge. Manual upward scrolling pauses visual follow but not the socket. Resume clears the
pending count and scrolls once to the newest row.

## Inspectors

The right-side overlay uses a single accessible dialog shell. It moves focus inside on open,
closes on Escape, and returns focus to the invoking control.

- **Project:** ID, name, canonical/display path available in the project snapshot, active
  sessions, and bounded related events. Lifecycle, readiness, tasks, leases, GitHub, owner,
  health score, and unreliable inventory joins are omitted.
- **Session:** ID, project, agent ID, state, presence, start, heartbeat, duration, optional
  branch, and bounded related events. Task/file/lease/worktree ownership/model/provider/ACP
  and tool timeline are omitted.
- **Event:** stream ID, event ID/type/time, workspace/project/session/agent references,
  correlation/causation IDs, safe bounded structured payload, and supported navigation
  targets. Strings are React text, never HTML or executable links.

## Visual and accessibility direction

Phase 5A tokens remain the source of truth: graphite surfaces, indigo selection, restrained
semantic colors, 220 px text rail, 12 px minimum technical metadata, thin rules, compact
rows, and small radii. The signature is a continuous ledger-like activity rail whose stream
ID appears only in detail. The inspector is a quiet right-hand technical sheet, not a nested
dashboard.

At 1280 px it overlays the workspace; at 1440 and 1728 px it remains at most 480 px wide.
The document never gains horizontal overflow. Status uses text, focus is visible, reduced
motion is respected, and live announcements are summarized rather than emitted for every
high-frequency field change.

## Dependencies and security

No dependency is added. WebSocket, timers, AbortController, React, Zod, existing protocol
schemas where browser-safe, and existing Vitest/Testing Library are sufficient. No vendor,
ACP, Goose, database, global state, UI-kit, virtualization, or telemetry package is needed.

All traffic remains same-origin and loopback protected. Dashboard source has no Redis or
filesystem import. The server stays server-to-client only, keeps bounded queues, and rejects
invalid Host/Origin upgrades. The client never renders credentials, URLs, environment data,
raw HTML, or unbounded payloads.

## Test strategy

Pure unit tests cover schema validation, unknown events, dedupe/retention, pause/resume,
filters, invalidation mapping, coalescing, reconnection, cancellation, and stale merge rules.
React tests cover routes, activity interaction, keyboard selection, inspectors, focus return,
escaping, and partial states. Existing daemon tests remain the security authority for asset,
Host/Origin, queue, and relay behavior. Full unit, real Redis integration, build, diff, and
browser measurement gates close the phase.
