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

The control plane identifies filesystem/Git-backed projects and configuration. Phase 3
persists human-readable AgentDefinitions, project-agent bindings, capabilities, profiles,
plans, snapshots, and receipts in canonical local files while Redis holds validated
operational projections. Duplicate project paths and control-plane IDs are rejected rather
than merged.

### Coordination plane

IRIS coordination currently covers registered sessions, opaque agent IDs, heartbeats,
presence, status transitions, durable same-project request/reply, normalized
project/runtime events, and realtime delivery. These are modules within `@luwi/runtime`,
`@luwi/redis`, and the daemon; IRIS is not a separate package.

### Execution plane

Codex, Claude Code, Gemini CLI, Kimi, Git, worktrees, test runners, and build tools execute
work. LUWI coordinates them and never becomes the coding-agent process.

## Package boundaries

- `@luwi/protocol` owns strict Zod wire schemas, normalized Runtime events, HTTP responses,
  and WebSocket wrappers.
- `@luwi/runtime` owns Redis-independent path canonicalization, status policy, readiness,
  usage aggregation, Git attribution, graph query policy, structural findings, evaluation,
  in-flight mutation tracking, and typed errors.
- `@luwi/redis` owns the official Redis client, key construction, stored representations,
  Redis Functions, repositories, ownership mechanics, Streams, retention, and dead-letter
  persistence. Redis data is validated before crossing this boundary.
- `@luwi/daemon` composes security, lifecycle, HTTP routes, the presence sweeper, the
  consumer-group relay, and bounded WebSocket queues. It is the only process with Redis
  credentials.
- `@luwi/cli` is an HTTP/WebSocket client. Its simulations model a future Session Bridge
  without direct Redis access.
- `@luwi/mcp-server` is a thin official-SDK stdio adapter bound to one LUWI session. It uses
  loopback daemon HTTP only and has no Redis dependency.
- `@luwi/adapters` passively detects and parses native configuration and proposes
  deterministic files and declares optional telemetry support. Filesystem and command
  collaborators are injected; it never writes.

Metrics, lifecycle, memory, graph, Git intelligence, session routing, and IRIS do not have
speculative package boundaries.

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

The CLI-first lifecycle layer adds no supervisor or datastore. For the exact default local
Redis URL it invokes the repository's fixed Compose service arguments, then starts the built
daemon as one detached child. Ownership metadata is written under `LUWI_HOME/runtime` only
after the versioned runtime response is healthy and its generated startup instance identity
matches. Atomic, bounded `LUWI_HOME/runtime/lifecycle.lock` acquisition serializes `start` and
`stop` across CLI processes. The private lifecycle token is held in the daemon process and
generated owner record; it is never returned by HTTP or logged.

`POST /api/v1/runtime/stop` is a loopback-only lifecycle mutation. It accepts only the matching
token and schedules the same idempotent graceful shutdown path used by `SIGINT`/`SIGTERM`.
The CLI first matches the live `runtimeInstanceId` to its owner record, so it never treats a
stale PID as ownership and never kills an unverified process. Normal `luwi stop` leaves Redis
running. `luwi stop --with-redis` uses `docker compose stop redis`; it does not remove the
container volume, image, configuration, or AOF data.

`doctor` and `status` remain outside the Redis protocol boundary. They use versioned daemon
HTTP responses, bounded TCP listener probes, PATH discovery, and fixed Compose inspection.
Redis Function compatibility is reported as verified only when a ready daemon has completed
its Redis bootstrap.

Runtime reset is an offline maintenance exception that preserves the same package boundary: the
CLI coordinates lifecycle state but never speaks Redis, while a dedicated `@luwi/daemon` entry is
the only executable that opens the Redis connection. Its production namespace is the compile-time
constant `luwi:v1:`. It enumerates with bounded `SCAN`, rejects any returned key outside that
namespace, and deletes validated keys in `UNLINK` batches of at most 100. Caller-provided
namespaces, database-wide flushes, volume operations, and deletion while a daemon/listener is
present are refused.

