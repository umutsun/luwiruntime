# Event-driven wake dispatcher acceptance

- Date: 2026-09-10
- Status: implementation complete; final live evidence pending

## Scope

This record covers the version-13 event-driven wake dispatcher: singleton bridge slots, durable wake
intents, daemon recovery, no-shell Codex queue dispatch, exactly-once workflow continuation, managed
CLI lifecycle, bound-session MCP operations, and redacted Pulse reads.

The deterministic live command uses a real loopback daemon and the dedicated Redis instance on port 6391. It launches the built production `wake serve` command, a real supervised workspace-write Codex
worker, and a disposable persistent Codex coordinator. Exact-thread wake is directed only to that
disposable coordinator. The script deletes the thread during verified cleanup. Unit and integration
tests retain injected process seams for failure paths that would be unsafe or nondeterministic to
force through a real provider process.

## Safety envelope

- The command refuses Redis hosts other than `127.0.0.1:6391` and refuses credentials, fragments,
  alternate databases, and production ports 6379 and 6380.
- Every run creates a cryptographically random Redis namespace and Function library name.
- The daemon receives isolated `LUWI_HOME`, native-home, workspace, and runtime-instance values.
- The supplied workspace is never deleted. The command creates one run-specific child directory and
  removes it only when an ownership marker contains the same run ID and the resolved path remains a
  direct descendant.
- Redis cleanup scans and unlinks only the exact run namespace, then deletes only that run's Function
  library. It never uses `FLUSHDB`, `FLUSHALL`, `KEYS`, or a production namespace.
- Evidence contains timestamps, opaque IDs, states, provider/profile labels, commit, and test counts.
  It omits message content, native conversation IDs, owner tokens, command arguments, executable
  paths, working paths, and child output.

## Command

Build the complete workspace first, then run:

```powershell
node scripts/wake-live-acceptance.mjs `
  --redis-url redis://127.0.0.1:6391 `
  --workspace C:/xampp/htdocs/luwiruntime/.worktrees/wake-acceptance-fixture `
  --codex-executable C:/Users/umuts/AppData/Local/OpenAI/Codex/bin/8e5b6932251c2c1c/codex.exe `
  --git-executable "C:/Program Files/Git/cmd/git.exe"
```

The command prints one redacted JSON record. Set `LUWI_WAKE_ACCEPTANCE_DEBUG=1` only for local failure
diagnosis; debug mode may print an internal error string and must not be used to capture acceptance
evidence.

## Required automated gates

| Gate                            | Final result |
| ------------------------------- | ------------ |
| Prettier                        | Pending      |
| ESLint                          | Pending      |
| TypeScript project build        | Pending      |
| Unit tests                      | Pending      |
| Redis integration tests on 6391 | Pending      |
| Production build                | Pending      |

## Deterministic live scenarios

The live script must pass all of these assertions before it emits `status: passed`:

1. Refuse non-isolated Redis targets, noncanonical executables, and ambiguous environment keys before
   provider work begins; require a clean, stable source tree for a full pass.
2. Build the TypeScript project twice from the recorded clean HEAD and require identical bounded
   digests for all runtime artifacts used by the command.
3. Start a real daemon with unique version-13 keys and register a disposable Git project.
4. Probe the supplied Codex executable, verify daemon detection resolves the same canonical path and
   measured version, and register one coordinator plus one worker with that evidence.
5. Create a disposable persistent Codex coordinator and bind its exact main `codex-native-v1`
   identity, MCP session, and `codex-queue-v1` wake adapter.
6. Seed a durable response before `wake serve` starts, stop and restart the daemon, recreate the wake
   consumer group at `0-0`, then require the production dispatcher to queue the exact disposable
   thread and let that coordinator continue the workflow through MCP.
7. Start the built production supervisor, observe its singleton slot and native-headless worker, send
   a real workflow request, and require the supervised Codex worker to answer through its bound MCP
   session without changing the fixture repository.
8. Require the dispatcher to queue the exact coordinator thread for the real worker response and
   require one fenced workflow continuation. The durable source inbox must retain both responses.
9. Race two bridge-slot owner tokens concurrently, require exactly one `acquired` and one `held`, wait
   through the ownership TTL, acquire one replacement, and prove the stale token cannot release it.
10. Read wake and bridge-slot HTTP projections and prove native IDs, launcher evidence, and owner
    tokens are absent.
11. Label Claude Code, Gemini CLI, and Antigravity as `not-exercised`; the command makes no automatic
    execution claim for those providers.

The integration suite separately exercises two complete supervisor instances, blocking claim
cancellation, stale PEL reclaim, dispatching crash recovery, daemon restart, and WebSocket-independent
delivery with the same real Redis endpoint and an injected process seam.

## Provider readiness

| Provider    | Explicit manual bridge                            | Supervised fresh run                            | Existing-conversation wake                 |
| ----------- | ------------------------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| Codex       | Available                                         | `read-only` and `workspace-write`, opt-in       | `codex-queue-v1` with trusted main binding |
| Claude Code | Available                                         | Disabled pending installed-client policy proof  | Unavailable                                |
| Gemini CLI  | Available                                         | Disabled pending sandbox and approval proof     | Unavailable                                |
| Antigravity | Available only through its explicit observed path | Disabled while safe unattended mode is unproved | Unavailable                                |

`dispatched` means the host queue process exited successfully and reported acceptance. It does not
mean the model finished the resumed turn. `indeterminate` means a side effect may have happened and
therefore forbids automatic replay. `fallback_only` means LUWI proved no host process was started.
The durable source inbox remains authoritative for all three outcomes.

## Rollout

Wake supervision stays disabled after install and upgrade. Enable it per binding through the strict
effective configuration leaf:

```json
{
  "settings": {
    "luwiNativeBridge": {
      "enabled": true,
      "provider": "codex",
      "executionProfile": "workspace-write"
    }
  }
}
```

Release protocol, runtime, Redis Function library, daemon, CLI, MCP server, and dashboard together.
The daemon refuses an incompatible Function library instead of serving partial wake behavior.
Stopping supervision does not disable ordinary request/reply, direct-session routing, manual inbox
reads, or explicit bridge commands.

## Final evidence

The final integrated command output, commit, gate counts, and any measured host limitation will be
recorded here after the run. No provider success will be inferred from an online heartbeat or an
installed executable alone.
