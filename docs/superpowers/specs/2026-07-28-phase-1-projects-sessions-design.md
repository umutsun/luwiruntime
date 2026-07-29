# Phase 1 Projects and Sessions Design

- Status: Approved design; implementation pending
- Date: 2026-07-28
- Governing documents: root `AGENTS.md`, ADR 0004, ADR 0005

## Goal

Implement the smallest complete Redis-native vertical slice for project registration,
agent-session visibility, heartbeat presence, stale-session recovery, and persistence-first
realtime delivery.

The authoritative mutation path is:

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

Redis remains the only runtime datastore. Git and the local filesystem remain canonical for
source code and configuration.

## Scope

Phase 1 includes:

- project registration, retrieval, listing, path uniqueness, and optional local Git metadata
  detection;
- session registration, retrieval, listing, status transitions, heartbeat, graceful close,
  and stale-session disconnection;
- TTL-backed presence plus a heartbeat deadline sorted set;
- Redis Function-backed atomic projection and event transitions;
- global and project event Streams;
- one persistent realtime consumer group;
- a server-to-client WebSocket event endpoint;
- bounded retention compatible with pending recovery;
- CLI project, session, simulation, event-list, and event-watch commands;
- a reproducible two-session terminal demonstration.

Phase 1 does not include Pub/Sub, a dashboard, MCP, agent adapters, AgentDefinition CRUD,
request/reply, tasks, leases, cursor catch-up, an atomic snapshot watermark, GitHub API
integration, metrics projections, lifecycle analysis, memory federation, or knowledge-graph
features.

## Package boundaries

No new package is added.

- `@luwi/protocol` owns Zod schemas and wire types for projects, sessions, errors, runtime
  state, HTTP payloads, stored Runtime events, and WebSocket wrappers.
- `@luwi/runtime` owns Redis-independent project/session rules, canonical-path behavior,
  the exact session status matrix, runtime readiness, mutation draining, and the testable
  presence-sweeper policy.
- `@luwi/redis` owns key construction, stored representations, Redis Function source and
  deployment, Redis-time transitions, projection reads, Streams, consumer groups,
  ownership lease mechanics, retention, and dead-letter persistence.
- `@luwi/daemon` composes filesystem and Git inspection, runtime lifecycle, HTTP routes,
  WebSocket handshake and broadcast hub, relay, sweeper, reconnect, and shutdown.
- `@luwi/cli` remains an HTTP/WebSocket client. Simulation code is isolated in a CLI-only
  module and never imports Redis.

The only new production dependency may be the official Fastify-compatible WebSocket plugin
for the installed Fastify major version. No second WebSocket or worker framework is added.

## Runtime ownership and lifecycle

### Single-daemon ownership

After opening command/admin Redis connections, startup acquires:

```text
luwi:v1:runtime:daemon-owner
```

The value is an opaque owner token containing the `runtimeInstanceId`. The lease uses a
15,000 ms TTL and renews every 5,000 ms. Acquisition uses `SET NX PX`. Renewal and release
use compare-token Lua scripts because the Function library may not exist when ownership is
first acquired.

The renewal loop starts immediately after acquisition and continues throughout bootstrap,
recovery, readiness, and draining until Redis clients are closing.

If another valid owner exists, startup returns `DAEMON_ALREADY_RUNNING`. It does not inspect
or replace Functions, create or claim consumer state, or open the listener.

If renewal or ownership verification fails, the runtime stops accepting mutations and
enters `degraded` or `recovering`. It never continues as an authoritative daemon without
ownership. Lease release deletes the key only when its value still matches this instance's
token.

### Runtime states

The internal state machine is:

```text
starting -> recovering -> ready
ready -> degraded | recovering | draining
degraded -> recovering | draining
recovering -> ready | degraded | draining
draining -> stopped
starting -> stopped
```

Only `ready` accepts mutations. The mutation guard atomically rechecks readiness while
acquiring an in-flight slot, rejects new slots after draining begins, and releases every slot
in `finally`.

