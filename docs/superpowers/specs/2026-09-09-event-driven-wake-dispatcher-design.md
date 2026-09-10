# Event-driven wake dispatcher design

Date: 2026-09-09. Owner approval: the hybrid design was approved in conversation before this
document was written. This document extends ADR 0031; it does not change the execution boundary
until its implementation plan is separately approved.

## Problem

LUWI already persists requests and responses correctly, but an online interactive coding-agent
session is not an event consumer. Its MCP server is a request-driven stdio child: it can read and
complete a message after the host starts a model turn, but it cannot create that turn. A heartbeat
proves presence only. Consequently a direct message can be queued or delivered while the visible
Codex, Claude, Gemini, or Antigravity conversation remains idle.

ADR 0031 added an unattended native bridge that claims an inbox and starts one fresh headless
process per request. That closes the execution gap only when routing selects the bridge. Today
agent-targeted routing ranks status and heartbeat, so another idle interactive session can still win.
The command is also operator-run, permits arbitrary trailing native arguments, and does not prevent a
second bridge for the same agent and project. Finally, a headless worker can complete a request while
the interactive coordinator that sent it remains asleep and does not see the durable response until a
person starts another turn.

The missing component is therefore a host-side wake dispatcher around the existing durable message
state, not background behavior inside MCP.

## Goals

1. Route `targetAgentId` work to an online native-headless bridge whenever one exists, while
   preserving exact `targetSessionId` semantics and the current no-bridge fallback.
2. Keep at most one supervised bridge active for each project and agent tuple, with
   bounded takeover after process death or machine sleep.
3. Start unattended native agents only from named, validated provider execution profiles. A
   supervised process never forwards arbitrary caller-supplied arguments.
4. Create a durable wake intent when a terminal response is written for a coordinator that declared
   a supported host-wake adapter.
5. Wake a bound Codex conversation through `codex queue`, while retaining the response in the LUWI
   message projection and source inbox when host wake is unsupported, unavailable, or uncertain.
6. Make every bridge and wake outcome observable through read-only daemon APIs and Pulse without
   exposing native conversation identifiers or process-owner tokens.
7. Advance an explicit workflow exactly once after coordinator review, even when a host wake is
   delivered more than once or its delivery result is uncertain.
8. Prove a real cross-agent implementation loop in which Codex delegates to a workspace-writing
   Claude worker, receives verified evidence, and emits one causally linked follow-up task.

## Non-goals

- MCP remains a thin stdio adapter and does not subscribe to Redis, request server-side sampling, or
  attempt to inject a host turn.
- No terminal keystroke injection, window automation, accessibility automation, or vendor-private UI
  protocol.
- The wake dispatcher does not invent work, dependencies, or acceptance decisions. Only a resumed
  coordinator advances an explicitly created workflow through a fenced continuation operation.
- No general dependency scheduler, automatic retry of agent work, or parallel child execution.
- No automatic replay after an external process may have accepted work.
- No claim that Claude, Gemini, or Antigravity can wake an already-open conversation. They remain
  durable-inbox or fresh-headless providers until a measured, supported inbound-turn API exists.
- No unrestricted supervised execution profile. The existing foreground bridge remains available for
  explicit operator experiments, but it participates in the same singleton guard.

## Architecture

```text
coordinator session
  -> create explicit workflow revision 1 + message targeted by agent id
  -> Redis message_request
       -> durable target inbox request
       -> message.requested Runtime event
  -> selectMessageTarget prefers an online metadata.bridge=native-headless session
  -> supervised bridge claims request
       -> delivered -> acknowledged -> processing
       -> one provider process under a validated execution profile
       -> child completes through bound LUWI MCP
  -> Redis terminal message transition
       -> durable source inbox response
       -> message.<terminal> Runtime event
       -> optional durable wake intent + wake.requested Runtime event
  -> wake dispatcher claims intent
       -> resolve historical native binding for the source session
       -> dispatching fence
       -> Codex: codex queue --thread <nativeSessionId> --message <fixed pointer prompt>
       -> dispatched | fallback_only | indeterminate
  -> coordinator turn calls luwi_get_message(correlationId)
  -> coordinator reviews evidence and calls luwi_continue_workflow(expectedRevision, wakeIntentId)
       -> atomically advances the workflow and creates exactly one next message, or completes/blocks
```

