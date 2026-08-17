# LUWI Runtime — Repository Instructions

## 1. Purpose

LUWI Runtime is a local-first, single-user control and coordination runtime for developers
who manage multiple software projects with multiple AI coding agents.

It integrates with Codex, Claude Code, Gemini CLI, Kimi, Git, and local developer tools. It
does not replace or impersonate coding agents.

The product promise is:

> See every project. Coordinate every agent. Ship without collisions.

The initial product focuses on a reliable loopback-only daemon, project and session
visibility, Redis-native realtime coordination, and safe foundations for later local
interfaces.

## 2. Binding architecture

### Canonical source and configuration

Git and the local filesystem are canonical for:

- project source code;
- LUWI configuration;
- native coding-agent configuration;
- skills;
- hooks;
- policies;
- profiles;
- MCP definitions;
- documentation and test evidence.

LUWI must never silently overwrite native files. Configuration changes follow inspect,
import, propose, diff, snapshot, approve, render, validate, and rollback.

### Runtime and operational state

Redis is the only runtime datastore. It is not a cache or secondary transport.

Redis is the:

- operational database;
- durable event bus;
- coordination fabric;
- delivery system;
- current-state projection store;
- cached-metrics store.

Redis owns:

- events and audit history;
- sessions, presence, and heartbeats;
- messages and tasks;
- leases and temporary ownership;
- current-state projections;
- cached metrics;
- lifecycle and ranking projections;
- rebuildable knowledge-graph relations derived from events.

Do not introduce PostgreSQL, SQLite, Neo4j, another datastore, or a Redis Stack module into
the initial architecture. Optional external storage may be considered later only through an
adapter, after a demonstrated requirement and a separate accepted ADR.

### Derived views

Normalized Runtime events plus canonical filesystem/Git observations are the rebuild inputs
for:

- metrics;
- project activity;
- lifecycle progress;
- rankings;
- knowledge-graph relations;
- audit and operational history.

Every derived view must be rebuildable from retained normalized events and the applicable
canonical files/Git facts. Do not create a dedicated analytics, graph, relational, embedded,
or search database.

## 3. Product planes

Use three conceptual planes without turning each plane into a package.

### Control plane

The filesystem and Git own durable definitions for projects, agents, profiles, skills,
hooks, MCP definitions, policies, and configuration snapshots.

Redis may hold runtime projections of those definitions for fast access, but the projection
is not canonical configuration.

### Coordination plane

IRIS means **Inter-Agent Realtime Intelligence & Synchronization**. IRIS is a module family
inside `@luwi/runtime`, not a separate package.

IRIS owns runtime sessions, presence, heartbeats, task intents, messages, leases, project
events, awareness, and audit history through Redis.

### Execution plane

External coding agents and local tools execute work:

- Codex;
- Claude Code;
- Gemini CLI;
- Kimi;
- Git and worktrees;
- test runners;
- build tools.

LUWI coordinates execution. It does not inject into terminals in the initial milestones.

## 4. Local-only security boundary

LUWI is a single-user local runtime. It has no login, signup, account, OAuth, JWT, RBAC,
tenant, organization, or multi-tenant subsystem.

Binding rules:

- the daemon binds to `127.0.0.1` by default;
- the daemon rejects every other `HOST` value;
- local mode has no remote-binding override;
- Redis may be published by Compose only on host address `127.0.0.1`;
- coding agents, Session Bridges, browsers, and CLIs never receive Redis credentials.

Browser and WebSocket rules:

- do not enable wildcard CORS;
- validate `Origin` against an explicit loopback allowlist before accepting browser or
  WebSocket traffic;
- reject absent or unexpected browser origins when an origin is required;
- do not stream unvalidated arbitrary client payloads.

Logging rules:

- do not log secrets, credentials, environment dumps, complete prompts, or full memory
  documents;
- use structured identifiers such as request, correlation, project, agent, session, task,
  message, and event IDs;
- return safe errors without stack traces or connection details.

## 5. Repository structure

Keep package boundaries minimal:

```text
luwi-runtime/
├─ apps/
│  ├─ daemon/
│  ├─ cli/
│  ├─ mcp-server/
│  └─ dashboard/
├─ packages/
│  ├─ adapters/
│  ├─ protocol/
│  ├─ runtime/
│  └─ redis/
├─ docs/
│  ├─ architecture/
│  ├─ decisions/
│  ├─ design/
│  ├─ guides/
│  ├─ legacy/
│  ├─ remediations/
│  └─ superpowers/
├─ .claude/
├─ AGENTS.md
├─ CLAUDE.md
├─ README.md
├─ compose.yaml
├─ package.json
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ eslint.config.js
├─ .gitattributes
└─ .gitignore
```

Package responsibilities:

- `@luwi/protocol`: versioned Zod schemas and wire types.
- `@luwi/runtime`: Redis-independent errors, lifecycle, projects, sessions, messages,
  intelligence normalization, attribution, graph query policy, optimization analysis, and
  IRIS state transitions.
- `@luwi/redis`: official Redis client integration and all Redis-specific representations.
- `@luwi/daemon`: composition root and sole Redis-accessing process.
- `@luwi/cli`: versioned daemon HTTP client.
- `@luwi/mcp-server`: thin stdio MCP adapter over the daemon HTTP API; never a Redis client.
- `@luwi/adapters`: injected native-agent detection, passive inspection, capability
  matrices, and deterministic render proposals; never direct file writes.
