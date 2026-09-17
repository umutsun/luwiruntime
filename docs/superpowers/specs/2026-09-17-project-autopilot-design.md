# Per-project autopilot design

Date: 2026-09-17. Requested by the owner as "agentic mode / autopilot enabled per project, with
hermes (LuwiBot) coordinating the workers — plan it, do not start". Decision record: ADR 0035
(Proposed). Nothing in this document is built; every section describes intended behaviour.

## Problem

Every coordination primitive the runtime has still waits for a person at the top. A bridge worker
(`session bridge native`, ADR 0031) executes an `instruction` unattended, but someone writes the
instruction. Leases refuse a collision, but someone chooses the next piece of work so two workers are
not sent into the same files. LuwiBot — the owner's assistant, an external local service the
dashboard already reaches over `ws://127.0.0.1:3100/chat` — could hold a plan for a project and drive
the workers, but the runtime gives it no project-level switch, no place to record the plan where the
operator can see and gate it, and no durable wake-up except the responses to messages it already
sent.

Three measured facts (2026-09-17, from the tree):

1. `selectMessageTarget` already prefers a `native-headless` bridge session for an agent-routed
   message and calls the interactive one the "PM session" (`packages/runtime/src/message-routing.ts`).
   The runtime knows the shape of a coordinator; it has no record for it.
2. Every terminal message transition appends an `itemKind: 'response'` entry to the **source**
   session's inbox (`function-library.ts`, the `message_respond` family). A coordinator that
   dispatched a message is therefore already woken by its result through `inbox/claim`. It is not
   woken by an approval, a mode change or an operator's nudge.
3. `packages/protocol/src/project-role.ts` (`projectRoleSchema`: provider, role, `eligibleWork`,
   `humanGate`, `writableBranch`, `worktreePath`) has zero consumers. `.luwi/` is gitignored in this
   repository; `.luwi/manifest.json` already carries per-project `agentDefaults` and is written by the
   canonical store with a content hash.

"Hermes" appears nowhere in the repository. Whether LuwiBot is built on a framework of that name,
what its CLI and MCP client look like, and whether it has a headless one-shot mode are unknown here
and are Phase 0 of the plan. This design is deliberately indifferent to the answer: the coordinator
is a session, and the runtime's contract to it is the same whether it runs one headless process per
inbox item or one long-lived process polling its inbox.

## Goal

One operator-held switch per project — `off`, `supervised`, `autopilot` — under which a designated
coordinator session may record tasks, dispatch them to bridge workers as ordinary `instruction`
messages within a declared budget, and be woken by the results, approvals and mode changes it needs;
the whole of it visible in the project drawer and the ticker, gateable by the operator, and honest
about what the runtime cannot enforce.

## Non-goals

No scheduler, planner or model call in the daemon. No retries or re-dispatch. No worker-created or
cross-project tasks. No label routing (`eligibleWork`). No branch or worktree per task (needs Git
mutation, §21). No GitHub or merge step. No token budget. No terminal injection. No change to
`luwi_message_request_v1`, to the native bridge, to its prompt framing, or to a worker's permission
model. No new package (§5), no new dependency, no new datastore.

## Vocabulary

| Term        | Meaning                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| coordinator | The online, non-terminal session(s) of the policy's `coordinatorAgentId` in the project. LuwiBot, in practice. |
| worker      | A session of one of the policy's `workerAgentIds`; in practice a `session bridge native` process.              |
| operator    | The person at the dashboard or CLI. Not a session. The only party that sets the mode or approves a gated task. |
| task        | A project-scoped work record the coordinator writes and the runtime dispatches as one `instruction` message.   |
| notice      | A durable inbox item that wakes the coordinator. Never the truth; the task store is.                           |
| gate        | A task state (`awaiting_approval`) that only the operator can leave.                                           |

## Architecture

```
operator ── dashboard / CLI ──▶ daemon ── mode, policy, approve/reject/cancel, wake
                                   │
LuwiBot (coordinator session) ─────┤   luwi_get_autopilot · luwi_list_tasks · luwi_create_task
   wakes on inbox/claim:           │   luwi_dispatch_task ──▶ evaluateDispatch ──▶ task_dispatch (Lua)
   response | notice               │                                 │
                                   │                     POST /messages (Idempotency-Key task:<id>)
                                   │                                 │
worker (session bridge native) ◀───┘   ordinary `instruction` in its inbox; unchanged
   completes through luwi_respond_to_message
                                   │
                                   └── message terminal ──▶ task_transition complete ──▶ response item +
                                                             notice in the coordinator's inbox
```

