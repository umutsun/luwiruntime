# Per-Project Autopilot Implementation Plan

> **For agentic workers:** this plan is **not started** — the owner asked for the plan and explicitly
> not for the work (2026-09-17: "planla, işe başlama"). Nothing below may be executed until ADR 0035
> moves from `Proposed` to `Accepted` and the owner says so. When it is: REQUIRED SUB-SKILL
> superpowers:test-driven-development for every task; run the `redis-invariants` agent over every
> change under `packages/redis/` and every daemon change that appends events; steps use checkbox
> (`- [ ]`) syntax for tracking, and none is checked.

**Goal:** One operator-held switch per project — `off`, `supervised`, `autopilot` — under which a
coordinator session (LuwiBot) records tasks, dispatches them to bridge workers as ordinary
`instruction` messages within a declared budget, and is woken by results, approvals and mode changes;
visible and gateable in the project drawer; honest about what the runtime cannot enforce.

**Spec:** `docs/superpowers/specs/2026-09-17-project-autopilot-design.md` · **ADR:** 0035 (Proposed)

**Constraints:** `AGENTS.md` is binding — §3 (no terminal injection), §5 (no task package), §7 (read
before touching Functions; declared keys; no policy in Lua; no trimming in transition Functions), §12
(no control-plane write through MCP), §13 (commit only when asked), §15 (every transition tested),
§19 (`/verify` green before claiming done). `luwi_v1` → v13 lands in Phase 2 and nowhere else. No new
package or dependency. `.luwi/manifest.json` is written only through the canonical store. The native
bridge, its framing and `luwi_message_request_v1` do not change — a test pins them.

**Sequencing rule (§20):** each phase is a vertical, runnable increment that leaves the repository
green and truthful. Shipping one phase does not authorize the next; the owner decides at every gate.

---

## Phase 0 — Measure and decide (no code)

The repository's discipline is measurement before specification (B1's spec was corrected twice by
measurement; the Albanoosh run turned a latency problem into a correctness one). "Hermes" appears
nowhere in this tree, and the only known LuwiBot fact is the dashboard's WebSocket to
`127.0.0.1:3100/chat`.

### Task 0.1: Measure LuwiBot on this machine

- [ ] Record how LuwiBot is installed and started (process, working directory, config root, version),
      and whether it is a Hermes-based agent. Write the findings to
      `docs/superpowers/specs/2026-09-XX-luwibot-coordinator-measurement.md` — facts only, with the
      commands that produced them.
- [ ] Headless one-shot: does a command exist that takes a prompt, runs to completion and exits with a
      code? Record the exact argv, exit codes, where output goes, and whether it accepts a working
      directory. Measure one run's wall time and token usage if the tool reports it.
- [ ] MCP client: how a stdio server is configured (file, keys, env forwarding), whether it forwards
      `LUWI_SESSION_ID`/`LUWI_DAEMON_URL` to the server process, and how tool calls are approved
      unattended. Measure by registering `apps/mcp-server/dist/main.js` as `luwi-runtime` against the
      fixture daemon with a registered session and calling `luwi_list_sessions`.
- [ ] Scheduler: does it have a periodic or cron trigger of its own? Record the granularity.
- [ ] Conversation identity: is there a stable per-conversation id on disk or in the API, so a native
      reference could be declared (ADR 0022)? If not, say so — the coordinator then registers unbound.
- [ ] Real message sizes: `luwi message list --project <id>` for every project; record the largest
      `instruction` content in bytes against the 32 KiB brief bound and the 30 000-byte headless cap.

### Task 0.2: Decide the coordinator run shape (owner gate G1)

- [ ] If Task 0.1 found a headless one-shot: the coordinator runs as `luwi session bridge native
  hermes -- <its permission args>` — one headless run per inbox item (response or notice), ADR 0031's
      proven shape, crash-safe, permissions on the command line. `hermes` joins `NativeAgentName` with
      its argv shape measured, not guessed.