- `@luwi/dashboard`: the read-only React/TypeScript Pulse shell, served by the daemon from
  its build output; consumes only the versioned daemon HTTP and WebSocket API and the
  `@luwi/protocol` browser export. Never a Redis client.

Do not create separate packages for metrics, knowledge graph, lifecycle, memory, IRIS,
session routing, tasks, or leases until at least two real consumers prove a boundary.

The dashboard precondition — daemon, CLI, persistence, presence, and realtime protocol under
test — was met before Phase 5A, and `apps/dashboard` now exists. Do not add Turborepo until
pnpm workspace scripts are insufficient.

`@luwi/daemon` is the only package permitted to depend on `@luwi/redis`, and `@luwi/redis` is
the only package permitted to import the `redis` client. This is enforced mechanically by a
`no-restricted-imports` rule in `eslint.config.js`, so a violation fails `pnpm lint` rather
than waiting for review.

## 6. Technology choices

Use:

- Node.js 22 or newer;
- TypeScript strict mode;
- ESM;
- pnpm workspaces;
- Fastify;
- a maintained Fastify-compatible WebSocket package when realtime transport is added;
- the official `redis` Node.js client;
- Zod;
- Pino;
- Vitest;
- ESLint flat configuration;
- Prettier;
- Commander or an equally small maintained CLI library;
- the official maintained Model Context Protocol TypeScript SDK, isolated in
  `@luwi/mcp-server`;
- standard Redis 7 features only.

Before adding a production dependency:

1. explain why the standard library or an existing dependency is insufficient;
2. verify that the package is maintained;
3. keep the dependency behind an existing package boundary when practical.

## 7. Redis-native operational model

All Redis keys use the `luwi:v1:` namespace. Redis data is untrusted input and must be
validated when read.

### Streams

The implemented runtime uses these Redis Streams for durable ordered records and delivery:

```text
luwi:v1:events:global
luwi:v1:events:project:{projectId}
luwi:v1:events:dead-letter
luwi:v1:inbox:session:{sessionId}
```

Streams are the source of truth for events, delivery, and audit history. Pub/Sub is never a
source of truth.

Session inboxes use consumer group `luwi-session-inbox-v1` and caller identities
`bridge-{bridgeInstanceId}`. Session outboxes and task-delivery Streams remain deferred.

### Consumer groups and recovery

Recoverable processors must use:

- consumer groups;
- unique consumer names;
- explicit acknowledgements after successful processing;
- `XPENDING` or equivalent pending-entry inspection;
- `XAUTOCLAIM` after a configurable idle threshold;
- idempotent processing because delivery is at least once.

Do not acknowledge before the state transition or projection update succeeds. Do not delete
pending work to hide a failure.

The realtime relay must reinspect pending state continuously, not only once at startup, so
entries younger than the claim threshold are eventually recovered. Repeated poison failures
must keep the runtime degraded until the entry is safely dead-lettered and acknowledged.

### Hashes

The runtime uses hashes for current entity state:

```text
luwi:v1:project:{projectId}
luwi:v1:session:{sessionId}
luwi:v1:message:{messageId}
```

Do not expose these Redis representations from `@luwi/runtime` or `@luwi/protocol`.
Do not create an AgentDefinition hash implicitly from an opaque session `agentId`.

### Sets

Sets and sorted sets provide relationships and secondary indexes. Message correlation and
idempotency use deterministic string indexes.

```text
luwi:v1:index:projects
luwi:v1:index:project:{projectId}:sessions
luwi:v1:index:agent:{agentId}:sessions
luwi:v1:index:message:correlation:{correlationId}
luwi:v1:index:message:idempotency:{sourceSessionId}:{sha256}
```

### Sorted sets

Sorted sets cover heartbeat/message deadlines and message lookup/retention:

```text
luwi:v1:deadline:heartbeats
luwi:v1:deadline:messages
luwi:v1:index:messages
luwi:v1:index:messages:terminal
luwi:v1:index:project:{projectId}:messages
luwi:v1:index:session:{sessionId}:messages:source
luwi:v1:index:session:{sessionId}:messages:target
```

Future tasks, leases, activity, lifecycle progress, and rankings may use additional sorted
sets only when their phases are approved.

### TTL state

Use TTL-backed keys for presence and temporary ownership:

```text
luwi:v1:presence:session:{sessionId}
luwi:v1:runtime:daemon-owner
```

Never infer online state from an old registry or session hash. Presence requires a fresh
heartbeat timestamp and a live TTL key.

### Redis Functions

Use versioned Redis Functions when a state mutation and event append must succeed atomically.
The initial function library is named `luwi_v1`.

Functions may:

- validate expected current-state versions;
- mutate hashes, sets, sorted sets, and TTL keys;
- append the normalized event to the required Streams;
- return identifiers and transition results.

Functions must not contain product policy that belongs in `@luwi/runtime`. Function inputs
and outputs require versioned validation, deterministic behavior, and integration tests.
Function deployment and compatibility are owned by `@luwi/redis`.

Event-emitting Functions must preflight Stream appendability before their first mutation;
corrupted or exhausted Stream positions must not produce partial projection/event writes.

### Pub/Sub

The implemented runtime does not use Pub/Sub. A future phase may use it only after durable
persistence for:

- disposable realtime fan-out;
- connected UI invalidation;
- hints that clients should reload projections.

