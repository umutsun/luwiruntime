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

Normalized Runtime events are the durable source for:

- metrics;
- project activity;
- lifecycle progress;
- rankings;
- knowledge-graph relations;
- audit and operational history.

Every derived view must be rebuildable from retained normalized events. Do not create a
dedicated analytics, graph, relational, embedded, or search database.

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
│  └─ cli/
├─ packages/
│  ├─ protocol/
│  ├─ runtime/
│  └─ redis/
├─ docs/
│  ├─ architecture/
│  └─ decisions/
├─ AGENTS.md
├─ README.md
├─ compose.yaml
├─ package.json
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ eslint.config.js
└─ .gitignore
```

Package responsibilities:

- `@luwi/protocol`: versioned Zod schemas and wire types.
- `@luwi/runtime`: Redis-independent errors, lifecycle, projects, sessions, messages, tasks,
  leases, projections, and IRIS state transitions.
- `@luwi/redis`: official Redis client integration and all Redis-specific representations.
- `@luwi/daemon`: composition root and sole Redis-accessing process.
- `@luwi/cli`: versioned daemon HTTP client.

Do not create separate packages for metrics, knowledge graph, lifecycle, memory, IRIS,
session routing, tasks, or leases until at least two real consumers prove a boundary.

Do not add a dashboard before the daemon, CLI, persistence, presence, and realtime protocol
have tests. Do not add Turborepo until pnpm workspace scripts are insufficient.

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
- standard Redis 7 features only.

Before adding a production dependency:

1. explain why the standard library or an existing dependency is insufficient;
2. verify that the package is maintained;
3. keep the dependency behind an existing package boundary when practical.

## 7. Redis-native operational model

All Redis keys use the `luwi:v1:` namespace. Redis data is untrusted input and must be
validated when read.

### Streams

Phase 1 uses these Redis Streams for durable ordered records:

```text
luwi:v1:events:global
luwi:v1:events:project:{projectId}
luwi:v1:events:dead-letter
```

Streams are the source of truth for events, delivery, and audit history. Pub/Sub is never a
source of truth.

Session inbox/outbox and task-delivery Streams remain deferred.

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

Phase 1 uses hashes for current entity state:

```text
luwi:v1:project:{projectId}
luwi:v1:session:{sessionId}
```

Do not expose these Redis representations from `@luwi/runtime` or `@luwi/protocol`.
Do not create an AgentDefinition hash implicitly from an opaque session `agentId`.

### Sets

Phase 1 uses sets for relationships and secondary indexes:

```text
luwi:v1:index:projects
luwi:v1:index:project:{projectId}:sessions
luwi:v1:index:agent:{agentId}:sessions
```

### Sorted sets

Phase 1 uses a sorted set for heartbeat deadlines:

```text
luwi:v1:deadline:heartbeats
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

Phase 1 does not use Pub/Sub. A future phase may use it only after durable persistence for:

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
message.responded
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
  scope: "global" | "project";
  projectId?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
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
```

These routes are implemented in Phase 1. Message request/reply routes remain deferred to
Phase 2 and must not be documented as available yet.

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

## 12. Session Bridge direction

A future Session Bridge communicates only with the daemon through versioned local HTTP or
WebSocket protocols. It may register, heartbeat, update status, consume and acknowledge
inbox messages, respond, publish tool/file events, request leases, and close cleanly.

Do not implement terminal injection in the initial milestones. Do not give a bridge Redis
credentials.

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

Phase 1 coverage includes:

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
flow, Session Bridge direction, future MCP adapter, recovery, retention, and local security.

ADRs record binding choices:

```text
docs/decisions/0001-typescript-node.md
docs/decisions/0002-redis-streams.md
docs/decisions/0003-daemon-owned-redis-access.md
docs/decisions/0004-redis-only-local-runtime.md
docs/decisions/0005-redis-native-operational-core.md
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
```

Start standard Redis with AOF:

```text
docker compose up -d redis
```

Docker is optional. An external standard Redis server is accepted through:

```text
REDIS_URL=redis://127.0.0.1:6379
```

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

### Phase 2 — Request/reply

Add:

- message request;
- target inbox;
- acknowledgement;
- response and correlation;
- timeout;
- evidence metadata;
- pending-entry recovery;
- CLI request/reply demonstration.

Do not begin Phase 2 before Phase 1 is tested and documented.

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

Keep the implemented Phase 1 projects/sessions foundation verified and documented.

Do not begin Phase 2, dashboard, MCP, knowledge-graph UI, GitHub integration, or coding-agent
adapter implementation until Phase 1 acceptance remains green and the next scope is
explicitly approved.
