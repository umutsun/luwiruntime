# CLI-First MVP Completion Design

**Date:** 2026-08-24  
**Status:** Approved for implementation

## Goal

Bring LUWI Runtime to a locally usable MVP through one explicit CLI-first path while
preserving its standalone character:

> Start the local runtime, launch a native coding agent through an optional LUWI wrapper,
> observe the session and its capabilities, coordinate it through one bounded message
> action, and stop only the resources LUWI owns.

The first supported native agent commands are Claude Code, Codex, and Gemini CLI. They
remain independent tools. LUWI observes and coordinates them; it does not replace,
impersonate, embed, or require them.

## Architectural boundary

The MVP stays inside the current package graph:

- `@luwi/cli` owns lifecycle commands and explicit agent wrappers;
- `@luwi/runtime` owns self-healing session bootstrap policy and state-independent domain
  behavior;
- `@luwi/adapters` owns passive native identity and capability observation;
- `@luwi/daemon` remains the composition root and the only Redis-facing application;
- `@luwi/dashboard` adds only the bounded Ask-agent coordination action;
- `@luwi/protocol` changes only when a versioned wire contract is genuinely required;
- `@luwi/redis` remains the only package that imports the Redis client.

No new package, framework, datastore, agent orchestration service, background supervisor, or
Redis module is introduced. Redis remains the only operational datastore and runs locally
through the existing Docker Compose service by default.

## CLI product surface

The MVP exposes this primary surface:

```text
luwi doctor
luwi setup
luwi start
luwi status
luwi stop [--with-redis]
luwi agent run claude -- <native arguments>
luwi agent run codex -- <native arguments>
luwi agent run gemini -- <native arguments>
```

Existing expert and diagnostic commands remain available. The new commands provide the
recommended golden path rather than hiding or removing existing functionality.

### `luwi doctor`

`doctor` is read-only. It reports machine-readable and human-readable checks for:

- supported Node.js and pnpm versions;
- Docker and Docker Compose availability;
- Redis reachability and Redis Functions support;
- configured daemon and Redis loopback endpoints;
- required ports and current listeners;
- daemon health and protocol compatibility;
- Claude, Codex, and Gemini executable discovery;
- canonical LUWI and native-agent configuration roots.

Checks distinguish `ok`, `warning`, and `error`, include a safe remediation hint, and never
print secrets, environment dumps, connection credentials, or native config contents.

### `luwi setup`

`setup` prepares only LUWI-owned, secret-free local configuration. Before any write it shows
the target and proposed change, requires explicit approval unless a deliberately scoped
non-interactive approval flag is supplied, and uses canonical filesystem paths.

It does not create a real `.env`, edit native Claude/Codex/Gemini files, change Docker or
Redis configuration, or delete existing state. Optional native integration snippets are
printed with `--print-hooks`; the user applies them manually.

### `luwi start`

`start` performs a bounded, idempotent startup sequence:

1. validate the loopback-only configuration;
2. start the existing Compose Redis service when the configured Redis endpoint is the
   Compose-managed local default;
3. wait for Redis readiness and required Function compatibility;
4. start one daemon child owned by this LUWI installation;
5. wait for a healthy daemon response;
6. report the resulting endpoints and ownership state.

An already healthy compatible runtime is success, not an error. A port conflict, foreign
daemon, incompatible runtime, or unavailable external Redis produces a bounded safe failure.
The command never kills an unverified process.

### `luwi status` and `luwi stop`

`status` combines daemon health, Redis health, Compose state, and verified owned-process
metadata without treating an old PID file as proof of ownership.

`stop` gracefully stops only the daemon whose ownership can be verified. Redis remains
running by default so AOF-backed local state stays warm. `stop --with-redis` additionally
stops the existing Compose service without deleting its named volume. Neither form removes
data, images, configuration, or foreign processes.

## Explicit agent wrappers

The wrapper is optional and transparent. A native agent must remain usable without LUWI.

For each `agent run` command, the CLI:

1. resolves the executable, canonical working directory, and LUWI project identity;
2. attempts a bounded daemon connection and session registration;
3. launches the native agent with inherited stdio and its native arguments;
4. adds only bounded LUWI context such as `LUWI_SESSION_ID` and the loopback daemon URL to
   the child environment;
5. maintains session heartbeats while the child runs;
6. forwards termination signals and cleans up only its verified child process tree;
7. closes the LUWI session when the native process exits.

If LUWI is unavailable or registration fails, the wrapper reports degraded observation and
still launches the requested native agent. LUWI failure must not block coding work.

### Self-healing session behavior

Transient heartbeat failures use bounded exponential backoff. If the daemon reports that
the session is missing, terminal, or disconnected, the wrapper re-registers a visible LUWI
session and resumes heartbeats.

The already-running native child environment cannot be changed. A replacement session ID is
therefore used for observation only; LUWI MCP binding that depends on `LUWI_SESSION_ID`
requires restarting the native agent. The CLI reports this limitation explicitly. It does
not introduce a hidden proxy, second datastore, prompt injection, or terminal manipulation
to conceal the boundary.

### Native identity

A wrapper declares native session identity only when deterministic evidence is available.
Claude, Codex, and Gemini integrations are validated independently; a guessed or ambiguous
identifier is never persisted. An unresolved identity remains visible as an unbound LUWI
session with evidence explaining why it is unresolved.

