# Lost-target redispatch — design

Status: approved by the owner 2026-09-23. Not built.

## Problem (measured)

An autopilot task is dispatched to an **agent** but bound to that agent's **session** at dispatch
time: `selectMessageTarget` resolves `task.agentId` to one live session
(`packages/runtime/src/message-routing.ts:106-138`), the message is appended to that session's
inbox stream `luwi:v1:inbox:session:<id>`, and the task records `targetSessionId`
(`packages/runtime/src/task-state.ts:160-163`).

When that session dies — a daemon or manager restart, a lapsed heartbeat, a reaped `starting`
session — the three terminal transitions (`closeSession`, `disconnectExpiredSession`,
`reapStartingSession`) release the session's leases (P12) and do nothing to its messages. The
worker's bridge comes back under a **new** session id with a new, empty inbox; the old message is
unreachable. It waits for its deadline (default task timeout 30 min), becomes `timed_out`, the task
becomes `failed`, and the orchestrator asks the brain to **replan** (`orchestrator-cycle.ts:197-208`)
— spending a replan and a brain judgment on an infrastructure hiccup. Measured 2026-09-23: four
times in one day; parallel work stalls for 30 minutes each time.

## Decision

Fail fast, then redispatch the same task to the same agent's live session, bounded.

1. **Fail fast (daemon).** When a session becomes terminal, every non-terminal message whose target
   is that session is failed with reason code `TARGET_SESSION_LOST`, through the existing
   `message_fail` Function (`packages/redis/src/function-library.ts:1358`). Candidates come from the
   existing index `luwi:v1:index:session:<id>:messages:target` (`redis-keys.ts:222`); each is read
   and failed only if still non-terminal (the Function's own state check is the guard; a
   `responded` race wins). It runs from the same terminal-transition hook that releases leases
   (`runtime.ts:644-648`, `:864`, `:875`), best-effort: a failure is logged and the deadline sweep
   stays the backstop. No new key, stream, event type or Function; no `luwi_v1` bump.
2. **Requeue (runtime).** A new task transition `requeue`: `dispatched|dispatching → ready`, clears
   `correlationId` and `targetSessionId`, increments a new optional `redispatchCount` (default 0),
   records `lastRedispatch: { at, reason: 'target_session_lost', correlationId }`.
3. **Autopilot reaction (daemon).** Where a terminal message completes its task
   (`autopilot-service.ts` `complete`, `:503-563`): if the message failed with
   `TARGET_SESSION_LOST` and `redispatchCount < 2`, apply `requeue` instead of `complete`, and
   notify the coordinator (`kick`) so the next cycle dispatches it. Otherwise today's path
   (`failed` → replan) is unchanged.
4. **Redispatch (unchanged dispatch).** The next dispatch routes through `selectMessageTarget`
   again, which already excludes terminal and `starting` sessions, so it lands on the agent's live
   session. The new message carries `retryOf: <old correlationId>` (ADR 0037) so the chain is
   traceable. Its brief gains one line: "A previous attempt was interrupted when its session ended;
   the working tree may contain its partial changes — inspect them before continuing."

## Out of scope

Moving a message between inbox streams (rejected: cross-stream Lua with pending entries, and the
new session may not exist yet); making direct `message ask` exchanges visible on the dashboard
(separate work); retrying a message that failed for any other reason.

## Error handling

- The fail-fast hook never throws into the terminal transition; per-message failures are counted
  and logged once.
- A crash between the session ending and the fail-fast leaves today's behaviour: the deadline sweep
  times the message out.
- The old worker process may still finish and try to respond: the message is already terminal, so
  the response is refused; its file edits remain in the lane, which the redispatch brief warns
  about.
- If the agent has no live session at redispatch time, dispatch is denied `worker_unavailable` as
  today and retried on later cycles.

## Tests

- Runtime: `requeue` from `dispatched` and `dispatching`; refused from every other state; clears
  the routing fields; increments `redispatchCount`.
- Daemon: closing a session fails its in-flight messages with `TARGET_SESSION_LOST` and leaves a
  `responded` one alone; a disconnected and a reaped session do the same.
- Autopilot: a `TARGET_SESSION_LOST` failure requeues the task and kicks the coordinator; the third
  loss fails it (replan path); any other failure reason still fails it.
- Redispatch: the new message carries `retryOf` and the interrupted-attempt line.
- `redis-invariants` review before completion (the hook touches message state).

## Acceptance

A worker session killed mid-task: within one orchestrator cycle (not 30 minutes) the task is
`dispatched` again to the same agent's new session, the goal spent no replan, and the dashboard
shows one redispatch.