Three loopback links, never merged: the dashboard talks to LuwiBot over its own WebSocket as today
(`luwibot-chat.tsx`, unchanged), LuwiBot talks to the daemon as a bound session, and the dashboard
talks to the daemon. The daemon never calls LuwiBot and LuwiBot never receives Redis credentials (§4).

## Autopilot record

One record per project. The mode is runtime state; the policy is a canonical declaration projected
into the same record.

```ts
type AutopilotMode = 'off' | 'supervised' | 'autopilot';

type AutopilotPolicy = {
  coordinatorAgentId: AgentId; // must be an enabled project-agent binding
  workerAgentIds: AgentId[]; // ≤ 16; each an enabled binding; never the coordinator;
  // empty = every enabled binding except the coordinator
  protectedPaths: string[]; // ≤ 32, project-relative, lease-normalized
  maxInFlight: number; // 1..8, default 2   (dispatching + dispatched)
  maxDispatchesPerHour: number; // 1..120, default 20
  defaultTaskTimeoutMs: number; // 60_000..MESSAGE_MAX_TIMEOUT_MS, default 1_800_000
};

type AutopilotRecord = {
  projectId: string;
  mode: AutopilotMode; // default 'off'; Redis only; never canonical
  policy: AutopilotPolicy | null; // null until a policy is declared
  policyHash?: string; // sha256 of the canonical policy JSON
  version: number; // monotonic; every write is a CAS (ADR 0022 pattern)
  changedAt: string;
};
```

Rules:

- `mode` may be set only by the operator surfaces. `PUT …/autopilot/policy` and `POST …/autopilot/mode`
  are not reachable from MCP. A `mode` other than `off` with `policy: null` is refused
  (`AUTOPILOT_NOT_CONFIGURED`): a switch with nobody to switch on is not a state worth storing.
- The policy is written to `.luwi/manifest.json` as `data.autopilot` through the canonical store's
  existing `createManifest` (content-hashed), then projected by `luwi_autopilot_policy_put_v1`. At
  daemon start the reconciliation that restores agent bindings also restores the policy; a manifest
  policy naming an unknown or disabled agent fails readiness with `CONFIG_RECONCILIATION_REQUIRED`,
  the same way a bad binding manifest does. The **mode is never read from the manifest**; after a
  reset or a fresh database every project is `off`.
- Coordinator presence is derived, not stored: the dashboard and `GET …/autopilot` compute it from
  the sessions the snapshot already holds (agent id, project, online, not terminal, not `starting`).

## Tasks

```ts
type TaskState =
  | 'ready'
  | 'awaiting_approval'
  | 'approved'
  | 'dispatching'
  | 'dispatched'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'rejected';

type Task = {
  id: string;
  projectId: string;
  title: string; // 1..200
  brief: string; // 1..32 768 UTF-8 bytes — it becomes the message content
  createdBy: { kind: 'session'; sessionId: string; agentId: AgentId } | { kind: 'operator' };
  agentId?: AgentId; // the worker; required at dispatch
  paths: string[]; // ≤ 32, normalized like leases (display form + match form)
  dependsOn: string[]; // ≤ 8 task ids in the same project
  evidenceRequirements: EvidenceType[]; // ≤ MESSAGE_MAX_EVIDENCE_ITEMS
  timeoutMs: number; // policy default unless set
  state: TaskState;
  gate?: 'supervised' | 'protected_path'; // why it is (or was) awaiting approval
  approval?: { decision: 'approved' | 'rejected'; at: string; note?: string }; // note ≤ 500
  correlationId?: string; // the dispatch message
  dispatchSourceSessionId?: string; // the coordinator session that issued step 1; scopes the repair key
  targetSessionId?: string;
  dispatchedAt?: string;
  terminalAt?: string;
  outcome?: {
    // copied from the message, never invented
    messageState: 'responded' | 'rejected' | 'failed' | 'timed_out';
    status?: 'answered' | 'partially_answered' | 'rejected' | 'failed';
    answer?: string; // first 4 096 chars; the full answer is on the message
    confidence?: number;
    evidenceCount: number;
  };
  version: number;
  createdAt: string;
  updatedAt: string;
};
```