Consumers must be able to recover from Streams and projections after missing every Pub/Sub
message.

### Persistence

Local Redis uses append-only persistence:

```text
appendonly yes
appendfsync everysec
```

Docker Compose mounts `/data` to a named persistent volume and publishes port 6379 only on
`127.0.0.1`.

AOF with `everysec` reduces local data loss but does not guarantee zero loss. Do not describe
it as a backup. Document recovery and backup separately if those features are added.

### Bounded Stream retention

Transition Functions do not trim. The periodic retention service uses these configurable
defaults:

```text
LUWI_STREAM_MAXLEN_GLOBAL=100000
LUWI_STREAM_MAXLEN_PROJECT=50000
LUWI_STREAM_MAXLEN_DEAD_LETTER=10000
LUWI_RETENTION_INTERVAL_MS=60000
LUWI_CONSUMER_CLAIM_IDLE_MS=30000
LUWI_MESSAGE_MAX_CONTENT_BYTES=32768
LUWI_MESSAGE_MAX_SUBJECT_BYTES=512
LUWI_MESSAGE_MAX_RESPONSE_BYTES=65536
LUWI_MESSAGE_MAX_EVIDENCE_ITEMS=32
LUWI_MESSAGE_DEFAULT_TIMEOUT_MS=120000
LUWI_MESSAGE_MAX_TIMEOUT_MS=86400000
LUWI_INBOX_CLAIM_LIMIT=10
LUWI_INBOX_BLOCK_MS=5000
LUWI_INBOX_MIN_IDLE_MS=15000
LUWI_INBOX_MAX_CLAIM_LIMIT=100
LUWI_TERMINAL_MESSAGE_RETENTION_MS=604800000
LUWI_MESSAGE_IDEMPOTENCY_RETENTION_MS=86400000
LUWI_SESSION_INBOX_MAXLEN=10000
LUWI_NATIVE_LINK_RETENTION_MAX=1000
```

On standard Redis versions before 8.2, trim the global Stream only when group metadata is
valid, pending and lag are zero, and the relay is healthy. Otherwise defer trimming.
Retention is an operational bound, not tenant isolation. Never trim entries still required
for pending recovery.

## 8. Runtime event envelope

All events use a versioned validated envelope:

```ts
type RuntimeEvent = {
  id: string;
  version: 1;
  type: string;
  occurredAt: string;
  workspaceId: string;
  projectId?: string;
  agentId?: string;
  sessionId?: string;
  correlationId?: string;
  causationId?: string;
  payload: unknown;
};
```

Use UTC ISO 8601 timestamps. Generate IDs centrally with `crypto.randomUUID()` unless an
already-required maintained dependency provides UUIDv7.

Initial event types:

```text
runtime.started
runtime.stopping
project.registered
project.updated
session.registered
session.heartbeat
session.status.changed
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

Add event types only with a real transition, schema, persistence path, and tests.

## 9. Initial domain model

### Project

```ts
type Project = {
  id: string;
  name: string;
  localPath: string;
  repositoryUrl?: string;
  defaultBranch?: string;
  createdAt: string;
  updatedAt: string;
};
```

The filesystem and Git remain canonical for project code and configuration. Redis owns the
runtime project projection and activity state.

### Agent definition

```ts
type AgentDefinition = {
  id: string;
  kind: "codex" | "claude-code" | "gemini-cli" | "kimi" | "other";
  displayName: string;
  executable?: string;
  detectedVersion?: string;
  enabled: boolean;
  adapterId: string;
  nativeConfigRoots: string[];
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
};
```

### Session

```ts
type AgentSession = {
  id: string;
  agentId: string;
  projectId: string;
  status:
    | "starting"
    | "idle"
    | "thinking"
    | "tool_running"
    | "waiting_for_input"
    | "waiting_for_agent"
    | "blocked"
    | "completed"
    | "disconnected";
  taskSummary?: string;
  workingDirectory: string;
  branch?: string;
  worktreePath?: string;
  startedAt: string;
  lastHeartbeatAt: string;
  metadata: Record<string, unknown>;
};
```

Domain packages never expose Redis-specific field layouts.

## 10. Daemon protocol

Use the versioned prefix `/api/v1`.

Initial routes:

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
GET  /api/v1/realtime  (WebSocket upgrade)

POST /api/v1/messages
GET  /api/v1/messages
GET  /api/v1/messages/:correlationId
GET  /api/v1/messages/:correlationId/wait
POST /api/v1/messages/:correlationId/acknowledge
POST /api/v1/messages/:correlationId/processing
POST /api/v1/messages/:correlationId/respond
POST /api/v1/messages/:correlationId/reject
POST /api/v1/messages/:correlationId/fail
POST /api/v1/sessions/:sessionId/inbox/claim
```

These project, session, event, realtime, message, and inbox routes are implemented. They are
the Phase 1 and Phase 2 subset only. Phases 3 through 5B added agent, capability, profile,
config, context, usage, git, package, technology, graph, and optimization routes under the
same `/api/v1` prefix, plus `GET /` and `GET /assets/:asset` for the built dashboard.

`apps/daemon/src/app.ts` is the canonical route list. Read it rather than this section when
you need the current surface; keep this section as the protocol contract, not an inventory.

The WebSocket server broadcasts normalized events only after Redis persistence succeeds.
Browser and WebSocket origins require an explicit loopback allowlist.

`GET /health` reports daemon status, version, uptime, Redis connectivity, and timestamp. It
returns non-2xx when required Redis operations fail.

