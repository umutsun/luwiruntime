# Lost-target redispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a worker's session dies, fail its in-flight messages at once and redispatch their
tasks to the same agent's live session (at most twice per task) instead of waiting 30 minutes and
spending a replan.

**Architecture:** A daemon hook on the three session-terminal transitions fails the session's
non-terminal target messages with `TARGET_SESSION_LOST` through the existing `message_fail`
Function. The autopilot, completing a task from such a message, applies a new pure `requeue`
transition (back to `ready`) and kicks the coordinator; the next orchestrator cycle dispatches it
again through unchanged routing, linked with `retryOf`.
Spec: `docs/superpowers/specs/2026-09-23-lost-target-redispatch-design.md`.

**Tech Stack:** TypeScript, Zod (protocol), Vitest, Redis Functions (`luwi_v1`, unchanged).

## Global Constraints

- No new Redis key, stream, event type or Lua Function. Prefer no `luwi_v1` bump; if the registry's
  own rule (`packages/redis/src/function-library.ts` header / `CLAUDE.md` "a record-shape change
  moves the version") demands one for new optional task fields, stop and report — do not bump
  silently.
- Reason code, verbatim: `TARGET_SESSION_LOST`. Redispatch bound, verbatim: at most **2**
  redispatches per task (`redispatchCount < 2` requeues; the third loss follows today's path).
- The fail-fast hook never throws into a terminal transition; the message deadline sweep remains
  the backstop.
- Interrupted-attempt brief line, verbatim: "A previous attempt was interrupted when its session
  ended; the working tree may contain its partial changes — inspect them before continuing."
- AGENTS.md §7 applies (message state is Redis-owned); a `redis-invariants` review is required
  before Task 2 is complete. `CLAUDE.md` traps: a new optional stored field must be added to any
  field whitelist on read (e.g. `parseStoredMessage`), route bodies through `parseRequestInput`.
- Gate per task: `pnpm exec prettier --write <touched files>`, `pnpm lint && pnpm typecheck &&
pnpm test`; one commit per task ending with `Co-Authored-By: Claude Opus 5.5
<noreply@anthropic.com>`; no push; never restart the daemon/manager/workers (controller deploys).

---

### Task 1: The `requeue` task transition

**Files:**

- Modify: `packages/protocol/src/task.ts` (`taskSchema`, ~line 98-145)
- Modify: `packages/runtime/src/task-state.ts` (`TaskTransition`, `applyTaskTransition`)
- Test: `packages/runtime/src/task-state.test.ts`

**Interfaces:**

- Produces: `taskSchema` gains `redispatchCount: z.number().int().min(0).optional()` and
  `lastRedispatch: z.strictObject({ at: timestampSchema, reason: z.literal('target_session_lost'),
correlationId: identifierSchema.optional() }).optional()`.
- Produces: `TaskTransition` member `{ kind: 'requeue'; reason: 'target_session_lost' }`.
  From `dispatched` or `dispatching` only → `state: 'ready'`, `correlationId`, `targetSessionId`,
  `dispatchSourceSessionId`, `dispatchedAt` removed, `redispatchCount: (task.redispatchCount ?? 0) + 1`,
  `lastRedispatch: { at: now, reason, correlationId: task.correlationId }` (when the task had no
  correlationId, e.g. `dispatching`, omit `lastRedispatch.correlationId` — make that field optional
  in the schema accordingly). Any other state → the module's existing `invalid(...)` refusal.

- [ ] **Step 1: Failing tests** in `task-state.test.ts` using the file's existing task fixture:
      requeue from `dispatched` (fields cleared, count 1, lastRedispatch set); a second requeue counts 2;
      requeue from `dispatching`; refused from `ready`, `done`, `failed`, `awaiting_approval`.
- [ ] **Step 2:** `pnpm vitest run packages/runtime/src/task-state.test.ts` → FAIL.
- [ ] **Step 3:** Implement the schema fields and the transition. Check whether the task record is
      stored by a Redis Function that whitelists fields (grep `task_write` in
      `packages/redis/src/function-library.ts` and the autopilot repository's task parse); if it
      whitelists, carry the two fields through; if a version bump would be needed, stop and report.
- [ ] **Step 4:** Tests pass; run the gate.
- [ ] **Step 5:** Commit `feat(runtime): a dispatched task can be requeued when its target session is lost`.

---

### Task 2: Fail a dead session's in-flight messages at once

**Files:**

- Modify: `apps/daemon/src/message-service.ts` (new method), `apps/daemon/src/runtime.ts`
  (terminal-transition hooks ~`:644-648`, the presence-sweeper and starting-reaper adapters
  ~`:171-283`, `:864`, `:875`)
- Possibly modify: `packages/redis/src/message-repository.ts` (a read of the target index)
- Test: `apps/daemon/src/message-service.test.ts`, and the runtime test that covers the lease
  release on terminal transitions (grep `releaseSessionLeases` in `apps/daemon/src/*.test.ts`)

**Interfaces:**

- Produces: `messageService.failForLostTarget(sessionId: string): Promise<{ failed: number; skipped: number }>`.
  Reads member correlation/message ids of `luwi:v1:index:session:<sessionId>:messages:target`
  (key helper in `packages/redis/src/redis-keys.ts:222`; find the existing repository read for it),
  loads each message, and for each whose state is non-terminal calls the existing fail path with
  error/reason code `TARGET_SESSION_LOST` and a detail such as
  "The target session <id> ended before responding.". A refusal because the message turned
  terminal meanwhile is `skipped`, never thrown.
- Find out, and state in the report, how the existing fail path authorises the responder (the
  `message_fail` Function in `function-library.ts` ~`:1358` via `message_transition`). If it
  requires `responderSessionId === targetSessionId`, pass the dead target session's id (the
  daemon acts for it); if it refuses a terminal responder, add the narrowest daemon-internal path
  that still goes through `message_transition` (no new Function) and explain it.
- Where the failure reason is stored on the message (response status/answer/error code) and how
  the autopilot will read it back must be written down in the report — Task 3 depends on it.

- [ ] **Step 1: Failing tests**: a session with one `delivered` and one `processing` target message
      and one already `responded` → after `failForLostTarget`: two `failed` with `TARGET_SESSION_LOST`,
      the responded one untouched (`skipped` or not counted). Runtime wiring test: `closeSession`,
      the presence disconnect, and the starting reap each invoke `failForLostTarget` with the session id
      (the same seam that invokes `releaseSessionLeases` today), and a throw from it does not fail the
      transition.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; wire into the same three places as `releaseSessionLeases`, after it,
      `try/catch` + one log line with counts.
- [ ] **Step 4:** Tests pass; gate. Report the exact Redis commands issued for the §7 review.
- [ ] **Step 5:** Commit `fix(messages): fail a dead session's in-flight messages at once`.

---

### Task 3: The autopilot requeues a task whose target was lost

**Files:**

- Modify: `apps/daemon/src/autopilot-service.ts` (`complete` ~`:503-563`, `finishDispatch`
  ~`:436-499`)
- Test: `apps/daemon/src/autopilot-service.test.ts`

**Interfaces:**

- Consumes: Task 1's `requeue` transition and fields; Task 2's stored reason `TARGET_SESSION_LOST`
  and where to read it on the message.
- Behaviour: in `complete(task, message)`, when the message is `failed` with reason
  `TARGET_SESSION_LOST` and `(task.redispatchCount ?? 0) < 2`, apply `taskMove(task, { kind:
'requeue', reason: 'target_session_lost' })`, write it with a `task.updated`-style event the file
  already uses for task field changes (reuse an existing event type; grep `writeTask(` callers), and
  `notify(projectId, 'kick', { taskId })` exactly as `approveTask` does. Otherwise unchanged.
- Behaviour: in `finishDispatch`, when the task has `lastRedispatch?.correlationId`, pass
  `retryOf: task.lastRedispatch.correlationId` to `askForTask` (ADR 0037 checks it exists, same
  project, terminal — a failed message qualifies) and append the interrupted-attempt line
  (Global Constraints, verbatim) to the message brief/content.

- [ ] **Step 1: Failing tests** (use the file's harness/fake): a dispatched task whose message
      fails `TARGET_SESSION_LOST` → task `ready`, `redispatchCount` 1, a `kick` notice; the third loss
      (`redispatchCount: 2`) → task `failed` as today; a `failed` message with any other reason →
      `failed` as today; redispatch of a requeued task sends `retryOf` = old correlationId and the
      brief contains the interrupted-attempt line.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests pass; gate.
- [ ] **Step 5:** Commit `feat(autopilot): redispatch a task whose target session was lost`.

---

### Task 4: Deploy and prove it live (controller)

- [ ] `redis-invariants` review of Tasks 2-3 passes (no Critical/Important open).
- [ ] With no task in flight: `pnpm build`, restart the daemon (`luwi stop` / `luwi start`; confirm a
      new `runtimeInstanceId`); the manager relaunches the bridges and orchestrator.
- [ ] Acceptance: dispatch a small real task; while it is `dispatched`, kill that worker's bridge
      process (single pid, not a tree). Expect within one orchestrator cycle: message `failed`
      (`TARGET_SESSION_LOST`), task back to `ready` then `dispatched` to the new session, new message
      with `retryOf`, the goal's `usage.replans` unchanged.
- [ ] Record the outcome in memory.