### State machine (pure, `@luwi/runtime`)

```
ready ──dispatch──▶ dispatching ──(message created)──▶ dispatched ──(message terminal)──▶ done | failed
  │                     ▲
  ├──dispatch (gated)──▶ awaiting_approval ──approve──▶ approved ──dispatch──▶ dispatching
  │                                └──reject──▶ rejected
  └──cancel──▶ cancelled        (also from awaiting_approval and approved; never from dispatching/dispatched)
```

- Created as `ready` by the coordinator (Phase 2) or, later, by the operator (Phase 3, `createdBy`
  operator, for the coordinator to pick up).
- `update` (title, brief, agentId, paths, dependsOn, evidenceRequirements, timeoutMs) is allowed in
  `ready` and `awaiting_approval` only; an update to a gated task returns it to `ready`, because the
  operator approved a particular brief, not a slot.
- `approve` and `reject` are operator-only. `approved` is consumed by the next dispatch; a task that
  fails after approval is terminal, and a new task needs a new approval.
- A `dispatched` task cannot be cancelled: the worker owns it until its deadline (§3). The dashboard
  says so instead of hiding the control.
- `done` ⇐ message `responded`; `failed` ⇐ message `rejected`, `failed` or `timed_out`. The worker's
  own words are copied into `outcome`; the runtime decides nothing about quality.

### Dispatch evaluation (pure, `@luwi/runtime`, `evaluateDispatch`)

Inputs: mode, policy, the task, the in-flight tasks (state, match paths, agent), dispatch timestamps
inside the last hour, dependency states, live leases in the project, the worker agent's available
sessions. Output, in this order of precedence:

| Result                       | When                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `denied: mode_off`           | mode is `off`                                                                              |
| `denied: task_state`         | task is not `ready` or `approved`                                                          |
| `denied: worker_not_allowed` | `agentId` absent, the coordinator itself, or not in the effective worker list              |
| `denied: dependency_unmet`   | any `dependsOn` task is not `done`                                                         |
| `gated: supervised`          | mode `supervised` and task not `approved`                                                  |
| `gated: protected_path`      | mode `autopilot`, task not `approved`, and a task path overlaps a protected path           |
| `denied: in_flight_limit`    | in-flight count ≥ `maxInFlight`                                                            |
| `denied: rate_limit`         | dispatches in the last hour ≥ `maxDispatchesPerHour`                                       |
| `denied: path_overlap`       | a task path overlaps an in-flight task's path (`leasePathsConflict` on match forms)        |
| `denied: lease_overlap`      | a task path overlaps a lease held by a session other than a worker session of `agentId`    |
| `denied: worker_unavailable` | no online, non-`starting` session of `agentId` in the project (`selectMessageTarget` rule) |
| `dispatch`                   | otherwise                                                                                  |

A task with **no declared paths is treated as the whole project** (match form `''`, which prefixes
everything): it gates on any protected path in `autopilot` and overlaps every in-flight task. An
undeclared scope is the widest scope. This reuses `normalizeLeasePath` and `leasePathsConflict`
unchanged.

Only `task_state`, `in_flight_limit`, `rate_limit` and `path_overlap` are re-checked atomically in
Lua (the in-flight hash and the rate zset are declared keys; the limits arrive as arguments so the
Function carries no policy constant, §7). Dependency, lease and availability checks are read-then-act
and the design says so.

### Dispatch, in two steps with an idempotency key

1. `luwi_task_dispatch_v1`: CAS on `version`; state `ready|approved` → `dispatching`; record
   `dispatchSourceSessionId` (the coordinator session issuing it); `ZCOUNT` the rate zset over the
   window and `ZADD` this dispatch; `HSET` the in-flight hash; return the new version. It deletes
   nothing — aged window entries are the retention sweep's to remove, as expired leases are skipped
   rather than deleted during acquire (ADR 0020) — and it appends no event: `dispatching` is an
   internal step, and one dispatch gets one event, `task.dispatched`, when the message exists.
