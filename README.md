# LUWI Runtime

LUWI Runtime is a local-first, single-user control and coordination runtime for developers
who use multiple AI coding agents across local projects. It coordinates tools such as Codex,
Claude Code, Gemini CLI, and Kimi; it does not replace or impersonate them.

> See every project. Coordinate every agent. Ship without collisions.

## Current status

Phase 5D — read-only project scope and intelligence routes — is implemented on the Phase 5B
realtime Pulse and the Phase 1–4 runtime foundation:

- strict TypeScript/ESM pnpm workspace with `protocol`, `runtime`, and `redis` packages;
- Fastify daemon bound to `127.0.0.1` with an owned lifecycle and explicit readiness states;
- Redis 7 Functions for atomic project/session projection and event transitions;
- canonical local-path project registration with atomic duplicate detection;
- opaque agent IDs, concurrent sessions, heartbeat sampling, TTL presence, and expiry;
- bounded global/project event Streams and a bounded dead-letter Stream;
- consumer-group recovery with continuous `XPENDING`/`XAUTOCLAIM` reinspection, validation,
  poison-entry retries, and post-acceptance acknowledgement;
- persistence-first, server-to-client WebSocket delivery with bounded per-client queues;
- CLI project, session, simulation, event-list, and event-watch commands;
- durable same-project request/reply with deterministic online-session routing;
- message projections, correlation/idempotency indexes, deadlines, and per-session inbox
  Streams;
- pending-until-terminal inbox delivery with `XAUTOCLAIM` recovery;
- delivered, acknowledged, processing, responded, rejected, failed, and timed-out states;
- bounded HTTP waits, timeout race protection, and pending/lag-aware message retention;
- CLI message/inbox commands plus manual, echo, and status-responder bridge simulations;
- a thin bound-session stdio MCP server that uses only the daemon HTTP API;
- filesystem-canonical AgentDefinitions, project-agent bindings, capability packages, and
  profiles with Redis operational projections;
- deterministic global/project inheritance, disable tombstones, dependency and
  compatibility errors, and per-value provenance;
- injected Codex, Claude Code, Gemini CLI, and Kimi adapters for passive detection,
  inspection, context discovery, and support matrices;
- bounded shell-free native version probes with a 2.5 second timeout, separate 64 KiB output
  limits, sibling-safe failure handling, and a Windows-only `.cmd`/`.bat` path that invokes
  only the canonical System32 command processor with fixed `/d /s /c` and literal
  `--version` arguments; native utility selection never searches ambient `PATH`, and bounded
  timeout/output cleanup verifies the exact owned process tree before reporting success;
- tested Codex and Claude Code native render subsets; Gemini CLI and Kimi native writes
  remain read-only;
- redacted ConfigPlans, one-time approvals, explicit unmanaged-file adoption,
  preconditions, bounded local snapshots, staged/fsynced atomic replacement,
  process/filesystem target locks, drift, rollback, and reconciliation;
- plan/artifact binding, snapshot-payload verification, pre-rollback snapshots,
  canonical managed-target ownership, and uncertain Redis-transition recovery;
- owned-startup validation and rebuild of Phase 3 Redis projections from canonical
  manifests;
- static context inventory with exact-hash duplicate groups and clearly labeled generic
  character estimates across instructions and assigned capability artifacts;
- HTTP/CLI management and eight project-bounded read-only Phase 3 MCP tools;
- normalized exact, reported, adapter-extracted, estimated, and unavailable usage records
  with idempotent ingestion and source-separated summaries;
- static context estimates plus explicit session/adapter observations that keep assigned,
  effective, loaded, invoked, and unknown states distinct;
- bounded read-only local Git observation, credential-redacted remotes, exact trailer and
  separately labeled correlated attribution;
- non-executing Node, Python, Dart/Flutter, PHP, Rust, and Go package/technology inventory
  with canonical-root containment, opened-handle `dev`/`ino` identity proof, and an
  independently enforced 2 MiB chunked limit for every manifest read;
- a provenance-bearing Redis operational graph with bounded traversal, failure diagnostics,
  and atomic shadow-generation rebuild;
- deterministic structural context findings and human-approved proposals that reuse Phase 3
  ConfigPlan, approval, snapshot, apply, drift, rollback, and reconciliation;