- [ ] Otherwise: the coordinator runs long-lived, bound through a session file (`session attach
  --session-out` or an equivalent hook), and its own loop polls `luwi_inbox_next` (block ≤ 30 s) plus
      its own scheduler as the periodic wake.
- [ ] Record the decision in the measurement spec and in ADR 0035's Consequences before Phase 1.

### Task 0.3: Owner gates recorded in ADR 0035

| Gate | Question                                                                                               | Default in this plan                              |
| ---- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| G1   | Coordinator run shape (Task 0.2)                                                                       | bridge-per-item if a headless one-shot exists     |
| G2   | `luwi_v1` → v13 in Phase 2 (two record kinds, seven Functions; one daemon restart)                     | yes                                               |
| G3   | The `notice` inbox item in Phase 1 (a protocol change every inbox consumer re-validates)               | yes — without it "enable" does nothing observable |
| G4   | Policy canonical in `.luwi/manifest.json`; mode Redis-only and never canonical                         | yes                                               |
| G5   | A fourth dashboard write module, `api/autopilot-mutations.ts`                                          | yes                                               |
| G6   | `supervised` gates every dispatch; `autopilot` gates only protected paths; empty paths = whole project | yes                                               |

- [ ] Ask the owner; set ADR 0035 to `Accepted` with the answers, or stop here.

**Exit:** the measurement spec exists with commands and numbers; G1–G6 answered; ADR 0035 `Accepted`.
No code changed.

---

## Phase 1 — The switch: autopilot record, policy, mode, notice

Vertical slice: after this phase an operator can declare a policy and flip a project to `supervised`
or `autopilot`, the ticker shows it, and the coordinator's inbox receives a `notice`. No tasks yet.

### Task 1.1: Protocol

- [ ] `packages/protocol/src/autopilot.ts`: `autopilotModeSchema`, `autopilotPolicySchema` (bounds
      from the spec; `workerAgentIds` never contains `coordinatorAgentId`; `protectedPaths` through
      `normalizeLeasePath`), `autopilotRecordSchema`, `autopilotPolicyPutRequestSchema` (strict),
      `autopilotModeRequestSchema`, `autopilotKickResponseSchema` (`coordinatorNotified`), collection
      schemas, error codes. Tests: every bound, the coordinator-in-workers refusal, path normalization.
- [ ] `packages/protocol/src/message.ts`: `inboxNoticeEnvelopeSchema` and the widened
      `inboxEnvelopeSchema` union. Tests: a notice parses; a request/response still parses; an unknown
      `itemKind` is refused.
- [ ] `packages/protocol/src/runtime-event.ts`: `autopilot.mode.changed`, `autopilot.policy.updated`,
      `autopilot.notice.queued`. Test: the enum count moves by three.
- [ ] Export from `index.ts` and `browser.ts` (the dashboard needs the record and mode schemas).

### Task 1.2: Runtime (pure)

- [ ] `packages/runtime/src/autopilot-policy.ts`: `evaluateModeChange(record, requested)` →
      `changed | unchanged | refused(not_configured)`; `effectiveWorkers(policy, bindings)`.
- [ ] `packages/runtime/src/message-routing.ts`: factor the candidate ranking into
      `rankAgentSessions({ sessions, projectId, agentId })`; `selectMessageTarget` calls it. Test: order
      identical to today for every existing case (the PM-session tests stay byte-identical).
- [ ] `packages/runtime/src/message-policy.ts`: `coordinatorInstructionRefused({ policy, sourceAgentId,
  kind, origin })` — `true` only for `instruction` from the coordinator with `origin !== 'task'`.

### Task 1.3: Redis (read §7 first; `redis-invariants` before completing)

- [ ] `redis-keys.ts`: `projectAutopilot(projectId)`, `autopilotProjects`.
- [ ] `function-library.ts`: `luwi_autopilot_policy_put_v1` (keys: record, projects set, global and
      project streams; CAS on `version`; validates the stored record before overwriting; `unchanged`
      when the hash matches; appends `autopilot.policy.updated`) and `luwi_autopilot_mode_set_v1`
      (refuses a non-`off` mode with no policy; `unchanged` on the same mode; appends
      `autopilot.mode.changed`), `luwi_inbox_notice_v1` (keys: target inbox stream, two event streams;
      preflights; `XADD` the notice; appends `autopilot.notice.queued`). No trimming.