The public listener opens only after initial recovery, so clients normally observe `ready`,
`degraded`, `recovering`, or `draining`. `starting` and initial `recovering` normally occur
before the listener opens. `stopped` cannot be queried after listener shutdown. Protocol
schemas still represent all states.

### Startup order

Startup is strictly ordered:

1. connect command and administrative Redis clients;
2. verify Redis is version 7.0 or newer;
3. acquire the single-daemon ownership lease;
4. inspect, load, or safely replace the `luwi_v1` Function library;
5. verify its expected version, content hash, and registered function names;
6. ensure the global event Stream exists;
7. create `luwi-realtime-v1` at `$` only when the group is absent;
8. create consumer identity `daemon-{runtimeInstanceId}`;
9. initialize the WebSocket hub without opening the public listener;
10. inspect `XPENDING`, claim stale entries with `XAUTOCLAIM`, and process recovery entries;
11. start continuous `XREADGROUP` processing for new entries;
12. start the presence sweeper and retention service;
13. mark the runtime `ready`;
14. open Fastify on `127.0.0.1:4782`.

Normal commands/Functions, blocking relay reads, and administrative/bootstrap work use
separate Redis connections.

Redis versions before 7.0 fail startup with `REDIS_VERSION_UNSUPPORTED`, including detected
and required versions in safe details. There is no `EVAL` fallback for application
transitions.

### Function compatibility

Startup uses `FUNCTION LIST` to inspect `luwi_v1`. `FUNCTION LOAD REPLACE` is allowed only
while this daemon owns the startup/recovery lease and only when the expected version or
content hash differs. The loader validates the version function and complete expected
function registry after loading. A failed or unverifiable load prevents readiness.

The Phase 1 library contains:

```text
luwi_project_register_v1
luwi_session_register_v1
luwi_session_heartbeat_v1
luwi_session_status_v1
luwi_session_close_v1
luwi_session_disconnect_v1
luwi_function_version_v1
```

### Redis loss and recovery

When Redis is lost after startup:

- health returns 503;
- mutation requests return `RUNTIME_NOT_READY`;
- no in-memory authoritative mutation is performed;
- no success event is broadcast;
- reconnect uses exponential backoff from 250 ms up to 5,000 ms;
- after reconnect, the daemon verifies ownership, Functions, Stream, group, and consumer;
- pending entries are recovered before returning to `ready`.

The retry interval is bounded; recovery continues until shutdown rather than silently giving
up. Redis-backed reads return `RUNTIME_NOT_READY` rather than presenting stale data as
current. If recovery discovers that a different valid owner token has taken the lease, this
instance drains and closes instead of reacquiring authority behind the new owner's back.

### Draining shutdown

Shutdown:

1. enters `draining`;
2. rejects new mutations;
3. waits up to 5,000 ms for accepted mutations;
4. keeps the relay active long enough to process their persisted events;
5. stops new relay reads at the drain deadline;
6. ACKs only fully processed entries and leaves unfinished entries pending;
7. stops the presence sweeper and retention service;
8. closes WebSocket clients and clears their queues/timers;
9. closes Fastify and all Redis clients;
10. releases the ownership lease only when still owned;
11. enters `stopped`.

## Project model and canonical paths

The public Project shape is:

```ts
type Project = {
  id: string;
  name: string;
  localPath: string;
  canonicalPath: string;
  repositoryUrl?: string;
  defaultBranch?: string;
  createdAt: string;
  updatedAt: string;
};
```

The stored projection additionally contains:

```ts
type StoredProjectPathIdentity = {
  identityPath: string;
  pathIdentityHash: string;
};
```

`identityPath` is not exposed in normal public project responses.

Project registration:

1. trims and validates the request;
2. resolves `localPath` to an absolute path;
3. requires an existing directory;
4. resolves symbolic links or junctions with `realpath` when possible;
5. normalizes separators to `/`;
6. removes trailing separators except filesystem roots;
7. uppercases the Windows drive letter for display;
8. preserves the resolved display case in `canonicalPath`;
9. lowercases the Windows identity value for comparison while preserving case on
   case-sensitive filesystems;