Canonical project restoration is ordered before dependent startup reconciliation. The daemon
loads validated tracked projects from the canonical manifest, canonicalizes each current local
path, and either restores the missing projection with the original ID and timestamps or fails
closed on path/identity drift. Only after all projects exist does it rebuild project-agent
bindings, capabilities, profiles, and later derived projections. The passive CLI discovery path is
separate: it reads only immediate child directory metadata and real paths, defaults to a dry run,
and applies registrations and Git observations only through versioned daemon HTTP routes.

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

The production library is compatibility version 9. Its functions are:

```text
library: luwi_v1

luwi_project_register_v1
luwi_session_register_v1
luwi_session_heartbeat_v1
luwi_session_status_v1
luwi_session_close_v1
luwi_session_disconnect_v1
luwi_message_request_v1
luwi_message_delivered_v1
luwi_message_acknowledge_v1
luwi_message_processing_v1
luwi_message_respond_v1
luwi_message_reject_v1
luwi_message_fail_v1
luwi_message_timeout_v1
luwi_control_upsert_v1
luwi_control_delete_v1
luwi_control_plan_transition_v1
luwi_control_plan_complete_v1
luwi_usage_ingest_v1
luwi_graph_rebuild_transition_v1
luwi_intelligence_batch_transition_v1
luwi_graph_projection_failure_v1
luwi_function_version_v1
```

`luwi_intelligence_batch_transition_v1` preflights bounded intelligence projection/index
operations and both event Streams, then applies the state changes and event append as one
atomic transition. It is used for multi-record Git, package, attribution, graph-operation,
and optimization-evaluation updates; product policy and filesystem/Git observation remain
outside Lua.

`luwi_graph_projection_failure_v1` atomically appends a bounded projection diagnostic and
marks graph health degraded, so recovery cannot miss a recorded projection failure.

## Redis taxonomy

```text
luwi:v1:events:global
luwi:v1:events:project:{projectId}
luwi:v1:events:dead-letter

luwi:v1:project:{projectId}
luwi:v1:session:{sessionId}
luwi:v1:message:{messageId}

luwi:v1:index:projects
luwi:v1:index:project:path:{pathIdentityHash}
luwi:v1:index:project:{projectId}:sessions
luwi:v1:index:agent:{agentId}:sessions
luwi:v1:index:messages
luwi:v1:index:messages:terminal
luwi:v1:index:message:correlation:{correlationId}
luwi:v1:index:message:idempotency:{sourceSessionId}:{sha256}
luwi:v1:index:project:{projectId}:messages
luwi:v1:index:session:{sessionId}:messages:source
luwi:v1:index:session:{sessionId}:messages:target

luwi:v1:presence:session:{sessionId}
luwi:v1:deadline:heartbeats
luwi:v1:deadline:messages
luwi:v1:inbox:session:{sessionId}
luwi:v1:runtime:daemon-owner

luwi:v1:agent-definition:{agentId}
luwi:v1:project-agent-binding:{bindingId}
luwi:v1:capability:{capabilityId}
luwi:v1:capability-binding:{bindingId}
luwi:v1:profile:{profileId}
luwi:v1:config-plan:{planId}
luwi:v1:config-operation:{operationId}
luwi:v1:config-drift:{driftId}
luwi:v1:context-source:{sourceId}
luwi:v1:context-footprint:project:{projectId}:agent:{agentId}

luwi:v1:index:capabilities
luwi:v1:index:capability-bindings
luwi:v1:index:project:{projectId}:capabilities
luwi:v1:index:project:{projectId}:capability-bindings

luwi:v1:usage:{usageId}
luwi:v1:index:{project|agent|session}:{id}:usage
luwi:v1:metrics:{scope}:source:{usageSource}
luwi:v1:context-contribution:{contributionId}
luwi:v1:index:{project|agent|session}:{id}:context-contributions
luwi:v1:git:observation:{observationId}
luwi:v1:git:project:{projectId}:current
luwi:v1:git:commit:{projectId}:{commitSha}
luwi:v1:attribution:{attributionId}
luwi:v1:package:{projectId}:{ecosystem}:{packageId}
luwi:v1:technology:{projectId}:{technologyId}
luwi:v1:graph:generation:{generation}:node:{kind}:{id}
luwi:v1:graph:generation:{generation}:edge:{edgeId}
luwi:v1:graph:generation:{generation}:{out|in}:{kind}:{id}
luwi:v1:graph:generation:active
luwi:v1:graph:rebuild:{operationId}
luwi:v1:optimization:{finding|proposal|evaluation}:{id}
```

