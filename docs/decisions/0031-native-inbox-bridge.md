# ADR 0031: Native inbox bridge for unattended headless agent runs

Status: Accepted  
Date: 2026-09-08

## Context

ADR 0006 gave every session a durable inbox and ADR 0025 proved one unattended reader of it — the
DeepSeek ACP bridge. For the three vendors LUWI actually coordinates, nothing reads the inbox
without a person. `session attach`, `agent run` and the Claude and Antigravity hooks register,
heartbeat and renew leases; the message then waits until someone types "check your inbox".

The Albanoosh run of 2026-09-08 measured the cost. The daemon logged no error and delivered all 14
messages; 4 timed out, every one on a 3–5 minute deadline, and the acknowledgements that did happen
took 15 to 474 seconds. Two further facts turned a latency problem into a correctness one.
`selectMessageTarget` ranks candidates by status before heartbeat, and no client ever moves a
session off `starting`, so with several sessions online the newest heartbeat — an arbitrary helper —
is chosen; a manual `session attach` with no reader behind it is therefore a target that guarantees
a timeout. And Claude Code fires `SessionStart` in `--print` mode as well, while `agent run` strips
an inherited `LUWI_SESSION_ID` before spawning, so one headless run registered two sessions, one of
them a ghost. Seven distinct `claude-code` session ids appeared in a single morning.

`AGENTS.md` §3 keeps LUWI out of terminals and §21 leaves task orchestration unapproved. Both
constraints hold here: nothing below writes into an interactive terminal, and nothing assigns or
schedules work. The owner approved this decision in conversation on 2026-09-08 after the evidence
above was presented; the design is `docs/superpowers/specs/2026-09-08-native-inbox-bridge-design.md`.

## Decision

### One unattended session per bridge, served by headless runs

`luwi session bridge native <claude|codex|gemini> [nativeArgs...]` registers one ordinary LUWI
session through the existing session bootstrap — bounded requests, retrying heartbeat, rotation on
`SESSION_NOT_FOUND`/`SESSION_TERMINAL` (ADR 0030), lease renewal (ADR 0026), close on stop — with
metadata `{ bridge: 'native-headless', provider }`. It sets the session `idle` while waiting and
`tool_running` while a child runs, so the router's existing status ranking prefers it over any
`starting` helper and the dashboard row is honest.

For each claimed request the bridge acknowledges, marks processing, and starts **one** headless
native process — `claude --print <prompt> …`, `codex exec … <prompt>`, `gemini --prompt <prompt> …`
— in the session's working directory with `LUWI_SESSION_ID` and `LUWI_DAEMON_URL` inherited, so the
vendor's configured `luwi-runtime` MCP server binds to this session. The message content is the
child's prompt behind a fixed, visible framing that names the correlation id and the reply tool.
Everything after `--` reaches the native CLI unchanged; the bridge adds no permission of its own.

### The bridge completes only what the child did not

The child is expected to finish the message through `luwi_respond_to_message` (or reject/fail).
After it exits the bridge reads the message once. If it is terminal, the child completed it. If it
is still `processing`, the bridge writes `fail` — naming the exit code, the deadline stop, or the
operator stop, with a bounded output tail — and never `answered`: a bridge that turns stdout into
an answer would be asserting a confidence it does not have. A request recovered in `processing`
from an earlier claim is failed rather than replayed, as ADR 0025 decided for DeepSeek. Processing
is sequential; the inbox is the queue.

### Deadline and stop use the owned-process cleanup that already exists

The child is stopped at the message's `deadlineAt`, and on an operator `SIGINT`/`SIGTERM`, through
the same owned-process-tree cleanup `agent run` uses. A prompt larger than 30 000 bytes is failed
before any spawn, because the Windows command line is capped at 32 767 characters.

### A process launched under a LUWI session attaches no second one

Both attach hooks exit immediately when `LUWI_SESSION_ID` is inherited. A native process started
by this bridge or by `agent run` already has its session; registering another created the ghosts.

### What is not done

No daemon route, protocol shape, Redis key, Function, or `luwi_v1` version changes. No new
dependency or package; the bridge lives in `@luwi/cli` beside the DeepSeek one and shares its
daemon-client type. No scheduler, no work assignment, no change to routing or to the message
protocol. No retries or replays, no concurrent children, no stdin prompt delivery, no memory across
messages beyond what the operator passes as a native resume argument. No terminal injection and no
native-configuration write. Antigravity is not verified headless: `agy` is not installed on this
machine, so the `gemini` shape is carried but only claude and codex are proven live.

## Consequences

A message to a bridged agent is picked up within one claim block (30 s), executed unattended, and
always reaches a terminal state that tells the sender what happened. With one `idle` bridge per
agent and project, target selection is deterministic instead of heartbeat-random, and the dashboard's
status and task columns stop lying.

The costs are real. Every message is a fresh headless run, paid in tokens and start-up time, with no
conversational memory unless the vendor's own resume is passed through. The child's permissions are
exactly what the operator gives it on the command line; a bridge started with broad permissions will
edit files unattended. A message in flight when the bridge process dies stays with the dead session
until its deadline — sessions are runtime identity, not configuration, and nothing here changes
that. A session rotation during a child run strands that child's MCP binding; the child fails and
the bridge reports it, but the work is lost. The bridge trusts the child's own MCP report: a child
that answers wrongly is not caught here. And the framing is one more thing in the prompt the agent
reads; it is fixed and visible, and any change to it is a code change with a test.