10. hashes `identityPath` with SHA-256.

The caller-provided `localPath` remains the user-facing display input after normalization.
`canonicalPath` is the resolved display path. Filesystem roots such as `/` and `C:/` remain
intact.

When repository metadata is omitted, the daemon may run bounded local Git commands to
detect `remote.origin.url` and the symbolic `origin/HEAD` default branch. Failure to detect
metadata does not fail registration. GitHub APIs are not used.

The path identity index is:

```text
luwi:v1:index:project:path:{pathIdentityHash}
```

If the index exists, the Function loads the referenced project and compares its stored
`identityPath`:

- equal identity returns `PROJECT_ALREADY_REGISTERED`;
- different identity returns `PROJECT_PATH_HASH_COLLISION`;
- neither outcome mutates state or emits an event.

Duplicate registration returns HTTP 409, includes the existing ID and canonical display
path in safe error details, and sets:

```text
Location: /api/v1/projects/{existingProjectId}
```

It never merges or overwrites metadata. Retry idempotency is deferred to a future optional
`Idempotency-Key` mechanism.

## Session model and agent identity

The public AgentSession shape follows the root contract and uses:

```ts
type SessionStatus =
  | 'starting'
  | 'idle'
  | 'thinking'
  | 'tool_running'
  | 'waiting_for_input'
  | 'waiting_for_agent'
  | 'blocked'
  | 'completed'
  | 'disconnected';
```

`agentId` is required, caller-supplied, stored exactly after validation, and treated as
opaque. It matches:

```text
^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$
```

Multiple sessions may share an `agentId`. An unseen `agentId` is valid. Registration does
not create an AgentDefinition hash and does not infer provider, executable, account, model,
capability, configuration, skill, hook, or policy data.

`sessionId` is generated by the daemon for each running session. Registration requires a
registered project and creates the session in `starting`.

Session read APIs return a validated view:

```ts
type SessionView = AgentSession & {
  presence: 'online' | 'offline';
};
```

Presence is `online` only when the session is non-terminal and its TTL key exists.
`completed` and `disconnected` are always `offline`. A non-terminal projection whose TTL has
expired may be reported as `offline` during the short interval before the sweeper persists
`disconnected`; the API must not pretend the stale session is online. Project-scoped and
global session lists return the same view. `session list --online` filters this validated
view without introducing a separate datastore query contract.

`workingDirectory` is canonicalized with the project path rules and must be an existing
directory. It need not be inside `project.localPath`, because a Git worktree may be located
elsewhere. Phase 1 does not prove complete worktree ownership.

### Exact status transitions

The status endpoint accepts only:

```text
idle
thinking
tool_running
waiting_for_input
waiting_for_agent
blocked
completed
```

It cannot target `starting` or `disconnected`.

Allowed state changes are:

| Current             | Allowed different targets                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `starting`          | `idle`, `thinking`, `tool_running`, `waiting_for_input`, `waiting_for_agent`, `blocked`, `completed` |
| `idle`              | `thinking`, `tool_running`, `waiting_for_input`, `waiting_for_agent`, `blocked`, `completed`         |
| `thinking`          | `idle`, `tool_running`, `waiting_for_input`, `waiting_for_agent`, `blocked`, `completed`             |
| `tool_running`      | `idle`, `thinking`, `waiting_for_input`, `waiting_for_agent`, `blocked`, `completed`                 |
| `waiting_for_input` | `idle`, `thinking`, `tool_running`, `waiting_for_agent`, `blocked`, `completed`                      |
| `waiting_for_agent` | `idle`, `thinking`, `tool_running`, `waiting_for_input`, `blocked`, `completed`                      |
| `blocked`           | `idle`, `thinking`, `tool_running`, `waiting_for_input`, `waiting_for_agent`, `completed`            |
| `completed`         | none                                                                                                 |
| `disconnected`      | none                                                                                                 |

