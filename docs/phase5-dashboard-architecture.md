# Phase 5 Dashboard Architecture (5A + 5B)

Date: 2026-08-05

## Decision

`apps/dashboard` is a React 19 + TypeScript + Vite application. Vite is build tooling, not a
runtime service. The production bundle is served by the existing Fastify daemon on the same
loopback origin. The dashboard has no Redis client, filesystem access, external analytics,
CDN resources, remote fonts, mutation controls, or product-specific integration.

No Phase 5B dependency was added. Web platform WebSocket, AbortController, timers, and the
existing Zod/React stack are sufficient; this avoids a frontend event bus, global state
framework, WebSocket framework, or vendor SDK.

## Boundaries

```text
Browser
  -> GET / and /assets/*       built dashboard files
  -> GET /health, /api/v1/*    validated daemon reads
  -> WS /api/v1/realtime       validated normalized events

apps/dashboard
  api/          validated transport, resource results, stale-preserving refresh
  pulse/        pure snapshot mapping and derivations
  realtime/     validation, bounded deduplication, reconnect and invalidation
  activity/     bounded filters and live-follow state
  inspectors/   read-only project, session and event evidence
  components/   semantic rendering
  styles/       normalized tokens and desktop layout
```

`@luwi/protocol` is reused where its schemas are browser-safe. Session and realtime
collections use narrow equivalent browser schemas because the canonical runtime event module
has a Node crypto import and the canonical session metadata validation is Node-specific. API
reads import the explicit `@luwi/protocol/browser` entry, which exports only browser-safe
schema modules and never evaluates the Node runtime-event factory. API state, WebSocket
connection state, Activity following, snapshot freshness, inspector selection, and route
state remain separate.

The frontend never imports `@luwi/redis`, `@luwi/runtime`, daemon internals, or adapters. It
calls no mutation endpoint.

## Routes and read surfaces

`#/pulse` and `#/activity` are implemented. Other modules remain disabled `Planned` labels,
not links or buttons. Project inspection uses project identity/path, active-session count,
and up to 20 newest retained matching Activity events. Session inspection is available from
the active-session table and retained Activity references; it shows IDs, status, presence,
timestamps, project name, optional branch, an honest bounded duration, and up to 20 newest
matching events. Event inspection uses the validated envelope and an 8 KiB text-only payload
preview. A Project action requires a known project snapshot. A Session action requires a known
session and, when the event also names a project, the session's authoritative `projectId` must
match it. Conflicting or missing references remain text-only and explicitly unavailable; the
event payload is never corrected or trusted as navigation authority. Active Session duration
captures one time value per render and advances through one 60-second inspector clock that is
removed for terminal sessions, navigation away, close, and unmount.

Lifecycle, release readiness, tasks, leases, ownership, GitHub state, inferred scores,
agent execution, configuration apply/rollback, and cloud/account surfaces remain absent.

## Snapshot, realtime, and failure model

Initial resources are fetched independently and validated. A failed request or missing field
never becomes zero. A complete transport failure shows daemon unavailable; a validated
non-2xx health response shows degraded. A sibling endpoint failure leaves valid panels
visible.

Realtime has explicit `connecting`, `live`, `reconnecting`, `disconnected`, and `unavailable`
states. Reconnect uses 1, 2, 5, then 10 second bounded delays. Every edge into `live`, both
the initial connection and a reconnect, triggers one coalesced full refresh because the
WebSocket protocol has no backlog cursor. Duplicate `live` notifications are inert. Realtime
failure never clears a valid snapshot.

Event invalidations coalesce for 250 ms. One refresh may run with one trailing batch.
Obsolete requests are aborted and generation-checked. Failed resource refreshes preserve
prior data and visibly mark affected resources stale. An authoritative request first emits a
non-destructive `refreshing` snapshot when retained safe data exists, then resolves to
`current`, `stale`, or `unavailable`; the refresh controller remains the single freshness and
resource-generation owner.

First-live, reconnect, realtime invalidation, and the visible Retry action all enter that
same controller. The initial bootstrap is `unavailable` when it contains no ready resource;
manual Retry does not create a parallel bootstrap freshness path.