## 11. Request/reply semantics

Cross-session communication is asynchronous:

- a request identifies source session, target session, project, content, optional deadline,
  and correlation ID;
- the target receives it through a durable inbox Stream or connected Session Bridge;
- a response includes correlation ID, source and target sessions, status, answer, optional
  evidence, optional confidence, and verification time;
- the HTTP request returns an accepted result and does not wait indefinitely;
- deadlines create explicit `message.timed_out` events;
- evidence and freshness are separate from model-generated confidence.

## 12. Session Bridge and MCP boundary

The CLI includes HTTP-only `manual`, `echo`, and `status-responder` bridge simulations. They
claim durable inbox work, acknowledge/process it, and optionally return explicitly simulated
responses. They never receive Redis credentials and do not inject terminal prompts.

`@luwi/mcp-server` is a thin stdio adapter bound to one registered online session. It
validates daemon responses, derives source/responder identity from `LUWI_SESSION_ID`, and
operates only through loopback HTTP. Phase 3 control-plane and Phase 4 intelligence tools
are read-only and project-bounded. A bounded optimization-analysis request is allowed;
acceptance, graph rebuild, native config approval/apply, rollback, and Git mutation are
never exposed through MCP.

`@luwi/adapters` passively detects and inspects Codex, Claude Code, Gemini CLI, and Kimi.
Adapters accept injected filesystem/home/project/executable/runner collaborators, execute
only a detected CLI's `--version` during explicit installation detection, never write
files, and never execute discovered skills, hooks, plugins, scripts, or MCP servers.

## 13. Git and safety

- Initialize Git if the directory is not already a repository.
- Never delete or rewrite user files without explicit evidence that they are generated or
  explicitly in scope.
- Never use `git reset --hard`, `git clean -fd`, force push, amend, rebase, merge, or push
  unless explicitly requested.
- Keep generated runtime state, Redis data, coverage, build output, and secrets out of Git.
- Add `.env.example`; never add a real `.env`.
- Commit only when the user explicitly asks.

## 14. Engineering conventions

- Enable strict TypeScript.
- Avoid `any`; use `unknown` and validate boundaries.
- Keep domain logic separate from HTTP and Redis representations.
- Use dependency injection through plain functions and constructors.
- Avoid deep inheritance and speculative generic abstractions.
- Export package public APIs from one `src/index.ts`.
- Use typed application errors and machine-readable safe API error codes.
- Log stack traces locally with identifiers, never in client responses.
- Validate request bodies, parameters, queries, WebSocket messages, Redis Function results,
  and Redis data read from storage.

## 15. Tests

Every state transition requires tests.

Phase 1 through Phase 4 coverage includes:

1. event-envelope validation;
2. project registration and duplicate behavior;
3. session registration;
4. heartbeat updates;
5. invalid session status;
6. expiry and disconnection;
7. Redis-unavailable health;
8. persistence-before-WebSocket broadcast;
9. consumer acknowledgement and pending recovery;
10. `XAUTOCLAIM` recovery;
11. Redis Function atomic success and rollback behavior;
12. bounded Stream trimming;
13. non-loopback bind and invalid origin rejection;
14. single-daemon ownership and owned recovery;
15. bounded WebSocket client queues.
16. complete message transition and timeout race rules;
17. same-project deterministic routing and idempotency conflicts;
18. inbox pending recovery, pending-until-terminal acknowledgement, and safe terminal skip;
19. message/inbox retention that defers while pending or lagged;
20. daemon message routes, bounded waits, draining, and Redis-loss behavior;
21. CLI message/bridge behavior and bound-session MCP tools.
22. AgentDefinition, binding, capability, profile, provenance, and tombstone rules.
23. adapter inspection/render fixtures without passive execution or direct writes.
24. unmanaged-file refusal, target-root checks, snapshots, atomic replacement, locks,
    drift, rollback, and reconciliation.
25. control-plane Redis projections, indexes, Functions, events, HTTP/CLI routes, and
    project-bounded read-only MCP tools.
26. usage source/confidence validation, idempotency, source-separated aggregates, and
    absent-value preservation.
27. assigned/effective/loaded/invoked context distinctions and unknown-safe finding rules.
28. read-only Git allowlisting, timeout/output bounds, credential redaction, exact and
    correlated attribution.
29. non-executing Node, Python, Dart, PHP, Rust, and Go package/technology inventory.
30. graph identity, provenance, bounded traversal, shadow-generation swap, failure
    diagnostics, and retention.
31. proposal state, acceptance-without-apply, Phase 3 ConfigPlan handoff, post-change
    evaluation, and `causalClaim: false`.
32. Phase 4 HTTP/CLI and project-scoped read-only MCP tools.

Use unit tests for `@luwi/runtime` transitions and integration tests for Redis behavior.

Redis integration tests:

- require an explicit `LUWI_TEST_REDIS_URL`;
- use a dedicated test database and unique per-run key prefix;
- never silently use a developer's default database;
- never flush unrelated keys;
- clean only keys created by the current test run.

## 16. Documentation

`README.md` documents current behavior honestly, prerequisites, platform setup, Redis AOF,
installation, commands, health checks, CLI use, architecture, security, and roadmap limits.

`docs/architecture/overview.md` explains the planes, package boundaries, Redis-native data
flow, Session Bridge/MCP boundaries, recovery, retention, and local security.