Requesting the same endpoint-allowed status returns `unchanged` and emits no event. Every
other combination returns `invalid_transition` or `terminal` without mutation.

### Heartbeat and presence

Defaults:

```text
LUWI_SESSION_PRESENCE_TTL_MS=15000
LUWI_PRESENCE_SWEEP_INTERVAL_MS=1000
HEARTBEAT_EVENT_INTERVAL_MS=30000
```

Normal CLI simulations heartbeat every 5,000 ms. The fast demonstration uses a 3,000 ms
presence TTL, 250 ms sweep interval, and 1,000 ms heartbeat interval.

Redis server `TIME` is authoritative for `lastHeartbeatAt`, TTL expiry, heartbeat deadline,
and Function-produced event timestamps. Application clocks do not authoritatively timestamp
presence transitions.

Registration and heartbeat atomically write:

- the session projection;
- `luwi:v1:presence:session:{sessionId}` with millisecond TTL;
- the session score in `luwi:v1:deadline:heartbeats`.

Heartbeat is rejected with `SESSION_TERMINAL` for both `completed` and `disconnected`.

The heartbeat request may include an optional bounded metadata snapshot. The protocol
canonicalizes it to stable JSON before the Function call. When supplied and different from
the stored canonical metadata, it replaces the previous session metadata and counts as a
relevant metadata change. Omitted metadata leaves the projection unchanged. Metadata is
limited to 16 KiB after UTF-8 JSON serialization and must not be used for complete prompts,
memory documents, environment dumps, or credentials.

Heartbeat sampling emits `session.heartbeat` only when no heartbeat event has been emitted,
the configured event interval elapsed, or relevant heartbeat metadata changed. Other
heartbeats return:

```json
{
  "status": "renewed",
  "eventEmitted": false
}
```

Projection, TTL, and deadline renewal remain atomic even without an event.

### Graceful close and stale disconnection

`luwi_session_close_v1` is the only transition used by the HTTP close route. It:

- verifies the session;
- returns unchanged when already `completed`;
- returns the existing terminal state when already `disconnected`;
- changes a non-terminal session to `completed`;
- removes presence and deadline state;
- updates the projection;
- appends one `session.completed` event to global and project Streams.

Normal close never produces `disconnected`.

The sweeper uses an injected clock only to select deadline candidates in deterministic unit
tests. It passes each selected expected deadline to `luwi_session_disconnect_v1`. The
Function uses Redis time and preflights:

- the current sorted-set deadline still equals the expected deadline;
- the session is non-terminal;
- the presence key is absent or expired.

If presence still exists, the Function reads `PTTL`, reconciles the deadline to Redis time
plus remaining TTL, returns unchanged, and emits no event. A truly stale session becomes
`disconnected`, loses presence/deadline state, and emits `session.disconnected`.

## Redis Function atomicity

Functions do not use deliberate Redis runtime errors as normal domain outcomes and do not
assume arbitrary errors roll back prior writes.

Before the first write, every transition validates:

- argument count and encoding;
- required entity existence;
- expected state and complete status legality;
- duplicate and path-index conditions;
- Redis types for every key it will touch;
- event intent fields and serializability;
- stream and index preconditions.

After the first write, Functions execute only deterministic commands against prevalidated
LUWI-owned keys. Results are structured discriminated values such as:

```text
created
updated
renewed
unchanged
conflict
terminal
not_found
invalid_transition
```

The application creates one event ID and sends one event intent. The Function uses Redis
time to complete one RuntimeEvent, serializes it once, and writes the identical event JSON
to global and project Streams. The Streams receive distinct Redis stream IDs, while
`RuntimeEvent.id` remains identical across both.

Transition Functions do not trim Streams.

Each Runtime event Stream entry has one field named `event` containing the complete
validated RuntimeEvent JSON. The global and project entries reuse the same serialized value.

Phase 1 persists these mutation event types:

```text
project.registered
session.registered
session.heartbeat
session.status.changed
session.completed
session.disconnected
```

