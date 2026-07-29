# Alice Shell Bridge legacy review

## Scope and decision rule

This is a read-only product and architecture review of
`temp/alice-shell-bridge-legacy`. The legacy repository was inspected as evidence;
none of its code, tests, setup scripts, servers, or build commands were executed,
and no legacy file was changed.

The root `AGENTS.md` is the decision authority for every recommendation below.
Where the legacy design conflicts with LUWI Runtime's three-plane architecture,
daemon-owned Redis boundary, versioned protocol, Redis Streams, safety rules, or
phased roadmap, the LUWI contract wins.

Feature status in this report means:

- **Implemented, not runtime-verified**: a substantive source path exists, but this
  review did not execute it.
- **Partial**: source exists, but the path is incomplete, inconsistent, unsafe, or
  contradicted elsewhere.
- **Mock/demo**: behavior is hard-coded, random, in-memory, or simulated.
- **Planned/config-only**: a name or contract exists without a complete
  implementation.

Nothing in the legacy repository has enough automated evidence to be called
production-proven.

## Executive assessment

Alice Shell Bridge captured an important product instinct: developers need a
project-aware view of multiple coding agents, shared context, recent activity, and
simple operational controls. Its best ideas are product concepts and workflows,
not reusable architecture.

The implementation evolved into several overlapping CLIs, MCP servers, backend
servers, configuration formats, Redis key schemes, and dashboards. Those paths do
not share one validated protocol or one authoritative runtime. Redis coordination
is primarily independent string or hash records plus a Pub/Sub channel. No Redis
Streams, consumer groups, durable inbox/outbox flow, heartbeat TTL presence, or
correlated request/reply state were found.

The correct LUWI response is therefore:

- preserve the local-first, multi-project, multi-agent product direction;
- redesign coordination around the LUWI daemon and versioned IRIS events;
- defer dashboards, MCP, adapters, memory federation, and advanced metrics until
  their contracted phases;
- discard the legacy runtime boundaries, storage contracts, port choices, direct
  execution surface, and demo claims.

This review does not change the current LUWI Runtime architecture.

## Feature reality