2. The task service calls the message service's internal `askForTask` — the same code path as
   `POST /api/v1/messages`, not reachable over HTTP — with `sourceSessionId` = the coordinator session,
   `targetAgentId` = the task's worker, `kind: 'instruction'`, `subject: "task <id>: <title>"`,
   `content` = the brief, the task's evidence requirements and timeout, and
   `Idempotency-Key: task:<taskId>` scoped to the coordinator session as the existing index already
   is. The existing idempotency machinery makes a repeat return the existing message.
3. `luwi_task_transition_v1` `dispatched`: records `correlationId`, `targetSessionId`, `dispatchedAt`,
   writes the correlation reverse index, appends `task.dispatched`.

A crash between steps leaves `dispatching`, and the repair has to survive a coordinator rotation,
because the idempotency index is scoped to the **source session**
(`index:message:idempotency:{sourceSessionId}:{sha256}`, 24 h retention) and a dead source session
is refused. The reconciliation sweep (below) therefore first reads that index for
`dispatchSourceSessionId` and key `task:<taskId>` through a new bounded `findByIdempotencyKey` read:
a message found there means step 2 already succeeded, and the sweep runs step 3 with its correlation
id. Only when nothing is found does it re-issue step 2 from a live coordinator session. A task still
`dispatching` past the idempotency retention is marked `failed` (`dispatch_unrecoverable`) rather
than guessed at. If step 2 is refused (`TARGET_SESSION_UNAVAILABLE` because the worker vanished), the
task goes `failed` with `outcome.messageState: 'failed'` and the reason, and the in-flight entry is
removed — never silently retried.

### Completion

The daemon's message service gains an injected `onTerminal(correlationId, state, response)` seam
(the same shape as `deferProjection`). The task service looks up the correlation reverse index and
runs `task_transition complete`: `dispatched` → `done|failed`, `HDEL` in-flight, `ZADD` terminal
index, copy the outcome, append `task.completed`, then queue a `task_completed` notice to the
coordinator. The sweep repeats the same for any `dispatched` task whose message is already terminal.
`complete` is state-guarded (`dispatched` → terminal), so the seam and the sweep cannot both win, and
only the winner queues the notice. In the ticker the message's own terminal event precedes
`task.completed`; that order is a fact of the two-step design, not a defect.

## Coordinator wake-up: the `notice` inbox item

`inboxEnvelopeSchema` gains a third branch:

```ts
{
  streamId, itemKind: 'notice', targetSessionId, createdAt,
  payload: {
    kind: 'mode_changed' | 'task_approved' | 'task_rejected' | 'task_completed' | 'kick',
    projectId, mode?, taskId?, correlationId?
  }
}
```

- Appended by `luwi_inbox_notice_v1` (declared keys: the target inbox stream, the two event streams)
  with an `autopilot.notice.queued` event. The target is the coordinator agent's best online session
  chosen by the same ranking `selectMessageTarget` uses, factored into a `rankAgentSessions` helper
  that needs no source session. **If no coordinator session is online, nothing is queued** and the
  response carries `coordinatorNotified: false`; the dashboard shows "coordinator absent — it will
  read its tasks when it next joins".
- **The claim path must learn the item, or it drops it.** `claimSessionInbox`
  (`packages/redis/src/session-inbox.ts`) validates every entry against a message projection,
  acknowledges one without a projection as `projection_missing`, and throws `INBOX_ENTRY_INVALID` when
  a claim yields only invalid entries. A notice has no message, so it gains its own branch: validated
  by the notice schema, **acknowledged on claim** — like a `response` item, it carries no work of its
  own and the task store is the truth — and returned in `items`. Existing consumers already skip
  non-`request` items (`native-bridge.ts`, `deepseek-bridge.ts`); `luwi_inbox_next` re-validates with
  the widened union and returns notices to the coordinator.
- A notice is at-least-once and never the truth. The coordinator's contract on every wake is: read
  `luwi_get_autopilot`; if `off`, stop; read `luwi_list_tasks`; act on what the store says. A lost or
  duplicated notice therefore costs latency, not correctness (ADR 0006, applied to the inbox itself).

## Redis (§7)

New declared keys, all under `luwi:v1:`:

