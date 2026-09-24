# Autopilot: goals, an orchestrator and workers, with the human in the loop

ADR 0035. Autopilot is a per-project mode under which a LUWI-owned orchestrator loop turns a goal
into tasks, dispatches them to bridge workers, verifies what comes back, reworks once, and asks the
operator when it must. The brain that plans and judges is pluggable — LuwiBot over its own
WebSocket, or a native CLI headless — and never holds a pen: every change to the repository is a
worker's.

## 1. Declare the policy (once per project)

Every agent named here must be an enabled binding of the project (`luwi project agent list`).

```text
luwi autopilot policy --project <id> \
  --coordinator luwibot \
  --worker claude-code codex \
  --reviewer codex \
  --operator-proxy luwibot-chat \
  --protect AGENTS.md packages/redis \
  --max-in-flight 2 --max-per-hour 20
```

- `--coordinator` is the agent the orchestrator registers its session as.
- `--worker` are the agents tasks may be dispatched to (default: every other enabled binding).
- `--reviewer` gets a read-only review task after each completed work task, never its own author.
- `--operator-proxy` are agents whose sessions may approve, answer and abandon **for the operator**
  — the LuwiBot chat, so the human in that chat stays in the loop.
- `--protect` are project-relative paths that always wait for approval at dispatch, in every mode.
  A task that declares no paths counts as touching the whole project.

The policy is written to the project's `.luwi/manifest.json` (`data.autopilot`) and projected into
Redis; the daemon re-projects it at every owned start. The **mode** is never written to a
manifest: it is runtime state, default `off`, and `luwi reset` leaves every project `off`.

## 2. Start the workers and the orchestrator

Workers are the ADR 0031 bridges, with their own permission model after `--`:

```text
luwi session bridge native claude --project <id> -- --allowedTools mcp__luwi-runtime,Edit,Bash
luwi session bridge native codex  --project <id> -- --sandbox workspace-write
```

Two things a Claude worker must have or it will do the edit and then fail to finish it:
`mcp__luwi-runtime`, so it can call `luwi_respond_to_message` to complete the task (without it the
bridge only ever sees an unfinished message and closes it `failed`); and `Edit` rather than `Write`
— Claude's file-permission rules key on `Edit(path)`, which covers `Write`, `Edit` and `MultiEdit`,
so a bare `Write` allow grants nothing. A worker that only edits but never commits needs `Bash` too.

The orchestrator is one process per project. Its brain is chosen on the command line:

```text
luwi session bridge orchestrator --project <id> --brain luwibot-ws --brain-url ws://127.0.0.1:3100/chat
luwi session bridge orchestrator --project <id> --brain claude -- --allowedTools Read,Grep
```

For a native brain, everything after `--` is the judgment run's permission model; grant it no
write tool. The orchestrator wakes on its inbox (worker responses and notices) and on a tick
(`--tick-ms`, default 60 s). It is stateless: stop and restart it at any time and it resumes from
the store.

## 3. Switch the mode

```text
luwi autopilot mode supervised --project <id>   # plans, replans and reworks wait for approval
luwi autopilot mode autopilot  --project <id>   # runs within budgets; protected paths still gate
luwi autopilot mode off        --project <id>   # no new dispatch; a running worker finishes or times out
```

Switching sends a `mode_changed` notice to the coordinator's inbox; `luwi autopilot show` tells
whether a coordinator session is online. Autopilot on with no orchestrator running is a visible
state that dispatches nothing, not an error.

## 4. Give it a goal

```text
luwi goal create --project <id> --title "Retry the flaky import" \
  --objective "Make the transcript import survive a truncated last line." \
  --criterion "pnpm test passes" --criterion "no new dependency"
```

Or from the LuwiBot chat: the bot's `luwi_create_goal` tool creates the same goal on the
operator's behalf. Then:

- **supervised**: the orchestrator plans; `luwi goal show <goalId>` shows the plan; approve with
  `luwi goal approve-plan <goalId>` (or `luwi_approve_plan` from the chat when `luwibot-chat` is an
  operator proxy). Approving a plan approves every task in it.
- **autopilot**: tasks are dispatched as they become ready, within `maxInFlight` and the hourly
  window, never over a path another in-flight task or a foreign lease holds.
- A completed task is checked deterministically (evidence, commits known to the Git observation, a
  test claim), reviewed by the reviewer when one is configured, and judged by the brain: `accept`,
  `rework` (one bounded follow-up), or `escalate`.
- A `blocked` goal carries one question. Answer it with `luwi goal answer <goalId> --text …` or
  `luwi_answer_goal` from the chat; `luwi goal abandon <goalId>` ends it.

`luwi task list --project <id> --goal <goalId>` shows every task with its state, outcome, checks and
verdict; the ticker shows `goal.*`, `task.*` and `orchestrator.judgment.decided` as they happen.

## What the runtime guarantees, and what it cannot

- The mode and the policy are the operator's; no MCP tool changes them.
- Dispatch is the only choke point: an `instruction` from the coordinator outside a task is
  refused (`AUTOPILOT_DISPATCH_REQUIRED`); questions stay free.
- A refused dispatch is a 200 with `outcome: 'denied'` and a `task.dispatch.denied` event.
- Budgets are atomic where it matters: in-flight, hourly rate and path overlap are re-checked
  inside `luwi_task_dispatch_v1`.
- An invalid brain answer goes back once with the refusals, then escalates; a decision under the
  goal's `minConfidence` is never applied; three consecutive brain failures escalate.
- LUWI still cannot stop a worker mid-edit (§3) and runs no test command of its own; verification
  reads the worker's evidence and the runtime's own observations.

## Not built yet

The dashboard has no autopilot section (goals and tasks are visible through the CLI, MCP and the
ticker); `hermes` is not a native brain provider until its CLI is measured; `luwi autopilot up` does
not exist (start the bridges yourself); terminal tasks are not swept for retention; the
`scope_exceeded` check against transcript file observations is not wired.