- [ ] `function-registry.ts`: three names added; **version stays 12 in this phase** (a new function reloads on its own, as B0's `native_declare` did at v11; the record-shape bump waits for Phase 2 so the library moves once).
- [ ] `session-inbox.ts`: a `notice` branch in `claimSessionInbox` — validated by the notice schema,
      acknowledged on claim, returned in `items`, no message lookup. Without it the existing path
      acknowledges a notice as `projection_missing` and drops it.
- [ ] `autopilot-repository.ts`: `putPolicy`, `setMode`, `get`, `list`, `queueNotice`; every read
      validated with the protocol schemas; `REDIS_DATA_INVALID` on a bad record.
- [ ] Integration tests (`/redis-it`): put/get/list, CAS conflict, mode without policy refused, the
      notice lands in the stream, the claim path's new `notice` branch returns it once and acknowledges it
      on claim, `XAUTOCLAIM` never re-delivers it, no partial write on
      any refusal.

### Task 1.4: Canonical store and reconciliation

- [ ] `canonical-store.ts`: `readProjectAutopilotPolicy(projectRoot)` and
      `renderProjectAutopilotPolicy(project, policy)` in `.luwi/manifest.json` `data.autopilot`, same
      content-hash validation as `agentDefaults`; a malformed block fails with
      `CONFIG_RECONCILIATION_REQUIRED`.
- [ ] `runtime.ts` owned-start reconciliation: after bindings are restored, project every manifest
      policy through `putPolicy`; a policy naming an unknown or disabled agent fails readiness. Tests
      beside the binding-reconciliation ones.

### Task 1.5: Daemon service and routes

- [ ] `apps/daemon/src/autopilot-service.ts`: `get`, `list`, `putPolicy` (validate agents against the
      project's enabled bindings → `AUTOPILOT_POLICY_INVALID`; write the manifest **then** project;
      under `withMutation`), `setMode` (operator; queues a `mode_changed` notice to the best-ranked
      coordinator session; returns `coordinatorNotified`), `kick`, `coordinatorSessions(projectId)`.
- [ ] `message-service.ts`: injected `autopilotPolicy(projectId)` seam; `ask` refuses per Task 1.2
      with `AUTOPILOT_DISPATCH_REQUIRED` (409); an internal `askForTask` (not exported to routes) that
      passes `origin: 'task'` — built now, first used in Phase 2.
- [ ] `app.ts`: `GET /api/v1/autopilot`, `GET/PUT …/projects/:projectId/autopilot[/policy]`,
      `POST …/autopilot/mode`, `POST …/autopilot/kick`. Route tests: validation, 403/409 mapping, the
      Origin-less-POST content-type rule.

### Task 1.6: CLI

- [ ] `luwi autopilot show|policy|mode|kick` in `cli.ts`; tests for argv → request and error codes.

### Task 1.7: MCP

- [ ] `luwi_get_autopilot` (read, project-bounded, with derived coordinator presence);
      `luwi_inbox_next` output schema widened to the notice item; `luwi_ask_agent` surfaces
      `AUTOPILOT_DISPATCH_REQUIRED` as a structured error. Tests in `tools.test.ts`.

### Task 1.8: Dashboard

- [ ] `api/autopilot-scope.ts` (project-scoped read; invalidation on `autopilot.*`) and the snapshot's
      `autopilot` resource in `bootstrap.ts`/`pulse.ts`.
- [ ] `api/autopilot-mutations.ts` — `setMode`, `putPolicy`, `kick`; added to the
      `product-independence.test.ts` allowlist (four modules; prohibited operations still forbidden).
- [ ] `components/autopilot-panel.tsx`: header row, segmented mode control, `ConfirmDialog` on
      enabling, absent-coordinator status line, wake button. Mounted in the project drawer above
      `ProjectDetail`. Tests: control state per mode, confirmation content names coordinator, workers,
      limits and protected paths, the off path needs no dialog, wake disabled while absent.
- [ ] `overview/model.ts`: `OverviewProject.autopilot`; Board chip; drill-down fact row; ticker labels.
      Tests in `model.test.ts`, `overview.test.tsx`, `app.test.tsx` (drawer section is reachable and
      named).
- [ ] `class-coverage.test.ts` and `tokens.test.ts` register the new files; both themes checked.

### Task 1.9: Seed, docs, gate

- [ ] `scripts/seed-runtime.ts`: a `seed-coordinator` agent (kind `other`) bound to the fixture project
      and a session for it set `idle`; a policy naming it with `seed-claude` and `seed-codex` as workers
      and one protected path; mode `supervised`. Re-runnable (`unchanged` tolerated).
- [ ] Docs: `AGENTS.md` §7 keys, §8 events, §21 approval paragraph; `README.md` current status;
      `CLAUDE.md` status and tool counts; `docs/architecture/overview.md`.
- [ ] `pnpm format:write`, then `/verify`.

**Exit:** on the fixture daemon, `luwi autopilot mode --project <id> supervised` answers with
`coordinatorNotified: true`, the coordinator session's inbox yields a `notice` through
`luwi_inbox_next`, the ticker shows `autopilot.mode.changed`, the project tile shows `SUPERVISED`, and
a coordinator `luwi_ask_agent` with `kind: 'instruction'` is refused. `/verify` green.

---

## Phase 2 — The task domain and dispatch

Vertical slice: after this phase the seeded coordinator creates a task, dispatch is denied in `off`,
gated in `supervised`, dispatched in `autopilot`, and the seeded worker's answer completes it. The
board shows every state.

### Task 2.1: Protocol

- [ ] `packages/protocol/src/task.ts`: `taskStateSchema`, `taskSchema` (bounds from the spec),
      `taskCreateRequestSchema`, `taskUpdateRequestSchema`, `taskDispatchResponseSchema`
      (`dispatched | gated | denied` with the reason enum), approve/reject/cancel request schemas,
      list query and collection schemas, error codes, constants (`TASK_MAX_ACTIVE_PER_PROJECT`,
      `TASK_MAX_PATHS`, `TASK_MAX_DEPENDENCIES`, `TASK_MAX_BRIEF_BYTES = MESSAGE_MAX_CONTENT_BYTES`).
- [ ] `runtime-event.ts`: the nine `task.*` types. Exports for node and browser.

### Task 2.2: Runtime (pure)

- [ ] `packages/runtime/src/task-state.ts`: the transition table; `applyTransition` returns the next
      state or a typed refusal; every edge in the spec diagram tested, including "update returns a gated
      task to `ready`" and "no cancel from dispatching/dispatched".
- [ ] `packages/runtime/src/task-dispatch-policy.ts`: `evaluateDispatch` with the spec's precedence
      table; one test per reason; empty paths = whole project; overlap through `leasePathsConflict`.
- [ ] `packages/runtime/src/task-reconciliation.ts`: pure planner for the sweep — given tasks in
      `dispatching`/`dispatched` and their messages' states, which repairs and completions to run.

### Task 2.3: Redis (§7; `redis-invariants`)

- [ ] Keys: `task(taskId)`, `projectTasks`, `projectTasksActive`, `projectTaskDispatches`,
      `taskCorrelation(correlationId)`, `tasksTerminal`.
- [ ] Functions: `luwi_task_create_v1` (active-count bound on the declared zset/hash; `TASK_LIMIT_REACHED`),
      `luwi_task_update_v1` (CAS; allowed states only; gated → ready), `luwi_task_dispatch_v1`
      (CAS; state; in-flight count from the active hash; rate window `ZCOUNT` with the window and limits as arguments — the Function deletes nothing, aged
      entries are the retention sweep's; `dispatchSourceSessionId` recorded; overlap scan over the active hash; `HSET` + `ZADD`; no event),
      `luwi_task_transition_v1` (`gate`, `approve`, `reject`, `cancel`, `dispatched` with the reverse
      index, `complete` with `HDEL` + terminal index + outcome, `dispatch_failed`; each appends its one
      event). Every refusal leaves no partial state.
- [ ] `function-registry.ts`: **version 13**; the comment states why (two new record kinds).
- [ ] `message-repository.ts`: a bounded `findByIdempotencyKey(sourceSessionId, key)` read over the
      existing idempotency index, for dispatch repair.
- [ ] `task-repository.ts` with validated reads, `listProjectTasks` (bounded, over-fetch by one for
      `truncated`), `findDispatching`, `findDispatchedWithTerminalMessage`, terminal retention sweep.
- [ ] Integration tests: every Function's success and refusal; **the dispatch race** (two callers, one
      slot → exactly one `dispatching`); aged rate-window entries removed by the sweep and never by the Function; CAS conflict; complete is idempotent on a
      repeat; retention removes a terminal task and its reverse index; v12 → v13 reload compatibility.

### Task 2.4: Daemon

- [ ] `apps/daemon/src/task-service.ts`: `create`, `update`, `get`, `list`, `dispatch` (coordinator
      identity → `AUTOPILOT_NOT_COORDINATOR`; `evaluateDispatch` with live leases and sessions; the
      two-step dispatch through `messages.askForTask` with `Idempotency-Key: task:<id>`; `gated` writes
      the gate transition; `denied` appends `task.dispatch.denied` and nothing else), `approve`,
      `reject`, `cancel` (operator or coordinator), `completeFromMessage(correlationId, state, response)`,
      `reconcileOnce()` (repair order: the issuing session's idempotency index first, a re-issue from a
      live coordinator only when it holds nothing, `failed` past the 24 h retention).
- [ ] `message-service.ts`: the `onTerminal` seam fired after `respond`, `reject`, `fail` and
      `timeoutMessage` succeed; wired to `completeFromMessage` in `runtime.ts`.
- [ ] `runtime.ts`: `reconcileOnce` at owned start and on the retention timer; cleared on both teardown
      paths; the `runtime.test.ts` timer guard extended.
- [ ] `app.ts`: the task routes from the spec; tests for validation, identity refusal, the three
      dispatch outcomes as 200 bodies, operator-only approve/reject.
- [ ] A pin test: `native-bridge.test.ts` asserts `framePrompt` and `nativeHeadlessArguments` output
      byte-for-byte against fixtures, so this phase provably left the worker side alone.

### Task 2.5: CLI and MCP

- [ ] `luwi task list|show|create|dispatch|approve|reject|cancel`; tests.
- [ ] `luwi_list_tasks`, `luwi_get_task`, `luwi_create_task`, `luwi_update_task`, `luwi_dispatch_task`,
      `luwi_cancel_task`; identity from the binding; project-bounded; output schemas protocol-owned;
      tests. `CLAUDE.md` tool counts: 43 tools, 28 reads, 15 writes.

### Task 2.6: Dashboard

- [ ] `api/autopilot-scope.ts` gains the task list (invalidated on `task.*`);
      `api/autopilot-mutations.ts` gains `approve`, `reject`, `cancel`.
- [ ] `components/task-board.tsx`: grouped list, rows, controls per state, message link, outcome first
      line, truncation notice, empty state. Tests against a fake gateway for approve/reject/cancel and
      for the no-control-on-dispatched rule.
- [ ] Overview: `inFlight`/`maxInFlight` on the tile chip and the drill-down row; Timeline marks
      through the existing activity feed; ticker labels for the four task events.

### Task 2.7: Seed, docs, gate

- [ ] Seed: set the `seed-claude` worker session `idle` (the `starting` trap), then three tasks through
      the real routes — one left `awaiting_approval`, one dispatched under `autopilot` and answered by
      claiming the worker's inbox and responding, one `done` — and one denied dispatch so
      `task.dispatch.denied` is in the fixture's activity.
- [ ] Docs: §7 keys, §8 events, §21, README, CLAUDE.md (v13, restart note), overview.md.
- [ ] `pnpm format:write`, `/verify`, and `/redis-it`.

**Exit:** the fixture proves every state and every outcome; the dispatch race test passes against
Memurai; the bridge pin test is green; `/verify` green.

---

## Phase 3 — The live coordinator and policy editing

### Task 3.1: The coordinator's run shape (per G1)

- [ ] If bridge-per-item: add `hermes` to `NativeAgentName` with the measured argv, a
      `session bridge native hermes` live path, and the same ghost-prevention rule (a coordinator
      launched under a LUWI session attaches no second one).
- [ ] If long-lived: document the session-file binding and the loop (`luwi_inbox_next` block, then
      `luwi_get_autopilot` and `luwi_list_tasks` on every wake) and provide a `luwi session attach`
      recipe for it.
- [ ] Declare the native reference when Phase 0 found a stable conversation id; otherwise register
      unbound and say so in the drawer's coordinator chip.

### Task 3.2: The coordinator's operating instructions

- [ ] `docs/guides/autopilot-coordinator.md`: the fixed, visible contract the operator installs into
      LuwiBot — on wake read the mode and stop if `off`; claim the inbox; re-read the tasks; create tasks
      with paths, a worker and evidence requirements; dispatch and respect every `gated`/`denied`
      answer without retrying in a loop; never ask a worker to widen its permissions; report in the task
      brief what "done" means. Not executed by LUWI; a document.

### Task 3.3: Policy editing from the drawer

- [ ] `autopilot-panel.tsx` inline policy form (coordinator picker from the project's enabled
      bindings, worker checklist, protected paths, limits) through `putPolicy`; replaces the CLI-only
      sentence. Tests: the coordinator cannot be a worker; limits validated at the edge.
- [ ] Operator-created tasks (`createdBy: operator`) from the board — `POST …/tasks` without a
      `sessionId` — for the coordinator to pick up. Only if the owner wants it at this gate.

### Task 3.4: Live proof on one real project

- [ ] Start the daemon (restart once for v13), a `claude-code` bridge worker with its usual `--`
      permissions, and the LuwiBot coordinator per Task 3.1, all on one registered project.
- [ ] `supervised`: the coordinator proposes two tasks; approve one in the drawer; the worker completes
      it; the board shows `done` with the message link and evidence count; the other stays gated.
- [ ] `autopilot` with `maxInFlight 1`: the coordinator dispatches the second; a third is
      `denied: in_flight_limit` and appears in the ticker; then completes.
- [ ] `off` while a worker runs: no new dispatch; the running task finishes; the board's sentence is
      accurate.
- [ ] Report, per the Albanoosh acceptance format: wall times per hop, tokens per task where
      attributed, every denial with its reason, every gap between design and observation — and correct
      the spec where measurement disagrees with it.

**Exit:** the live report exists; ADR 0035's Consequences carry the measured numbers; README's
"Current status" and `AGENTS.md` §21 say autopilot is built with exactly the limits it has.

---

## Deferred, with reasons (recorded, not dropped)

| Item                                         | Reason                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Retries / re-dispatch                        | A retry hides a failure the coordinator should decide about; a new task is the honest retry.        |
| Worker-created tasks                         | Lets a worker widen its own work; the worker answers with evidence, the coordinator decides.        |
| `eligibleWork` label routing                 | Needs a task taxonomy nothing produces yet; the coordinator names the worker.                       |
| Branch / worktree per task                   | Git mutation, excluded by §21; `writableBranch`/`worktreePath` stay unconsumed.                     |
| GitHub, PR, merge                            | §21 GitHub integration is out of scope.                                                             |
| Token budget per project                     | Attribution is partial for gemini/antigravity workers; a budget that cannot be measured is fiction. |
| Cross-project tasks                          | Messages are same-project by ADR 0006; a task follows its message.                                  |
| Daemon-side planning                         | The runtime must not become the brain (§1, §3, the CLI-first boundary).                             |
| Notifications to the operator (push, e-mail) | Outside the loopback boundary (§4); the drawer and ticker are the surface.                          |