Activity is a narrow incremental exception: a structurally validated event is appended by
canonical `streamId`. This operation is idempotent and cannot mutate a backend projection.
The Activity buffer is capped at 200 events and duplicate memory at 512 stream IDs. REST
remains authoritative for Pulse projections and reseeds Activity after reconnect. Unknown
valid events remain visible with an unsupported-type label; malformed or over-64 KiB
messages are rejected and only a bounded count is retained.

## Security

- daemon loopback Host/Origin policy remains authoritative;
- asset serving uses the allowlisted entry and validated Vite asset filenames;
- no SPA fallback accepts arbitrary filesystem paths;
- Redis is shown only as local status/latency, never a credential or URL;
- untrusted strings render through React text nodes; no raw HTML API is used;
- event payload previews are text-only and capped at 8 KiB;
- the browser receives no Redis credentials and never connects to Redis.

## Desktop and accessibility

The supported floor is 1280 px with 1440x960 and 1728x1117 reference sizes. The sidebar is
220 px. Secondary Pulse columns stack at narrower desktop widths. Activity controls wrap to
two columns; technical values truncate or wrap inside their own bounds. The inspector
overlays from the right and does not resize the page.

Focus is keyboard-visible. Activity rows and inspectors are keyboard reachable. Manual
scrolling pauses visual following without changing connection state. Inspectors receive
initial focus, close on Escape, and restore focus to the opener. High-frequency events are
announced through one hidden polite live region that aggregates accepted additions for 750
ms. Initial history, duplicates, filter changes, and inspector actions are silent; paused
announcements state that new events are waiting. The paused new-event count and bounded
invalid-message count remain visible summarized status. Reduced-motion preference is
respected.

## Development transport

Production keeps the daemon's existing origin defaults and same-origin asset/API/WebSocket
transport on `127.0.0.1:4782`. Development uses Vite on `127.0.0.1:4783`; its explicit
`/api` proxy enables WebSocket upgrades and its `/health` proxy remains HTTP-only. The daemon
receives the exact upstream Host through `changeOrigin`; the browser Origin remains subject
to daemon validation. The daemon must be started with `LUWI_ALLOWED_ORIGINS` explicitly including
`http://127.0.0.1:4783`. No development origin is added to production defaults.

## Testing

Vitest and React Testing Library cover the shell, snapshots, connection transitions,
envelope validation, stream-ID deduplication and bounds, refresh coalescing/cancellation,
stale preservation, Activity filtering/following, inspector focus and safe payloads, and
product independence. Existing daemon tests cover asset traversal, Host/Origin, slow-client
queues, persistence-first relay, and Redis recovery behavior.

## Phase 5C — project scope

Date: 2026-08-08

`#/projects` and `#/projects/<projectId>` are implemented. Route parsing moved out of an inline
helper into `apps/dashboard/src/routing.ts` because a third route can now carry an identifier.
`parseRoute` never throws: an unknown route, a malformed percent sequence, an over-long identifier
(the protocol bound is 128), or extra path segments each degrade to the nearest safe route rather
than blanking the shell. `routeHref` percent-encodes the identifier so a value containing `/`
cannot forge an extra segment.

The project list needs no new request. It renders name, middle-abbreviated local path with an
accessible full-value title, and the active-session count already derived by `buildPulseSnapshot`.

Project detail loads on demand through `loadProjectScope`, which issues four independent bounded
reads and returns each with its own state. `apps/dashboard/src/api/project-scope.ts` owns the
mapping and reduces commit `changedPaths` to a count, so no full path list ever reaches the
browser.

Project scope has its own invalidation mapper rather than widening `PulseResourceKey`. The two
refresh domains have different lifetimes — the Pulse snapshot is always present, project scope
exists only while a project is selected — so coupling them would make either harder to reason
about. A selection change aborts the in-flight load and clears retained resources first, so a slow
response can never render one project's evidence under another project's name. A realtime refresh
is dropped by a generation guard if the selection moved on.

`Graph` remains a disabled `Planned` label. The daemon exposes only rooted graph queries, so no
honest global summary can be derived; inventing one would be a fabricated claim rather than a
missing feature. Lifecycle, release readiness, tasks, leases, ownership, GitHub state, inferred
scores, agent execution, configuration apply/rollback, and cloud surfaces remain absent.

Layout uses CSS grid with `minmax` rather than fixed widths. Panels do not scroll independently;
wide tables scroll inside their own `.table-wrap`, so the page body never overflows horizontally.
