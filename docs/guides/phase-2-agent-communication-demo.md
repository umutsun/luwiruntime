# Phase 2 agent communication and MCP demo

This walkthrough uses only the loopback daemon API. Bridge output is explicitly simulated;
it does not inspect native agent memory, Git state, tests, or builds unless a later adapter
actually performs those operations.

## 1. Start Redis and the daemon

```powershell
docker compose up -d redis
$env:REDIS_URL = "redis://127.0.0.1:6379"
pnpm --filter @luwi/daemon dev
```

Keep the daemon running. In another PowerShell terminal, register the project and three
sessions:

```powershell
pnpm --filter @luwi/cli dev project register --name "LUWI Runtime" --path .
pnpm --filter @luwi/cli dev session register --project <projectId> --agent claude-sim --working-directory .
pnpm --filter @luwi/cli dev session register --project <projectId> --agent gemini-sim --working-directory .
pnpm --filter @luwi/cli dev session register --project <projectId> --agent codex-sim --working-directory .
```

Record the Claude, Gemini, and Codex session IDs.

## 2. Start the three simulated bridges

Keep the Claude source session online with a manual bridge in its own terminal:

```powershell
pnpm --filter @luwi/cli dev session bridge simulate `
  --session <claudeSessionId> `
  --bridge-instance claude-demo `
  --mode manual
```

This bridge owns the Claude session heartbeat and visibly claims terminal response
notifications without inventing an answer. The MCP server is not a heartbeat owner.

```powershell
pnpm --filter @luwi/cli dev session bridge simulate `
  --session <geminiSessionId> `
  --bridge-instance gemini-demo `
  --mode status-responder
```

The bridge continuously claims its durable inbox. It acknowledges and marks requests
processing before responding with a clearly labeled simulated LUWI session snapshot. Stop
the bridge with Ctrl+C; this does not close the registered session. While running it sends
session heartbeats every five seconds. Inbox output redacts full content and responses by
default; `--include-content` is an explicit local debugging opt-in.

Start the second, independent Codex bridge in another terminal:

```powershell
pnpm --filter @luwi/cli dev session bridge simulate `
  --session <codexSessionId> `
  --bridge-instance codex-demo `
  --mode echo
```

This proves that the project can keep multiple bridge consumers online. The Codex bridge
returns only a clearly labeled simulated echo; it does not invoke a native Codex process.

## 3. Bind the MCP server to Claude

Configure an MCP stdio client with:

```text
command: pnpm
args: --filter @luwi/mcp-server dev
LUWI_DAEMON_URL=http://127.0.0.1:4782
LUWI_SESSION_ID=<claudeSessionId>
LUWI_MCP_REQUEST_TIMEOUT_MS=30000
```

For a concrete repository-local MCP test harness, build once and invoke the tool over a
real stdio MCP transport:

```powershell
pnpm build
$env:LUWI_DAEMON_URL = "http://127.0.0.1:4782"
$env:LUWI_SESSION_ID = "<claudeSessionId>"
$env:LUWI_MCP_REQUEST_TIMEOUT_MS = "30000"
pnpm --filter @luwi/mcp-server harness
pnpm --filter @luwi/mcp-server harness luwi_ask_agent '{"targetAgentId":"gemini-sim","kind":"status_request","subject":"Project status","content":"Have you completed the requested project work?","evidenceRequirements":["session_state"],"timeoutMs":120000,"idempotencyKey":"phase-2-demo-status-1","waitMs":30000}'
```

The first harness command lists the approved tools. The second launches the built MCP
server as a child process, calls `luwi_ask_agent`, prints validated `structuredContent` plus
a concise bounded text summary, and closes both sides of the stdio transport.

The process refuses to start if the bound session is missing, offline, or terminal. It
revalidates that binding for every tool call but deliberately does not send heartbeats; keep
the Claude bridge from step 2 running.

Call `luwi_ask_agent`:

```json
{
  "targetAgentId": "gemini-sim",
  "kind": "status_request",
  "subject": "Project status",
  "content": "Have you completed the requested project work?",
  "evidenceRequirements": ["session_state"],
  "timeoutMs": 120000,
  "idempotencyKey": "phase-2-demo-status-1",
  "waitMs": 30000
}
```

The result includes the correlation ID, selected Gemini session, current state, and terminal
response if it completed within the bounded wait.

## 4. Inspect durable state

```powershell
pnpm --filter @luwi/cli dev message get <correlationId>
pnpm --filter @luwi/cli dev message list --project <projectId>
pnpm --filter @luwi/cli dev events list --limit 100
pnpm --filter @luwi/cli dev session list --project <projectId> --online
```

The running Claude bridge reports the terminal response notification from its durable inbox.
The ordered Runtime events show requested, delivered, acknowledged, processing, and
responded transitions.

## 5. Recover a pending request

Stop the Gemini status responder. Start a manual bridge so claiming and responding are
separate, deterministic actions:

```powershell
pnpm --filter @luwi/cli dev session bridge simulate `
  --session <geminiSessionId> `
  --bridge-instance gemini-crash-demo `
  --mode manual `
  --min-idle-ms 0