The MVP does not build a generalized agent manager. Resume semantics, fleet supervision,
automatic native configuration, and provider-specific orchestration are deferred.

## Passive capability observation

The existing adapter model is completed with `LUWI_CAPABILITY_ROOTS` support and known
global/project-local roots for Claude, Codex, and Gemini. Scanning is read-only and uses
injected filesystem collaborators.

Observed capabilities:

- retain an explicit `observed` provenance distinct from assigned, effective, loaded, and
  invoked state;
- never overwrite declared or filesystem-canonical LUWI capability definitions;
- never execute skills, hooks, plugins, scripts, MCP servers, package managers, or discovered
  commands;
- validate and bound paths, file sizes, entry counts, recursion, and elapsed time;
- report malformed, inaccessible, ignored, and truncated entries rather than converting
  missing evidence into absence;
- preserve project scope and native-agent source in projections and Pulse.

## Pulse Ask-agent action

Pulse remains observation-first. Its only additional coordination mutation in this MVP is
an Ask action backed by the existing durable request/reply protocol.

The action:

- is available only for an online target session in the same project;
- sends bounded subject, content, and deadline values through the existing daemon message
  endpoint;
- derives or selects a valid LUWI source session rather than inventing agent identity;
- disables duplicate submission while a request is in flight and supplies a daemon-side
  idempotency key;
- navigates successful submission to the Messages view with the correlation identifier;
- displays safe validation, offline-target, timeout, and daemon-unavailable failures.

It does not acquire leases, assign tasks, optimize context, mutate Git, apply configuration,
inject a prompt into a terminal, or add further dashboard mutations.

## Failure isolation and recovery

All startup, network, scan, child-process, and shutdown operations are bounded. Error
messages use safe codes and remediation hints without stack traces or credentials.

Key recovery rules are:

- agent execution continues when LUWI observation is degraded;
- daemon ownership is verified before stop or cleanup;
- Redis state and the Compose volume survive normal stop;
- partial startup rolls back only resources started and owned by the current command;
- duplicate start, stop, message, heartbeat, and close operations are idempotent where the
  domain permits;
- corrupted local ownership metadata causes a refusal or warning, never an unverified kill;
- capability scan failures degrade the observation result, not daemon readiness or agent
  execution.

## Delivery sequence

Implementation proceeds as six vertical increments, leaving the repository runnable after
each one:

1. self-healing session bootstrap;
2. Claude/Codex/Gemini agent runner;
3. passive capability observation;
4. `doctor`, `setup`, `start`, `status`, and `stop` lifecycle;
5. Pulse Ask-agent action;
6. golden-path verification, operational documentation, and release gates.

Each increment receives its own implementation plan and test-first execution. Scope discovered
outside an increment is recorded for later instead of being folded into a generic framework.

## Validation strategy

Unit and component tests use injected clocks, daemon clients, process runners, filesystem
collaborators, and scripted native executables. They cover:

- bootstrap registration, retry, re-registration, cancellation, and terminal state handling;
- wrapper argument fidelity, inherited stdio, degraded launch, heartbeat lifecycle, signal
  forwarding, exit-code preservation, and verified process cleanup on Windows;
- deterministic native identity success and unresolved cases for all three agents;
- capability-root precedence, provenance, bounds, malformed input, and proof of no execution;
- lifecycle readiness, idempotency, foreign-process refusal, partial rollback, Compose
  command construction, and volume-preserving stop;
- Ask validation, same-project/online constraints, idempotency, navigation, and safe errors.

Redis behavior continues to use opt-in integration tests with `LUWI_TEST_REDIS_URL`, a
dedicated database, a unique run prefix, and current-run-only cleanup. A final live smoke
test uses the user's locally installed Claude, Codex, and Gemini CLIs without requiring
automated prompt injection or credentials in test output.

Every increment must pass its focused tests. MVP completion additionally requires successful
format, lint, typecheck, full unit test, applicable Redis integration test, and build gates.

## MVP acceptance

On a supported local machine with Node, pnpm, Docker, and at least one supported native agent:

1. `luwi doctor` identifies readiness or gives actionable safe remediation;
2. `luwi start` brings the Compose Redis and daemon to healthy loopback-only state;
3. `luwi agent run <agent> -- ...` preserves the native terminal experience;
4. the session and passively observed capability state appear in Pulse;
5. heartbeat interruption and daemon restart recover visible session observation;
6. Pulse can send one durable Ask request to an eligible same-project session;
7. `luwi status` reports the combined runtime state;
8. `luwi stop` stops the owned daemon while retaining Redis, and
   `luwi stop --with-redis` stops Compose Redis without deleting data.

The README and operator guide describe prerequisites, the golden path, degraded behavior,
Docker/AOF persistence, recovery, security boundaries, native identity limits, and exact
non-goals honestly.

## Explicit non-goals

- No cloud service, account, authentication, tenant, or remote binding.
- No autonomous task orchestration, agent fleet manager, prompt router, or terminal injection.
- No additional datastore, vector store, queue, search engine, or Redis Stack module.
- No automatic native-agent file edits, MCP installation, hook installation, or config apply.
- No Git mutation, worktree orchestration, GitHub integration, or release scoring.
- No exact token claims without native evidence and no inference that an unobserved capability
  is unused.
- No generalized plugin runtime or provider abstraction beyond the three explicit MVP
  wrappers.