Project and session creation/update timestamps and every event timestamp produced by these
Functions come from the same Redis server clock used by the transition.

## Key and Stream taxonomy

All key construction is centralized in `@luwi/redis`; route handlers never concatenate Redis
keys.

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

Session inbox/outbox Streams remain deferred to Phase 2. Phase 1 session events are written
to the global and applicable project event Streams.

## Retention

Retention is handled by a separate periodic service, not transition Functions.

Before trimming the global Stream, the service uses group metadata and requires:

- `pending == 0`;
- `lag == 0`;
- lag and group metadata are present and valid;
- the realtime relay is healthy.

If any condition fails, global trimming is deferred and an internal bounded diagnostic is
recorded. When safe, approximate `MAXLEN` trimming applies the configured global limit.

This is the conservative fallback for standard Redis versions before Redis 8.2
consumer-aware trimming. LUWI does not depend on Redis 8.2 behavior in Phase 1.

Project Streams have no Phase 1 consumer group and use independent approximate `MAXLEN`
retention. The dead-letter Stream is independently bounded. Temporary growth is preferred
over destroying recoverable pending work.

## Realtime relay

The global Stream is the only authoritative source for WebSocket Runtime events. Pub/Sub is
not used.

The persistent group and consumer are:

```text
group: luwi-realtime-v1
consumer: daemon-{runtimeInstanceId}
```

The group is created with `$` only when absent. Existing cursors and pending entries are
never reset on restart. Group creation completes before mutation traffic can be accepted.

### Recovery

Startup recovery:

1. inspects `XPENDING`;
2. uses `XAUTOCLAIM` after the configurable idle threshold;
3. drains claimed entries before new entries;
4. validates every stored event with `@luwi/protocol`;
5. processes valid entries through the internal broadcaster;
6. dead-letters malformed entries;
7. ACKs only successful processing;
8. leaves unsuccessful entries pending.

Because the public listener is not open, recovered events normally have no connected
clients. Recovery completes and ACKs them after validation/broadcaster acceptance; it does
not wait for clients or replay old events to future connections.

Continuous processing then uses `XREADGROUP` with `>`. Phase 1 supports one active daemon and
one relay consumer. Redis relay delivery is at-least-once. Multiple-daemon ordering and
fan-out are explicitly unsupported.

### WebSocket delivery

WebSocket delivery is best-effort realtime delivery backed by durable Redis Streams and
HTTP projections. XACK proves relay processing and queue acceptance, not that a remote
client rendered or received an event.

Every payload is:

```ts
type RealtimeEventMessage = {
  streamId: string;
  event: RuntimeEvent;
};
```

The relay never creates a replacement event or event ID. Clients deduplicate by global
`streamId`, using `RuntimeEvent.id` as a secondary identity.

Defaults:

```text
LUWI_WS_QUEUE_LIMIT=256
LUWI_WS_SEND_TIMEOUT_MS=1000
LUWI_WS_MAX_PAYLOAD_BYTES=65536
LUWI_WS_MAX_BUFFERED_BYTES=1048576
```

Every client has a FIFO queue and at most one active send. Queue length, socket state,
send timeout, and `bufferedAmount` are enforced. Overflowed or slow clients are disconnected
and their timers/queues are cleared.

For each event, the broadcaster takes a stable snapshot of healthy clients. It accepts the
event into every healthy queue, removes clients exceeding limits, and returns success. The
relay then ACKs. With no clients, a valid event may be ACKed immediately after validation.
A disconnect after queue acceptance and before network delivery does not keep the Stream
entry pending.

### Handshake security

The route is exactly:

```text
/api/v1/realtime
```

When `Origin` exists, it must exactly match an explicit loopback allowlist. Wildcards,
`Origin: null`, suffix matching, substring matching, and loose host normalization are
rejected.

When `Origin` is absent, the remote socket address must be loopback, the `Host` header must
match an allowed loopback host and daemon port, and the request path must match exactly.
This path supports local CLI/native clients and is not a browser bypass.

