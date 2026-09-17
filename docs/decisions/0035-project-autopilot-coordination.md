# ADR 0035: Per-project autopilot, a coordinator session, and a bounded task domain

Status: Proposed  
Date: 2026-09-17

## Context

The product promise in `AGENTS.md` §1 is three clauses: see every project, coordinate every agent,
ship without collisions. After ADR 0031 every clause has machinery behind it, and every piece of
that machinery still waits for a person. A worker served by `session bridge native` executes a
message unattended, but someone has to write the message. Leases refuse a collision, but someone has
to decide what to work on next so that two workers are not sent into the same files. The owner's
LuwiBot — the docked assistant the dashboard already talks to over a WebSocket on `127.0.0.1:3100`,
which is an external local service and not part of this repository — can hold a plan for a project
and could drive the workers itself, but nothing in the runtime lets it do so in a way the owner can
switch on for one project, watch, gate, and switch off.

`AGENTS.md` §21 lists **task orchestration** as unapproved, and `docs/superpowers/specs/2026-08-24-cli-first-mvp-design.md`
rules out "an agent orchestration service or background supervisor". Both stand. This decision
does not put a scheduler in the daemon and does not let the runtime decide what work exists. It
gives an external coordinator a durable queue to wake from and a gated pen to write with, per
project, under a switch only the operator holds. The owner asked for this on 2026-09-17 as "agentic
mode / autopilot enabled per project, with hermes (LuwiBot) coordinating the workers" and asked for
a plan before any code. This ADR is that plan's binding part; the design is
`docs/superpowers/specs/2026-09-17-project-autopilot-design.md` and the implementation plan is
`docs/superpowers/plans/2026-09-17-project-autopilot.md`.

Four facts measured from the tree shape the decision:

- **The dispatch primitive already exists.** An `instruction` message to a bridge worker is a unit
  of unattended work with a deadline, a terminal state and evidence. `selectMessageTarget` already
  prefers a `native-headless` bridge session over an interactive one sharing the agent id, and its
  comment already calls the interactive one the "PM session". What is missing is the plan around the
  message: what was intended, what is waiting, what was refused, and who approved it.
- **The coordinator's wake-up primitive already exists.** A worker's terminal transition appends a
  `response` item to the **source** session's inbox (`luwi_message_respond_v1` and its siblings), so
  a coordinator that dispatched a message is already woken by its result through `inbox/claim`.
  Nothing wakes it for an approval, a mode change or an operator's nudge.
- **A `projectRole` schema exists with no consumer** (`packages/protocol/src/project-role.ts`,
  `docs/design/project-role-schema.md`): provider, role, `eligibleWork`, `humanGate`. It was written
  for exactly this and never connected. This decision consumes its intent — a coordinator role, worker
  eligibility and a human gate — as an autopilot policy, and leaves the branch and worktree fields
  out (they need Git mutation, which §21 still excludes).