ADRs record binding choices:

```text
docs/decisions/0001-typescript-node.md
docs/decisions/0002-redis-streams.md
docs/decisions/0003-daemon-owned-redis-access.md
docs/decisions/0004-redis-only-local-runtime.md
docs/decisions/0005-redis-native-operational-core.md
docs/decisions/0006-session-inbox-request-reply.md
docs/decisions/0007-filesystem-canonical-agent-config.md
docs/decisions/0008-capability-scope-and-inheritance.md
docs/decisions/0009-event-derived-operational-graph.md
docs/decisions/0010-context-optimization-feedback-loop.md
docs/decisions/0011-local-git-observation-and-attribution.md
docs/decisions/0012-code-structure-observer.md
docs/decisions/0013-bounded-global-graph-summary.md
docs/decisions/0014-complete-graph-projection-inputs.md
docs/decisions/0015-internal-validation-failures-are-server-errors.md
docs/decisions/0016-rooted-graph-exploration-view.md
```

Each ADR contains context, decision, consequences, and status.

## 17. Local developer experience

Expected root commands:

```text
pnpm build
pnpm dev
pnpm lint
pnpm format
pnpm typecheck
pnpm test
pnpm test:integration
pnpm clean
```

Application commands:

```text
pnpm --filter @luwi/daemon dev
pnpm --filter @luwi/cli dev -- runtime
pnpm --filter @luwi/mcp-server dev
```

`pnpm` is required. Node 22 and newer no longer bundle Corepack, so install it explicitly with
`npm i -g pnpm@11.9.0` to match the `packageManager` field. `pnpm typecheck` and `pnpm build`
each have a separate `apps/dashboard` leg because the root `tsconfig.json` `references` array
deliberately omits the dashboard; `tsc -b` alone does not cover it. `pnpm test` already
includes the dashboard's tests.

Start standard Redis with AOF:

```text
docker compose up -d redis
```

Docker is optional. An external standard Redis server is accepted through:

```text
REDIS_URL=redis://127.0.0.1:6379
```

Any server that provides standard Redis 7 semantics is acceptable, including a Windows service
such as Memurai. Verify Redis Functions support with `FUNCTION LIST` before relying on it, since
the atomic transition path requires them.

Default daemon values:

```text
HOST=127.0.0.1
PORT=4782
REDIS_URL=redis://127.0.0.1:6379
LOG_LEVEL=info
WORKSPACE_ID=local
```

## 18. Milestones

### Phase 0 — Foundation

Phase 0 contains:

- pnpm TypeScript ESM workspace;
- `protocol`, `runtime`, and `redis` packages;
- daemon and CLI;
- Redis connectivity;
- validated health and runtime APIs;
- structured logging;
- graceful shutdown;
- tests and documentation.

Acceptance:

- frozen install succeeds;
- formatting, typecheck, lint, tests, and build pass;
- daemon starts on `127.0.0.1`;
- non-loopback binding is rejected;
- health exposes current Redis connectivity;
- CLI prints validated runtime status;
- shutdown is graceful.

### Phase 1 — Projects and sessions

Phase 1 contains:

- project registration;
- session registration;
- heartbeats and status transitions;
- TTL-backed presence and expiry;
- Redis Function-backed atomic transitions where required;
- Redis Stream persistence with bounded retention;
- consumer-group recovery;
- persistence-first WebSocket broadcast;
- CLI simulation for two sessions.

Acceptance also requires atomic canonical-path uniqueness, opaque `agentId` values without
implicit AgentDefinition CRUD, single-daemon ownership, stale pending recovery, bounded
WebSocket queues, safe origin/Host checks, Redis-loss recovery, and draining shutdown.

Do not add dashboard, MCP server, agent adapters, metrics packages, knowledge-graph packages,
or another datastore.

### Phase 2 — Request/reply and thin MCP

Phase 2 contains:

- message request;
- target inbox;
- acknowledgement;
- response and correlation;
- timeout;
- evidence metadata;
- pending-entry recovery;
- CLI request/reply and bridge simulation;
- thin bound-session stdio MCP adapter.

Do not add dashboard, native coding-agent adapters, prompt injection, task/lease systems,
metrics/lifecycle packages, knowledge graphs, GitHub integration, or another datastore as
part of Phase 2.

### Phase 3 — Agent and capability control

Phase 3 contains:

- explicit AgentDefinition registry and project-agent bindings without rewriting opaque
  historical session IDs;
- global/project capability packages and named profiles;
- deterministic inheritance, disable tombstones, dependencies, compatibility, and
  provenance;
- passive Codex, Claude Code, Gemini CLI, and Kimi adapters;
- filesystem-canonical LUWI manifests;
- native inspection, import/render plans, explicit adoption, one-time approval, snapshots,
  atomic apply, rollback, drift, and Redis reconciliation;
- exact plan-artifact binding, snapshot-payload validation, pre-rollback snapshots, and
  canonical managed-target ownership;
- canonical-manifest validation and Redis projection rebuild before readiness;
- stable static context inventory across instructions and assigned capability artifacts,
  with clearly labeled generic character estimates;
- validated HTTP/CLI surfaces and project-bounded read-only MCP tools.

Do not add a dashboard, authentication, cloud sync, arbitrary package execution, hook/plugin
execution, MCP supervision, tasks, leases, exact model token telemetry, Smart Context
Optimization, knowledge graphs, GitHub integration, or another datastore as part of Phase
3.

