# Phase 1 two-session demo

This walkthrough proves project registration, two concurrent opaque-agent sessions,
heartbeat presence, status changes, ordered persisted events, realtime WebSocket wrappers,
TTL disconnection, and graceful completion.

It uses fast demo timing without changing normal defaults. Use a disposable Redis database
or server. Do not point it at unrelated data.

## 1. Start Redis

With Compose:

```text
docker compose up -d redis
```

Or set `REDIS_URL` to an existing standard Redis 7 server.

## 2. Start the daemon

PowerShell, terminal 1:

```powershell
$env:REDIS_URL = "redis://127.0.0.1:6379"
$env:LUWI_SESSION_PRESENCE_TTL_MS = "3000"
$env:LUWI_PRESENCE_SWEEP_INTERVAL_MS = "250"
$env:LUWI_HEARTBEAT_EVENT_INTERVAL_MS = "1000"
pnpm --filter @luwi/daemon dev
```

macOS/Linux, terminal 1:

```sh
REDIS_URL=redis://127.0.0.1:6379 \
LUWI_SESSION_PRESENCE_TTL_MS=3000 \
LUWI_PRESENCE_SWEEP_INTERVAL_MS=250 \
LUWI_HEARTBEAT_EVENT_INTERVAL_MS=1000 \
pnpm --filter @luwi/daemon dev
```

The public listener opens only after ownership, Function verification, Stream/group
bootstrap, and pending recovery complete.

## 3. Verify health and register the project

Terminal 2:

```text
pnpm --filter @luwi/cli dev runtime
pnpm --filter @luwi/cli dev project register --name "LUWI Runtime Demo" --path .
```

Copy the returned project `id` as `<projectId>`. Repeating the registration must return:

```text
409 PROJECT_ALREADY_REGISTERED
Location: /api/v1/projects/<projectId>
```

It must not update metadata or append another `project.registered` event.

## 4. Start Codex and Gemini simulations

Terminal 3:

```text
pnpm --filter @luwi/cli dev session simulate --project <projectId> --agent codex-sim --working-directory . --heartbeat-ms 500 --status tool_running
```

Terminal 4:

```text
pnpm --filter @luwi/cli dev session simulate --project <projectId> --agent gemini-sim --working-directory . --heartbeat-ms 500 --status waiting_for_input --ungraceful
```

Both commands print their registered session. Keep both terminals running.

## 5. Verify projections and durable order

Terminal 2:

```text
pnpm --filter @luwi/cli dev session list --online
pnpm --filter @luwi/cli dev session list --project <projectId>
pnpm --filter @luwi/cli dev events list --limit 100
```

Expected:

- two online sessions with distinct `sessionId` values;
- `codex-sim` is `tool_running`;
- `gemini-sim` is `waiting_for_input`;
- `project.registered`, both `session.registered`, both status changes, and sampled heartbeat
  events appear in ascending Redis `streamId` order.

## 6. Observe realtime wrappers

Terminal 5:

```text
pnpm --filter @luwi/cli dev events watch
```

The command first prints current project/session snapshots, then server-produced messages:

```json
{
  "streamId": "1785337000000-0",
  "event": {
    "id": "...",
    "version": 1,
    "type": "session.heartbeat",
    "occurredAt": "...",
    "workspaceId": "local",
    "projectId": "...",
    "agentId": "codex-sim",
    "sessionId": "...",
    "payload": {
      "metadataChanged": false
    }
  }
}
```

The wrapper carries the persisted global Stream ID. The WebSocket does not manufacture a
second event ID.

## 7. Demonstrate expiry

Press Ctrl+C in terminal 4. Because Gemini was started with `--ungraceful`, it does not call
the close endpoint.

After slightly more than three seconds:

```text
pnpm --filter @luwi/cli dev session list --online
pnpm --filter @luwi/cli dev session get <geminiSessionId>
pnpm --filter @luwi/cli dev session get <codexSessionId>
pnpm --filter @luwi/cli dev events list --limit 30
```

Expected:

- Gemini is `disconnected` and offline;
- Codex remains online;
- exactly one `session.disconnected` event exists for Gemini.

## 8. Close Codex gracefully

Press Ctrl+C in terminal 3. The normal simulator sends exactly one close request before
exiting.

Then verify:

```text
pnpm --filter @luwi/cli dev session get <codexSessionId>
pnpm --filter @luwi/cli dev events list --limit 30
```

Codex is `completed` and offline with exactly one `session.completed` event.

Stop `events watch` and the daemon with Ctrl+C. The daemon drains accepted mutations and
their relay work before releasing its owner lease.

## Guarantees and limits

- Redis Stream processing is at least once.
- WebSocket network delivery is best effort.
- A client reconnect fetches current snapshots; Phase 1 has no history cursor/catch-up API.
- Only one authoritative daemon is supported.
- No dashboard, message request/reply, tasks, leases, MCP, or agent adapter participates in
  this demo.