```text
luwi:v1:project:{projectId}:autopilot                hash   mode, version, changedAt, policy (JSON), policyHash
luwi:v1:index:autopilot:projects                     set    projects holding an autopilot record (sweep + list)
luwi:v1:task:{taskId}                                hash   the task record (fields above; `json` for the read path)
luwi:v1:index:project:{projectId}:tasks              zset   taskId scored by createdAt ms
luwi:v1:index:project:{projectId}:tasks:active       hash   taskId → {state, matchPaths, agentId, correlationId?}  (in-flight scan set)
luwi:v1:index:project:{projectId}:tasks:dispatches   zset   taskId scored by dispatchedAt ms (hourly window; counted in-Function, aged entries removed by the retention sweep)
luwi:v1:index:task:correlation:{correlationId}       string taskId
luwi:v1:index:tasks:terminal                         zset   taskId scored by terminalAt ms (retention)
```

New Functions in `luwi_v1`, version **13**: `luwi_autopilot_mode_set_v1`,
`luwi_autopilot_policy_put_v1`, `luwi_task_create_v1`, `luwi_task_update_v1`, `luwi_task_dispatch_v1`,
`luwi_task_transition_v1` (approve, reject, cancel, gate, dispatched, complete, dispatch_failed),
`luwi_inbox_notice_v1`. Every key is declared by the caller; no Function derives a key name; every
event-emitting Function preflights the streams before its first write; none trims. The active hash
keeps the overlap scan on one declared key, as ADR 0020's held-lease hash does. `task_create` refuses
past 200 active tasks per project (`TASK_LIMIT_REACHED`, a 409). Terminal tasks are retained for
`LUWI_TASK_TERMINAL_RETENTION_MS` (default = terminal message retention) and swept on the retention
cadence; the correlation reverse index follows the task.

## Events (§8)

```text
autopilot.mode.changed      { from, to }                                  actor: operator
autopilot.policy.updated    { policyHash, coordinatorAgentId, workerCount }
autopilot.notice.queued     { noticeKind, taskId? }                        sessionId: the coordinator
task.created                { taskId, title, agentId?, createdBy }
task.updated                { taskId, fields[] }
task.gated                  { taskId, gate }
task.approved / task.rejected   { taskId, note? }                          actor: operator
task.dispatch.denied        { taskId, reason }
task.dispatched             { taskId, correlationId, agentId, targetSessionId }
task.completed              { taskId, correlationId, state, outcomeStatus? }
task.cancelled              { taskId, by }
```

Twelve types, each with a real transition, schema, persistence path and test. The task board is a
projection of `task.*` plus the record; both are rebuildable from retained events and no other store.

## Daemon surface

```text
GET   /api/v1/autopilot                              every project's record (bounded, for the snapshot)
GET   /api/v1/projects/:projectId/autopilot
PUT   /api/v1/projects/:projectId/autopilot/policy   operator; writes the manifest then projects
POST  /api/v1/projects/:projectId/autopilot/mode     operator; { mode }
POST  /api/v1/projects/:projectId/autopilot/kick     operator; queues a `kick` notice
GET   /api/v1/projects/:projectId/tasks?state=&limit=
POST  /api/v1/projects/:projectId/tasks              { sessionId, title, brief, agentId?, paths?, dependsOn?, evidenceRequirements?, timeoutMs? }
GET   /api/v1/tasks/:taskId
PATCH /api/v1/tasks/:taskId                          { sessionId, …fields }
POST  /api/v1/tasks/:taskId/dispatch                 { sessionId }  → 200 { outcome: 'dispatched' | 'gated' | 'denied', … }
POST  /api/v1/tasks/:taskId/approve | reject         { note? }      operator
POST  /api/v1/tasks/:taskId/cancel                   { sessionId? } coordinator or operator
```

Every route is strict-validated and runs under `withMutation` where it writes. `sessionId` is the
coordinator's session: the service checks it exists, is online and non-terminal, belongs to the
project, and has the policy's coordinator agent id — else `AUTOPILOT_NOT_COORDINATOR` (403). An
`Origin`-less POST still needs `content-type: application/json` (ADR 0021). Error codes:
`AUTOPILOT_NOT_CONFIGURED`, `AUTOPILOT_NOT_COORDINATOR`, `AUTOPILOT_DISPATCH_REQUIRED`,
`AUTOPILOT_POLICY_INVALID`, `TASK_NOT_FOUND`, `TASK_STATE_INVALID`, `TASK_PATH_INVALID`,
`TASK_DEPENDENCY_INVALID`, `TASK_LIMIT_REACHED`. A dispatch denial is not an error code: it is a 200
with `outcome: 'denied'` and a `task.dispatch.denied` event (ADR 0020).