Redis remains the operational source of truth. The wake queue is a blocking Stream read through the
daemon, so arrival wakes the dispatcher immediately. Runtime WebSocket events remain UI and latency
hints; correctness never depends on a connected socket. The source response inbox is untouched by
the dispatcher and is always the final fallback.

The execution plane remains in `@luwi/cli`. The daemon validates requests, owns Redis credentials,
and exposes bounded claim and transition routes; it never spawns a coding agent or calls a vendor
CLI.

## Agent-targeted routing

`selectMessageTarget` keeps the direct-session branch first and unchanged. For `targetAgentId`, it
continues to filter to the same project, requested agent, online presence, and non-terminal status.
The comparator then applies these keys in order:

1. `metadata.bridge === "native-headless"` first;
2. the existing status rank;
3. newest heartbeat;
4. lexical session ID.

The bridge marker uses exact string equality. Truthy values, other bridge names, offline sessions,
and terminal sessions receive no preference. If no online native-headless candidate exists, every
candidate ties on the first key and the existing result is preserved. If two bridge sessions are
temporarily visible, the remaining keys make the result deterministic while observability reports
the duplicate.

The stored `selectionReason` says whether native-bridge preference participated, so the message
record explains why a particular session received the request. A caller that needs a particular
interactive conversation continues to use `targetSessionId` and never gets redirected.

## Supervised bridge singleton

### Topology

`luwi wake serve` is one foreground supervisor process. It reads enabled project-agent bindings and
their effective configuration, then owns zero or more in-process native bridge workers. Each worker
reuses `createNativeBridge` and the ordinary bootstrap's heartbeat, rotation, lease-renewal, and
cleanup mechanics; supervision does not add another message execution implementation. Bridge-slot
ownership errors are a new fatal class that the bootstrap must surface to the supervisor instead of
swallowing as a transient registration failure. A worker with no registered session backs off and
never spins around `pollOnce()`.

The lifecycle commands manage the supervisor as a process separate from the daemon:

- `luwi wake start` starts it idempotently and writes the same bounded PID/identity receipt pattern
  used by runtime lifecycle code;
- `luwi wake stop` stops only a process whose receipt and identity still match;
- `luwi wake status` reports process health plus daemon-observed ownership;
- `luwi wake serve` remains the foreground entry used by tests and process launch;
- `luwi setup --wake-autostart` and `--no-wake-autostart` manage a separate per-user Windows logon
  task that invokes `luwi wake start`.

The existing runtime autostart remains independent. The wake task may run first: it waits a bounded
time for the loopback daemon and exits with a clear degraded result if the daemon never becomes ready.
Non-Windows autostart reports `unsupported`, matching ADR 0027; foreground and explicit start remain
portable.

### Slot identity and ownership

A bridge slot is the tuple `(workspaceId, projectId, agentId)`. Provider is a validated attribute of
the owner rather than part of the identity: routing addresses an agent, so a second provider for the
same agent must not create a second worker. The Redis key uses a SHA-256 identifier derived from the
canonical tuple; no user string is interpolated into a key. Before a worker registers a LUWI
session, it acquires the slot through the daemon with a random process-local owner token and a
15-second TTL. It renews every 5 seconds. The token never appears in list APIs, events, logs, or
session metadata.

Acquire, renew, attach-session, release, and expire are compare-and-set Redis Functions. Only the
current token can attach a session, renew, or release. A contender receives `held` with bounded public
metadata and remains standby. Expiry permits takeover but never deletes a newer owner. This is the
same ownership shape as the daemon owner lease, scoped per bridge tuple.

This slot is a distinct primitive. Work leases describe editable paths, native bindings describe a
vendor conversation, and filesystem lifecycle locks can remain stale after a crash; none provides
the fenced compare-and-set ownership required here.

After acquisition the worker registers through a typed bridge-owner declaration containing the slot
ID, owner token, provider, and execution profile. The daemon validates the token against the live
slot, writes the reserved bridge metadata itself, and rejects caller-supplied values for the reserved
`bridge`, `bridgeSlotId`, `provider`, and `executionProfile` keys. Heartbeats cannot replace those
reserved values. The resulting public session metadata is:

