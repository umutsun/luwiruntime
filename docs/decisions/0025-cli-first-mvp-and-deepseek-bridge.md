# ADR 0025: CLI-first MVP, runtime reset, capability observation, and the DeepSeek ACP bridge

Status: Accepted  
Date: 2026-09-01

## Context

`AGENTS.md` §1 promises a runtime that lets a developer "see every project, coordinate every agent,
ship without collisions". ADR 0024 closed the first clause for clients that register themselves, and
ADRs 0022/0023 built the identity and attribution machinery behind them. What was still missing was
an ordinary way to _reach_ any of it: there was no first-class command to start the runtime, wrap a
native agent, observe the skills that agent actually carries, reset operational state for a clean
reinstall, or drive a single bounded coordination action from the dashboard.

Between 2026-08-24 and 2026-08-25 that surface was designed and built as one tranche against four
written specifications, then verified green (148 test files / 1452 tests, typecheck and lint clean)
on 2026-09-01 before it was committed. This ADR is the retro-record §16 and §21 require: it names the
architecture the tranche introduced, states what it deliberately does not do, and resolves the two
plan collisions the tranche exposed. Nothing here approves new work — it records what was approved in
the four specs and built under them.

The four specifications this ADR consumes, and cites rather than restates where they already decide:

- `docs/superpowers/specs/2026-08-24-cli-first-mvp-design.md` (lifecycle, agent wrappers, capability
  observation, the Pulse Ask action, and the explicit non-goals);
- `docs/superpowers/specs/2026-08-24-deepseek-acp-bridge-design.md` (the experimental ACP bridge);
- `docs/superpowers/specs/2026-08-25-cli-runtime-reset-project-discovery-design.md` (runtime reset
  and project discovery);
- `docs/superpowers/specs/2026-08-25-dashboard-detail-drawer-spacing-design.md` (the modal detail
  drawer).

Two of those specs made decisions that collide with earlier plans, so this ADR must resolve them
rather than let the tree diverge silently (owner decision G1, 2026-09-01):

1. The 2026-08-24 CLI-first spec adds one bounded dashboard mutation (the Pulse Ask action). The
   2026-08-25 detail-drawer spec's non-goals still say "No dashboard mutation is added." Both were
   in flight at once; the Ask flow is built, tested, and documented.
2. The 2026-08-25 detail-drawer spec replaces the docked Inspector column that the 2026-08-14
   dashboard redesign (phase 2) had introduced as grid track three.

## Decision

The tranche stays inside the current package graph — no new package, datastore, Redis module,
background supervisor, or provider abstraction — exactly as the CLI-first spec's "Architectural
boundary" section requires. `@luwi/redis` remains the only package that imports the Redis client;
`@luwi/cli` never connects to Redis.

### 1. A CLI-first lifecycle surface, with a token-gated remote stop

`luwi doctor|setup|start|status|stop|reset` is the recommended golden path; the existing expert
commands remain. The command logic lives in `apps/cli/src/lifecycle.ts` (a `LifecycleService`), and
`apps/cli/src/cli.ts` wires argv to it — the `reset` command invokes `resetRuntimeState()`; the other
five map one-to-one. `start` is bounded and idempotent, `stop` verifies daemon ownership before
stopping and never kills an unverified process, and a failed registration never blocks the native
agent (CLI-first spec, "CLI product surface" and "Failure isolation and recovery").

`stop` needs the daemon to shut itself down, so `POST /api/v1/runtime/stop` exists — but a stop
endpoint that anyone on loopback can call is a denial-of-service primitive. It is therefore gated: a
daemon not started by the lifecycle CLI answers `DAEMON_LIFECYCLE_UNMANAGED` (403), and a caller
whose `x-luwi-lifecycle-token` header does not match the managed daemon's ownership token answers
`DAEMON_LIFECYCLE_FORBIDDEN` (403). The comparison is constant-time (`timingSafeEqual` behind a
length guard), so the token cannot be recovered by timing. This is the only remote-lifecycle write,
and it changes no §4 loopback rule.

### 2. Runtime reset as a daemon-boundary maintenance entry, over the `luwi:v1:` namespace only

A clean reinstall must clear LUWI operational state without treating a shared Redis database as
disposable — other local apps may use the same listener (runtime-reset spec, "Context" and
"Non-goals": no `FLUSHDB`/`FLUSHALL`, no volume or container deletion, no recursive scan). The reset
logic (`resetRuntimeNamespace`/`inspectRuntimeNamespace` in `packages/redis/src/runtime-reset.ts`)
does a bounded, cursor-based `SCAN` and batched `UNLINK`, and revalidates `key.startsWith(namespace)`
on every key before it can enter a deletion batch. The namespace is a **parameter**, and the
compile-time constant `PRODUCTION_RUNTIME_NAMESPACE = 'luwi:v1:'` lives in the sole production caller,
`apps/daemon/src/runtime-reset-main.ts` — the daemon boundary, the only application allowed to depend
on `@luwi/redis`. The CLI validates lifecycle state and confirmation, then launches that bounded
maintenance entry; it never becomes a Redis client itself.