The message service refuses `kind: 'instruction'` from a coordinator session with
`AUTOPILOT_DISPATCH_REQUIRED` (409) once the project's policy names that agent. It reads the policy
through an injected `autopilotPolicy(projectId)` seam; the internal `askForTask` path bypasses the
check because it _is_ the dispatch.

Two new environment settings: `LUWI_TASK_TERMINAL_RETENTION_MS` (default 604 800 000) and
`LUWI_TASK_MAX_ACTIVE_PER_PROJECT` (default 200). The reconciliation sweep rides
`LUWI_RETENTION_INTERVAL_MS` and runs once at owned start, like `config/reconcile`; it is cleared on
both teardown paths and the `runtime.test.ts` timer guard covers it.

## CLI

```text
luwi autopilot show   --project <id>
luwi autopilot policy --project <id> --coordinator <agentId> [--worker <agentId>…] [--protect <path>…]
                      [--max-in-flight N] [--max-per-hour N] [--task-timeout-ms N]
luwi autopilot mode   --project <id> <off|supervised|autopilot>
luwi autopilot kick   --project <id>
luwi task list  --project <id> [--state <s>]
luwi task show  <taskId>
luwi task create   --project <id> --session <coordinatorSessionId> --title … --brief-file … [--agent …] [--path …] [--after <taskId>…]
luwi task dispatch <taskId> --session <coordinatorSessionId>
luwi task approve | reject | cancel <taskId> [--note …]
```

`--session` on the coordinator commands mirrors `message ask --source`: the CLI is the versioned HTTP
client and takes identity explicitly; only MCP derives it from the binding.

## MCP (§12)

| Tool                 | Method                         | Notes                                                       |
| -------------------- | ------------------------------ | ----------------------------------------------------------- |
| `luwi_get_autopilot` | `GET …/projects/:id/autopilot` | project-bounded read; includes derived coordinator presence |
| `luwi_list_tasks`    | `GET …/projects/:id/tasks`     | bounded, reports truncation                                 |
| `luwi_get_task`      | `GET …/tasks/:id`              | same project only                                           |
| `luwi_create_task`   | `POST …/projects/:id/tasks`    | `sessionId` from the binding, never from input              |
| `luwi_update_task`   | `PATCH …/tasks/:id`            | same                                                        |
| `luwi_dispatch_task` | `POST …/tasks/:id/dispatch`    | returns the three outcomes verbatim                         |
| `luwi_cancel_task`   | `POST …/tasks/:id/cancel`      | same                                                        |

`luwi_inbox_next` returns `notice` items. No tool sets the mode, writes the policy, approves or
rejects: those are control plane and operator-only. `luwi_ask_agent` with `kind: 'instruction'` from
a coordinator answers `AUTOPILOT_DISPATCH_REQUIRED`. Tool count becomes 43 (28 reads, 15 writes);
`CLAUDE.md` and `overview.md` state the new counts.

## Dashboard design

The owner's direction stands: no separate page. Everything lives in the project drawer and the
overview model.

### Project drawer — `AUTOPILOT` section (above `ProjectDetail`, below **Edit project**)

- **Header row.** Eyebrow `AUTOPILOT`. A three-way segmented control `Off · Supervised · Autopilot`
  (a `radiogroup`, keyboard-navigable, current mode pressed). Beside it the coordinator chip:
  `coordinator <agent> · online (n)` or `coordinator <agent> · absent`, and the budget line
  `in flight 1/2 · 3/20 this hour · protected src/redis/**, AGENTS.md`. With no policy: the control
  is disabled and one line says `No autopilot policy — declare one with luwi autopilot policy` (Phase
  3 replaces the sentence with an inline policy form).