- non-causal post-change evaluation and project-scoped read-only Phase 4 MCP tools;
- unit and opt-in Redis integration tests.
- a loopback-served React/TypeScript Pulse shell with independently validated read-only
  health, project, session, agent, activity, usage, context, and optimization snapshots;
- explicit loading, empty, partial, degraded, Redis-unavailable, daemon-unavailable, and
  WebSocket connection states;
- validated WebSocket events with first-live and reconnect refresh, bounded reconnect,
  512-stream-ID duplicate suppression, 200-row Activity retention, and 250 ms coalesced REST
  invalidation;
- live Activity follow/pause/resume, local bounded filters, and safe unknown-event display;
- a polite 750 ms aggregate Activity announcement region that ignores history and duplicates;
- read-only Project, Session, and Event inspectors whose selection stores only entity IDs and
  resolves every render from current authoritative snapshots, with bounded related Activity,
  project-coherent known-reference navigation, and bounded text-only payloads; the single
  60-second duration clock exists only for a current nonterminal Session with a finite,
  non-future `startedAt`;
- non-destructive `refreshing` state while retained data is revalidated by first-live,
  reconnect, realtime invalidation, or manual Retry; zero-safe-resource bootstrap is
  unavailable, and completion resolves to current, stale, or unavailable.
- a `#/projects` route with a project registry and on-demand project-scoped evidence: repository
  observation, commit attribution, bound agents, package inventory, and technology inventory, each
  loaded independently so one failure cannot erase its siblings;
- repository evidence rendered at the depth the observation carries — branches, tags, worktrees, and
  recent commits as labelled groups that each carry their own count, every worktree with its head
  and its detached or locked state, and branch and tag names in display-bounded lists that say how
  many were shown of how many exist;
- commit attribution reported as observed rather than asserted: a commit the runtime could not tie
  to a session is shown as unattributed with the reason it could not, never as a guess, and its
  grade is always readable as text;
- an explicit not-observed state for a project with no recorded Git scan, kept distinct from an
  unavailable read, so an unscanned project is never reported as a fault;
- disclosed truncation on every bounded project collection and per-tier confidence rendered as
  text rather than colour alone;
- project-scoped realtime refresh that runs only for the project currently on screen, with a
  generation guard that drops a response when the selection has moved on;
- dedicated read-only routes for sessions, agent definitions, usage, context, and optimization,
  where usage sources are never summed across differing provenance, context observations are shown
  as four independent counts rather than pipeline stages, and context token figures stay labelled
  as generic character estimates;
- agent kinds rendered verbatim, with no vendor label map or per-vendor branch anywhere in the
  dashboard.

The operational graph now has a bounded global read. `GET /api/v1/graph/summary` reports the
active generation, projection health, and exact per-kind node and edge cardinality, and the
`#/graph` route renders it. A graph that has never been built reports no totals rather than zero.

The graph also carries a code-structure layer. During a rebuild the daemon parses the project's
own TypeScript with the compiler API — it parses and never executes — and projects resolved
file-to-file imports and the module dependencies aggregated from them into the same generation as
the event-derived relationships, kept apart by provenance. An import it cannot resolve is recorded
as unresolved rather than pointed at the nearest plausible file.

ADR 0018 added `#/messages`, a read-only view of inter-agent requests that renders what an
Activity row cannot: who asked whom, the subject and body, why the runtime selected that recipient,
the state, and the response with its own confidence. A rejected message is presented as an answer
rather than as a fault. Selecting a bound agent on the Projects route opens
`#/projects/<id>/agents/<agentId>` and loads the effective configuration with its conflicts and
unsupported capabilities, plus the pair-scoped context summary and footprint — which is what makes
the binding's profile and capability counts openable rather than terminal.

`pnpm seed` populates an isolated fixture runtime over the daemon's own HTTP API so those surfaces
can be looked at before being called done. It refuses to run unless the daemon reports a fixture
workspace, because agent definitions, capabilities and profiles are filesystem-canonical and a
Redis database alone does not isolate them.

ADR 0019 closed the last two of those domains. `#/capabilities` renders the registered inventory —
every package with its kind, scope, source, and compatible agent kinds, and every profile with the
capabilities it names resolved to their real names. A profile reference with no match is reported
as beyond the loaded page or as not registered, which are opposite facts, and as unresolvable when
the catalogue read itself failed. `#/config` renders the native-configuration chain in the order a
reader needs it: drift first, classified from its two recorded hashes as an edit, a removal, an
unexpected file, or nothing at all; then plans with the redacted diff the daemon produced; then the
snapshots, where a file that did not exist before the apply is marked as such, because undoing that
apply is a delete and not a restore. Neither route offers any control that plans, approves,
applies, rolls back, assigns, or rescans.