| Capability                       | Evidence                                                                                                                                        | Status                            | Assessment                                                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project-aware CLI                | `bin/asb.cjs` and `backend/asb-core.cjs` load project JSON, switch a current project, and expose file, command, and context operations.         | Implemented, not runtime-verified | Useful workflow evidence, but coupled to Windows paths, project-specific Redis databases, direct shell execution, and mutable local JSON.                                                                           |
| Alternate CLI                    | Root `index.js` implements a second project/file/exec/context command surface with different Redis keys and representations.                    | Partial                           | Duplication created two sources of truth; the two CLIs are not compatible at the storage-contract level.                                                                                                            |
| Redis project and agent registry | Initialization scripts write a current project, project records, and agent hashes.                                                              | Implemented, not runtime-verified | Demonstrates the registry idea, but schema, key naming, and Redis data types are inconsistent.                                                                                                                      |
| Session and context storage      | A project session blob and expiring context records are stored as JSON strings.                                                                 | Partial                           | There is no schema version, read validation, concurrency control, heartbeat update, presence TTL, or reliable ordering.                                                                                             |
| Agent activity coordination      | Per-agent action records are written with timestamp-based keys and optionally published to `asb:agent:actions`.                                 | Partial                           | This is an activity log and disposable notification, not durable coordination. Related-action fields are useful provenance hints.                                                                                   |
| Agent request/reply              | Configuration and UI language imply agent communication.                                                                                        | Planned/config-only               | No correlated request, target inbox, acknowledgement, response record, deadline processing, or timeout event exists.                                                                                                |
| Presence                         | Agent hashes contain static statuses and `lastSeen` values; mock APIs report agents online.                                                     | Planned/config-only or mock       | No heartbeat loop or TTL-backed presence exists. Old records can be mistaken for online sessions.                                                                                                                   |
| MCP integration                  | Multiple wrappers and server variants expose file, shell, project, context, Redis, build, and database tools.                                   | Partial                           | Implementations overlap and disagree. The package's default MCP wrapper omits Redis; another wrapper accesses Redis directly; another requires undeclared dependencies and exposes destructive database operations. |
| AI roles and orchestration       | Claude, Gemini, and Codex personas return heuristic or template output.                                                                         | Mock/demo                         | The files contain TypeScript syntax in `.js` files and fail Node syntax checks. No real agent process or provider integration backs the results.                                                                    |
| Code analysis and scaffolding    | Tool names and generator functions exist.                                                                                                       | Partial or mock                   | One server references an unresolved analysis function; generated outputs are mostly templates, fixed scores, and placeholder recommendations.                                                                       |
| Next.js activity dashboard       | Project selection, Redis-backed activity/context API routes, polling, filters, and stats components exist.                                      | Partial                           | It reads Redis and filesystem configuration directly, hard-codes paths and key prefixes, does not scope the activity feed by selected project, and treats activity counts as agent stats.                           |
| React token dashboard            | Agent cards, online badges, token counts, quality, approvals, and achievements exist.                                                           | Mock/demo                         | Initial values are hard-coded, tasks use random delays and token counts, every agent is displayed online, and the backend announces demo mode with mock data.                                                       |
| PostgreSQL/pgvector search       | A full-featured MCP variant declares database and search tools.                                                                                 | Planned/config-only               | The required database package is undeclared, one advertised search tool has no handler, and the implementation embeds environment-specific database configuration.                                                  |
| Tests                            | Scripts connect to local Redis, write sample data, invoke global commands, and print success messages.                                          | Partial                           | They are mutable smoke scripts rather than isolated assertions. They use fixed developer databases, do not use per-run prefixes, do not clean up safely, and some catch errors without failing.                     |
| Cross-platform operation         | README language is general, while scripts and paths target Windows/XAMPP, `where`, `dir`, VS Code extension directories, and fixed drive paths. | Planned/config-only               | Cross-platform behavior is not established.                                                                                                                                                                         |

### Important implementation findings

- Root `package.json` declares ESM, while several `.js` entry points use CommonJS
  `require`; those entry points are not coherent under the declared module mode.
- The MCP analysis files fail static Node syntax checks because TypeScript syntax
  is stored in `.js` files.
- The main MCP server references an analysis function it does not import.
- The full MCP variant imports packages that are not declared or installed and
  defines a semantic-search tool without a matching handler.
- A plaintext database credential is embedded in legacy source. It must not be
  copied; if it was ever real, it should be treated as exposed and rotated outside
  this repository-review task.
- Setup scripts overwrite native tool configuration and one script terminates all
  Node processes during its test step. Both behaviors violate LUWI's inspection,
  diff, snapshot, approval, and safety direction.

## Product ideas worth preserving

### Local-first multi-project control

The project selector, current-project workflow, project-local context, and
cross-project dashboard direction all support LUWI's core promise. **Adopt the
product goal**, but represent projects through the control plane and daemon API
instead of global mutable keys and filesystem-scanned JSON.

### External agents remain external

The legacy product tried to make Claude, Gemini, and Codex visible through shared
tools rather than replace the tools themselves. **Adopt this intent**. LUWI's
execution plane and future Session Bridges are the safer realization.

### Activity, context, and operational awareness

Recent agent actions, command history, project context, agent filters, and session
views are useful cockpit concepts. **Adopt these information needs**, but derive
them later from validated snapshots and durable events. Do not adopt the legacy UI
or its polling/data-access implementation.

### Provenance between actions

Fields such as `relatedTo` and `basedOn` show an early need to explain how one
agent action followed another. **Adopt the provenance requirement** through
LUWI's `correlationId` and `causationId`, with evidence and freshness stored
separately from confidence.

### Ephemeral versus retained state

The legacy code applies TTLs to some activity and context records while retaining
a current session snapshot. **Adopt the distinction**, but redesign it as
TTL-backed presence, validated current-state records, and explicit Stream
retention policies.