### Phase 4 — Usage, Git, operational graph, and context optimization

Phase 4 contains:

- normalized exact, reported, adapter-extracted, estimated, and unavailable usage with
  source-separated summaries and idempotent ingestion;
- static context estimates plus explicit session/adapter loaded and invoked observations;
- bounded read-only local Git observation and exact/correlated/unknown attribution;
- non-executing package and technology inventory for Node, Python, Dart/Flutter, PHP, Rust,
  and Go;
- a standard-Redis operational graph with provenance, bounded named queries, incremental
  projection, shadow-generation rebuild, a bounded global summary answered from index cardinality
  rather than traversal (ADR 0013), and a non-executing TypeScript code-structure layer projected
  into the same generation (ADR 0012);
- structural findings and deterministic proposals;
- explicit acceptance followed by the existing Phase 3 ConfigPlan approval/snapshot/apply
  path;
- post-change evaluation that reports observations without causal model-quality claims;
- validated HTTP/CLI and project-bounded read-only MCP intelligence surfaces.

Unknown evidence is never converted to unused. The Git observer never mutates a repository
or contacts a remote; authorization uses exact read-only argument templates, not top-level
Git verbs. Project-owned graph identities include project scope. Shadow generations validate
counts and edge endpoints before activation. Incremental graph refresh atomically removes
obsolete membership, and adjacency traversal has examined-edge budgets. Package scans use
Git-tracked paths when available and disclose filesystem fallback/truncation. Optimization
proposals retain an immutable baseline and post-change evaluation uses only explicit evidence
recorded after the Phase 3 apply timestamp. Scanners never execute package managers, scripts,
hooks, plugins, or MCP definitions. No Phase 4 path writes instruction prose directly.

Do not add the Pulse dashboard, lifecycle/release scoring, GitHub integration, cloud sync,
semantic/vector knowledge graph, memory federation, autonomous task/lease orchestration,
prompt injection, automatic optimization apply, another datastore, or Redis Pub/Sub as part
of Phase 4.

## 19. Definition of done

A change is done only when:

- behavior matches the accepted scope;
- types are correct;
- relevant tests exist and pass;
- formatting, lint, typecheck, tests, and build pass;
- Redis integration behavior is tested when changed;
- public behavior and operational limits are documented;
- the diff contains no accidental files or secrets;
- remaining limitations are reported honestly.

Do not claim a command passed unless it was actually run successfully. For a command that
cannot run, report the exact command, error, likely cause, and next safe action.

## 20. How Codex works here

- Plan before large changes.
- Prefer vertical runnable increments.
- Keep the repository working after each milestone.
- Do not label architecture or planned behavior as implemented.
- Avoid speculative infrastructure and package boundaries.
- Ask only when a choice changes architecture materially or risks data.
- End implementation turns with files changed, commands run, test results, milestone status,
  unresolved issues, and the exact next task.

## 21. Immediate objective

Keep the implemented Phase 1 projects/sessions, Phase 2 request/reply/MCP, Phase 3
agent/capability control, Phase 4 operational intelligence/optimization foundation, and
Phase 5B native realtime Pulse verified and documented.

Phase 5A through Phase 5D were subsequently approved and shipped. The read-only Pulse dashboard,
bounded Activity, read-only inspectors, project scope, and the sessions, agents, usage, context,
and optimization routes in `apps/dashboard` are implemented. Those approvals covered the read-only
dashboard only.

Phase 5C added the `#/projects` route and on-demand project-scoped reads for repository
observation, bound agents, packages, and technologies. Phase 5D added five further read-only
routes, two of which load a bounded collection only while their route is open. Neither phase
called a mutation endpoint, added a dependency, or added a datastore.

The operational graph is no longer a disabled label. ADR 0013 added `GET /api/v1/graph/summary`,
a read-only Phase 4 surface extension that answers the global question from index cardinality on
the active generation rather than from traversal. It reports the active generation, projection
health, and exact per-kind node and edge counts, and it withholds totals entirely when the graph
has never been built rather than reporting zero. The `#/graph` dashboard route renders that
contract and calls no mutation endpoint.

ADR 0014 then closed the two projection gaps that were defects rather than absences. Every graph
write path records its generation, so retention sees every generation it is responsible for and
the summary reports a retained-generation count again. Module roots come from every parsed
manifest rather than from dependency records, so a workspace package that declares nothing is
still a module and its files are no longer misattributed to the enclosing one.

Rebuild ordering and per-project graph counts remain unanswered, deliberately. Both would be
straightforward and neither has a consumer, so building them now would add write cost and key
cardinality to answer a question nothing asks. ADR 0014 records the reasoning.

ADR 0012's code-structure observer was approved and its first increment implemented. The daemon
parses the project's own TypeScript with the compiler API — never executing it — and projects
`FILE_IMPORTS_FILE` and `MODULE_DEPENDS_ON_MODULE` into the existing Phase 4 graph generation
alongside the event-derived edges, distinguished by provenance. `typescript` is now a production
dependency of `apps/daemon`; ADR 0012 states the cost. Function-level nodes, call graphs, and
multi-language extraction remain out of scope.

ADR 0017 approved the first read from the 2026-08-09 UI audit's item 10 and only that one. The
dashboard now consumes `GET /api/v1/projects/:projectId/git/attributions` as a fifth project-scoped
read, and renders the branch, tag, and worktree evidence the Git observation was already delivering
and the dashboard was discarding at its boundary. No daemon route, dependency, datastore, or write
path was added.