Every read-only domain the 2026-08-09 audit listed now has a dashboard consumer.

Dashboard mutations, optimization accept/reject/evaluate, lifecycle/release scoring, release
readiness, unified search, GitHub integration, prompt injection, tasks, leases, semantic knowledge
graph, memory federation, cloud accounts, and authentication are not implemented.

## Architecture and security

Redis is the only runtime datastore. It is the operational database, durable event bus,
coordination fabric, and projection store. Git and the local filesystem are canonical only
for source code and configuration.

Only the daemon receives Redis credentials. HTTP and WebSocket clients use the versioned
local API. The daemon:

- accepts only `HOST=127.0.0.1`;
- validates exact loopback `Host` and browser/WebSocket `Origin` values;
- rejects wildcard origins and `Origin: null`;
- does not log Redis URLs, secrets, complete prompts, or unbounded payloads;
- acquires a TTL-backed single-daemon owner lease before bootstrap mutation.

After `pnpm build`, the daemon serves Pulse at `http://127.0.0.1:4782/`. For frontend
development, start the daemon with
`LUWI_ALLOWED_ORIGINS=http://127.0.0.1:4782,http://localhost:4782,http://127.0.0.1:4783`, then
run `pnpm dev:dashboard` in a second terminal. Vite binds to `127.0.0.1:4783`; `/api` proxies
HTTP and WebSocket traffic to `127.0.0.1:4782`, while `/health` proxies HTTP only. The
proxy normalizes only the upstream Host; the browser Origin is still validated exactly. The
development origin is explicit and is not part of production defaults. See the [Phase 5 dashboard architecture](docs/phase5-dashboard-architecture.md),
[realtime contract](docs/phase5-dashboard-realtime-contract.md), and
[capability matrix](docs/phase5-dashboard-capability-matrix.md).

Redis Streams are durable and recoverable. WebSocket delivery is best-effort realtime
delivery: an `XACK` confirms validated relay processing and queue acceptance, not browser
rendering or network receipt. Clients obtain current project/session snapshots after
connecting.

See [the architecture overview](docs/architecture/overview.md), [ADR
0004](docs/decisions/0004-redis-only-local-runtime.md), and [ADR
0005](docs/decisions/0005-redis-native-operational-core.md). Phase 3 configuration safety
and inheritance are defined by [ADR 0007](docs/decisions/0007-filesystem-canonical-agent-config.md)
and [ADR 0008](docs/decisions/0008-capability-scope-and-inheritance.md).
Phase 4 graph, optimization, and local Git boundaries are defined by [ADR
0009](docs/decisions/0009-event-derived-operational-graph.md), [ADR
0010](docs/decisions/0010-context-optimization-feedback-loop.md), and [ADR
0011](docs/decisions/0011-local-git-observation-and-attribution.md). The code-structure observer,
its parser dependency, and the alternatives rejected for it are recorded in [ADR
0012](docs/decisions/0012-code-structure-observer.md). The bounded global graph summary, and the
alternatives rejected for it, are recorded in [ADR
0013](docs/decisions/0013-bounded-global-graph-summary.md), and the projection-input gaps it
left behind — with the two that were deliberately not built — in [ADR
0014](docs/decisions/0014-complete-graph-projection-inputs.md).

## Prerequisites

- Node.js 22 or newer;
- pnpm 11;
- Git;
- standard Redis 7 or newer through `REDIS_URL`.

Docker is optional. `compose.yaml` provides standard Redis with AOF and a persistent volume.

## Install

```text
pnpm install --frozen-lockfile
```

The daemon reads environment variables directly; it does not load a real `.env` file. Copy
the relevant values from `.env.example` into your shell or process manager.

Defaults:

```text
HOST=127.0.0.1
PORT=4782
REDIS_URL=redis://127.0.0.1:6379
LOG_LEVEL=info
WORKSPACE_ID=local
```

`LUWI_HOME` and `LUWI_NATIVE_HOME` are optional. Normal operation uses `~/.luwi` and the OS
home. Tests and the Phase 3 demo set both to temporary sandbox roots.