- **The dashboard's write surface is an allowlist of three modules**, so a fourth is a decision, not
  drift, and the existing `ConfirmDialog` and `DetailDrawer` give the switch a place to live without a
  new page (the owner's 2026-09-15 direction: no separate pages).

## Decision

### Autopilot is a per-project mode the operator sets, and it is never canonical

Each project carries an autopilot record with a `mode` of `off`, `supervised` or `autopilot`, default
`off`. The mode lives in Redis only, changes through one Function that appends `autopilot.mode.changed`,
and is set exclusively by the operator — the dashboard's project drawer or the CLI. **No MCP tool and
no session can change it**, including the coordinator: a coordinator that could widen its own authority
would make the switch a fiction. The mode is deliberately **not** written to any canonical manifest, so
a checked-out `.luwi/` directory or a restored manifest can never turn autopilot on, and `luwi reset`
leaves every project `off`.

`supervised` means the coordinator plans and proposes, and every dispatch waits for the operator's
approval. `autopilot` means the coordinator dispatches on its own within the policy's budget, and only
a task touching a protected path waits for approval.

### The policy is filesystem-canonical, like every other declaration of who may do what

The autopilot policy — the coordinator's agent id, the worker agent ids it may dispatch to, protected
paths, `maxInFlight`, `maxDispatchesPerHour` and a default task timeout — is configuration in the
ADR 0007 sense: it is stored in the project's `.luwi/manifest.json` beside `agentDefaults`, projected
into the same Redis autopilot record, and reconciled at daemon start like the agent bindings are. A
policy names agents by their AgentDefinition id; the coordinator is an ordinary agent (LuwiBot is
registered as kind `other`), and an id that is not an enabled binding of the project is refused.

### The coordinator is a session, and the runtime never originates work

The coordinator is whichever online, non-terminal session of the policy's coordinator agent is bound
to the project. It registers, heartbeats and is reaped exactly as every other session (ADRs 0024,
0030, 0031, 0034). The runtime hands it three things and nothing more: a readable autopilot state, a
task store it alone may write, and durable **notice** items in its own inbox — appended when the mode
changes, when a task is approved or rejected, when a dispatched task completes, and when the operator
presses "wake". A notice is a wake-up, not the truth: the coordinator re-reads the task store on every
wake, so a lost or duplicated notice costs latency and never correctness, which is ADR 0006's rule
for realtime hints applied to the inbox stream itself.

The daemon runs **no loop that decides work**. Every `instruction` message still has a session as its
author. The one timer this decision adds is a reconciliation sweep on the existing retention cadence
that finishes a dispatch interrupted by a crash and closes a task whose message went terminal while
the inline path was not there to see it.

### Tasks are a bounded, event-derived coordination record — the first since leases

A task is a project-scoped record with a title, a brief that becomes the message content, an optional
worker agent id, declared project-relative paths, up to eight same-project dependencies, evidence
requirements and a timeout. Its states are `ready`, `awaiting_approval`, `approved`, `dispatching`,
`dispatched`, `done`, `failed`, `cancelled` and `rejected`. Every transition is a Redis Function
appending its event, and the projection is rebuildable from `task.*` events (§2). There is no task
package (§5): the domain lives in `@luwi/runtime` (state machine and dispatch policy, pure),
`@luwi/redis` (records, indexes, Functions) and the daemon (service, routes, sweep).

Dispatch is the only choke point. `POST /api/v1/tasks/:id/dispatch` from the coordinator evaluates
mode, gate, worker eligibility, dependencies, in-flight limit, hourly rate, path overlap with in-flight
tasks and overlap with live leases, and answers one of `dispatched`, `gated` or `denied` — the denial a
**200 with a body** and a `task.dispatch.denied` event, as ADR 0020 decided for a correctly answered
refusal. The atomic subset — state CAS, in-flight count, rate window, overlap against the in-flight
hash — is checked again inside `luwi_task_dispatch_v1` with the limits passed as arguments, so two
dispatches racing for the last slot produce one grant. A task that declares no paths is treated as
touching the whole project, exactly as an empty lease match form is: an undeclared scope is the widest
scope, never the narrowest.

A dispatch is two steps with an idempotency key, not one giant Function: the task moves to
`dispatching`, the existing `POST /api/v1/messages` path creates the `instruction` with
`Idempotency-Key: task:<taskId>` from the coordinator session, and the task records the correlation
id. A crash between the steps is repaired by the sweep: it reads the issuing coordinator session's
idempotency index for that key first and re-issues only when no message exists, so a coordinator
rotation never produces a second message. `luwi_message_request_v1` is unchanged.

Once the policy names a coordinator, an `instruction` message sent by a coordinator session outside a
task is refused with `AUTOPILOT_DISPATCH_REQUIRED`. Questions and status requests stay free in every
mode, as ADR 0025's Ask flow already established that asking is not orchestration.

### Workers are untouched

A worker sees an ordinary `instruction` message. `session bridge native` and its prompt framing do
not change; the task id rides in the subject. The worker's permission model remains everything after
`--` on its bridge command line (ADR 0031), and autopilot adds no permission to it. Leases stay
advisory and worker-held. The task's outcome is a copy of the worker's own response status and
evidence; the runtime never converts a `failed` into a retry.

### Surfaces

| Surface   | What it does                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP      | `GET/PUT …/projects/:id/autopilot[/policy]`, `POST …/autopilot/mode`, `POST …/autopilot/kick`, `GET …/projects/:id/tasks`, `POST …/tasks`, `GET/PATCH …/tasks/:id`, `POST …/tasks/:id/dispatch\|approve\|reject\|cancel` |
| MCP       | `luwi_get_autopilot`, `luwi_list_tasks`, `luwi_get_task` (reads); `luwi_create_task`, `luwi_update_task`, `luwi_dispatch_task`, `luwi_cancel_task` (coordinator-only writes); `luwi_inbox_next` learns the `notice` item |
| CLI       | `luwi autopilot show\|policy\|mode\|kick`, `luwi task list\|show\|create\|dispatch\|approve\|reject\|cancel`                                                                                                             |
| Dashboard | An **Autopilot** section in the project drawer: mode control behind a confirmation, coordinator presence, policy summary, the task board with approve/reject/cancel/wake; an autopilot badge on the overview             |

Every MCP write takes the actor from the bound session and never from input (ADR 0020); a session
that is not the project's coordinator gets `AUTOPILOT_NOT_COORDINATOR`. Mode and policy are control
plane and are never exposed through MCP (§12). The dashboard gains its fourth and only new write
module, `api/autopilot-mutations.ts`, added to the allowlist; it approves, rejects, cancels, wakes and
sets the mode and policy, and it still sends no instruction of its own.

### What is not done

No daemon-side scheduler, planner or model call; the runtime does not know what the next task should
be. No retries or re-dispatch — a failed task stays failed and the coordinator may create another. No
worker-created tasks. No cross-project tasks. No `eligibleWork` label routing yet: the coordinator
names the worker. No branch or worktree per task (the `projectRole` fields `writableBranch` and
`worktreePath` need Git mutation, still excluded by §21). No GitHub, pull-request or merge step. No
token budget: usage attribution is partial for two of the four vendors, and a budget that cannot be
measured would be a fiction. No terminal injection. No change to `luwi_message_request_v1`, to the
bridge, or to the worker's permission model.

Two rejected alternatives deserve naming. **Messages as the task record** was rejected because a
message has no pre-dispatch state, no gate and no dependency, so nothing could be approved before it
was sent. **A coordinator-only plan** (LuwiBot keeps the backlog in its own memory) was rejected
because the dashboard could not show what an unattended mode intends to do, and §2 already assigns
tasks to Redis.

## Consequences

`luwi_v1` moves to **v13**: two new record kinds (the autopilot record and the task) and seven new
Functions. A daemon started before this change must be restarted once. `AGENTS.md` §7 gains the
declared keys, §8 the twelve event types, §21 the approval; the MCP count becomes 43 tools, 28 reads
and 15 writes.

An operator can switch a project to `supervised`, watch the coordinator propose tasks, approve one,
and see a bridge worker complete it — then switch to `autopilot` and let the loop run within a stated
budget, with every dispatch, gate and denial in the ticker. Switching to `off` stops new dispatches at
once; it does not stop a worker already running, because §3 keeps LUWI out of terminals, and the
dashboard says so beside the switch.

The costs are stated. Autopilot on with no coordinator online is a visible state that dispatches
nothing, not an error the runtime hides. A coordinator that rotates mid-dispatch leaves the response
in the dead session's inbox; the sweep and the coordinator's re-read on wake recover it. Dependency
and lease checks are read-then-act; only the budget and in-flight overlap are atomic. Every task is a
fresh headless worker run paid in tokens, with the memory limits ADR 0031 already states. The
coordinator's own loop shape — one headless run per notice, or a long-lived process polling its inbox —
is LuwiBot's to choose and Phase 0 of the plan to measure; the runtime's contract is the same for both.
The record shape and its bounds (200 active tasks per project, 32 KiB brief, 32 paths, 8 dependencies)
are compile-time constants with tests, so widening any of them is a reviewable change.