The agent session index is derived membership, not an AgentDefinition. Phase 1 never creates
`luwi:v1:agent:{agentId}`. Project capability package IDs and project assignment IDs use
separate sets; their entity types are never mixed in one index.

Session inboxes use `luwi-session-inbox-v1`; caller consumers are
`bridge-{bridgeInstanceId}`. Session outboxes remain deferred.

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

Implemented project/session/message events are:

```text
project.registered
session.registered
session.heartbeat
session.status.changed
session.completed
session.disconnected
message.requested
message.delivered
message.acknowledged
message.processing
message.responded
message.rejected
message.failed
message.timed_out
```

Every event uses the validated version 1 envelope and is written to the global and applicable
project Stream.

## Request/reply and inbox recovery

Message creation validates the source, selects an online non-terminal target in the same
project, and invokes one Redis Function. The Function atomically:

1. revalidates both session projections and presence keys;
2. creates the authoritative message hash and correlation/idempotency indexes;
3. adds project/source/target lookup indexes and the deadline;
4. appends the durable request to the target session inbox;
5. appends the same normalized `message.requested` event ID to the global and project
   Streams.

Target selection by opaque `agentId` is deterministic: preferred session status, newest
heartbeat, then lexical session ID. A direct cross-project target is rejected.

Inbox claim runs `XAUTOCLAIM` before `XREADGROUP`, so recovered pending items are returned
before new work. Redis reads are non-blocking on the shared command connection; the daemon
implements bounded HTTP long polling with short readiness-aware polls so an idle bridge
cannot stall heartbeats, mutations, or sweepers. A request remains pending through
`delivered`, `acknowledged`, and
`processing`; a terminal response/rejection/failure/timeout acknowledges the original
target entry and appends a response notification to the source inbox. The message
projection is authoritative, so duplicate delivery cannot create a second terminal result.

The application clock only selects deadline candidates. The timeout Function compares the
expected sorted-set score with Redis server time and the current non-terminal projection.
A committed response makes the timeout unchanged; a committed timeout makes a later
response fail with `MESSAGE_TERMINAL`.

The global event relay remains the only WebSocket path. Message events are persisted first
and then broadcast by the existing consumer-group relay. Realtime delivery is a wake-up
hint; bridge recovery always comes from its durable session inbox.

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

Message retention removes terminal projections only after their configured age and after
any idempotency index has expired. Per-session inbox `MAXLEN` trimming runs only with known
zero pending and zero lag. Temporary growth is preferred to deleting recoverable delivery
state.

## Session Bridge simulator and MCP adapter

The CLI's `manual`, `echo`, and `status-responder` modes simulate a Session Bridge using only
daemon APIs. Status responder evidence is explicitly labeled simulated and describes only
the LUWI project/session snapshot it actually read. The simulator never closes the
underlying coding session unless a separate session-close command is issued.

The experimental DeepSeek Harness bridge is a real but deliberately thin Session Bridge in
`@luwi/cli`. One bridge process owns exactly one LUWI session, one ACP subprocess, and one
fresh ACP session. Startup is ordered and transactional:

```text
LUWI register -> ACP process -> initialize -> session/new
              -> declare native ACP session id -> heartbeat/inbox loop
```