Remote binding is intentionally unsupported in local mode.

## Start Redis

With Docker:

```text
docker compose up -d redis
docker compose ps
```

The service publishes only `127.0.0.1:6379`, enables `appendonly yes` with
`appendfsync everysec`, and stores `/data` in `luwi-redis-data`. `docker compose down` keeps
the volume.

An existing standard Redis server also works:

```text
REDIS_URL=redis://127.0.0.1:6379
```

Do not expose Redis on a non-loopback interface.

## Run on Windows PowerShell

Windows native-probe cleanup uses validated canonical paths under the canonical Windows
system directory for `cmd.exe`, `taskkill.exe`, and the fixed non-interactive process-snapshot
PowerShell helper. It never falls back to a same-named program on `PATH`. A timed-out or
output-limited probe has a five-second total cleanup budget: taskkill alone is not success;
the runner must verify that the root and all known descendants are absent, or return
`failure: cleanup`. The reusable early-root-close stress proof runs 25 iterations by default:

```powershell
pnpm test:windows-cleanup-stress
```

Terminal 1:

```powershell
$env:REDIS_URL = "redis://127.0.0.1:6379"
pnpm --filter @luwi/daemon dev
```

Terminal 2:

```powershell
Invoke-RestMethod http://127.0.0.1:4782/health
pnpm --filter @luwi/cli dev runtime
```

## Run on macOS or Linux

Terminal 1:

```sh
export REDIS_URL=redis://127.0.0.1:6379
pnpm --filter @luwi/daemon dev
```

Terminal 2:

```sh
curl --fail-with-body http://127.0.0.1:4782/health
pnpm --filter @luwi/cli dev runtime
```

## CLI examples

```text
pnpm --filter @luwi/cli dev project register --name "LUWI Runtime" --path .
pnpm --filter @luwi/cli dev project list
pnpm --filter @luwi/cli dev project get <projectId>

pnpm --filter @luwi/cli dev session register --project <projectId> --agent codex-sim --working-directory .
pnpm --filter @luwi/cli dev session list --online
pnpm --filter @luwi/cli dev session heartbeat <sessionId>
pnpm --filter @luwi/cli dev session status <sessionId> tool_running
pnpm --filter @luwi/cli dev session close <sessionId>

pnpm --filter @luwi/cli dev message ask --source <sourceSessionId> --target-agent gemini-sim --kind question --content "Project status?" --wait-ms 30000
pnpm --filter @luwi/cli dev message list --project <projectId>
pnpm --filter @luwi/cli dev message get <correlationId>
pnpm --filter @luwi/cli dev message await <correlationId> --wait-ms 30000

pnpm --filter @luwi/cli dev inbox claim --session <targetSessionId> --bridge-instance manual-1
pnpm --filter @luwi/cli dev message acknowledge <correlationId> --session <targetSessionId>
pnpm --filter @luwi/cli dev message processing <correlationId> --session <targetSessionId>
pnpm --filter @luwi/cli dev message respond <correlationId> --session <targetSessionId> --answer "Simulated answer."

pnpm --filter @luwi/cli dev session bridge simulate --session <targetSessionId> --bridge-instance gemini-bridge --mode status-responder

pnpm --filter @luwi/cli dev events list --limit 100
pnpm --filter @luwi/cli dev events watch

pnpm --filter @luwi/cli dev agent detect
pnpm --filter @luwi/cli dev agent list
pnpm --filter @luwi/cli dev project agent effective <projectId> <agentId>
pnpm --filter @luwi/cli dev capability list --project <projectId>
pnpm --filter @luwi/cli dev profile list
pnpm --filter @luwi/cli dev config inspect --body '{"agentId":"codex-main","projectId":"<projectId>"}'
pnpm --filter @luwi/cli dev context footprint <projectId> codex-main

pnpm --filter @luwi/cli dev usage summary --project <projectId>
pnpm --filter @luwi/cli dev context analyze --project <projectId> --agent codex-main
pnpm --filter @luwi/cli dev git scan --project <projectId>
pnpm --filter @luwi/cli dev package scan --project <projectId>
pnpm --filter @luwi/cli dev graph rebuild
pnpm --filter @luwi/cli dev graph neighbors project <projectId> --direction out
pnpm --filter @luwi/cli dev optimize analyze --project <projectId> --agent codex-main
```

`agentId` is a validated opaque logical identifier. Session registration does not require or
create an AgentDefinition record.