The endpoint is server-to-client only. Protocol ping/pong is allowed. Unexpected
application data frames are rejected, maximum payload is enforced, and logs contain only
bounded safe connection metadata.

### Dead-letter handling

Malformed entries are persisted to `luwi:v1:events:dead-letter` before source ACK. A record
contains:

- source Stream key and stream ID;
- validation issue codes;
- runtime version and consumer name;
- safely readable event type;
- detection timestamp;
- SHA-256 hash of original fields;
- a size-limited redacted diagnostic preview.

It never stores environment variables, authorization values, complete prompts, memory
documents, or an unbounded raw payload. If dead-letter persistence fails, the source stays
pending and a bounded error is logged. Repeated failures increment an internal observation
counter; after three consecutive failures the relay makes the runtime degraded so the
poison entry cannot fail invisibly forever.

The diagnostic preview is redacted before storage and limited to 2,048 UTF-8 bytes.

## HTTP API

Phase 1 implements:

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
GET  /api/v1/realtime
```

Every request, parameter, query, response, stored event, and WebSocket wrapper is validated
with `@luwi/protocol`.

`GET /api/v1/events`:

- defaults `limit` to 100;
- accepts integers from 1 through 1,000;
- reads the newest global entries with `XREVRANGE`;
- reverses them into ascending Redis Stream order;
- returns `{ events: Array<{ streamId, event }> }`;
- has no cursor or long-poll behavior.

Malformed history entries produce a safe validation failure and dead-letter diagnostic; they
are never returned as valid Runtime events.

Errors use safe machine-readable codes, including:

```text
PROJECT_ALREADY_REGISTERED
PROJECT_PATH_HASH_COLLISION
PROJECT_NOT_FOUND
PROJECT_PATH_INVALID
SESSION_NOT_FOUND
SESSION_TERMINAL
SESSION_TRANSITION_INVALID
RUNTIME_NOT_READY
DAEMON_ALREADY_RUNNING
REDIS_VERSION_UNSUPPORTED
```

## CLI and simulations

Commands:

```text
luwi runtime

luwi project register
luwi project list
luwi project get

luwi session register
luwi session list
luwi session get
luwi session heartbeat
luwi session status
luwi session close
luwi session simulate