- **Turning it on confirms.** Selecting `supervised` or `autopilot` opens the existing `ConfirmDialog`
  titled `Enable <mode> for <project>?` listing the coordinator and its presence, each worker agent and
  whether a bridge session of it is online, the limits, the protected paths, and the sentence
  _"Workers act within the permissions their bridge commands were started with. LUWI adds none and
  cannot stop an agent that is already editing."_ Confirm label `Enable supervised` / `Enable
autopilot`. Selecting `off` needs no dialog (it narrows), and the row then shows _"New dispatches
  stop now; a running worker finishes or times out."_
- **Absent coordinator.** Mode on and no coordinator session online renders an inline notice
  `Autopilot is on but no coordinator session is online — nothing will be dispatched until one joins.`
  (`role="status"`). This is a state, not an error.
- **Task board.** A list grouped by state — `Awaiting approval`, `In flight`, `Ready`, `Done`, `Failed`
  — each row: title, worker agent (with `IdBadge`), a `StatusChip` for the state, age, the gate reason
  when gated, and for dispatched/terminal rows a link to `#/messages/<correlationId>` (opens the
  routed message inline, existing behaviour) plus the first line of `outcome.answer`. Row controls:
  `Approve` / `Reject` (with an optional note) on `awaiting_approval`; `Cancel` on `ready`, `approved`
  and `awaiting_approval`; none on `dispatching`/`dispatched` with the hover text _"the worker owns it
  until its deadline"_. Terminal rows are read-only. Empty state: _"No tasks yet. The coordinator
  creates tasks when it wakes."_ Bounded at the daemon's limit and says `truncated` when it is.
- **Wake coordinator** button, enabled only while a coordinator session is online; the result line
  says whether a notice was queued.
- Reads come through a new `api/autopilot-scope.ts` (project-scoped, invalidated on `autopilot.*` and
  `task.*` events, following `lease-scope.ts`). Writes come through **`api/autopilot-mutations.ts`**,
  the fourth allowlisted module; `product-independence.test.ts` names it and keeps forbidding every
  prohibited operation inside it.

### Overview

- `OverviewProject` gains `autopilot?: { mode, coordinatorOnline: boolean, inFlight: number, maxInFlight: number }`
  derived in `overview/model.ts` from the snapshot's new `autopilot` resource and its sessions —
  pure, tested.
- **Board** lens: a project tile in `supervised`/`autopilot` shows a second chip `SUPERVISED` /
  `AUTOPILOT` (tone `outline`; `ink` when the coordinator is absent, because that is the state that
  needs eyes). **Flow**: the coordinator's ribbon animates on `task.*` activity like any other. **Radial**
  and **Knowledge**: no change. **Timeline**: `task.*` marks come free from the activity feed.
- **Drill-down** for a project focus: one fact row `Autopilot · supervised · coordinator online ·
1 in flight of 2`, and a link `Open autopilot` to the drawer section.
- **Ticker** labels for `task.dispatched`, `task.completed`, `task.dispatch.denied`,
  `autopilot.mode.changed`; other new types render verbatim as Activity already does.
- New classes (`autopilot__*`, `task-board__*`) are registered with `class-coverage.test.ts`; every
  colour, spacing and font value is a token (`tokens.test.ts`). Light and dark themes both checked.

## Safety invariants (each one a test)

1. The mode is operator-only, defaults to `off`, is never written to a manifest, and is `off` after a
   reset. No MCP tool can change it or the policy.
2. Every `instruction` message has a session author. The daemon originates no message.
3. Dispatch is the only choke point: a coordinator `instruction` outside a task is refused; a
   `question` or `status_request` is not.
4. A refused dispatch writes nothing but its `task.dispatch.denied` event; the budget and in-flight
   overlap checks are atomic in Lua with limits passed as arguments.