Reset preserves `LUWI_HOME`, the filesystem-canonical project manifest, AgentDefinitions, `.luwi`
manifests, and native agent configuration. So the tranche also completed the missing prerequisite:
owned-startup reconciliation now restores project projections from canonical manifests _before_
rebuilding project-scoped bindings, failing readiness with `CONFIG_RECONCILIATION_REQUIRED` on a path
or identity conflict. To keep that restore timestamp-faithful, `project_register` in the function
library now accepts caller-supplied `createdAt`/`updatedAt` (strictly both-or-neither, non-empty),
defaulting to the server clock when absent.

**The function library stays at version 12.** The registry rule (`function-registry.ts`) moves the
version only on a record-shape change; the stored project hash writes the same field set it always
did — `createdAt`/`updatedAt` already existed — and only the _source_ of those values changed. A
value-source change is not a shape change, so the version correctly did not move. (v12 itself was
B1's usage-record change, which added two fields.) No `XGROUP` or stream is created by reset.

### 3. Passive, one-level, dry-run-first project discovery

`luwi project discover <absolute-root>` reads only the immediate directory entries of a canonicalized
root — non-recursive, following no entry whose resolved path escapes the root, reading no file
contents to classify a directory (so a deliberately non-Git project is still discoverable). It is a
dry run by default; `--apply` submits selected projects through the existing versioned daemon HTTP
API (`POST /api/v1/projects`, then `POST /api/v1/projects/{id}/git/scan`), classifying each as
registered, unchanged, conflict, or failed and never overwriting conflicting facts. The plan-building
service is `apps/cli/src/project-discovery.ts`; the command, the dry-run/apply branch, and the HTTP
submission are in `cli.ts`. Discovery writes no project, Git, or `.luwi` file itself, and never
touches Redis (runtime-reset spec, "Project discovery architecture").

### 4. Read-only capability observation feeding a real `capabilities/scan` mutation

The adapter model is completed so the catalogue can describe the machine rather than a seed.
`packages/adapters/src/capability-observer.ts` scans declared roots read-only — it opens manifests
`'r'`, lists directories, canonicalizes paths, parses `SKILL.md` frontmatter, and executes nothing it
finds (no skill, hook, plugin, script, or MCP definition), per §12/§18. Every record it produces
carries `managementMode: 'observed'`, distinct from declared/assigned/effective/loaded/invoked, so a
scanned capability can never overwrite a registered one. The observer takes its roots as an argument;
`LUWI_CAPABILITY_ROOTS` is read in `apps/daemon/src/config.ts` and threaded through the control-plane
service, where it becomes the `luwi-configured-roots-v1` root source _alongside_ the native roots
(e.g. `.claude`, `claude-code-native-v1`) the daemon always adds.

`POST /api/v1/capabilities/scan` was converted from a disguised read into a genuine `withMutation`:
it serializes a write, calls `repository.putCapability` and emits `capability.registered` /
`capability.updated` events for each observation (refusing a conflict with a non-observed record into
`conflictsSkipped`), and returns a `capabilityScanResponseSchema` result whose diagnostics report
roots scanned/unavailable, malformed manifests, ignored entries, and truncation (CLI-first spec,
"Passive capability observation").

### 5. A second dashboard write module for the bounded Ask flow (supersession)

Pulse stays observation-first with exactly one added coordination mutation: an Ask action for an
online, same-project target, sending a bounded `question` through the existing durable request/reply
protocol with a daemon-side idempotency key and navigating to the correlation on success (CLI-first
spec, "Pulse Ask-agent action"). It acquires no lease, assigns no task, injects no terminal text, and
adds no further dashboard mutation.

`apps/dashboard/src/api/message-mutations.ts` owns exactly `POST /api/v1/messages` for that flow.
This **supersedes ADR 0021's allowlist-of-one and the 2026-08-05 audit's "no mutation buttons" line,
for this one flow only.** `product-independence.test.ts` now allowlists two modules —
`config-mutations.ts` and `message-mutations.ts` — and still forbids the prohibited operations
everywhere, including inside both allowlisted modules (proposals accept/reject/evaluate, graph
rebuild, `config/reconcile`, and Git commit/checkout/push). The 2026-08-25 detail-drawer spec's "No
dashboard mutation is added" non-goal is **superseded** by the 2026-08-24 CLI-first spec's Ask flow;
this ADR resolves that collision in favour of the Ask flow (owner decision G1).

### 6. A modal detail drawer replaces the docked Inspector column (supersession)

List-to-detail surfaces now open in one right-side overlay `DetailDrawer`
(`apps/dashboard/src/components/detail-drawer.tsx`): `role="dialog"`, `aria-modal="true"`,
`aria-labelledby`, initial focus on the close control, a Tab focus trap, Escape and backdrop close,
focus restoration to the opener, and a portal above the shell. The shell keeps two layout tracks —
navigation rail and main content — with no permanent Inspector track; `shell.test.ts` pins
`grid-template-columns: var(--rail-width) minmax(0, 1fr)` and asserts no `--inspector-width` token
survives (detail-drawer spec, "Chosen Interaction" and "Component Design").

This **supersedes the 2026-08-14 redesign's phase-2 docked third track.** That phase's own
accessibility argument — that `aria-modal` on a permanently visible pane lies to assistive
technology — is satisfied here in the opposite direction: the drawer is genuinely modal, and appears
only when something is selected. The Inspector's content styling is reused inside the drawer; only the
grid track was removed.

### 7. The DeepSeek Harness ACP bridge as an experimental CLI edge adapter

`session bridge deepseek` (`apps/cli/src/deepseek-bridge.ts`, `deepseek-acp-client.ts`) registers one
DeepSeek Harness ACP process as one ordinary LUWI session and declares its native identity with
adapter id `deepseek-harness-acp-v1`. It creates a fresh ACP session only — `newSession({ cwd,
mcpServers: [] })`, no history import, no resume — maps each claimed LUWI request onto one ACP prompt
one at a time, and answers `answered` only on `end_turn` with non-blank output, routing other stop
reasons through the existing reject/fail transitions (bridge spec, "Lifecycle" and "Message
mapping"). It does no ACP-time MCP injection because DeepSeek Harness rejects a non-empty
`mcpServers` (bridge spec, "Permissions and MCP") — the code fact is the empty array; the rationale is
the spec's.

The only new production dependency is the vendor-neutral ACP SDK (`@agentclientprotocol/sdk`, pinned
`0.25.1`), and it appears in `apps/cli/package.json` alone. **No `@luwi/daemon`, `@luwi/runtime`,
`@luwi/protocol`, or `@luwi/redis` imports it or any DeepSeek package.** The bridge uses only the
loopback HTTP API, receives no Redis credentials, and writes no native configuration. It **routes
around**, and does not resolve, the SQLite-store blocker parked on 2026-08-17: it registers a fresh
ACP session rather than importing DeepSeek's on-disk history.

### What this ADR does not approve

It records built work; it authorizes no new work. The next items in the §21 sequence remain
unapproved: **automatic lease renewal** and **autostart**, and beyond them automatic drift
reconciliation (distinct from the interrupted-apply recovery at `POST /api/v1/config/reconcile`),
lifecycle/release scoring, task orchestration, a semantic or vector knowledge graph, memory
federation, GitHub integration, prompt injection, automatic optimization apply, cloud accounts,
authentication, and remote control-plane work. Transcript ingestion for non-Claude vendors is also
not opened: the B1 reader is Claude-format-specific, and the DeepSeek bridge imports no history.

## Consequences

A developer can now run the runtime, wrap a native agent, see the skills that agent carries, ask one
bounded question from Pulse, reset operational state for a clean reinstall, and bridge one DeepSeek
Harness process — all through the CLI and dashboard, without any of it becoming a precondition for the
agent itself. Reset is a real safety boundary: it can only remove keys under `luwi:v1:`, it refuses
while a daemon is running, and a non-LUWI key in the same database survives it (proven by an
integration sentinel). It is not a backup or a factory reset, and it intentionally destroys LUWI
operational history — that is the stated cost.

The two supersessions are now recorded rather than latent. The dashboard's write surface is exactly
two modules, enforced by a test that fails if a third appears or if either writes a prohibited
operation. The docked Inspector is gone from the shell grid and its accessibility contract is honest.
`AGENTS.md` §21 and the 2026-08-14 redesign plan are updated in the same commit that lands this
record, so no reader is left believing the allowlist is one or the Inspector is docked.

The costs and limits are bounded and stated. The DeepSeek bridge is experimental: one session, one
ACP process, fresh sessions only, permissions fail closed, and a Windows shutdown that cannot prove
ownership reports cleanup as unverified rather than claiming success. Capability observation describes
this machine and these vendor layouts; a layout change surfaces as a diagnostic, not as silent
absence. Project discovery handles one directory level and never guesses display-name word
boundaries. The reset namespace and the function-library version are compile-time constants, so a
namespace or record-shape change is a code change with a test, not a runtime surprise. And because the
tranche adds a stop endpoint and a dashboard mutation, both are gated — the stop by an ownership token
compared in constant time, the mutation by the two-module allowlist — so widening either is a
deliberate, reviewable change rather than an accident.