luwi events list
luwi events watch
```

`session simulate` supports `codex-sim`, `gemini-sim`, arbitrary valid opaque agent IDs,
multiple concurrent simulations, and multiple sessions for the same project.

Normal simulation registers once, sends periodic heartbeats, optionally updates status,
handles `SIGINT`/`SIGTERM`, sends exactly one graceful close, stops timers, closes clients,
and exits. Repeated signals cannot duplicate close.

With `--ungraceful`, it stops heartbeat without calling close or setting `disconnected`; the
sweeper produces disconnection after expiry.

### Events watch

`events watch`:

1. connects WebSocket;
2. starts bounded event buffering;
3. fetches project and session snapshots;
4. prints a labeled snapshot section;
5. sorts and flushes buffered events by stream ID;
6. prints a separate live-event section;
7. deduplicates with a bounded recent-stream-ID cache.

Buffer overflow fails visibly and never silently drops events. Invalid wrappers produce a
bounded diagnostic and are not printed as Runtime events.

The default pre-snapshot buffer holds 256 wrappers. The recent-ID cache holds the latest
4,096 global stream IDs and evicts the oldest ID when full.

Reconnect may use bounded exponential backoff. After reconnect, the CLI states that a
realtime gap may have occurred, refreshes snapshots, and continues bounded deduplication. It
does not claim the snapshot plus events form a transactionally exact projection. An atomic
snapshot/cursor handshake and cursor catch-up remain future work.

## Testing

Development follows red-green-refactor. Required coverage includes:

- protocol validation for agent IDs, projects, sessions, errors, runtime states, event
  history, and WebSocket wrappers;
- canonical path duplicates across relative/absolute, trailing separator, Windows case, and
  supported symlink/junction aliases;
- concurrent duplicate registration and hash-collision distinction;
- no project mutation or duplicate event on conflict;
- unseen agent IDs, multiple sessions per agent, and no implicit AgentDefinition hash;
- every allowed, unchanged, rejected, and terminal status combination;
- heartbeat projection, TTL, deadline, Redis time, sampling, and terminal rejection;
- graceful close cleanup, completed state, and repeated-close idempotence;
- stale disconnection, active preservation, and heartbeat/sweeper race reconciliation;
- atomic preflight failure with no partial projection or event;
- identical RuntimeEvent IDs and distinct Stream IDs across global/project Streams;
- Function version/load behavior and Redis 7 minimum;
- ownership acquisition, renewal, conflict, loss, and compare-token release;
- group creation at `$` only when absent and preservation on restart;
- ACK, failed-broadcast pending behavior, `XPENDING`, `XAUTOCLAIM`, and recovered-before-new
  ordering;
- malformed event redaction, bounded dead-letter persistence, and failed dead-letter pending
  behavior;
- global trim deferral for pending, lag, unavailable metadata, or unhealthy relay, and trim
  only when safe;
- latest event endpoint ordering and limits;
- exact-origin, `Origin: null`, no-origin loopback, no-origin non-loopback, exact path, and
  Host checks;
- server-only application frames, max payload, FIFO client ordering, queue overflow, send
  timeout, `bufferedAmount`, disconnected clients, and no-client ACK;
- mutation readiness, reconnect/recovery, in-flight draining, and WebSocket shutdown;
- CLI response validation, bounded deduplication, snapshot overflow, reconnect snapshots,
  one-close simulation, ungraceful disappearance, and concurrent simulations.

### Redis integration isolation

`LUWI_TEST_REDIS_URL` must be explicit. Function tests prefer a dedicated Redis server,
port, and data directory.

If a dedicated server is unavailable, tests use:

- a run-specific Function library name;
- run-specific registered function names through an injected function registry;
- a run-specific key namespace, optionally on database 15.

The suite detects when `LUWI_TEST_REDIS_URL` identifies the normal `REDIS_URL` server and
refuses unsafe Function tests unless an explicit test-only override is present and all
Function names are namespaced. The exact override is:

```text
LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS=true
```

Server identity comparison ignores the Redis database number and compares scheme, host, and
port, because Redis Function libraries are server-scoped.

Tests never run `FUNCTION FLUSH`, never replace or delete production `luwi_v1`, never run
`FLUSHDB` or `FLUSHALL`, and clean only their run-specific keys and Function library.

## Demonstration

The documented terminal demonstration will:

1. start the owned daemon on `127.0.0.1:4782`;
2. register one local project;
3. start `codex-sim` and `gemini-sim`;
4. set Codex to `tool_running`;
5. set Gemini to `waiting_for_input`;
6. show both heartbeating and online;
7. show ordered global events through the CLI;
8. show WebSocket wrappers with persisted global stream IDs;
9. stop Gemini without close;
10. observe Gemini become `disconnected` after TTL expiry;
11. verify Codex remains online;
12. close Codex gracefully to `completed`.

The demo uses explicit fast timing overrides without changing normal defaults.

## Documentation changes

Implementation updates:

- `AGENTS.md` with the implemented event key taxonomy and Phase 1 invariants;
- `README.md` from Phase 0 status to the implemented Phase 1 surface;
- `docs/architecture/overview.md` with ownership, lifecycle, Functions, relay, presence,
  recovery, retention, and realtime guarantees;
- ADR 0005 with the concrete `luwi:v1:events:*` taxonomy and conservative trimming policy;
- `.env.example` with validated ownership, presence, heartbeat sampling, relay, WebSocket,
  retention, reconnect, and drain settings;
- a reproducible Phase 1 terminal demo guide.

Documentation must distinguish Redis at-least-once relay processing from best-effort remote
WebSocket delivery and must not describe deferred snapshot/cursor behavior as implemented.