```json
{
  "bridge": "native-headless",
  "provider": "codex",
  "bridgeSlotId": "<derived-id>",
  "executionProfile": "workspace-write"
}
```

The owner token is deliberately absent. A session rotation updates the slot's session ID under the
same token before polling the new inbox. If renewal is refused or becomes unprovable, the worker
stops claiming, signals an active owned child, completes that message as failed when the responder
session still permits it, closes its session, and returns to standby. It never continues work after
losing ownership.

The foreground `session bridge native` command acquires the same slot. It either owns the slot or
fails before registering a session; it cannot bypass the guard. A coordinated upgrade rejects a new
registration that supplies reserved bridge metadata without a valid typed owner declaration. An old
bridge session that registered before the upgrade may remain visible until its presence TTL expires,
so the router remains deterministic and the dashboard flags that short compatibility window.

## Safe provider execution profiles

Supervised bridges do not accept `nativeArgs`. Their policy comes from the existing effective agent
configuration under a typed `settings.luwiNativeBridge` leaf:

```json
{
  "enabled": true,
  "provider": "codex",
  "executionProfile": "workspace-write"
}
```

The leaf is parsed by a strict protocol schema after normal profile and project override resolution.
Unknown fields, provider/AgentDefinition-kind mismatches, invalid effective configuration, missing
executables, and unsupported profile combinations keep the slot inactive and produce a bounded
diagnostic. No secret, arbitrary environment value, shell fragment, or free-form argv is accepted.

Two semantic profiles exist:

| Profile           | Workspace access                                        | Approval behavior                                              | Intended work                |
| ----------------- | ------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------- |
| `read-only`       | provider-enforced read-only                             | only the bound LUWI MCP calls needed to report state           | inspection and review        |
| `workspace-write` | restricted to the registered working directory/worktree | deterministic noninteractive approval for that bounded surface | approved implementation work |

Each provider adapter translates a semantic profile to a constant argv template and launches with
`shell: false`. The executable is the resolved enabled AgentDefinition executable or the provider's
fixed default. The environment is copied through the existing runner, with LUWI binding variables
overwritten by the bridge. Message text appears only in the provider prompt position. Output and
diagnostics remain bounded as in ADR 0031.

Initial supervised support is deliberately narrower than the manual bridge:

| Provider    | Fresh headless bridge | Supervised profiles                                                                                                                      | Existing-conversation wake                         |
| ----------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Codex       | supported             | `read-only`, `workspace-write` using measured sandbox flags and the existing MCP binding arguments                                       | `codex queue`                                      |
| Claude Code | supported manually    | enabled only after its installed version's noninteractive tool allowlist is verified by adapter fixtures; otherwise reported unsupported | unsupported                                        |
| Gemini CLI  | supported manually    | disabled until sandbox and approval flags are measured end to end                                                                        | unsupported; no reliable per-conversation identity |
| Antigravity | supported manually    | disabled because its observed unattended mode requires `--dangerously-skip-permissions`                                                  | unsupported; no verified inbound-turn API          |

A provider/profile pair cannot be enabled from a generic `additionalArgs` escape hatch. Adding a pair
requires a code change, exact argv tests, a no-shell process test, and one gated live acceptance run.
This keeps automatic execution narrower than an operator's explicit foreground command.

## Durable coordinator wake intents

### Capability declaration

An interactive session declares a top-level metadata value
`hostWakeAdapter: "codex-queue-v1"` only when all of these are true:

- its native reference was resolved and successfully bound;
- the reference came from a typed host declaration or exact launcher-provided identity; a
  filesystem heuristic is ineligible for automatic wake;
- the binding is a main session, not a subagent;
- the local Codex executable supports the measured `queue --thread --message` interface;
- the session's MCP launcher is bound to that same LUWI session.

No other adapter value is initially accepted. A missing or unknown value means durable inbox only.
The declaration is a capability signal, not authority: the daemon revalidates the source session and
native binding before releasing a claim to the dispatcher.