The complete two-session acceptance walkthrough is in [the Phase 1 demo
guide](docs/guides/phase-1-demo.md).

The Phase 2 request/reply and MCP walkthrough is in [the Phase 2 demo
guide](docs/guides/phase-2-agent-communication-demo.md).

The sandboxed Phase 3 walkthrough, including Phase 1/2 regressions and uncertain Redis
completion recovery, is in [the Phase 3 demo
guide](docs/guides/phase-3-agent-capability-demo.md). After `pnpm build`, run
`pnpm demo:phase3` against an explicit local Redis test URL.

The Phase 4 temporary-repository intelligence and optimization walkthrough is in [the Phase
4 demo guide](docs/guides/phase-4-intelligence-demo.md). After `pnpm build`, run
`pnpm demo:phase4`. It labels all telemetry as simulated, applies configuration only through
an explicitly approved Phase 3 plan, and cleans its run-specific Redis/filesystem state.

### MCP server

The MCP server is a stdio process bound to one existing online LUWI session:

```text
LUWI_DAEMON_URL=http://127.0.0.1:4782
LUWI_SESSION_ID=<registeredSourceSessionId>
LUWI_MCP_REQUEST_TIMEOUT_MS=30000
pnpm --filter @luwi/mcp-server dev
pnpm --filter @luwi/mcp-server harness
```

It exposes project/session discovery, ask/await/get, durable inbox claim, responder tools,
and project-bounded read-only AgentDefinition/capability/effective-config/context/drift,
usage, Git, package, technology, graph, and optimization-inspection tools. A bounded
optimization-analysis request is available, but proposal acceptance, plan approval/apply,
rollback, graph rebuild, and Git mutation are not exposed. The server never connects to
Redis, accepts a source/responder override for bound mutations, or starts for a missing,
offline, or terminal bound session. It revalidates that binding before every tool
operation. Build first, then pass a tool name and JSON object to `harness` for a concrete
stdio test.

Every tool advertises and validates an output schema. Successful results use MCP
`structuredContent` plus a concise bounded text summary; project and session discovery
results are capped at 100 entries and explicitly report truncation.

## HTTP and WebSocket API

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
GET  /api/v1/messages/:correlationId/wait?waitMs=30000
POST /api/v1/messages/:correlationId/acknowledge
POST /api/v1/messages/:correlationId/processing
POST /api/v1/messages/:correlationId/respond
POST /api/v1/messages/:correlationId/reject
POST /api/v1/messages/:correlationId/fail
POST /api/v1/sessions/:sessionId/inbox/claim

GET/POST/PATCH /api/v1/agents...
GET/POST/PATCH/DELETE /api/v1/projects/:projectId/agents...
GET/POST/PATCH /api/v1/capabilities...
GET/POST/PATCH /api/v1/profiles...
GET /api/v1/projects/:projectId/agents/:agentId/effective-config
POST /api/v1/config/{inspect,import-plan,render-plan,reconcile}
GET/POST /api/v1/config/{plans,snapshots,drift}...
GET/POST /api/v1/context...

