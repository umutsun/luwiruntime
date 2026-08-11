# ADR 0022: Native session binding

Status: Accepted  
Date: 2026-08-11

## Context

LUWI records what its own runtime observes, but nothing tied that record to the vendor-native agent
session that produced it. The MCP server binds to a LUWI `sessionId` carried in configuration, and
that value is more fragile than the documentation said: `disconnected` is terminal with no legal
transition out, and the presence sweeper writes it whenever a heartbeat deadline lapses. A session
identifier therefore dies permanently after a gap longer than the 15 second presence TTL. A daemon
restart is only one way to produce that gap.

Two further facts shaped the design. `CLAUDE_CODE_SESSION_ID` is present in the agent's environment
and is byte-identical to its transcript filename stem, so native identity can be **declared** rather
than inferred. And the session record lives in Redis rather than daemon memory, so a client that
keeps heartbeating survives a restart — the identity problem is about genuinely new sessions, not
about restarts.

`usage.sessionId` is required, so a future transcript ingestion cannot attribute a token record
without a LUWI session to attribute it to. That is why identity had to come first.

## Decision

### Identity is separated from liveness, and from scope

A **`NativeSessionBinding`** holds the adapter-scoped native identity. It is stable and long-lived,
and it carries **no presence, no project, no agent, no AgentDefinition and no confidence**. A
schema test asserts the absence of those fields rather than trusting the comment. Liveness comes
from the session's own heartbeat and TTL; scope comes from the linked session.

A **`NativeSessionLink`** records one exact association with one LUWI session over
`[linkedAt, unlinkedAt)`. It is immutable once written; the single exception is `unlinkedAt`,
written exactly once. The relationship is 1:N over time — one native session outlives many LUWI
sessions — and the link interval is what a later transcript record will be mapped onto.

`latestSessionId` is deliberately not stored. The invariant the conflict rule needs is "is there an
open link", not "which session was last", and `openLinkId` cannot be misread as presence.

### A declaration is exact or refused, and a live holder is never evicted

Six outcomes, decided by a pure function in `@luwi/runtime`: `created`, `linked`, `unchanged`,
`conflict`, `inconsistent`. A live holder is **reported, never moved to `completed`** — completing
another client's session would be a lie, because it did not complete, it was taken over. A conflict
writes nothing at all and creates no session.

`inconsistent` exists because missing evidence is not a free reference. A binding that names an open
link whose record cannot be read has lost the only statement of who held that identity; writing a
fresh link over it would destroy the discrepancy instead of reporting it.

`correlated`, `estimated` and `unknown` are deliberately absent. They belong to a later discovery
phase, where they will describe evidence LUWI inferred rather than a client declared.

### Lua validates; it does not decide

The daemon reads the binding and the linked session's status, the pure policy turns that observation
into one outcome, and the Redis Function verifies the observation still holds — compare-and-set on a
monotonic `version` — before applying the decided mutation. That split exists because section 7
forbids a Function from deriving a key name, and checking another session's presence key would
require exactly that.

`native_validate` runs **before `XGROUP CREATE`**, which is not a formality: `XGROUP CREATE …
MKSTREAM` creates a stream, so a conflict discovered afterwards would leave an inbox stream and a
consumer group behind for a session that was never registered. An integration test asserts
`EXISTS` on the inbox key is `0` after a refused declaration.

Contention is bounded at three attempts. The third `VERSION_CONFLICT` does not escape as a raw
repository error — every path maps it to `409 NATIVE_BINDING_CONTENDED`, because a caller would
otherwise see a 500 for what is a refusal. The session id and all event ids are minted once and stay
fixed across attempts, so a retry cannot append a second registration event for one registration.

### Append capacity is proven per append, not per stream

The existing `stream_appendable` answers "can this stream ever be appended to again". A two- or
three-event transition asks a different question. A stream whose last id is within `n-1` of the
maximum passes that check, accepts the first append and rejects the next, leaving a projection
written without one of its events. `stream_has_capacity(key, needed)` proves room for every append
before the first mutation, and an integration test crafts the boundary to show it.

### Terminal resolution is fail-closed

Every path that makes a session terminal closes its link: `session_close`, the sweeper's
`session_disconnect`, and `session_status` when the target is `completed` — the third being the one
most easily missed, since a session can reach a terminal state through the status endpoint without
ever calling close.

A session with no reverse index has no binding and takes the unchanged 5-key path. Once the reverse
index exists the evidence must be complete: if the binding, its `openLinkId`, or the link is missing,
or any of `binding.openLinkId`, `link.id`, `link.bindingId` and `link.sessionId` fails to match, the
transition **does not run at all**. Falling back would complete the session while abandoning an open
link.

The unlink itself validates before writing, because `HSET` creates a hash that does not exist: an
unlink pointed at a missing link would otherwise manufacture a phantom link carrying nothing but an
`unlinkedAt`. It also refuses a second close, which is what keeps `unlinkedAt` written exactly once.

### One clock, and two new event types

Every timestamp in this domain comes from the transition's own Redis clock: `linkedAt`,
`unlinkedAt`, the binding's `firstLinkedAt` and `lastLinkedAt`, and both events' `occurredAt`. Two
clocks would let a link interval disagree with the events that bound it, and the interval is what
transcript ingestion will join on.

`session.native.linked` and `session.native.unlinked` join `runtimeEventTypeSchema`, which is a
closed enum. Without that, both events would be written to the Stream and then rejected on the way
out by the repository parser and the realtime relay — a write that succeeds and a notification that
never arrives.

The 9-key registration response keeps exactly its existing shape. `native` and `events` appear only
in the 14-key form.

## Consequences

The dashboard, MCP server and every existing client are unaffected: the change is additive, no data
migration is required, and `LUWI_SESSION_ID` continues to work unchanged. The `luwi_v1` Function
library moves from v10 to v11.

**MCP self-registration is not included.** An owned bridge lifecycle needs periodic heartbeats,
graceful close, working-directory consistency validation, daemon and session loss handling, and
concurrent-instance handling; without all of it a self-registered session simply becomes
`disconnected` after the presence TTL. A1 is therefore a seam: within it, declarations are made
through the existing session registration API.

**A1 is not acceptance of A.** Link retention is A2 and is not implemented. Closed links accumulate
without bound, `trimmedLinkCount` stays `0` and `oldestRetainedLinkedAt` stays absent. Those fields
exist in the A1 schema so that A2 needs no projection migration.

**`usage.sessionId` is not solved.** Only a transcript record falling inside an unambiguous
`[linkedAt, unlinkedAt)` interval can be attributed. A record outside every such interval stays
unbound, and the transcript phase must define that policy. It is never assigned to the nearest
session.

A cannot detect the same subagent identifier appearing under two physical transcript paths, because
it accepts no path and reads no file. That check belongs to the transcript observer, which will have
a canonical source locator to prove it. A resolves the native-reference conflict only.

The presence semantics are unchanged: presence remains heartbeat plus live TTL, and no binding, link,
file or timestamp implies that a session is online.