It communicates with LUWI only through validated loopback HTTP and uses the existing
session, native-declaration, status, message-transition, response, and inbox routes. It does
not add a daemon route, Redis representation, event type, package boundary, DeepSeek runtime
dependency, or native-file writer. The sole new library is the vendor-neutral official ACP
SDK scoped to `@luwi/cli` and pinned to the version used by DeepSeek Harness. If the command
is never invoked, daemon/runtime behavior and dependencies are unchanged.

ACP output is folded from committed `agent_message_chunk` text. Inbox work is processed
serially because the current DeepSeek ACP server permits one in-flight prompt per session.
Permission requests fail closed unless the operator explicitly selects the one-shot allow
policy. ACP startup, cancellation, message-deadline execution, protocol frames, and response
bytes are bounded. A recovered message already marked `processing` is failed without replay,
because prior ACP side effects cannot be proven idempotent. Signals cancel ACP work before
process shutdown and LUWI session close; Windows shutdown reuses LUWI's creation-time-verified
owned-process-tree cleanup. An unexpected root exit is reported as unverified cleanup rather
than silently accepted. Startup failures roll back both owned resources. Prompts, answers,
environment dumps, malformed frames, and credentials are not logged.
Signal handling is installed before startup and aborts in-progress ACP initialization before
waiting for owned-resource rollback. The bridge validates its deliberately narrow inbound ACP
request/notification surface before handing frames to the SDK, preventing SDK diagnostics from
printing valid JSON with invalid protocol parameters.
Only a typed startup cancellation whose rollback succeeds is suppressed. Process-tree or LUWI
session cleanup failures are preserved through bridge shutdown and returned by the CLI.

DeepSeek Harness currently refuses non-empty `mcpServers` on `session/new`. LUWI therefore
does not smuggle an MCP server through ACP or rewrite Cordis. A composition that wants LUWI
tools configures DeepSeek's own MCP client plugin; the bridge provides the child process with
the already-registered `LUWI_SESSION_ID` and exact loopback daemon origin needed by LUWI's
existing bound-session MCP server.

The implemented MCP server verifies `LUWI_SESSION_ID` at startup, rejects offline/terminal
bindings, derives source and responder identity from that binding, and limits message reads
to the bound project/session. It exposes stdio tools through the official SDK and never
receives Redis credentials. Every tool advertises a protocol-owned output schema, validates
daemon output, returns `structuredContent`, and emits only a concise bounded text summary.
MCP discovery collections are capped and report truncation. Phase 3 adds project-bounded
read-only tools for AgentDefinitions, capabilities, effective config, context footprint, and
drift. Phase 4 adds project-scoped usage, context intelligence, Git, package, technology,
graph, and optimization reads plus a bounded analysis request. It deliberately exposes no
acceptance, graph rebuild, native-config approval/apply, rollback, or Git mutation tool.

## Capability and native-config control

AgentDefinitions do not replace opaque historical session IDs. Project bindings select
profiles and project capability assignments without limiting concurrent sessions. Effective
configuration uses fixed precedence from runtime defaults through global profiles and
capabilities, project profiles and capabilities, project-agent overrides, then ephemeral
preview overrides. Explicit disable is a tombstone. Missing dependencies, incompatible
agent kinds, and version conflicts make the preview invalid and prevent rendering.

The daemon, not adapters, owns all writes:

```text
inspect -> plan/redacted diff -> approve -> explicit apply
        -> process/filesystem locks -> precondition -> snapshot
        -> stage+fsync all temporary files -> journaled atomic renames
        -> atomic Redis plan/operation/event completion
```

An existing unmanaged file requires explicit adoption in the plan request. Approval tokens
are stored only as hashes and used once. Drift detection never overwrites files. Rollback is
a new approved plan. A local receipt makes a post-commit Redis failure reconcilable during
owned startup. A partial multi-file commit is left for hash-based reconciliation rather
than silently rolled back; ambiguous receipts keep the runtime degraded. Generated stale
filesystem locks are cleared only during owned startup, and validated snapshots are bounded
by `LUWI_CONFIG_SNAPSHOT_RETENTION_COUNT`.