## Redis IRIS concepts that can inform the new design

The legacy repository contains useful conceptual seeds, but not a reusable IRIS
protocol.

| Legacy concept                                 | Useful signal                                              | LUWI interpretation                                                                                                             | Recommendation                                 |
| ---------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `asb:projects` and current-project keys        | Redis can expose fast current control state.               | Projects are control-plane records; a selected project is a client preference, not global coordination truth.                   | **Redesign**                                   |
| `asb:agents:{project}` hash                    | Project-scoped agent discovery is useful.                  | Store validated `AgentDefinition` snapshots separately from live `AgentSession` state.                                          | **Redesign**                                   |
| Per-agent action keys                          | Agent actions should be observable and attributable.       | Append normalized events to global/project Streams; keep current snapshots separately.                                          | **Redesign**                                   |
| `asb:agent:actions` Pub/Sub                    | Connected observers benefit from low-latency invalidation. | Persist first, then broadcast through daemon WebSockets; use Pub/Sub only for disposable invalidation if needed.                | **Redesign**                                   |
| Expiring context records                       | Some coordination data should expire.                      | Use TTL specifically for presence and explicitly governed ephemeral state, not as a substitute for lifecycle events.            | **Redesign**                                   |
| Session blob with per-agent memory             | Sessions and contextual memory must be inspectable.        | Keep session state in IRIS; index external memory later with provenance rather than embedding mutable agent memory in one blob. | **Redesign**, then **defer** memory federation |
| `relatedTo` and `basedOn`                      | Causal relationships matter.                               | Use event correlation and causation IDs plus message correlation IDs.                                                           | **Adopt**                                      |
| Separate Redis database per project            | Attempts isolation.                                        | Use stable workspace/project IDs and versioned namespaces; do not make Redis database numbers the tenancy model.                | **Discard**                                    |
| Direct Redis access from agents and dashboards | Reduces early implementation effort.                       | All clients use versioned daemon HTTP/WebSocket APIs; only the daemon owns Redis credentials.                                   | **Discard**                                    |

No legacy Stream or queue contract should be migrated because none was found.
The names in root `AGENTS.md` remain authoritative:

```text
luwi:v1:stream:global
luwi:v1:stream:project:{projectId}
luwi:v1:stream:session:{sessionId}:inbox
luwi:v1:stream:session:{sessionId}:outbox
luwi:v1:stream:project:{projectId}:tasks
luwi:v1:stream:audit
```

## Technical patterns worth reconsidering

These patterns address real needs but require a new design:

1. **Current project selection** — keep it as CLI/UI state or an explicit
   user-scoped preference. A single global Redis key cannot represent multiple
   clients safely.
2. **Agent registry and capabilities** — map them to validated
   `AgentDefinition` records with kind, scope, project association, enabled state,
   and timestamps. Do not hard-code personas or imply an inactive agent is
   connected.
3. **Session snapshots** — preserve current status, working directory, branch,
   worktree, task summary, and metadata through the domain model. Compute online
   presence only from fresh heartbeat TTL state.
4. **Activity feeds** — derive them from persisted, versioned RuntimeEvents. A
   UI-facing broadcast happens only after persistence succeeds.
5. **Shared context** — treat documents, decisions, commits, and task summaries as
   provenance-bearing memory sources in the future. Avoid mutable, unversioned
   JSON blobs labeled as universal memory.
6. **Agent communication** — replace broadcasts with explicit asynchronous
   request/reply, source and target sessions, correlation, deadlines, evidence,
   acknowledgements, responses, and timeout events.
7. **Native configuration setup** — replace direct overwrites with
   detect/inspect/import, proposed changes, diff preview, snapshot, approved
   render, validation, and rollback.
8. **Operational dashboard** — retain project selection, presence, activity,
   blockers, and freshness as future Pulse requirements. Fetch only from the
   daemon; do not connect the dashboard to Redis.

## Legacy constraints to reject

- Multiple overlapping CLIs, MCP servers, and backend servers with no
  authoritative protocol.