ADR 0018 then lifted the condition ADR 0017 set. `scripts/seed-runtime.ts` populates an isolated
fixture runtime over the daemon's own HTTP API, so the deferred domains became verifiable, and
three of them were approved and built: inter-agent messaging as `#/messages`, effective agent
configuration and its conflicts, and the pair-scoped context summary and footprint. The last two
hang off `#/projects/<id>/agents/<agentId>`, which is what finally makes the Projects route's
`profileCount` and `capabilityCount` openable.

ADR 0019 then built the last two, both approved: the capability and profile catalogue as
`#/capabilities`, and config plans, snapshots and drift as `#/config`. Each is a route rather than a
panel because both are whole-runtime inventories that no project or pair frame contains. That config
route was strictly read-only until ADR 0021, which matters more there than anywhere else on this
surface: plan, approve, apply, rollback, drift scan and reconcile all write the developer's own
agent configuration files. Building the first consumer of `GET /api/v1/capabilities` also exposed a
hardcoded `truncated: false` over a list the service cuts at `limit`; the route now over-fetches by
one and compares, as every other bounded collection already did.

**No read domain from the 2026-08-09 audit is open.** What remains from that report is its
unnumbered depth work: `graph-diagram.tsx` has no direct test, three branches in
`GraphExplorerView` are unasserted, and the app shell's degraded-path signals are asserted nowhere.
None is a malfunction.

ADR 0020 approved and built **advisory work leases**, the first coordination write since Phase 2 and
the first work on the product promise's third clause. A session claims a project-relative path; a
claim overlapping a held one is refused with the holder named, and the refusal is a 200 with a body
because the runtime answered correctly. `luwi_v1` is at version 10 with `lease_acquire`,
`lease_renew`, `lease_release` and `lease_expire`; the per-project held set is one declared hash so
the conflict scan derives no key names; `deadline:leases` is a sorted set swept on the message
timeout interval. Four MCP tools take the holder from the bound session and never from input, which
is the coordination-state write section 12 already permits. The dashboard shows held leases and
offers no control over them.

The lease is advisory and this section does not pretend otherwise: section 3 keeps LUWI out of
terminals, so an agent that never asks still edits the file. Automatic renewal for a live session,
notification when a held path frees, and correlating a lease with the commits made under it are
**not** built and remain new scope.

Isolating a fixture takes `REDIS_URL`, `LUWI_HOME`, `LUWI_NATIVE_HOME` and `WORKSPACE_ID` together.
Redis alone is not enough: per ADR 0007 the filesystem is canonical for agent definitions,
capability packages and profiles, so those survive a `FLUSHDB` and land in the developer's real
`~/.luwi` unless `LUWI_HOME` is redirected. ADR 0018 records how that was found.

### Built: dashboard configuration mutations

On 2026-08-10 the owner approved **dashboard mutations**, and the configuration plan chain was
built. ADR 0021 records the phase and settles the three decisions this section had left open.

The dashboard is no longer read-only. `#/config` creates import and render plans, applies a plan
behind a confirmation, prepares a rollback plan from a snapshot, and rescans drift. It gained a
fourth read, `GET /api/v1/agents`, to populate the plan form's picker.

How the three decisions landed:

- **Origin on state-changing requests.** `validateLocalHttpRequest` now requires, for a `POST` that
  carries no `Origin`, that the media type be `application/json` — a thing a browser cannot send
  cross-site without a preflight the daemon deliberately never answers. The check is POST-only:
  `PUT`, `PATCH` and `DELETE` are not CORS-safelisted, so a cross-site one always preflights and
  never reaches a handler. No CORS header and no `OPTIONS` handler were added.
- **What a confirmation is.** The dialog comes before `approve`, and `approve` and `apply` run
  inside one function so the one-time token never outlives the gesture or reaches storage. An
  already-`approved` plan is shown with no control, because the state machine mints no second token.
- **Which mutations are in.** The plan chain, minus `reconcile`. Optimization
  accept/reject/evaluate, graph rebuild, Git mutation, `inspect` and lease release are out and
  untouched.

`apps/dashboard/src/api/config-mutations.ts` is the **only** production module in the dashboard
permitted to issue a state-changing request. `product-independence.test.ts` enforces that as an
allowlist of one and still forbids the prohibited operations everywhere, including inside it.

### Built: native session binding (A1 and A2, complete)

ADR 0022 added **native session identity**. A client may declare its vendor-native session reference
when it registers a LUWI session, and the runtime records a stable `NativeSessionBinding` plus an
immutable, time-bounded `NativeSessionLink` for each LUWI session that reference produced.

What holds: identity carries no presence, project, agent or confidence; a live holder is refused,
never evicted; a conflict writes nothing and creates no session; missing evidence is
`NATIVE_BINDING_INCONSISTENT` rather than a free reference; product policy lives in a pure
`@luwi/runtime` function and Lua only validates a compare-and-set on a monotonic `version`;
validation runs before `XGROUP CREATE`, so a refused declaration leaves no inbox stream; append
capacity is proven per append; all three terminal paths — `close`, `status → completed` and the
sweeper's `disconnect` — close the link, and resolution is fail-closed. Every timestamp comes from
one Redis transition clock. A landed with `luwi_v1` at **v11**; B1 later moved the current library
to **v12** for the expanded usage-record shape.