### Atomic creation

The winning terminal message transition already writes the terminal projection, source inbox
response, and `message.responded`, `message.rejected`, `message.failed`, or `message.timed_out` event
atomically. It is extended with declared source-session, workflow, and wake keys. When the source
session has an online presence key, exact `hostWakeAdapter` metadata, and an active workflow waiting
for that message, the same Redis Function also:

1. stores one wake intent keyed by the message ID;
2. appends that ID to the global wake Stream;
3. appends `wake.requested` with the terminal event as its `causationId`.

The wake record contains IDs, terminal state, adapter name, timestamps, and state only. It does not
copy message content, response content, evidence, native conversation ID, executable path, or owner
token. A duplicate terminal call returns the existing terminal message and cannot append another
intent because the original transition and intent creation committed together.

This new stored record shape moves `luwi_v1` to version 13. All keys are declared to the Function;
Lua derives no key names. A fresh wake consumer group is created at `0-0` during owned daemon startup
only after Function compatibility is established, so work committed while the dispatcher was absent
is not skipped. Pending or lagging wake entries are never trimmed.

### State machine

```text
pending -> claimed -> dispatching -> dispatched
                  \               -> fallback_only
                   \              -> indeterminate
                    -> claimed (safe reassignment after min-idle)
```

- `pending`: durable and not assigned.
- `claimed`: assigned through the wake consumer group, with no host side effect yet. A stale claim is
  safe to reassign.
- `dispatching`: an attempt ID and dispatcher ID were durably fenced immediately before starting the
  host command.
- `dispatched`: the host command exited successfully and reported queue acceptance. This means the
  turn was accepted, not that the model processed it.
- `fallback_only`: validation found no still-valid supported binding or capability declaration, or
  the adapter definitively could not start. The message and source inbox remain authoritative.
- `indeterminate`: the process timed out, exited nonzero after starting, the dispatcher crashed after
  the fence, or ownership was lost. The command may have accepted the turn, so no automatic replay is
  allowed.

`claimed` recovery uses `XAUTOCLAIM` after the configured minimum idle time. `dispatching` recovery
atomically marks `indeterminate` and acknowledges the wake Stream item. Terminal wake states are
idempotent. A dispatcher can retry a Redis reply whose outcome was lost by re-reading the intent and
continuing only from `pending` or `claimed`.

A bounded sweeper moves old `pending` or `claimed` intents to `fallback_only` after five minutes, so
a disabled dispatcher cannot pin records forever. Wake retention follows terminal-message retention;
message cleanup defers while its eligible wake intent is non-terminal. The source inbox response is
never claimed or acknowledged by the wake dispatcher.

## Codex queue adapter

The daemon resolves the source session's retained native-binding reverse index and returns an opaque
dispatch target only on the validated loopback claim route. It refuses missing, inconsistent,
trimmed, subagent, wrong-adapter, or conflicting evidence. Dashboard list responses never include the
native target.

Immediately before process launch, the dispatcher transitions the intent from `claimed` to
`dispatching`. It then invokes, without a shell:

```text
codex queue --thread <nativeSessionId> --message <wakePrompt>
```

`wakePrompt` is fixed except for validated IDs and terminal state:

```text
LUWI response <correlationId> is now <terminalState>. Call luwi_get_message with correlationId
"<correlationId>" to read the durable result, then continue coordinating from that evidence.
Wake intent: <wakeIntentId>.
```

The response body is not copied into the host command. The prompt is bounded to 1 KiB and every
identifier has already passed protocol validation. An exit code of zero records `dispatched`. A
spawn failure proven to occur before process creation records `fallback_only`. A timeout, signal,
lost process handle, or nonzero exit after start records `indeterminate`. None is automatically
retried.

If the queued turn cannot use the bound MCP server, no LUWI state is fabricated. The coordinator can
still read the response later through `luwi_inbox_next`, `luwi_get_message`, the CLI, or Pulse.

## Fenced workflow continuation