The local plan artifact must match the approved plan's adapter, target set, hashes,
management mode, import settings, and rollback snapshot. Snapshot payload hashes are
verified before rollback touches a target, and rollback takes its own pre-rollback snapshot.
Current managed-target ownership is a dedicated canonical record rather than an inference
from historical receipts. A Redis Function result whose reply is lost is reconciled against
the persisted plan/operation projections instead of being reported as a definite failure.

Global imports write AgentDefinition defaults; project imports write agent-specific defaults
to the project `.luwi/manifest.json`. Both go through the same plan, approval, snapshot,
journal, and atomic replacement path. The global root manifest tracks known project roots.
Owned startup validates canonical AgentDefinitions, capabilities, profiles, capability
bindings, and project-agent bindings and rebuilds missing/stale Redis projections before
readiness.

Codex and Claude Code expose a tested writable subset. Gemini CLI and Kimi remain read-only
where ownership/render semantics are not proven. Passive inspection never invokes a CLI;
explicit installation detection invokes only `--version`.

Context footprint is a static `ceil(UTF-8 bytes / 4)` estimate labeled
`generic-character-estimate`. Inventory covers passive instruction sources and assigned
skill, plugin, hook, MCP, policy, and instruction artifacts. Source IDs are stable for an
agent/project/path identity while content changes update the hash. Exact duplicate groups
use SHA-256 equality. This is not model telemetry, billing, semantic analysis, or automatic
context optimization.

## Phase 4 usage and context observations

`POST /api/v1/usage` validates a registered project/agent/session relationship, preserves
optional token fields, and deduplicates a supplied `sourceEventId` or `Idempotency-Key`.
`luwi_usage_ingest_v1` atomically stores the normalized record, scope indexes,
source-separated aggregate deltas, and the global/project Runtime event. Exact, reported,
adapter-extracted, estimated, and unavailable observations are never silently combined.
Unknown values stay absent rather than becoming zero.

Static Phase 3 context remains a generic estimate. A trusted local bridge may post an
explicit context contribution for its bound session. The daemon validates the source and
relationship before recording loaded/invoked facts. Assigned, effective, loaded, invoked,
and unknown are distinct. Observations never replace static estimates.

Current adapters explicitly report telemetry support as unsupported unless a tested parser
exists; unsupported fields are not inferred.

## Read-only Git and package observation

The Git observer uses `spawn("git", args, {shell:false})`, bounded output and timeouts,
`GIT_OPTIONAL_LOCKS=0`, and the ADR 0011 allowlist. Its process-local Git configuration trusts
only the exact observed working directory and disables repository-configured filesystem
monitors. It does not fetch or mutate. Repository root, HEAD/branch, status, local refs,
worktrees, recent commits/paths, LUWI trailers, and redacted configured remotes are projected
into Redis.

An explicit, internally consistent LUWI session/agent/project trailer set produces exact
attribution. Contradictory trailers are rejected as unknown. A unique bounded
branch/time/working-directory match produces correlated attribution. Ambiguous or absent
evidence remains unknown; Git author metadata is hashed and never equated with an agent.

Package scanning reads bounded manifests without executing a package manager. For Git
repositories, exact project-relative `git ls-files -z --cached -- .` output limits
language/file-pattern evidence
to tracked paths. Non-Git projects use a clearly labeled filesystem fallback. Scan responses
and events disclose the evidence scope and whether the file bound truncated the inventory.
The scanner supports Node, Python, Dart/Flutter, PHP, Rust, and Go. Technology signals are
structural and include manifest, package, or file-pattern evidence.

Scans run after project registration, session start/close, configuration apply, explicit
requests, and a conservative configurable interval. An unchanged repository-state hash
skips a duplicate Git projection.

## Operational graph and rebuild

