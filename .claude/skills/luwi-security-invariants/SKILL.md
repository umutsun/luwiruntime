---
name: luwi-security-invariants
description: The loopback-only security rules that LUWI Runtime is built on (AGENTS.md section 4). Use when touching the daemon's HTTP or WebSocket surface, host/origin validation, CORS, logging, error responses, Redis credential handling, the dashboard's dev-server origins, or the adapters that inspect native agent configuration. Also use when reviewing whether a change would widen the local-only boundary. Triggers on: bind address, HOST, Origin, CORS, WebSocket upgrade, allowlist, secret redaction, stack trace, error code, credential, daemon owner lease, adapter execution.
---

# LUWI Runtime security invariants

LUWI is a **single-user local runtime**. It has no login, signup, account, OAuth, JWT, RBAC,
tenant, or organization subsystem — and adding one is not a fix, it is a scope violation. The
security model is that nothing but the local user can reach the runtime, so every rule below
protects that single boundary. Widening it does not degrade a feature; it removes the entire
threat model.

These rules come from `AGENTS.md` section 4 and are binding. The generic `security-review` skill
covers injection, XSS, SSRF, and secrets — it does not know any of this.

## Network boundary

- The daemon binds `127.0.0.1` by default and **rejects every other `HOST` value**. There is no
  remote-binding override in local mode. A configuration flag that permits `0.0.0.0` is a defect
  even if it defaults to off.
- Redis may be published by Compose only on host address `127.0.0.1`.
- Coding agents, Session Bridges, browsers, and CLIs **never receive Redis credentials**. Only the
  daemon does. `@luwi/mcp-server` is a thin stdio adapter over loopback HTTP and must never become
  a Redis client.
- `LUWI_DAEMON_URL` must be an exact loopback HTTP origin: `http:` scheme, hostname in
  {`127.0.0.1`, `localhost`, `[::1]`}, no credentials, no path, no query, no fragment. See
  `apps/mcp-server/src/config.ts`.

## Browser and WebSocket

- **No wildcard CORS.** Ever.
- Validate `Origin` against an explicit loopback allowlist before accepting browser or WebSocket
  traffic. Reject absent or unexpected origins where an origin is required, and reject
  `Origin: null`.
- Validate the `Host` header for exact loopback values, not just the bind address.
- Do not stream unvalidated arbitrary client payloads. Per-client WebSocket queues are bounded
  (`LUWI_WS_QUEUE_LIMIT`, `LUWI_WS_MAX_PAYLOAD_BYTES`, `LUWI_WS_MAX_BUFFERED_BYTES`).
- Broadcast only **after** Redis persistence succeeds. A client must never observe an event that
  did not durably happen.
- Dashboard development is the one place extra origins appear, and only explicitly via
  `LUWI_ALLOWED_ORIGINS`. That is a dev-only widening; it must not become a default.

## Logging and errors

- Never log secrets, credentials, Redis URLs, environment dumps, complete prompts, or full memory
  documents.
- Use structured identifiers instead: request, correlation, project, agent, session, task,
  message, and event IDs.
- Return **safe errors without stack traces or connection details**. Machine-readable error codes
  belong in responses; stack traces belong in local logs with identifiers.
- `packages/runtime/src/secret-policy.ts` is the existing redaction boundary — reuse it rather
  than writing new redaction logic.

## Execution boundary

- `@luwi/adapters` passively detects and inspects Codex, Claude Code, Gemini CLI, and Kimi. It
  **never writes files** and **never executes discovered skills, hooks, plugins, scripts, or MCP
  servers**.
- The only execution permitted is a detected CLI's `--version`, shell-free, with a 2.5 second
  timeout and separate 64 KiB stdout/stderr caps. On Windows, `.cmd`/`.bat` go through the
  canonical System32 command processor with fixed `/d /s /c` and literal `--version` arguments,
  never an ambient `PATH` lookup, and cleanup verifies the exact owned process tree.
- Phase 4 scanners never execute package managers, scripts, hooks, plugins, or MCP definitions.
- The Git observer is read-only, never contacts a remote, and authorizes via **exact read-only
  argument templates** — not top-level Git verbs. `git log` is not an allowlist entry; a specific
  argument vector is.
- Acceptance, graph rebuild, native config approval/apply, rollback, and Git mutation are **never**
  exposed through MCP.

## Ownership and state

- A TTL-backed single-daemon owner lease (`luwi:v1:runtime:daemon-owner`) is acquired before
  bootstrap mutation. Renewal interval must stay shorter than the TTL.
- Presence requires a fresh heartbeat **and** a live TTL key — never infer online state from a
  stale registry or session hash.
- Redis data is untrusted input. Validate everything read from storage, including Redis Function
  return values.

## When reviewing

State which invariant a change touches and whether it widens the boundary. If a change _needs_ to
widen it, that is an ADR-level decision (`docs/decisions/`), not an implementation detail — say so
instead of implementing it.