Automatic wake applies only to messages created inside an explicit workflow. Existing standalone
`luwi_ask_agent` calls remain `inbox_only` unless the caller creates or continues a workflow. A
workflow stores a bounded objective, coordinator session ID, root correlation ID, monotonic revision,
current message ID, current wake intent ID, and one of `active`, `waiting_for_human`, `completed`, or
`failed`. It does not store a hidden conversation transcript.

The queued Codex turn may read and review the durable response more than once, but it advances work
through one operation:

```text
luwi_continue_workflow(workflowId, expectedRevision, wakeIntentId, decision)
```

`decision` is exactly one of: create one next message, complete the workflow, or block for a named
human decision. One Redis Function verifies the workflow revision, current wake intent, coordinator
identity, and proposed target; then atomically creates the next message and advances the revision, or
records the terminal/blocking decision and completes the wake. A duplicate Codex turn with the old
revision returns the already-committed result and cannot authorize a second downstream task.

If exact-thread wake is unavailable, a coordinator native worker may consume the same bounded
objective and continuation contract only when a safe coordinator execution profile is enabled. It
uses the same fenced continuation operation. Without that contract or profile, LUWI marks the
workflow `waiting_for_human`; it does not ask a memoryless worker to infer the next task.

## Daemon API and protocol

New strict protocol records and loopback routes are:

- `BridgeSlotView` and `GET /api/v1/bridge-slots` for redacted ownership and health;
- `WorkflowView`, `POST /api/v1/workflows`, and
  `POST /api/v1/workflows/:workflowId/continue` for bounded objectives and fenced continuation;
- `POST /api/v1/bridge-slots/:slotId/acquire|renew|attach|release` for bridge ownership;
- `WakeIntentView` and `GET /api/v1/wake-intents` with bounded project, state, and limit filters;
- `POST /api/v1/wake-intents/claim` with dispatcher instance, limit, block, and min-idle bounds;
- `POST /api/v1/wake-intents/:intentId/dispatching` with the exact claim and attempt IDs;
- `POST /api/v1/wake-intents/:intentId/complete` with `dispatched`, `fallback_only`, or
  `indeterminate` and one bounded reason code.

Mutation routes use the daemon's existing loopback origin/content-type protection. State transitions
take identity from the claimed record and route path; callers cannot redirect an intent to another
session or native conversation. Public errors contain stable codes and no argv, output, path, token,
or native ID.

New Runtime events are `bridge.slot.acquired`, `bridge.slot.attached`, `bridge.slot.released`,
`bridge.slot.expired`, `wake.requested`, `wake.claimed`, `wake.dispatching`, `wake.dispatched`,
`wake.fallback_only`, and `wake.indeterminate`. Each corresponds to a persisted transition. Repeated
renewals do not emit unless public metadata changes, preventing heartbeat noise.

## Dashboard observability

Pulse remains read-only for this feature. It adds no start, stop, retry, lease-release, or permission
control.

The Runtime route shows supervisor reachability, active/standby/degraded bridge counts, duplicate
slots, and oldest pending wake age. The Sessions route labels exact native-headless bridge sessions
with provider, execution profile, and slot health. The Messages detail view shows:

- routing mode and `selectionReason`;
- target bridge/session state;
- terminal response state;
- coordinator wake state and timestamps;
- a plain explanation when durable inbox is the only delivery path.

Native conversation IDs, owner tokens, command arguments, captured output, and executable paths are
never rendered or returned to browser code. Realtime events refresh these reads, while a full HTTP
reload produces the same answer after missed WebSocket traffic. Existing product-independence tests
continue to reject dashboard writes outside the two approved mutation modules.

## Failure behavior

| Failure                                     | Result                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| no online bridge                            | current agent-session fallback; message remains durable                                   |
| duplicate bridge start                      | one slot owner, contenders standby/refused; duplicate legacy sessions are surfaced        |
| slot owner dies before session registration | slot expires within 15 seconds; no session was selectable                                 |
| slot owner dies while idle                  | session presence and slot expire; another supervisor acquires and registers a new session |
| slot owner dies during native processing    | existing message processing recovery marks failed and never replays unknown side effects  |
| daemon or Redis disconnect                  | workers stop claiming after bounded failures; durable inbox and wake Stream retain work   |
| machine sleep                               | expired ownership and sessions are replaced; old tokens cannot evict new owners           |
| terminal transition reply lost              | retry reads the committed terminal message and existing wake intent; no duplicate wake    |
| dispatcher dies while `claimed`             | stale claim is reassigned safely                                                          |
| dispatcher dies while `dispatching`         | intent becomes `indeterminate`; no duplicate host turn                                    |
| Codex queue unavailable                     | `fallback_only` or `indeterminate` according to whether process start was proven          |
| source native binding unavailable           | `fallback_only`; source response inbox remains untouched                                  |
| WebSocket disconnected                      | no effect on dispatch; blocking durable Stream claim remains authoritative                |