The Phase 4 graph is an operational Redis projection, not a semantic knowledge graph.
Deterministic nodes and edges contain identifiers, bounded metadata, confidence,
observation time, provenance, and evidence IDs. Source code, complete diffs, prompts,
responses, credentials, and memory content are forbidden.

Named queries use bounded `SSCAN` over requested node adjacency and enforce result plus
examined-edge budgets for neighbors, paths, and subgraphs; they do not load a capped
whole-graph snapshot. Incremental projection atomically replaces changed active-generation
membership, including removal of obsolete nodes and edges, and appends one summary event. A
failure atomically records bounded diagnostics and marks graph health degraded without
changing the source event.

Rebuild writes a shadow generation from validated retained Runtime events plus canonical
manifests, current project/session projections, and retained Git/package observations. The
operation records the retained Stream watermark and processed-event count. It validates
stored counts and every edge endpoint before activation; the active graph remains intact on
failure. `luwi_graph_rebuild_transition_v1` verifies the owned rebuild lock and atomically
records completion, swaps the generation pointer, releases the lock, and persists the
summary event. Because Streams are bounded, rebuild reconstructs the retained operational
horizon rather than claiming unlimited historical completeness.

## Structural optimization loop

Optimization is deterministic and human-approved:

```text
observe -> measure -> recommend -> accept (no apply)
        -> Phase 3 ConfigPlan -> approve -> snapshot/apply
        -> post-change observe -> evaluate
```

Rules detect only evidence-backed structure such as oversized always-loaded sources, exact
hash duplicates, explicit cross-project non-use observations for a global capability, and a
broad declared MCP surface with few explicit calls. Unknown is not unused.

Only supported deterministic loading-mode changes create a ConfigPlan. Phase 4 has no
filesystem writer and never generates instruction prose. A proposal captures an immutable
pre-change baseline; a successful Phase 3 apply records its apply timestamp. Evaluation
counts only explicit post-apply session/adapter observations and usage evidence, compares
configuration hashes and evidence windows, returns verified/inconclusive/failed, and always
sets `causalClaim: false`.

## Pulse mutation boundary

The dashboard remains an HTTP/WebSocket client and never receives Redis credentials. Its read
loaders cannot mutate. Two separately constructed modules contain the complete browser write
surface: the Phase 3 configuration plan chain and `POST /api/v1/messages`. A static test rejects a
state-changing request from any other production dashboard module and continues to prohibit graph,
Git, optimization, and reconciliation writes.

The Sessions route exposes Ask only when the target is online and another online session exists in
the same project. The form fixes the message kind to `question`, supplies no evidence requirements,
uses protocol-bounded subject/content/deadline fields, and names both session IDs explicitly. One
idempotency key belongs to one draft: an unchanged retry retains it, while editing a field rotates
it. This is a convenience check over the authoritative daemon rules, not a replacement for them;
the daemon may still reject a session that went offline after the snapshot.

Successful acceptance navigates to the encoded correlation under `#/messages`. Pulse never inserts
an optimistic record: the bounded message read and normalized realtime events load the persisted
projection. The browser cannot acknowledge, process, answer, reject, fail, retry, cancel, or inject
the request into a terminal.

## Phase 4 retention

The intelligence retention pass removes old raw usage JSON while keeping source-separated
aggregate totals, deduplication tombstones, and retained Stream provenance. Aggregate
summaries remain available for their supported global/project/agent/session scope; filters
that require individual observations, such as arbitrary capability or time-window
combinations, use at most 1,000 retained raw records and fail explicitly when that bounded
query is incomplete. Raw listing uses bounded `SSCAN` and reports truncation. It bounds
superseded Git observations,
completed rebuild diagnostics, rejected proposals, and stale graph generations while
preserving current Git state, active/newest graph generations, accepted proposals,
baselines, and evaluations. Graph cleanup removes index membership incrementally so bounded
passes make progress. Usage responses report the earliest retained raw observation when
history is partial.
