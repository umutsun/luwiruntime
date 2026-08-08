# Phase 2 — Agent Communication and MCP Integration

Status: approved for implementation on 2026-07-29.

This design extends the Phase 1 Redis-native runtime without changing its ownership,
readiness, persistence-first event relay, loopback security, or package boundaries. The
binding inputs are the root `AGENTS.md`, ADR 0004, ADR 0005, the approved Phase 1 design,
the Phase 1 checkpoint, and the Phase 2 requirements supplied on 2026-07-29.

## Scope

Phase 2 adds same-project request/reply communication between registered online sessions,
durable per-session inboxes, bounded asynchronous waits, timeout processing, bridge
simulation, and a thin stdio MCP server.

It does not add native coding-agent adapters, prompt injection, task orchestration, offline
queues, cross-project routing, Pub/Sub, another datastore, dashboard features, memory
federation, or agent-definition management. Simulator answers and evidence are always
labelled as simulated.

## Package boundaries

- `@luwi/protocol` owns public message, response, evidence, inbox, HTTP, and MCP schemas.
- `@luwi/runtime` owns the message transition matrix, deterministic routing, request
  fingerprinting policy, size policy, and fake-clock-testable timeout selection.
- `@luwi/redis` owns keys, projections, indexes, Functions, inbox Streams/groups, pending
  recovery, timeout transitions, reads, and retention.
- `@luwi/daemon` owns target discovery, HTTP routes, bounded waits, inbox claim flow,
  timeout/retention scheduling, readiness, recovery, and draining.
- `@luwi/cli` owns message/inbox commands and bridge simulators using daemon APIs only.
- `@luwi/mcp-server` is a stateless stdio adapter over the daemon HTTP API.

The only new production dependency is the stable official
`@modelcontextprotocol/sdk` 1.29.x package, isolated to `apps/mcp-server`.

## Public model and limits

Messages use the states `queued`, `delivered`, `acknowledged`, `processing`, `responded`,
`rejected`, `timed_out`, and `failed`. Kinds are `question`, `status_request`, and
`instruction`.

UTF-8 byte limits are applied after schema validation:

- content: 32,768 bytes;
- subject: 512 bytes;
- response answer: 65,536 bytes;
- evidence: at most 32 entries;
- default timeout: 120,000 ms;
- maximum timeout: 86,400,000 ms.

Evidence, `verifiedAt`, and optional confidence remain independent. Confidence is constrained
to 0–1 and is never treated as proof.

## State machine

The exact allowed target states are:

| Current        | Allowed targets                                                              |
| -------------- | ---------------------------------------------------------------------------- |
| `queued`       | `delivered`, `timed_out`, `failed`                                           |
| `delivered`    | `acknowledged`, `processing`, `responded`, `rejected`, `timed_out`, `failed` |
| `acknowledged` | `processing`, `responded`, `rejected`, `timed_out`, `failed`                 |
| `processing`   | `responded`, `rejected`, `timed_out`, `failed`                               |
| terminal       | none                                                                         |

Repeating the current state is unchanged and emits no event. Repeating the already-committed
terminal operation returns the stored projection without rewriting the response or emitting
another event. Any other transition from a terminal state returns `MESSAGE_TERMINAL`.

## Routing and request identity

A request supplies exactly one of `targetSessionId` or `targetAgentId`. The source session
and selected target must exist, be online, be non-terminal, and share a project. Application
routing selects a target; the atomic request Function revalidates both session projections,
project membership, terminal state, and presence immediately before its first write.

Agent routing is deterministic: status rank (`idle`, `waiting_for_input`,
`waiting_for_agent`, `starting`, `thinking`, `tool_running`, `blocked`), then newest
heartbeat, then lexical session ID.

An optional idempotency key is scoped to the source session and hashed before key
construction. Its canonical request fingerprint covers the source session, original target
selector, kind, normalized optional subject, exact content, evidence requirements, and
timeout duration. It deliberately excludes generated IDs, selected-session results, and
absolute deadline timestamps. A same-key/same-fingerprint retry returns the original message
and selection even if later routing conditions change. A different fingerprint returns
`IDEMPOTENCY_KEY_CONFLICT`.