## Files and boundaries

The implementation plan should keep the work in these units:

| Area                                                                                       | Responsibility                                                                     |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `packages/protocol/src/bridge.ts`, `wake.ts`, `runtime-event.ts`                           | strict records, requests, responses, states, event names, public redaction         |
| `packages/protocol/src/workflow.ts`                                                        | bounded workflow objective, revision, decision, and public state                   |
| `packages/runtime/src/message-routing.ts`                                                  | pure native-headless preference and auditable reason                               |
| `packages/runtime/src/bridge-slot.ts`, `wake-intent.ts`                                    | pure transition and provider eligibility policy                                    |
| `packages/runtime/src/workflow.ts`                                                         | pure continuation authorization and monotonic revision policy                      |
| `packages/redis/src/bridge-slots.ts`, `wake-intents.ts`, `function-library.ts`, `keys.ts`  | slot ownership, durable wake queue, atomic terminal-intent write, retention        |
| `apps/daemon/src/bridge-slot-service.ts`, `wake-intent-service.ts`, `app.ts`, `runtime.ts` | validated loopback services, routes, sweeper, startup/shutdown wiring              |
| `apps/cli/src/wake-supervisor.ts`                                                          | binding discovery, slot lifecycle, bridge worker supervision                       |
| `apps/cli/src/provider-execution-profiles.ts`                                              | strict effective-config leaf and constant no-shell argv templates                  |
| `apps/cli/src/coordinator-wake.ts`                                                         | claim recovery, dispatch fence, Codex queue adapter, bounded result classification |
| `apps/cli/src/lifecycle.ts`, `cli.ts`                                                      | wake start/stop/status/serve and opt-in Windows autostart wiring                   |
| `apps/dashboard/src/api/wake-scope.ts`, route components, Pulse model                      | read-only slot/wake observability                                                  |

The exact split may reuse an existing repository or lifecycle file when the implementation plan
finds a smaller coherent unit, but protocol, pure policy, Redis state, daemon composition, CLI
execution, and browser presentation remain separate package responsibilities.

## Verification

### Unit and contract tests

- Routing: bridge preference over a newer idle interactive session; direct-session precedence;
  deterministic selection among multiple bridges; offline/terminal bridge ignored; unchanged
  no-bridge fallback.
- Protocol: strict bridge/wake records, bounded identifiers and reasons, state filters, new event
  types, and browser responses that omit native IDs and tokens.
- Runtime policy: exact bridge marker, slot transition matrix, supported adapter decision, wake
  transition matrix, workflow continuation matrix, timeout classification, and redaction.
- Provider profiles: exact no-shell argv for every supported provider/profile pair; rejection of
  arbitrary arguments, dangerous flags, kind mismatch, invalid config, and unsupported providers.
- Codex queue: exact argv ordering, fixed bounded prompt, zero/nonzero/timeout/spawn classifications,
  and no message or response content in argv or diagnostics.
- Workflow: one expected revision and wake intent can create at most one next message; duplicate or
  stale coordinator turns return the committed decision without creating another task.
- Supervisor: acquire before register, standby on held slot, renew, rotation attachment, stop on lost
  ownership, child cancellation, signal cleanup, and no polling before ownership.
- Dashboard: all wake states, duplicate bridge warning, stale/unavailable reads, keyboard-accessible
  status details, and absence of native IDs or mutation controls.

### Redis integration tests

- Two concurrent slot acquires produce one owner; stale owner renew/release cannot affect the winner.
- Expiry and reacquire preserve monotonic ownership and emit one transition per state change.
- A terminal message, source response envelope, terminal event, wake intent, wake Stream item, and
  `wake.requested` event commit atomically.
