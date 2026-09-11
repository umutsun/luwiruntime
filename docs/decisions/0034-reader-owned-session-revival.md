# ADR 0034: A session that never becomes ready is dropped, and its reader revives it

Status: Accepted  
Date: 2026-09-11

## Context

A session registers as `starting` and leaves it only when a reader binds: the native-headless
bridge's poll loop sets `idle` itself, and a GUI agent's session is bound by the LUWI MCP server's
`luwi_join`. The message router skips `starting` (ADR 0031): auto-routing to a session nobody
reads guarantees a timeout.

The daemon's starting-session reaper (`81a6f30`, `LUWI_SESSION_STARTING_GRACE_MS`, default
180 000 ms) makes a session still `starting` past the grace `disconnected`, because its attach
heartbeat alone would otherwise keep it `online` forever. That exposed the other half of the
problem. `createSessionBootstrap` treated every `SESSION_TERMINAL` as "rotate", so an attached GUI
session was reaped and re-registered as a fresh `starting` session every grace period — measured
live on 2026-09-11: six sessions per cycle across two projects, each cycle two events per session,
and a dashboard that showed workers that would never work. The owner's words: they go, then they
come right back.

Two facts fix the shape of the decision. The attach process is not the reader of the session it
keeps alive, so it cannot know when a replacement would be bound. And after a drop, the only
party still present that can act on the owner's `luwi_join` is the MCP server.

## Decision

### The bootstrap does not recover a session that never became ready

`createSessionBootstrap` gains `recoverUnready`. With `false`, the bootstrap reads the session's
status after each heartbeat while it is still `starting`, and a lost session that was never
observed leaving `starting` is reported as `dropped` — no re-registration, timers disarmed, the
process left alive for its own lifetime. `session attach` passes `false`. The bridges keep the
default `true`: they are their own reader and bind whatever they register.

The attach leaves its session file naming the dropped id, so an MCP server reports the session
as terminal rather than as missing.

### The reader revives on join

`luwi_join` on a bound session that is terminal registers a successor copied from the dropped
record — project, agent, working directory and metadata, plus `metadata.revivedFrom` — and the
native reference `session attach` now writes into the binding file beside the id (a session's
view does not carry it). The MCP server keeps the successor alive with its own heartbeat through
`createSessionBootstrap`, also with `recoverUnready: false`. Every later tool call binds to the
successor while the binding still names the dropped id. A successor the runtime reaps before the
next join is dropped the same way and answers `BOUND_SESSION_TERMINAL` until the join after that
registers again. A new attach — a different, live id in the binding — supersedes the successor,
which is closed.

Startup stays fail-closed on a missing or unknown session. A dropped attach session is neither:
its project is known, so the server starts, and every tool other than `luwi_join` answers
`BOUND_SESSION_TERMINAL` until the join.

`@luwi/mcp-server` now depends on `@luwi/runtime` for the bootstrap; the boundary in `AGENTS.md`
§5 and §12 concerns `@luwi/redis`, which it still never imports. The daemon client gained
`registerSession`, `heartbeat` and `closeSession` — the same three endpoints the CLI uses.

## Consequences

- A GUI conversation is present in LUWI only while it has been joined or within the grace of its
  attach; between, it is absent rather than a `starting` zombie. Joining is what brings it back.
- Transcript attribution for a GUI session that never joins ends when its native link is closed
  by the reap, and resumes on the successor, which re-declares the same native reference.
- A running `session attach` keeps the code it started with, and so does a running MCP server; a
  GUI gets both halves only after its attach process and MCP server restart.
- Covered by unit tests: the bootstrap rule (`session-bootstrap.test.ts`), the attach's extra
  readiness read (`cli.test.ts`), the revival (`session-revival.test.ts`), the join path
  (`tools.test.ts`) and the client endpoints (`daemon-client.test.ts`).