## Redis model

The authoritative message projection is `luwi:v1:message:{messageId}`. Correlation and
idempotency keys resolve to that projection. Global, project, source-session, and
target-session sorted indexes use Redis-time scores. `luwi:v1:deadline:messages` selects
timeout candidates, while Redis Functions authoritatively decide whether a deadline has
actually elapsed.

Every session inbox is `luwi:v1:inbox:session:{sessionId}` with group
`luwi-session-inbox-v1`. Session registration creates the Stream/group at `0-0` without
resetting an existing group. Bridge consumers use `bridge-{bridgeInstanceId}`.

Request creation atomically writes the message projection and indexes, appends the target
request inbox entry, stores its returned Stream ID internally, and persists one normalized
`message.requested` event to global and project Streams. All event-emitting Functions retain
one Runtime event ID across those two Streams while Redis assigns distinct Stream IDs.

## Claim and acknowledgement

Claim first inspects/claims stale pending entries with `XAUTOCLAIM`, then reads new entries
with `XREADGROUP ... >`. Recovered entries are returned before new entries. Every envelope
and referenced projection is validated.

A request entry stays pending while its projection is delivered, acknowledged, or
processing. A terminal transition acknowledges the original target-inbox entry. A terminal
request encountered again is acknowledged and skipped.

A source response-notification entry points to the authoritative terminal projection. It is
validated, returned once by claim, and acknowledged during successful claim processing;
clients can always recover the answer through message get/wait.

Malformed inbox items are never exposed as valid work. They are acknowledged only after a
bounded diagnostic is logged without content; the claim returns `INBOX_ENTRY_INVALID` if no
valid item can be returned.

## Response and timeout races

Respond/reject/fail verifies the responder is the selected target. A terminal transition
updates the projection, removes the deadline, appends a bounded response notification to the
source inbox, persists the normalized event, and acknowledges the original target entry when
known.

The timeout sweeper selects due IDs with an application clock. The timeout Function verifies
the stored expected deadline, terminal state, committed response absence, and Redis server
time. Response and timeout therefore race inside Redis serialization: exactly one wins and
the loser returns unchanged/terminal without a duplicate event.

## HTTP, waiters, lifecycle, and realtime

All mutation routes use the Phase 1 readiness/in-flight guard. Reads return unavailable
rather than stale data during Redis loss. A bounded waiter registry may wake HTTP wait calls,
but each response is reread and validated from Redis. Waits stop at 30 seconds and are
interrupted by draining/degradation.

Message events use the existing global Stream and Phase 1 consumer-group WebSocket relay.
Realtime is only a wake-up hint; durable bridge delivery always uses inbox claim.

Recovery revalidates the upgraded Function library and resumes timeout/inbox operations
under the existing daemon owner. Draining stops new claims/mutations, cancels waits, drains
accepted work within the Phase 1 deadline, and leaves unfinished inbox work pending.

## MCP boundary

The MCP process uses stdio and the official SDK. It validates
`LUWI_DAEMON_URL`, binds to one `LUWI_SESSION_ID`, verifies that session at startup, and
derives the source/responder session for every mutation tool. It contains no Redis dependency
and no authoritative state. Every tool advertises a protocol-owned output schema, validates
daemon output before returning it, uses `structuredContent`, and emits a concise bounded
text summary. Discovery collections are capped at 100 items and report truncation. Safe
daemon errors become `isError` tool results.

## Retention

Terminal projections/correlation indexes and idempotency indexes receive configurable
post-terminal retention. A terminal sorted index drives removal from relationship indexes.
Inbox trimming is approximate and occurs only with valid group metadata, zero pending work,
and zero lag. Recoverable pending work is never deliberately trimmed; temporary growth is
preferred.

## Verification

Every slice follows red-green-refactor. Completion requires the root format, typecheck, lint,
unit, Redis integration, and build commands; the Phase 1 regression demo; the complete
three-session Phase 2 demo; secret/logging checks; and an independent code review.
