# Native inbox bridge design

Date: 2026-09-08. Owner approval: the design below was presented in conversation and approved
("evet aç") before this file was written. Decision record: ADR 0031.

## Problem

The runtime delivered every message on 2026-09-08 (14 in the Albanoosh project, 0 daemon errors),
yet 4 of them timed out. Each one carried a 3–5 minute deadline, and every acknowledgement that day
took 15–474 s, because a human had to tell the agent to read its inbox. Three facts make the gap
structural rather than incidental:

1. **No listener.** `session attach`, `agent run` and the Claude/Antigravity hooks only register,
   heartbeat and renew leases. Nothing claims the inbox unattended.
2. **Selection is effectively random.** `selectMessageTarget` ranks by status, then by newest
   heartbeat. No client ever leaves `starting`, so every candidate ties and the newest heartbeat —
   an arbitrary helper — wins. A manual `session attach` with no reader behind it is a target that
   guarantees a timeout.
3. **Ghost sessions.** `SessionStart` hooks fire in `claude -p` mode too, and `agent run` deletes an
   inherited `LUWI_SESSION_ID` before spawning, so one headless Claude run registers two LUWI
   sessions — one bound to the MCP server, one nobody reads. Seven distinct `claude-code` session
   ids appeared in one morning.

## Goal

One long-lived, unattended LUWI session per (agent, project) that serves its own durable inbox by
running the native agent headless once per message, so a message to that agent is picked up within
one claim block (≤ 30 s), executed, and completed — by the child through MCP, or by the bridge with
an honest `failed` — without a human relay, and so the router always has exactly one `idle`
candidate to choose.

## Non-goals

No daemon, protocol, Redis, or Redis Function change. No new dependency or package. No scheduler,
work assignment, or routing change (this is not the §21 "task orchestration"). No retries, replays,
or concurrent children. No stdin prompt delivery. No terminal injection and no native-configuration
write. No Antigravity headless verification: `agy` is not installed on this machine.

## Architecture

```
luwi session bridge native <provider> [-- nativeArgs...]
   │
   ├─ createSessionBootstrap   register · heartbeat · rotate · renew leases · close   (unchanged)
   │
   └─ createNativeBridge       pollOnce():  claim(blockMs) → for each request item:
                                  get → ack → processing → status tool_running
                                  → executor.run({ prompt, deadlineAt })     ← one headless child
                                  → get again: terminal? child completed it : bridge fails it
                                  → status idle
```

### Files

| File                                  | Change                                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cli/src/bridge-daemon.ts`       | New. `BridgeDaemonClient` type, `isTerminalMessageState`, `boundedAnswer` — moved out of the DeepSeek bridge, which re-exports them.               |
| `apps/cli/src/native-bridge.ts`       | New. `createNativeBridge`, `NativeBridgeExecutor`, `nativeHeadlessArguments`, `framePrompt`.                                                       |
| `apps/cli/src/agent-runner.ts`        | `captureOutput?: (chunk: string) => void` on the process input; when present stdio is `['ignore', 'pipe', 'pipe']` and both streams are forwarded. |
| `apps/cli/src/cli.ts`                 | `session bridge native` command; the daemon client the DeepSeek command builds inline becomes `createBridgeDaemonClient` and is shared.            |
| `scripts/claude-attach-hook.mjs`      | Exit before doing anything when `LUWI_SESSION_ID` is inherited.                                                                                    |
| `scripts/antigravity-attach-hook.mjs` | Same guard; still answers `{}`.                                                                                                                    |

### Command

```
luwi session bridge native <claude|codex|gemini> [nativeArgs...]
  --project <id>            explicit project (else derived from the working directory, as agent run)
  --agent-id <id>           explicit AgentDefinition id (else the one enabled binding of that kind)
  --working-directory <p>   default cwd
  --executable <path>       override the registered executable
  --bridge-instance <id>    consumer identity, default native-bridge
  --limit 1                 items per claim (1–100); processing is sequential regardless
  --block-ms 30000          claim block (0–30000)
  --min-idle-ms 15000       pending recovery idle
  --heartbeat-ms 5000 · --lease-renew-ms 150000 · --connect-timeout-ms 2000 · --url