```

In another terminal, create a long-lived request:

```powershell
pnpm --filter @luwi/cli dev message ask `
  --source <claudeSessionId> `
  --target-session <geminiSessionId> `
  --kind question `
  --content "Recover this claimed request." `
  --timeout-ms 120000 `
  --idempotency-key phase-2-recovery-1
```

After the manual bridge prints the claimed item, stop it with Ctrl+C. Manual mode performs
no message transition, so the request remains pending in `luwi-session-inbox-v1`. Restart
with a responder:

```powershell
pnpm --filter @luwi/cli dev session bridge simulate `
  --session <geminiSessionId> `
  --bridge-instance gemini-demo-restarted `
  --mode status-responder `
  --min-idle-ms 0
```

The claim path runs `XAUTOCLAIM` before reading new entries, so recovered work is returned
first and becomes terminal. Re-run the same `message ask` command with the same
`--idempotency-key`; it returns the existing correlation ID and creates no duplicate
`message.requested` event.

## 6. Demonstrate timeout

Stop `gemini-demo-restarted` with Ctrl+C. Refresh presence once, then immediately create a
short request; no Gemini bridge is running to claim it:

```powershell
pnpm --filter @luwi/cli dev session heartbeat <geminiSessionId>
pnpm --filter @luwi/cli dev message ask `
  --source <claudeSessionId> `
  --target-session <geminiSessionId> `
  --kind question `
  --content "This request intentionally receives no response." `
  --timeout-ms 1000 `
  --wait-ms 3000
```

The final projection becomes `timed_out`; the source inbox receives a terminal
notification, global/project Streams contain `message.timed_out`, and a later response is
rejected as terminal.

## 7. Verify deterministic same-agent routing

Register a second session with the same opaque `gemini-sim` agent ID. Put the first session
in `idle` and the second in `thinking`. Restart the first responder and start a manual
heartbeat owner for the second session before sending the request:

```powershell
pnpm --filter @luwi/cli dev session register --project <projectId> --agent gemini-sim --working-directory .
```

Record `<secondGeminiSessionId>`. In two separate terminals run:

```powershell
pnpm --filter @luwi/cli dev session bridge simulate `
  --session <firstGeminiSessionId> `
  --bridge-instance gemini-routing-first `
  --mode status-responder
```

```powershell
pnpm --filter @luwi/cli dev session bridge simulate `
  --session <secondGeminiSessionId> `
  --bridge-instance gemini-routing-second `
  --mode manual
```

Then run:

```powershell
pnpm --filter @luwi/cli dev session status <firstGeminiSessionId> idle
pnpm --filter @luwi/cli dev session status <secondGeminiSessionId> thinking
pnpm --filter @luwi/cli dev message ask `
  --source <claudeSessionId> `
  --target-agent gemini-sim `
  --kind question `
  --content "Deterministic routing check." `
  --wait-ms 30000
```

The returned `selectedTargetSessionId` is the idle session. When statuses tie, the newest
heartbeat wins, followed by lexical session ID. Both `gemini-sim` sessions remain distinct;
no AgentDefinition entity is created.

## 8. Verify the cross-project guard

Register another local directory as a second project and add a session to it. A direct
request from the original Claude session to that session must fail:

```powershell
pnpm --filter @luwi/cli dev project register --name "Other local project" --path .\docs
pnpm --filter @luwi/cli dev session register --project <otherProjectId> --agent codex-foreign-sim --working-directory .\docs
pnpm --filter @luwi/cli dev message ask `
  --source <claudeSessionId> `
  --target-session <foreignSessionId> `
  --kind question `
  --content "This request must be rejected."
```

Expected error: `TARGET_PROJECT_MISMATCH`. No message projection, inbox entry, or
`message.requested` event is created.

## 9. Final checks

```powershell
pnpm --filter @luwi/cli dev session get <claudeSessionId>
pnpm --filter @luwi/cli dev session get <codexSessionId>
pnpm --filter @luwi/cli dev message list --project <projectId>
pnpm --filter @luwi/cli dev events list --limit 100
```

Claude and Codex remain online while their respective bridge processes are running. Bridge
shutdown does not close a session, but presence correctly expires when no heartbeat owner
remains. The message events remain ordered by the persisted global Stream IDs.

## MCP tools

The stdio server exposes:

```text
luwi_list_projects
luwi_list_sessions
luwi_get_session
luwi_get_project_state
luwi_ask_agent
luwi_await_response
luwi_get_message
luwi_inbox_next
luwi_acknowledge_message
luwi_mark_message_processing
luwi_respond_to_message
luwi_reject_message
luwi_fail_message
```

Inbox and mutation tools always use the bound `LUWI_SESSION_ID`; callers cannot override
the source or responder identity.