POST /api/v1/usage
GET  /api/v1/usage
GET  /api/v1/usage/summary
GET/POST /api/v1/context/contributions
GET  /api/v1/context/summary
POST /api/v1/context/analyze
GET/POST /api/v1/projects/:projectId/git...
GET/POST /api/v1/projects/:projectId/packages...
GET  /api/v1/projects/:projectId/technologies
GET/POST /api/v1/graph...
GET/POST /api/v1/optimization...
```

`POST /api/v1/projects` returns `409 PROJECT_ALREADY_REGISTERED` and a `Location` header
when the same canonical local path already exists. It never merges metadata on conflict.

Only runtime state `ready` accepts mutations. Redis or ownership loss changes the runtime to
`degraded`; health returns 503 and mutations return `RUNTIME_NOT_READY` until owned recovery
finishes. Projection/history reads also return 503 while current Redis state is unavailable.

## Development and verification

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

Integration tests never choose a developer Redis implicitly. Use a dedicated Redis server
when possible. A dedicated database on a disposable local server can be enabled explicitly:

PowerShell:

```powershell
$env:LUWI_TEST_REDIS_URL = "redis://127.0.0.1:6379/15"
$env:LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS = "true"
pnpm test:integration
```

macOS/Linux:

```sh
LUWI_TEST_REDIS_URL=redis://127.0.0.1:6379/15 \
LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS=true \
pnpm test:integration
```

Redis Function libraries are server-scoped rather than database-scoped. The override is
therefore required when the test server is shared. Tests use run-specific keys and Function
names, never call `FLUSHDB`/`FLUSHALL`, and clean only their own state.

## Persistence and retention

The global Stream is `luwi:v1:events:global`; each project has
`luwi:v1:events:project:{projectId}`. Transition Functions do not trim Streams. A periodic
retention service applies configurable approximate limits.

Each session has `luwi:v1:inbox:session:{sessionId}` and group
`luwi-session-inbox-v1`. Inbox entries remain pending until a terminal message transition;
retention defers while the group has pending work or lag. Terminal projections are retained
for seven days by default, idempotency indexes for one day, and inboxes are bounded to
10,000 entries only when recovery metadata is safe.

For standard Redis versions before 8.2, global trimming occurs only when the realtime group
reports valid metadata, zero pending entries, zero lag, and a healthy relay. Otherwise LUWI
defers trimming so recoverable entries are not destroyed. Project and dead-letter Streams
have independent bounds.

AOF with `everysec` improves local durability but is not a backup and may lose roughly the
most recent second during a host failure.

Native-config snapshots are local filesystem artifacts rather than Redis values. Completed
snapshots are bounded to 50 by default and can be configured with
`LUWI_CONFIG_SNAPSHOT_RETENTION_COUNT`. Pruning considers only validated LUWI snapshot
manifests; incomplete or foreign directories are left for manual review.

Global and project imports use the same approved, snapshotted file engine as native renders.
Global imports update AgentDefinition defaults; project imports update agent-specific
project-manifest defaults. On owned startup, canonical AgentDefinitions, capabilities,
profiles, capability bindings, and project-agent bindings are validated and used to rebuild
missing or stale Redis projections before the runtime becomes ready.

Phase 4 raw usage observations default to 30 days, superseded Git observations to 100 per
project, and graph generations to the active/newest safe pair. Retention preserves
source-separated usage aggregate totals, source-event deduplication, optimization
baselines/evaluations, active graph metadata, and normalized Stream provenance. Supported
global/project/agent/session aggregate summaries survive raw-record cleanup; arbitrary time,
capability, or combined filters cover at most 1,000 retained raw records and return an
explicit unsupported-filter error if that bounded summary would be incomplete. Raw lists
report truncation. Responses expose the earliest retained usage observation rather than
claiming unavailable history is complete.

Package inventory canonicalizes the project root and each candidate manifest before opening
it. After opening, LUWI canonicalizes and contains the candidate again, compares non-zero
bigint `dev` and `ino` identity from the handle and final path, then reads the validated handle
in 64 KiB chunks up to 2 MiB plus one detection byte. Symlinks and junctions that resolve
outside the root, ABA identity changes, broken links, directory targets, unsupported identity,
and files that start or grow oversized fail closed. In-root links to a stable regular file
remain readable; scanners still never execute package managers or project code.

## Package boundaries

- `@luwi/protocol`: validated versioned wire schemas and event envelopes.
- `@luwi/runtime`: Redis-independent paths, status/readiness, usage aggregation, Git
  attribution, graph query policy, structural findings, and evaluation.
- `@luwi/adapters`: passive native-agent adapters and deterministic file proposals.
- `@luwi/redis`: Redis client boundary, keys, Functions, repositories, Streams, ownership,
  retention, and recovery primitives.
- `@luwi/daemon`: lifecycle, security, HTTP/WebSocket transport, relay, and sweeper.
- `@luwi/cli`: local HTTP/WebSocket client and simulations.
- `@luwi/mcp-server`: official-SDK stdio adapter over loopback daemon HTTP.

No separate packages exist for IRIS, sessions, lifecycle, metrics, memory, Git
intelligence, or graphs. Those features remain modules inside existing boundaries until real
consumers prove a package split.

## Roadmap disclaimer

Phase 5B is limited to tested read-only Pulse, native realtime invalidation, bounded Activity,
and supported inspectors. Lifecycle/release intelligence, leases, global search,
ACP, GitHub, and mutation surfaces remain deferred. Future work must not bypass daemon-owned
Redis access, execute discovered code, convert unknown evidence to non-use, or describe
estimates/correlations as exact facts.