- Retrying an unobserved terminal success creates no second intent or Stream item.
- Continuing a workflow atomically advances its revision, completes the current wake decision, and
  creates exactly one next message or one terminal/human-blocked decision.
- Claim/reclaim is safe before `dispatching`; recovery after `dispatching` becomes
  `indeterminate` and never returns to pending.
- Cross-project/session/attempt mismatches write nothing.
- Retention defers for non-terminal wake intents and later removes terminal intents without touching
  unrelated test prefixes.

### Daemon and CLI integration tests

- The wake claim route resolves only a main Codex binding linked to the source session and returns a
  redacted fallback for absent, closed, trimmed, inconsistent, or wrong-adapter evidence.
- Daemon restart recovers pending wake entries and expired slot ownership without starting a vendor
  process itself.
- Two supervisor processes converge on one worker per slot.
- A source response wakes the dispatcher without a WebSocket client.
- Product-independence tests confirm the dashboard gained reads only.

### Gated live acceptance

On Windows, with a disposable project and Redis namespace:

1. Start the daemon and wake supervisor with one Codex coordinator adapter and one Claude
   `workspace-write` bridge profile scoped to a disposable worktree.
2. Register the authoritative interactive Codex coordinator through an exact trusted native binding
   and declare `codex-queue-v1`.
3. Create an explicit workflow and send one `targetAgentId: claude-code` implementation task.
4. Verify selection of the Claude bridge and observe
   `queued -> delivered -> acknowledged -> processing` with no manual inbox command.
5. Verify Claude acquires and releases the required work lease, edits only the disposable worktree,
   runs one approved test command, commits the result, and responds with commit and test evidence.
6. Observe one wake intent, one exact `codex queue` invocation, and `dispatched`; the visible Codex
   conversation reads the durable response, reviews its evidence, and calls the fenced workflow
   continuation once.
7. Verify that continuation atomically advances the workflow and emits exactly one causally linked
   follow-up task. Replay the same wake prompt and prove no duplicate downstream work is created.
8. Disconnect WebSocket before the response and verify the same result from the durable wake Stream.
9. Stop the dispatcher before the terminal response, restart it afterward, and prove the preexisting
   intent is claimed from `0-0` and dispatched once.
10. Kill a scripted dispatcher after `dispatching`; restart and prove `indeterminate`, no second host
    command, and the durable source inbox response remains readable.
11. Start two supervisors concurrently and prove exactly one bridge slot owner and one child process.
12. Sleep past both ownership TTLs, resume, and prove one replacement owner and no stale-token release
    of the replacement.
13. Enable a Gemini CLI profile only if its sandbox and policy pass the same no-shell, scoped-write,
    lease, and response checks. Otherwise prove it is visibly unavailable and cannot receive
    executable work. Antigravity must likewise remain visibly unavailable while its only measured
    unattended edit path requires unrestricted permission bypass.
14. Refresh Pulse and reconnect realtime; verify the same redacted workflow, bridge, message, lease,
    evidence, and wake facts.

The live run records timestamps and IDs but no prompt or response content. Claude proves unattended
workspace execution; provider-specific same-conversation wake remains Codex-only until another
provider exposes an exact supported enqueue interface.

## Rollout and compatibility

The routing comparator can ship first because it changes no wire or stored shape. The remaining work
lands behind disabled-by-default wake supervision and per-binding `enabled: true`; installing or
upgrading LUWI does not silently begin unattended execution. Existing manual bridge commands retain
their explicit behavior but acquire a singleton slot.

Protocol, Redis Function library, daemon, CLI, MCP package, and dashboard are released together for
the version-13 datastore shape. Startup refuses an incompatible Function library rather than serving
partial wake behavior. Disabling or stopping the dispatcher leaves ordinary message request/reply,
manual inbox reads, and direct-session routing operational.

The successful end state is precise: agent-targeted work has a deterministic unattended execution
path, and a completed response can create a supported host turn without sacrificing the durable
message path. An unsupported or uncertain host wake remains visible and recoverable rather than being
reported as success.