- Direct Redis credentials in CLIs, dashboards, MCP servers, agents, or setup
  files.
- Redis database numbers as project boundaries.
- Inconsistent keys such as `asb:current_project` versus
  `asb:current:project`, and a project registry used as both a hash and a JSON
  string.
- Timestamp-derived IDs without central generation, versioned envelopes, runtime
  validation, or deterministic ordering.
- `KEYS`, broad pattern deletion, database flush tools, and cleanup that can touch
  unrelated developer data.
- Unrestricted shell and file tools, absolute-path access, shallow blocked-command
  lists, and a filesystem MCP root covering a broad development directory.
- Hard-coded Windows/XAMPP paths, agent IDs, project names, Redis database numbers,
  external database settings, and legacy ports `3000`, `3001`, and `5000`.
- Silent native configuration overwrite, global installation assumptions, forced
  process termination, and scripts that install unrelated integrations.
- Direct mutation of shared session JSON without validation, atomic transitions,
  optimistic concurrency, or audit events.
- Treating a registry record or UI badge as proof that an agent is online.
- Polling Redis-backed UI routes as the definition of realtime coordination.
- Logging full command output and message bodies by default.
- Test scripts that connect to fixed local Redis databases, write state without a
  unique run prefix, or report success without assertions.
- Committed dependencies and build output as architecture or verification
  evidence.

## Features that existed only as mock UI

The React token-tracking dashboard is entirely demo-oriented:

- total sessions, token counts, quality scores, task counts, and durations start
  from hard-coded values;
- task execution is a timer plus random token generation;
- all agent status indicators are permanently online;
- approvals, retries, token-saving badges, progress, sharing, and celebration
  effects do not control a runtime;
- the Express API stores the same sample metrics in memory and identifies itself
  as demo mode.

The separate test server also returns hard-coded agent presence, performance,
Redis key counts, API counts, and task counts. These values are not backed by
health checks or IRIS state.

The Next.js dashboard is not purely mock: it has Redis-backed routes and genuine
polling code. It is still only partial because its statistics are activity counts,
its activity feed is not scoped by the selected project, its context key is
hard-coded, and it has no validated presence or session lifecycle.

LUWI should **discard the mock metrics and online claims**, while **deferring the
useful cockpit interactions** until the dashboard phase.

## Mapping to the new LUWI Runtime architecture

| Legacy concept                        | LUWI plane or boundary             | New representation                                                           | Decision                                        |
| ------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| Project JSON and project selector     | Control plane                      | `Project` with stable ID, local path, repository metadata, and timestamps    | **Redesign**                                    |
| Static agent records and capabilities | Control plane                      | `AgentDefinition` with kind, scope, project association, and enabled state   | **Redesign**                                    |
| Global current-project key            | Client preference                  | Explicit CLI/UI selection outside shared runtime truth                       | **Redesign**                                    |
| Session JSON blob                     | Coordination plane / IRIS          | Validated `AgentSession` snapshot plus lifecycle events                      | **Redesign**                                    |
| Static `lastSeen` and online badges   | Coordination plane / IRIS          | Heartbeat timestamps and TTL-backed presence                                 | **Discard** old inference; **redesign**         |
| Agent action keys                     | Coordination plane / IRIS          | Versioned `RuntimeEvent` appended to project/global/audit Streams            | **Redesign**                                    |
| Agent Pub/Sub broadcast               | Coordination transport             | Persisted event followed by WebSocket broadcast                              | **Redesign**                                    |
| Broadcast message                     | Coordination plane / IRIS          | Asynchronous message request/reply with inbox/outbox Streams and correlation | **Redesign** for Phase 2                        |
| Development context and agent memory  | Memory federation                  | Provenance-preserving index over native memory and project evidence          | **Defer**                                       |
| CLI file and shell execution          | Execution plane                    | External coding agents and future constrained bridges/adapters               | **Discard** from daemon; **defer** adapters     |
| MCP wrappers                          | Future protocol adapter            | MCP server calling stable daemon APIs, never Redis directly                  | **Defer**                                       |
| Redis-reading dashboard               | Future Pulse UI                    | Dashboard client using versioned daemon HTTP/WebSocket APIs                  | **Defer**                                       |
| Token and quality dashboard           | Future Pulse metrics               | Evidence-backed metrics with defined collection semantics                    | **Discard** mock values; **defer** real metrics |
| PostgreSQL/pgvector tools             | Legacy storage experiment          | Exclude from the Redis-only local runtime                                    | **Discard**                                     |
| Hard-coded agent workflows            | Future policies/task orchestration | Validated task intents and policies after core state transitions are stable  | **Defer**                                       |

