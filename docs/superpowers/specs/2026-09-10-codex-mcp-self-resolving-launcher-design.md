# Codex MCP Self-Resolving Launcher Design

## Problem

Codex CLI 0.153.4 starts MCP servers before it runs the `SessionStart` hook in the observed
interactive flow. The current LUWI Codex launcher requires that hook to publish a short-lived
attach record first. The launcher therefore exits during MCP initialization, and the hook writes
an unclaimed record only when the first user prompt begins. Trusting the hook or increasing its
timeout does not correct this ordering.

## Decision

Make `codex-mcp-launch.mjs` able to resolve its own attach request from the exact native Codex
identity and its inherited working directory. An existing valid hook record remains the preferred
input for compatibility, but absence of a record is no longer fatal.

The launcher will:

1. Read and validate the exact native identity from `CODEX_SESSION_ID` and `CODEX_THREAD_ID` using
   the existing identity helper.
2. Try to claim the matching fresh hook record without blocking startup for the current ten-second
   window.
3. If no record is available, run the existing CLI `session attach --agent-kind codex --dry-run`
   resolution itself with `CODEX_SESSION_ID` set to that validated identity and `cwd` set to the
   launcher's inherited working directory.
4. Parse the dry-run response and pass it through the existing `codexAttachPlan` validation before
   starting the long-lived attach owner and MCP server.

No project identifier is guessed. Project selection remains the CLI's canonical-path lookup, and
the launcher fails closed when its working directory is not registered or the dry-run output is
invalid.

## Alternatives Considered

### Increase the record freshness or startup timeout

This can hide slow startup but cannot solve the observed event ordering: a new interactive Codex
session does not publish the hook record until its first prompt, after MCP initialization has
already failed.

### Use a native Session Bridge or static LUWI session

This can make an agent reachable, but the bridge claims inbox work outside the requested
`luwi_*` MCP worker loop and does not bind the current native Codex conversation in the intended
way.

### Self-resolve in the launcher (selected)

This uses information already supplied to the MCP child, preserves the existing daemon/CLI
boundary, and removes the timing dependency without weakening project or native-session identity.

## Components and Data Flow

`codex-mcp-launch.mjs` remains the process owner. A small exported resolver will accept injected
process collaborators for tests and produce the same validated record shape currently written by
`codex-attach-hook.mjs`.

The normal flow becomes:

```text
Codex MCP child environment
  -> validate native conversation identity
  -> claim matching hook record when present
  -> otherwise resolve project from inherited cwd through CLI dry-run
  -> validate with codexAttachPlan
  -> start session attach with a rotating session file
  -> wait for online presence
  -> start the bound MCP stdio server
```

The hook remains useful for hosts or future Codex versions that run it before MCP initialization.
The fallback is local to Codex and does not change Claude or Antigravity launchers.

## Failure and Cleanup Rules

- Conflicting or absent Codex environment identities remain fatal.
- Non-loopback daemon URLs remain rejected by existing helpers.
- A dry-run timeout, non-zero exit, malformed JSON response, unregistered working directory, or
  invalid attach plan closes the launcher with the existing safe `MCP_LAUNCH_FAILED` envelope.
- The fallback does not create a LUWI session until the validated attach process starts.
- If online presence is not published in time, the attach child is terminated as it is today.
- Existing claimed-record and SessionEnd cleanup behavior is preserved.

## Testing

Add focused tests before production changes that prove:

1. a valid pre-published hook record remains preferred and no dry-run fallback is invoked;
2. absence of a hook record resolves from the launcher's exact Codex identity and inherited cwd;
3. fallback dry-run receives `--agent-kind codex` and the native identity through its environment;
4. non-zero, timed-out, or malformed dry-run output fails without starting attach or MCP children;
5. the resulting record is still validated by `codexAttachPlan`;
6. inherited `LUWI_SESSION_ID` continues to bypass owned attach creation.

After the focused red/green cycle, run the affected CLI test file, typecheck, lint, and build. Then
perform a fresh Codex startup and verify `luwi_join` returns the LUWI Runtime project name and a
Codex LUWI session ID before claiming the connection works.

## Scope

This change modifies only the Codex launcher, its directly shared helper if necessary, focused
tests, and truthful setup documentation. It does not change Redis, daemon routes, MCP tool
semantics, message delivery, native bridge behavior, or other agent launchers.