**A2 landed, so A is accepted.** Link retention bounds a binding at 1000 retained closed links
through `LUWI_NATIVE_LINK_RETENTION_MAX`. `native_link_trim` takes `2 + 2N` keys, removes at most 32
links per call, and takes the zset member, the link hash and the session reverse index together, so
no dangling `openLinkId` and no dangling reverse index survives. It appends no event and touches no
stream: retention is a service on the existing retention interval, not a transition. Every key is
declared with the identity it must hold, and any mismatch — an unclosed link, another binding,
another session, a duplicate, an empty batch — is refused with nothing written. The sweep enumerates
bindings through `index:session:{sessionId}:native`, which keeps `session_register` at 14 keys at the
cost of being O(sessions) per pass.

MCP self-registration is still not included, and a trimmed interval is never evidence for
attribution.

**Built: transcript ingestion through B1 (ADR 0023).** The design is
`docs/superpowers/specs/2026-08-14-native-transcript-ingestion-design.md`, split B0 / B1 / B2.

**B0 was a declaration surface, not a reader,** because at approval there were **zero native
bindings in either database** against nine sessions: a declaration rode only on
`POST /api/v1/sessions` and nothing that registers a session sent one, so an already-registered
session could never declare and no interval had ever existed. A reader built first would have
attributed nothing. B0 is now built: an already-registered, live, non-terminal session declares
through `POST /api/v1/sessions/:sessionId/native`, which takes the same `native` block registration
takes and, by strict schema, nothing else — a body cannot redirect a declaration at another
session. It reuses `evaluateNativeDeclaration` unchanged; `unchanged` is returned rather than
refused, so declaring on a timer or at startup is safe and writes nothing. The Redis Function
`native_declare` follows A1's contract — Lua validates a CAS and derives no key name, every key
arrives paired with the identity it must hold, a refusal writes nothing — and `luwi_v1` stays at
**v11**: `isCompatible` compares the source hash and function list, so a new function forces a
reload without a version bump, and no stored record changed shape. The CLI's `session register` and
`session simulate` take `--native-adapter` / `--native-session` / `--native-subagent`, and the seed
declares for one seeded session, so the fixture holds a binding and a real attribution interval.
That link starts open and may be closed by the normal presence sweeper when the seeded session
expires; B0 was verified live through both transitions.

**B1 is built: `usage.sessionId` is answerable, and only for sessions that declare.** A reader in
`@luwi/adapters` enumerates the transcript projects root — it derives no directory name from a
project path, because the drive-letter case varies on this machine and a wrong guess would read zero
files while looking like a clean scan — walks each project tree including `subagents/`, and emits one
observation per `requestId`. Its read surface is a separate `TranscriptFileSystem` (`listDirectory`,
`stat`, a bounded `readLines`, no offset read) rather than two more methods on `AdapterFileSystem`,
which no adapter and neither config service would ever call. `attributeObservation` in
`@luwi/runtime` decides attribution by half-open interval containment against
`findNativeLinkAt(bindingId, atMs)`, a `ZRANGE ... BYSCORE REV LIMIT 0 1` over the links zset that was
already scored by `linkedAt`. **Nothing falls back to the nearest session**: the four unbound cases —
no binding, outside every interval, trimmed, and a link whose session cannot be read — are counted
separately and reported. `projectId` and `agentId` come from the session record, never from the
transcript, which knows neither. The daemon owns a sixth timer on
`LUWI_TRANSCRIPT_SCAN_INTERVAL_MS` (default 300000, min 60000), cleared on both teardown paths. A
re-read is the steady state, so `USAGE_RECORD_DUPLICATE` is counted rather than thrown, and the
ingested record leaves `cachedInputTokens` and `totalTokens` unset so neither existing invariant can
fire. `luwi_v1` moves to **v12** — the usage record gained `cacheCreationInputTokens` and
`cacheReadInputTokens`, and a record-shape change is exactly what the version is for. **B2 fills
`SESSION_CHANGED_FILE`, which sits in the edge enum with no producer; it is specified and not
started.**

Measurement corrected two earlier conclusions. `subagents/` directories **do** exist — 71 of them,
oldest 2026-06-18, at `<sessionId>/subagents/workflows/<workflowId>/agent-<id>.jsonl` — and hold
11.3% of distinct requests, so a top-level-only reader loses a ninth of the evidence. And the usage
object does **not** always repeat identically across a request: 362 of 1961 multi-record requests
disagree, so the design fixes an explicit resolution rule. Usage is per `requestId`, never per record
— summing per record over-counts by 1.88×. **The join key is the `sessionId` inside each record,
never the filename**, which is a stem only for top-level transcripts. `cachedInputTokens` is left
alone with its `<= inputTokens` invariant and two new additive fields are added beside it. Nothing
discovered is executed and no conversation content is ever stored or logged. Automatic lease renewal
and autostart — the two items that follow ingestion in the sequence — remain unapproved.

**Every other prohibition below still stands.** Do not begin automatic drift reconciliation (the
unbuilt desired-state loop — not the implemented interrupted-apply recovery that answers
`POST /api/v1/config/reconcile`), lifecycle/release scoring, task orchestration, a semantic or
vector knowledge graph, memory federation, GitHub
integration, prompt injection, automatic optimization apply, cloud accounts, authentication, or
remote control-plane work until that specific scope is explicitly approved. Shipping one phase does
not authorize the rest.
