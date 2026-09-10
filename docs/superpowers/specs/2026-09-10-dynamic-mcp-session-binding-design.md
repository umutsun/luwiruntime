# Dynamic MCP Session Binding Design

## Problem

`session attach --session-out` replaces a terminal LUWI session with a new session and atomically
publishes the replacement ID. The MCP server currently reads only `LUWI_SESSION_ID` during startup,
verifies that session once, and captures it in every tool handler. A long-lived MCP process therefore
keeps using the terminal ID after the attach helper has rotated successfully.

## Decision

The MCP server accepts exactly one binding source:

- `LUWI_SESSION_ID` keeps the existing static behavior; or
- `LUWI_SESSION_FILE` names an absolute file written by `session attach --session-out`.

The file contains the strict JSON object `{ "attached": "<session-id>" }`. The server opens and reads
the file for every MCP tool call, then verifies that session through the daemon. A tool call resolves
the binding once and uses that immutable `SessionView` snapshot for every source, responder, inbox,
lease, and project-scoping decision made during that request.

Startup still resolves and verifies one session. Its project becomes the immutable project anchor for
the MCP process. A later file value may rotate the session ID, but a verified session from another
project is rejected before any operation.

## File safety

The file path must be explicit and absolute. The reader rejects a symbolic link, a non-regular file,
an empty or oversized file, malformed JSON, extra fields, and an invalid session identifier. On
POSIX, group or other permission bits are rejected; Windows relies on the configured per-user path's
ACL because POSIX mode bits are not authoritative there. The file is opened once and read through
that handle so one MCP request sees one filesystem snapshot even if the attach helper renames the
next value concurrently.

The attach writer creates a uniquely named temporary file with exclusive creation and mode `0600`,
writes one complete JSON record, and renames it over the configured path. It never follows a reusable
`.tmp` path supplied by another filesystem entry.

## Integration

`main.ts` builds the binding resolver, verifies the startup session, and passes a dynamic verified
session resolver to the existing tool-handler factory. The handler factory retains its initial
session as the project anchor and invokes the resolver once per tool call. Existing static callers
remain source compatible through the current two-argument factory form.

Native launchers that already own an attach helper pass the helper's mapping path as
`LUWI_SESSION_FILE` instead of copying its first value into `LUWI_SESSION_ID`. Direct and bridge
launches that already own a stable session continue using `LUWI_SESSION_ID`.

Codex's SessionStart hook publishes the validated dry-run attach request. Its MCP launcher uses the
matching `CODEX_SESSION_ID`/`CODEX_THREAD_ID` to claim only that conversation's record, then owns the
long-lived `session attach --session-out` process. It never selects the newest global Codex record.
Antigravity resolves only the current record published by its hook and never invents a conversation,
selects an arbitrary online session, or guesses a project. Because Antigravity's MCP process is
application-global, changing between concurrently active conversations still requires an MCP restart;
rotation within the selected conversation does not.

## Errors and limits

Binding failures fail closed with bounded, non-secret error messages. A missing or temporarily
replaced file does not fall back to a stale ID. The MCP server does not revive a terminal session,
write Redis directly, change session transition rules, or move leases between rotated sessions.

## Verification

Tests cover static compatibility, configuration exclusivity, file rotation, invalid content,
symlinks, POSIX permissions, one-resolution-per-request behavior, project-anchor rejection, and a
session-out hard-link attack against the legacy fixed temporary path. Relevant MCP and CLI tests run
before the full format, typecheck, lint, test, and build gates.