## Explicit recommendation matrix

### Adopt

- The local-first, multi-project, multi-agent control-plane product vision.
- Project, agent, session, activity, context, and operational-awareness concepts
  as distinct domain concerns.
- Provenance links between related actions.
- The product need for project selection, activity feeds, context inspection, and
  honest runtime status.

These align with the purpose, product pillars, three planes, and initial domain
model in root `AGENTS.md`.

### Redesign

- All Redis records behind `packages/redis` and daemon-owned access.
- Agent activities as validated RuntimeEvents persisted to Redis Streams.
- Presence as heartbeat timestamps plus TTL-backed keys.
- Messages as queued request/reply with correlation, evidence, deadlines, and
  explicit timeout events.
- Project and agent registries as typed control-plane models.
- Session/context handling as typed state transitions and provenance-bearing
  records.
- Realtime UI updates as persistence-first WebSocket broadcasts.
- Native agent configuration as inspect/diff/snapshot/approve/render/rollback.

These changes are required by the Redis, protocol, validation, safety,
configuration, and test rules in root `AGENTS.md`.

### Defer

- Dashboard and Pulse implementation.
- LUWI MCP server.
- Coding-agent and Session Bridge adapters.
- Memory federation and provenance-preserving search derived from Runtime events.
- Workflow automation, advanced agent capability routing, token accounting,
  quality scoring, and performance analytics.
- GitHub, lifecycle automation, and broader orchestration.

These belong after the tested daemon protocol and the applicable Phase 1 or Phase
2 foundations. The root contract explicitly defers most of them.

### Discard

- The legacy repository structure, dependency choices, servers, ports, frontend
  implementations, database design, and unfinished abstractions.
- Direct Redis access outside the daemon.
- Database-per-project isolation and all `asb:*` storage contracts.
- Duplicate entry points and incompatible key schemes.
- Mock agent personas, fixed performance scores, simulated token tracking, and
  permanent online indicators.
- Broad shell/file execution and destructive Redis tools.
- Hard-coded local paths, credentials, tool configuration, and global process
  manipulation.
- Legacy smoke scripts as a testing model.
- PostgreSQL, pgvector, and other legacy secondary-database plans.

These conflict with LUWI's architectural boundaries, security posture, phased
scope, cross-platform requirements, and definition of done.

## Lessons to carry forward

1. Establish one protocol and one process boundary before adding multiple clients.
2. Separate definitions, current state, presence, and immutable events.
3. Persist before broadcasting, and make replay and timeout behavior explicit.
4. Never equate configured, registered, recently active, and currently online.
5. Validate both incoming API data and data read back from Redis.
6. Keep storage details and credentials behind the daemon.
7. Make demos unmistakably synthetic and never present mock metrics as runtime
   evidence.
8. Test against isolated Redis state with unique prefixes and safe cleanup.
9. Add dashboards and adapters only after their source protocol is stable.
10. Treat native configuration changes as reviewed, reversible operations.

## Result

The legacy repository supplies useful product vocabulary and workflow evidence,
especially around project awareness, agent activity, context, and the desire for
Redis-backed coordination. It does not supply a compatible runtime architecture
or a durable IRIS protocol.

No legacy code or structure should be copied into LUWI Runtime. The next LUWI
milestone remains the one defined by the current repository plan and root
`AGENTS.md`; this review authorizes no implementation or architecture change by
itself.