```

Everything after `--` goes to the native CLI unchanged. That is the whole permission model: the
operator decides, per bridge, what the child may do (`--allowedTools mcp__luwi-runtime`,
`--permission-mode acceptEdits`, `--sandbox workspace-write`, …). The bridge adds nothing.

### Headless argument shapes

| Provider | argv                          | Why this order                                                   |
| -------- | ----------------------------- | ---------------------------------------------------------------- |
| claude   | `--print <prompt> ...native`  | `--allowedTools` is variadic and would swallow a trailing prompt |
| codex    | `exec ...native <prompt>`     | `codex exec [OPTIONS] [PROMPT]`                                  |
| gemini   | `--prompt <prompt> ...native` | `-p/--prompt` takes a value                                      |

### Prompt framing

Fixed, visible text in front of the message content — passed only as the argv prompt of a process
the bridge itself starts:

```
LUWI message <correlationId> (<kind>) from agent <sourceAgentId>, subject: <subject|none>.
You are LUWI session <sessionId> for agent <agentId>. When you are done, report through the
luwi-runtime MCP tools: call luwi_respond_to_message with correlationId "<correlationId>" and a
status of answered, partially_answered, rejected or failed. If those tools are unavailable, print
your final answer as plain text. Evidence requested: <list|none>.

<content>
```

A prompt over 30 000 bytes is failed with `NATIVE_PROMPT_TOO_LONG` before any spawn — the Windows
command line is capped at 32 767 characters. `ponytail:` stdin delivery is the upgrade path if real
messages ever approach the 32 KiB content limit; today's largest was ~3 KB.

### Completion rules

The child is expected to complete the message through the bound MCP server. After the child exits
the bridge reads the message once more:

| Observed                                | Bridge action                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| terminal (child completed it)           | nothing; report `completedBy: native`                                                                                  |
| still `processing`, exit code 0         | `fail`: "exited (code 0) without completing the message", plus output tail                                             |
| still `processing`, exit code ≠ 0       | `fail`: "exited (code N)", plus output tail                                                                            |
| stopped at deadline                     | `fail`: "stopped at the message deadline" (the daemon may already have timed it out; a terminal conflict is swallowed) |
| bridge stopping (operator signal)       | `fail`: "bridge stopped before the agent finished"                                                                     |
| recovered in `processing` at claim      | `fail`: not replayed (side effects unknown) — same rule as the DeepSeek bridge                                         |
| terminal at claim                       | skipped                                                                                                                |
| executor throws (spawn / cleanup error) | `fail` the message, then rethrow: the bridge exits, the operator fixes it                                              |

The bridge never writes `answered`. It has no basis to.

Output tail: the last 4 096 characters of combined stdout/stderr, kept only for the failure answer
and for the per-message report line on the bridge's stdout.

### Session lifecycle

The bootstrap owns the session exactly as `agent run` does: bounded requests, retrying heartbeat,
rotation to a fresh session on `SESSION_NOT_FOUND` / `SESSION_TERMINAL` (ADR 0030), lease renewal
(ADR 0026), close on stop. The bridge reads the current session id at every poll and sets `idle` on
each session it sees for the first time, so a rotated session is selectable immediately. Metadata:
`{ bridge: 'native-headless', provider }`.

Deadline: the CLI executor arms one timer per child that fires `SIGTERM` into the child's own
signal source; the process runner's existing owned-tree cleanup stops it. An operator `SIGINT` /
`SIGTERM` is relayed the same way and then closes the session.

### Ghost prevention

Both attach hooks return immediately when `LUWI_SESSION_ID` is already in the environment: the
process was launched under a LUWI session (by this bridge or by `agent run`) and must not register
a second one.

## Testing

- `native-bridge.test.ts`: happy path (child completes; bridge writes nothing but status), exit 0
  without completion, non-zero exit, deadline stop, operator stop, recovered processing, terminal
  at claim, response items ignored, prompt too long, argument shapes for the three providers,
  first-seen session set idle after rotation.
- `agent-runner.test.ts`: `captureOutput` switches stdio to pipes and forwards both streams.
- `cli.test.ts`: `session bridge native` wires bootstrap, status, claim, executor argv/env, and
  close on signal.
- `attach-hook-guard.test.ts`: both scripts exit 0 and write nothing under an inherited session id.
- Live: bridge for `claude-code` in Albanoosh; `luwi message ask --target-agent claude-code` with a
  2-minute deadline from another session; expect `responded` by the child within one claim block.
