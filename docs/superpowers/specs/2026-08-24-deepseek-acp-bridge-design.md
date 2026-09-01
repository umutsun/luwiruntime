# DeepSeek Harness ACP Bridge Design

**Date:** 2026-08-24  
**Status:** Approved for a minimal experimental increment

## Goal

Allow one DeepSeek Harness ACP process to participate as one LUWI session without making
DeepSeek a runtime dependency or changing LUWI's local-first architecture.

## Architectural boundary

The integration is an opt-in command under `@luwi/cli`. It is not a new package and it does
not change `@luwi/runtime`, `@luwi/protocol`, `@luwi/redis`, or the daemon. The bridge uses only
the existing loopback HTTP API. It never receives Redis credentials and never writes native
DeepSeek or LUWI configuration.

The only new production dependency is the vendor-neutral official ACP TypeScript SDK. It is
pinned to `0.25.1`, the version used by the current DeepSeek Harness ACP implementation. LUWI
does not depend on a DeepSeek package.

## Lifecycle

1. Register a normal LUWI session with the user-supplied project, agent, and workspace.
2. Spawn the user-supplied ACP command with protocol-pure stdin/stdout. Add only
   `LUWI_SESSION_ID` and `LUWI_DAEMON_URL` to the inherited child environment.
3. Negotiate ACP and create one fresh DeepSeek session for the same absolute workspace.
4. Declare that ACP session as LUWI native identity with adapter id
   `deepseek-harness-acp-v1`.
5. Keep the LUWI session alive, claim its durable inbox, and process one DeepSeek prompt at a
   time.
6. On shutdown, cancel an in-flight ACP prompt, close the ACP process, then close the LUWI
   session.

The bridge owns exactly one LUWI session, one ACP process, and one ACP session. It does not
resume or import DeepSeek history.

## Message mapping

For each claimed LUWI request, the bridge:

- reads the canonical current message state;
- acknowledges a delivered message;
- marks an acknowledged message processing;
- sends the request content as one ACP text block;
- accumulates committed `agent_message_chunk` text;
- responds with `answered` only for ACP `end_turn` and non-blank output;
- records other stop reasons or transport failures through the existing LUWI reject/fail
  transitions.

Duplicate terminal deliveries remain safe because current state is read before each transition.
A recovered message already in `processing` is failed without replaying ACP work: the bridge
cannot prove that the interrupted prompt had no side effects. Only one prompt is in flight,
matching DeepSeek Harness's ACP contract.

## Permissions and MCP

ACP permission requests fail closed by default. An explicit CLI option may select the first
one-shot allow choice; no persistent allow policy is created.

DeepSeek Harness currently rejects non-empty ACP `mcpServers`. Therefore the bridge does not
attempt ACP-time MCP injection. A DeepSeek Cordis composition may opt into
`@deepseek-ai/dsh-mcp-client` and launch LUWI's existing stdio MCP server. The child inherits
the bridge-created `LUWI_SESSION_ID` and loopback daemon URL, so that MCP server remains bound
to the correct LUWI session.

## Safety and failure behavior

- The command is explicit and opt-in; no daemon startup behavior changes.
- Child stdout is reserved for ACP frames and is never logged as text.
- Supported inbound ACP JSON-RPC envelopes and parameters are validated before the SDK sees
  them, so protocol-invalid frames cannot trigger content-bearing SDK diagnostics.
- ACP startup, cancellation, prompt execution, frame size, and accumulated response size are
  bounded. A prompt inherits the durable LUWI message deadline.
- Prompts, complete answers, credentials, and environment dumps are not logged.
- Startup is transactional: if ACP initialization, session creation, or native declaration
  fails, the child is reaped and the LUWI session is closed.
- Heartbeat loss stops new work and triggers shutdown.
- Signal handlers are installed before startup. A signal aborts ACP initialization or cancels
  in-flight ACP work before process termination, and waits for owned-resource rollback.
- On Windows, planned shutdown uses LUWI's existing creation-time-verified owned-process-tree
  cleanup. If the ACP root exits before ownership can be proven, shutdown reports cleanup as
  unverified instead of claiming success.
- No direct filesystem mutation, Redis access, terminal injection, or configuration apply is
  added.

## Deliberate non-goals

- No DeepSeek-specific package in the runtime dependency graph.
- No generic orchestration framework or new session-routing package.
- No ACP session resume, replay, multiple sessions, UI, or automatic Cordis edits.
- No automatic MCP installation or discovery.
- No change to LUWI's canonical configuration or Redis model.

## Validation

Unit tests use injected daemon and ACP clients to prove lifecycle ordering, durable message
transitions, failure mapping, heartbeat shutdown, and idempotent cleanup. A subprocess-level
test uses a scripted ACP child and the official SDK without requiring a DeepSeek credential.
The repository format, lint, typecheck, unit test, and build gates must pass.