5. A task with no paths is the whole project.
6. Workers keep their own permission model; the bridge, its framing and `luwi_message_request_v1` are
   unchanged (a test pins the bridge's argv and framing byte-for-byte).
7. Coordinator absence is shown, not hidden; `kick` with no coordinator answers
   `coordinatorNotified: false`.
8. No retries: `failed` is terminal; `dispatching` is repaired once by the sweep with the same
   idempotency key and then either `dispatched` or `failed`.
9. Every new timer is cleared on both teardown paths.
10. `.luwi/manifest.json` with a policy naming an unknown or disabled agent fails readiness loudly.

## Failure modes, stated

| Failure                                               | Behaviour                                                                                                                                                                                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordinator session rotates while a task is in flight | The response lands in the dead inbox; the sweep completes the task; the successor re-reads the store on wake. A rotation between the dispatch steps is repaired through the dead session's idempotency index, never by a second message. |
| Worker bridge dies mid-task                           | The message times out at its deadline; the task goes `failed` with `timed_out`; nothing is re-dispatched.                                                                                                                                |
| Daemon crash between dispatch steps                   | `dispatching` is repaired at start and every sweep: the issuing session's idempotency index first, a re-issue only when it holds nothing, `failed` past retention.                                                                       |
| Operator sets `off` while a worker runs               | No new dispatch; the running worker finishes or times out; the board says so.                                                                                                                                                            |
| Policy names an agent that is later disabled          | The next dispatch to it is `denied: worker_not_allowed`; readiness at the next start refuses the manifest.                                                                                                                               |
| Two coordinator sessions online                       | Notices go to the best-ranked one; both may act; the task CAS makes the second writer lose cleanly.                                                                                                                                      |
| Notice lost or duplicated                             | Latency only: the coordinator re-reads the store on every wake.                                                                                                                                                                          |

## Testing (§15, per transition)

- `@luwi/runtime`: state machine table; `evaluateDispatch` precedence with every reason; whole-project
  semantics for empty paths; `rankAgentSessions` equals `selectMessageTarget`'s order.
- `@luwi/redis` integration (`/redis-it`): each Function's success, refusal and no-partial-write;
  the dispatch race (two callers, one slot → one grant); the rate window counted, never trimmed, inside the Function; CAS conflict; notice append with a
  missing coordinator inbox; a notice returned once by the claim path, acknowledged on claim and never
  re-delivered by `XAUTOCLAIM`; retention of terminal tasks; function count and v13 compatibility.
- Daemon: routes, coordinator identity refusal, `AUTOPILOT_DISPATCH_REQUIRED`, the two-step dispatch
  with an injected fake message service, crash repair by the sweep, completion from the terminal seam,
  manifest reconciliation, timer teardown guard.
- CLI: every command's argv → request mapping and error mapping.
- MCP: seven tools' input/output schemas, session-derived identity, `notice` in `luwi_inbox_next`.
- Dashboard: model derivation, the segmented control and confirmation, approve/reject/cancel/wake
  flows against a fake gateway, the absent-coordinator notice, allowlist and class/token guards,
  `app.test.tsx` drawer assertions.
- Seed: the fixture gains a coordinator agent and session, a policy, `supervised` mode, and three tasks
  (`awaiting_approval`, `dispatched` and answered by the seeded worker through the real path, `done`).
  Trap: seeded sessions register `starting`, and agent-routed dispatch skips `starting`, so the seed
  must set the worker session `idle` first.
- Live (Phase 3): one real project, one `claude-code` bridge worker, the LuwiBot coordinator;
  supervised round trip, then autopilot within budget; measured report with times, tokens and every
  denial.

## Phase 0 measurements this design waits on

| Question                                                                 | Why it matters                                                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| How is LuwiBot run, and is it a Hermes-based agent?                      | Names the coordinator's runtime and its docs.                                                                                                    |
| Does it have a headless one-shot invocation (prompt in, exit when done)? | If yes, `session bridge native hermes` is the coordinator's run shape (ADR 0031, proven). If no, it runs long-lived and polls `luwi_inbox_next`. |
| Does it speak MCP as a client, and how is a server configured?           | It must bind `luwi-runtime` with `LUWI_SESSION_ID`/`LUWI_SESSION_FILE`.                                                                          |
| Does it have its own scheduler?                                          | A long-lived coordinator needs a periodic wake even with an empty inbox.                                                                         |
| What is its permission model for tools?                                  | The coordinator must be able to call the four write tools unattended.                                                                            |
| Does it expose a stable conversation id?                                 | Whether a native reference can be declared for usage attribution (ADR 0022).                                                                     |
| Size of real `instruction` messages today                                | Confirms the 32 KiB brief bound and the 30 000-byte headless prompt cap.                                                                         |

The answers pick the run shape and decide whether `hermes` joins `NativeAgentName`; they do not
change the runtime contract above.
