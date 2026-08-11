# Native session binding — design

Date: 2026-08-11
Status: approved, not implemented

Phase A of the sequence: **native identity binding** → transcript ingestion → automatic lease
renewal → autostart. This document specifies A only.

## 0. Delivery split: A1 and A2

A is delivered in two increments. This document specifies both; the implementation plans are
separate.

**A1** — protocol types, identifier derivation, the pure declaration policy, Redis keys, the extended
`session_register`, the three terminal close paths, the repository layer and the daemon wiring.

**A2** — link retention (§11) only.

The split is safe because transition Functions never trim: A1 is correct without retention. It is
**not free**. Until A2 lands, closed links accumulate without bound — one per LUWI session per native
identity — so `trimmedLinkCount` stays `0`, `oldestRetainedLinkedAt` stays absent, and the retention
guarantees in §11 are unimplemented. **A1 alone is therefore not acceptance of A.** A is accepted only
when A2 has landed and §11 holds.

The fields §11 needs are defined in the A1 schema so that A2 requires no projection migration.

## 1. Problem and current state

`#/config` aside, nothing in LUWI knows which vendor-native agent session produced the work it
records. The MCP server binds to a LUWI `sessionId` supplied as configuration, and that value is
fragile in a way the documentation understated.

| #   | Finding                                                                                                                                                                                                                                                                        | Evidence                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| F1  | `disconnected` is **terminal with no legal transition out**. The presence sweeper writes it when a heartbeat deadline lapses. A session id therefore dies permanently the moment its heartbeat gap exceeds the TTL — a daemon restart is only one way to produce that gap.     | `packages/runtime/src/session-status.ts:13,21`, `packages/runtime/src/presence-sweeper.ts` |
| F2  | Presence TTL defaults to 15 s, swept every 1 s. `verifyBoundSession` requires `presence === 'online'` and a non-terminal status, so the MCP server refuses to start against a lapsed session.                                                                                  | `apps/daemon/src/runtime.ts:90-91`, `apps/mcp-server/src/daemon-client.ts:249`             |
| F3  | `CLAUDE_CODE_SESSION_ID` is present in the agent's process environment and is byte-identical to the transcript filename stem. Native identity can be **declared**, not inferred. Inheritance by an MCP child process is strongly indicated but was not proven on this machine. | verified locally                                                                           |
| F4  | The session record and its presence key live in Redis, not in daemon memory. A client that keeps heartbeating survives a daemon restart; only a heartbeat gap kills it.                                                                                                        | `session_register` writes `SET presence PX ttl` and `ZADD heartbeatDeadlines`              |
| F5  | Native ↔ LUWI is **1:N over time**. One native session outlives many LUWI sessions.                                                                                                                                                                                            | consequence of F1                                                                          |
| F6  | `usageFields.sessionId` is required, so a usage record cannot exist without a LUWI session to attribute it to.                                                                                                                                                                 | `packages/protocol/src/intelligence.ts:91`                                                 |
| F7  | `keyPart` enforces `^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`. Unsafe external values are hashed into key material rather than embedded.                                                                                                                                            | `packages/redis/src/redis-keys.ts:111`, `projectPathIndex`                                 |

Affected boundaries: section 3 (this is coordination-plane runtime state, not canonical
configuration, so Redis is its home), section 7 (new keys, extended Functions, a new retention
sweep), section 8 (two new event types), section 12 (no adapter execution, no new MCP tool),
section 15 (every new transition needs tests).

## 2. Model

Two records with two different lifetimes.

**`NativeSessionBinding`** — the adapter-scoped native identity. Stable and long-lived. It carries
**no project, no agent, no AgentDefinition, no confidence and no presence**. Its only state fields
are `openLinkId`, `version` and bounded retention metadata.

**`NativeSessionLink`** — the exact association between a native identity and one LUWI session over
a bounded interval. Immutable once written; the single exception is `unlinkedAt`, which is written
once.

A declaration is **exact or rejected**. There is no binding-wide confidence in A, and a conflict
persists nothing. `correlated`, `estimated` and `unknown` belong to the later discovery and
attribution phase, where they will describe evidence LUWI inferred rather than a client declared.

`projectId` and `agentId` are never accepted from the native declaration. They are derived from the
registered session. AgentDefinition is resolved separately at read time and stored nowhere.

`latestSessionId` is deliberately **not** stored. The invariant the conflict rule needs is "is there
an open link", not "which session was last", and `openLinkId` cannot be misread as presence. The
most recent session is derived from the links index with `ZREVRANGE … LIMIT 0 1`.

## 3. Protocol types

```ts
const nativeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);

export const nativeSessionRefSchema = z.strictObject({
  adapterId: identifierSchema,
  nativeSessionId: nativeIdSchema,
  nativeSubagentId: nativeIdSchema.optional(),
});

export const nativeSessionKindSchema = z.enum(['main', 'subagent']);

export const nativeSessionBindingSchema = z.strictObject({
  id: identifierSchema,
  adapterId: identifierSchema,
  nativeSessionId: nativeIdSchema,
  nativeSubagentId: nativeIdSchema.optional(),
  kind: nativeSessionKindSchema,
  parentRef: nativeSessionRefSchema.optional(),
  openLinkId: identifierSchema.optional(),
  version: z.number().int().nonnegative(),
  linkCount: z.number().int().nonnegative(),
  trimmedLinkCount: z.number().int().nonnegative(),
  oldestRetainedLinkedAt: timestampSchema.optional(),
  firstLinkedAt: timestampSchema,
  lastLinkedAt: timestampSchema,
});

export const nativeSessionLinkSchema = z.strictObject({
  id: identifierSchema,
  bindingId: identifierSchema,
  sessionId: identifierSchema,
  linkedAt: timestampSchema,
  unlinkedAt: timestampSchema.optional(),
});
```

The request block carries the reference and nothing else:

```ts
native: nativeSessionRefSchema.optional();
```

`firstLinkedAt` and `lastLinkedAt` record link creations, not declaration attempts. An `unchanged`
outcome writes nothing at all, so neither field moves — the names say what the values mean rather
than implying a write that does not happen.

`kind` and `parentRef` are **derived, never accepted**: a present `nativeSubagentId` yields
`kind: 'subagent'` and `parentRef: { adapterId, nativeSessionId }`; its absence yields
`kind: 'main'`. Deriving them removes an entire class of self-contradictory declaration.

The charset is deliberately narrow. Both Claude Code forms — a UUID stem and an `agent-<hex>` stem —
fit. A vendor needing more is a reason to widen it then, with that vendor's layout in hand, rather
than to speculate now.

## 4. Redis representation

```text
luwi:v1:native-session:{bindingId}                HASH
  id, adapterId, nativeSessionId, nativeSubagentId?, kind, parentRefJson?,
  openLinkId?, version, linkCount, trimmedLinkCount, oldestRetainedLinkedAt?,
  firstLinkedAt, lastLinkedAt

luwi:v1:native-session-link:{linkId}              HASH
  id, bindingId, sessionId, linkedAt, unlinkedAt?

luwi:v1:index:native-session:{bindingId}:links    ZSET   score = linkedAt ms, member = linkId

luwi:v1:index:session:{sessionId}:native          STRING value = bindingId
```

Identifier derivation:

```text
bindingId = sha256(adapterId ‖ NUL ‖ nativeSessionId ‖ NUL ‖ (nativeSubagentId ?? ''))
linkId    = sha256(bindingId ‖ NUL ‖ sessionId)
```

Both are deterministic, which is what makes a declaration idempotent. `adapterId` leads the binding
preimage, so two vendors cannot collide by construction. The NUL separator removes concatenation
ambiguity between adjacent fields. No raw native value ever enters a key, per F7.

No `index:native-session:ref:{refHash}` key exists: `bindingId` **is** that hash, so a separate
index would enforce no invariant the primary key does not already enforce.

The reverse index `index:session:{sessionId}:native` has the **same lifetime as its link**. It is
written when the link is created, is left in place when the link is closed — a terminal session
still needs to resolve to its binding for later transcript mapping — and is deleted only when the
link is trimmed.

## 5. Runtime/Redis boundary: compare-and-set

Lua never owns product policy. The decision is made by a pure function in `@luwi/runtime`; the
Function verifies the state that decision was based on and applies the already-decided mutation.

1. The daemon reads the binding (if any), obtaining `version` and `openLinkId`.
2. If `openLinkId` is present, the daemon reads the linked session's status and presence. This read
   lives in the daemon precisely so that no Lua Function has to derive another session's key name,
   which section 7 forbids.
3. The pure policy function in `@luwi/runtime` maps that observed state to one outcome.
4. On `conflict` the daemon returns `409` and **calls no Function at all**.
5. Otherwise the daemon calls the Function with `expectedVersion`, `expectedOpenLinkId` and the
   decided transition.
6. Lua verifies that the stored `version` and `openLinkId` still equal the expected values. If they
   do, it applies the decided mutation and increments `version`. If they do not, it writes nothing
   and returns `version_conflict`.
7. A `version_conflict` causes a bounded re-read and re-evaluation.

**Retry limit: three CAS attempts per request in total** (one initial plus two retries). On
exhaustion the daemon returns `409 NATIVE_BINDING_CONTENDED`, which is distinct from
`409 NATIVE_SESSION_CONFLICT` so that a contended binding is never reported as a held one.

`version` is a monotonically increasing integer, starting at `1` for a newly created binding, and is
incremented by every binding mutation — link, unlink and retention trim alike.

For a `created` transition the daemon passes `expectedVersion: 0` and no `expectedOpenLinkId`, and
the Function additionally requires the binding key to be absent. A binding that appeared between the
daemon's read and the call therefore returns `version_conflict` rather than being overwritten, which
is what makes two concurrent first declarations resolve to exactly one winner.

## 6. Declaration outcomes

The pure policy function produces exactly one of:

| Observed state                                                                 | Outcome        | Effect                                                                                                 |
| ------------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------ |
| No binding                                                                     | `created`      | Binding and link written, `openLinkId` set, `version = 1`                                              |
| Binding exists, no `openLinkId`                                                | `linked`       | New link written; the previous link is **not touched**                                                 |
| Binding exists, open link points at **this** session                           | `unchanged`    | No write; idempotent success                                                                           |
| Binding exists, open link points at **another** online or non-terminal session | `conflict`     | Nothing written; the live session is **never** moved to `completed`; no `unknown` binding is persisted |
| Binding exists, open link points at a `disconnected` or `completed` session    | `linked`       | New link written; the old session is **not mutated**; the stale link is closed by the same transition  |
| Binding carries `openLinkId`, but the link hash or its session cannot be read  | `inconsistent` | Nothing written                                                                                        |

The `inconsistent` outcome exists so that missing evidence is never silently treated as a free
reference. A binding that names an open link whose record cannot be read has lost the only statement
of who held that identity; writing a fresh link over it would destroy the discrepancy rather than
report it. It returns `409 NATIVE_BINDING_INCONSISTENT` and writes nothing, so the state stays
inspectable. It is deliberately not retried: re-reading cannot manufacture a record that is absent.

**`conflict` fails the whole registration** with `409 NATIVE_SESSION_CONFLICT`, and no session is
created. This follows from the single atomic transition: a conflict means a live LUWI session already
holds this native identity, and creating a second one would double-count the agent. The cost is that
a client cannot re-register within the previous session's remaining TTL after a hard crash. That cost
is bounded by the presence TTL, does not arise in A because self-registration is deferred (§10), and
becomes rare once an owned bridge closes its link on graceful shutdown. The alternative — create the
session but not the link — was rejected because it produces exactly the registered-but-unbound state
that would then require a reconciliation path.

`unchanged` is specified because it is a rule of the binding, but it is **unreachable through A's
only entry point**: registration always mints a new session id, so an open link cannot already point
at it. It becomes reachable when a declaration surface for an existing session is added, and it is
implemented in the pure policy now so that surface inherits it rather than reinventing it.

## 7. Atomicity and the two-event contract

Session creation and the optional native binding and link are **one transition**. There is therefore
no registered-but-unbound state and no reconciliation path is required.

`session_register` currently takes 9 keys and 5 arguments. Extended, it accepts `#keys == 9` (no
native declaration) or `#keys == 14`:

| Key | Contents                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–9 | unchanged: session hash, project hash, project sessions set, agent sessions set, presence string, heartbeat deadlines zset, global events stream, project events stream, session inbox stream |
| 10  | `native-session:{bindingId}` hash                                                                                                                                                             |
| 11  | `native-session-link:{linkId}` hash                                                                                                                                                           |
| 12  | `index:native-session:{bindingId}:links` zset                                                                                                                                                 |
| 13  | `index:session:{sessionId}:native` string                                                                                                                                                     |
| 14  | stale `native-session-link:{staleLinkId}` hash, or a repeat of key 10 when there is none                                                                                                      |

Key 14 exists for one case: the binding's open link points at a session that is already terminal but
whose close has not yet been written (§6, last row). That stale link must be closed by the same
transition, or `openLinkId` would be overwritten and the old link would never receive its
`unlinkedAt`. When `native.staleLinkId` is absent the daemon repeats key 10, which that branch never
writes to, so the key count stays fixed.

Arguments gain `nativeJson` — `{ bindingId, linkId, staleLinkId?, transition, expectedVersion,
expectedOpenLinkId, binding, link }` — and `linkedEventId`, plus `unlinkedEventId` when
`staleLinkId` is present.

**Two phases, in this order.** The Function validates before it writes anything:

1. **`native_validate`** — performs **no mutation of any kind** and proves all of:
   - `expectedVersion` is an integer and not negative;
   - every required identifier is a non-empty string;
   - for a `created` transition, `binding.id` equals the declared `bindingId`;
   - `link.id` equals the link identifier in the payload and the declared link key entry;
   - `link.sessionId` equals the LUWI session being registered or closed;
   - an existing binding's stored `id` equals the declared `bindingId`;
   - `expectedOpenLinkId` and `staleLinkId`, when present, are strings and match what is stored;
   - a stale or unlink target link hash **exists**, belongs to that binding, and has no `unlinkedAt`;
   - the new link key does not already exist.

   It derives no key name: every key and every value it compares against is supplied by the caller.

2. `XGROUP CREATE … MKSTREAM` on the session inbox.
3. `native_apply` and the session projection mutations.

The ordering matters because `XGROUP CREATE … MKSTREAM` **creates a stream**, which is a durable
write. A `VERSION_CONFLICT` discovered after it would leave an inbox stream and a consumer group
behind for a session that was never registered. **A `VERSION_CONFLICT` must leave no durable trace at
all**, including no inbox stream and no consumer group.

**Event atomicity.** A native registration emits `session.registered` and `session.native.linked`,
and additionally `session.native.unlinked` when a stale link is closed in the same transition — two
events normally, three in the stale case. A terminal transition emits its existing terminal event and
`session.native.unlinked`.

**Append capacity is preflighted per append, not per stream.** It is not sufficient to check that the
two streams are appendable once: appendability is a property of the next entry, not of the stream as
a whole. A stream whose last id is at the maximum sequence for the current millisecond accepts one
append and rejects the next, so a two-event transition can pass a single check and still fail on its
second append after the first has been written. The preflight therefore proves that **each** of the
four appends (two-event case) or six appends (three-event case) can succeed, before the first
mutation of any kind. A stream that cannot accept every append it is about to receive aborts the whole
transition.

The projection mutation and all event appends happen inside the same Function. The persistence-first
realtime path carries every event, in the order they were appended.

Return shape:

```text
{
  status:  'created' | 'not_found' | 'error' | 'version_conflict',
  session: <the full stored session record, as today>,
  native: {
    transition: 'created' | 'linked' | 'unchanged',
    binding:    <the full stored binding record>,
    link:       <the full stored link record>,
    staleLink?: <the closed stale link record, present only in the stale case>
  },
  events: [
    { event: <session.registered>,       globalStreamId, projectStreamId },
    { event: <session.native.unlinked>,  globalStreamId, projectStreamId },   // stale case only
    { event: <session.native.linked>,    globalStreamId, projectStreamId }
  ]
}
```

The `events` array is ordered as appended and has two entries normally, three in the stale case.

**The `native` and `events` fields appear only when a native declaration was supplied.** A 9-key
registration returns exactly today's shape — `status`, `session`, `event`, `globalStreamId`,
`projectStreamId` — with no `native` key and no `events` key. Adding `events` unconditionally would
change a contract every existing caller and its parser already depend on, for no gain. The 14-key
form keeps those same top-level fields for the `session.registered` event so that the difference is
purely additive.

## 8. Terminal paths that close a link

**Every** path that makes a session terminal must close its open link, clear `openLinkId`, increment
`version` and emit `session.native.unlinked`. There are three, and all three are extended:

| Path                               | Function                                | Terminal event           | Keys  |
| ---------------------------------- | --------------------------------------- | ------------------------ | ----- |
| Graceful close                     | `session_close`                         | `session.completed`      | 5 → 7 |
| Heartbeat lapse                    | `session_disconnect` (presence sweeper) | `session.disconnected`   | 5 → 7 |
| Status endpoint set to `completed` | `session_status`                        | `session.status.changed` | 5 → 7 |

The third is the one most easily missed: `sessionStatusTargetSchema` includes `completed`, so a
session can reach a terminal state through the status endpoint without ever calling
`session_close`. **A session completed through the status endpoint must not leave `openLinkId`
behind.**

The two added keys are the binding hash and the link hash. The reverse index is not touched, because
it outlives the link's closure. Added arguments are `nativeJson` — `{ bindingId, linkId,
expectedVersion, expectedOpenLinkId }` — and `unlinkedEventId`. `unlinkedAt` is **not** an argument:
like every other timestamp in this domain it comes from the transition's own Redis clock (§10). Each
extended Function accepts both key counts, so a session with no binding behaves exactly as it does
today.

The daemon resolves the binding and link keys by reading `index:session:{sessionId}:native` before
the call, so no key name is derived inside Lua. The same CAS contract from §5 applies: the terminal
transition carries `expectedVersion` and `expectedOpenLinkId`, and a mismatch returns
`version_conflict` for bounded re-evaluation, bounded at the same three attempts.

**Terminal resolution is fail-closed.** A session that has no reverse index has no binding, and the
existing 5-key path is used unchanged. But once the reverse index exists, the evidence must be
complete: if the binding, its `openLinkId`, or the link record is missing, or if any of
`binding.openLinkId`, `link.id`, `link.bindingId` and `link.sessionId` fails to match the session
being closed, or if the link is already closed, the terminal transition **does not run at all**. It
returns `409 NATIVE_BINDING_INCONSISTENT` and performs no session mutation and no native mutation.
Falling back to the 5-key path there would complete the session while silently abandoning an open
link, which is exactly the loss of evidence the `inconsistent` outcome exists to prevent. Only an
exact match on all four fields runs the 7-key unlink. `close`, `status → completed` and the sweeper's
`disconnect` all use this same rule.

**CAS exhaustion maps to a refusal, never to a leaked error.** The first two `VERSION_CONFLICT`
results are re-read and re-evaluated. The third does not escape as a raw repository error: every
path — registration, `close`, `status → completed` and sweeper `disconnect` — returns
`409 NATIVE_BINDING_CONTENDED`. The session id and the registration, linked and unlinked event ids
are minted once and stay fixed across all three attempts.

**The unlink must validate before it writes, and must never create a record.** `HSET` creates a hash
that does not exist, so an unlink pointed at a missing or mismatched link would silently manufacture
a link with nothing but an `unlinkedAt`. The unlink therefore requires all of the following, and
returns `version_conflict` without writing if any fails:

- the binding hash exists and its `version` and `openLinkId` match the expected values;
- the link hash **exists**;
- its `id` equals the requested `linkId` and its `bindingId` equals the requested `bindingId`;
- its `unlinkedAt` is **absent**, so the field is written exactly once and a second close is refused
  rather than silently overwriting the first interval.

The transition clock is created **before** the unlink is applied, because the unlink stamps
`unlinkedAt` and the unlinked event's `occurredAt` from it. In the existing Functions `redis_now()`
is called after the appendability guard and immediately before the first mutation; the unlink block
goes after that call, not before it.

## 9. Main sessions and subagents

A subagent declares the parent's identifier as `nativeSessionId` and its own `agent-<hex>` stem as
`nativeSubagentId`. `kind` and `parentRef` are derived (§3). The parent binding is **never created
implicitly**; it is resolved at read time if it exists and otherwise reported as not observed, so no
dangling reference is written.

**A cannot detect the same subagent identifier appearing under two physical transcript paths.** A
accepts no path and reads no file, so it has no evidence with which to distinguish
`<uuid>/subagents/agent-x.jsonl` from `<uuid>/subagents/workflows/wf_1/agent-x.jsonl`. That check
belongs to the transcript observer phase, which will have a canonical source locator to prove it.
**A resolves the native-reference/session conflict only.**

`journal.jsonl`, `tool-results/`, `workflows/` and `memory/` are not sessions and have no
representation in `nativeSessionKindSchema`. A reads none of them; this is recorded as a contract for
the observer phase to honour.

## 10. Presence, APIs and events

**Presence remains heartbeat plus live TTL, and nothing else.** Neither the binding nor the link
carries, derives or implies presence. `openLinkId` means "not yet closed", not "alive" — a crashed
client leaves a link open until the sweeper closes it, bounded by the presence TTL. A transcript
file, a file timestamp and a historical record never affect presence.

New events: `session.native.linked` and `session.native.unlinked`, carrying identifiers only. Both
must be added to `runtimeEventTypeSchema`, which is a closed enum — an event type absent from it
fails validation in the repository parser, in the realtime relay and at every consumer, so the events
would be written and then rejected on the way out.

**Every timestamp in this domain comes from the Redis transition clock**, the same `redis_now()` the
surrounding Function already uses for its own event: `linkedAt`, `unlinkedAt`, the binding's
`firstLinkedAt` and `lastLinkedAt`, and both new events' `occurredAt`. No time value is carried in
from the daemon. Two clocks would let a link interval disagree with the events that bound it, and the
interval is the thing transcript ingestion will later join on.

The only API surface in A is the optional `native` block on `POST /api/v1/sessions`. Public
collection routes are **deferred**: no consumer exists for them yet, and neither transcript
ingestion nor an approved UI or CLI surface has asked for one.

**MCP self-registration is not included in A.** An owned bridge lifecycle needs periodic heartbeats,
graceful close, working-directory/project/agent consistency validation, daemon and session loss
handling, and concurrent-instance handling. Without all of it a self-registered session simply
becomes `disconnected` after the presence TTL and A fails again immediately. It is therefore its own
vertical increment. The existing `LUWI_SESSION_ID` path is preserved unchanged.

A is consequently a **seam**. Within A, declarations can be made through the existing session
registration API by the CLI, the bridge simulations and the tests.

## 11. Link retention

Transition Functions **never trim**. Retention is a separate periodic service, so that a hot path is
never made to pay for history.

- Bound: **at most 1000 closed links retained per binding**, configurable through
  `LUWI_NATIVE_LINK_RETENTION_MAX` in the same way every other bound in the daemon config is.
- An **open link is never trimmed**, at any count.
- A trimmed link is removed from the links zset **and** its link hash **and** its reverse index, so
  no dangling `openLinkId` and no dangling reverse index can survive a trim.
- The binding records the truncation honestly: `trimmedLinkCount` and `oldestRetainedLinkedAt`. A
  reader can therefore tell that history was cut and where the retained history begins.
- **A transcript record falling inside a trimmed interval is never assigned to a session.** It stays
  unavailable and unbound. Retention removes evidence; it does not license a guess.

The trim runs as `native_link_trim`, a new Function taking `2 + 2N` keys — the binding hash, the
links zset, and the hash plus reverse-index key of each of the `N ≤ 32` links being trimmed, all
declared by the caller after it has read which links to remove. It carries the same CAS contract:
`expectedVersion` guards the binding, and a trim that races a link or unlink returns
`version_conflict` and is retried on the next sweep rather than immediately.

## 12. Failure and recovery

| Situation                                                                    | Behaviour                                                                                                                                             |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown `projectId`                                                          | `404`; nothing written                                                                                                                                |
| Redis unavailable                                                            | `503`; no partial write, because the transition is one Function                                                                                       |
| Native conflict                                                              | `409 NATIVE_SESSION_CONFLICT`; nothing written; no session created                                                                                    |
| CAS retries exhausted                                                        | `409 NATIVE_BINDING_CONTENDED`; nothing written                                                                                                       |
| Malformed or over-long native id                                             | schema rejection; the session is not registered either                                                                                                |
| A required stream cannot accept an append                                    | whole transition aborts before the first mutation                                                                                                     |
| Client crashed with an open link                                             | the sweeper's `session_disconnect` closes it, bounded by the presence TTL                                                                             |
| Open link whose session is already terminal, close not yet written           | an arriving declaration is `linked`: it closes the stale link and creates its own in the same transition (§6), and never returns `conflict`           |
| Binding carries `openLinkId` but the link hash or its session cannot be read | `409 NATIVE_BINDING_INCONSISTENT`; nothing is written. Writing a fresh link here would hide the loss of the evidence that says who held the reference |

## 13. Compatibility and migration

Purely additive. Existing sessions have no binding and nothing about them changes. The
`LUWI_SESSION_ID` path is untouched. No data migration is required. `session_close`,
`session_status` and `session_disconnect` accept both key counts, so unbound sessions traverse them
exactly as today. The single versioned change is the `luwi_v1` Function library, **v10 → v11**,
which the existing load path already handles.

## 14. Test matrix

**Unit, `@luwi/runtime`**

- all five declaration outcomes from the pure policy function;
- `bindingId` and `linkId` determinism, and that the NUL separator prevents concatenation ambiguity
  between adjacent preimage fields;
- cross-vendor non-collision for identical native ids under different `adapterId` values;
- charset rejection, including an over-long id and a leading non-alphanumeric;
- `kind` and `parentRef` derivation for both main and subagent references;
- a structural assertion that the binding schema carries no presence, project, agent or confidence
  field;
- CAS evaluation: version match applies, mismatch re-evaluates, and the retry limit is three
  attempts.

**Redis integration**

- each of the five outcomes against the real Function;
- two concurrent declarations for one reference produce exactly one winner;
- `session_close`, `session_status → completed` and sweeper `session_disconnect` each close the open
  link, clear `openLinkId`, bump `version` and emit `session.native.unlinked`;
- a session completed through the status endpoint leaves **no** `openLinkId`;
- both events are appended to both streams inside one Function, and a stream that cannot accept an
  append aborts the transition with nothing written;
- the stale case: an open link whose session is already terminal is closed in the same transition
  that creates the new link, the closed link receives `unlinkedAt`, `openLinkId` points at the new
  link, and three events are appended in order;
- `unlinkedAt` is written exactly once, including when a stale close and a terminal close race;
- `version_conflict` is returned and nothing is written when the expected version is stale;
- retention: closed links beyond 1000 are trimmed from zset, hash and reverse index together; an
  open link is never trimmed; `trimmedLinkCount` and `oldestRetainedLinkedAt` reflect the cut;
- library v11 loads, and rollback to the previous version behaves;
- **conflict writes nothing** — asserted by comparing the full binding state before and after.

**Counter-tests**

- a live session is never moved to `completed` by an arriving declaration;
- the presence of a transcript file changes no presence value;
- a trimmed interval yields no session assignment.

## 15. Non-goals and what A hands to the transcript phase

**Non-goals.** Reading, parsing or ingesting transcripts. Creating bindings from historical
transcripts. Writing usage records. Extending the protocol for cache token fields. Extending
`AdapterFileSystem`. Any assumption about the Codex, Gemini CLI or Kimi native layout. Any change to
presence semantics. Lease renewal. Autostart. Starting or controlling coding-agent processes. Graph
edge creation.

**What A provides.** A join key the observer does not have to infer: the transcript filename stem is
the `nativeSessionId`, and the declared link gives an exact interval in which that native identity
belonged to a specific LUWI session.

**What A explicitly does not solve.**

- `usage.sessionId` is **not** solved. Only a transcript record falling inside an unambiguous
  `[linkedAt, unlinkedAt)` interval can be attributed. A record outside every such interval — or
  inside a trimmed one — stays unbound, skipped or pending, and the transcript phase must define that
  policy. **It is never assigned to the nearest session.**
- F1 is not solved. Until an owned bridge lifecycle exists, a heartbeat gap beyond the presence TTL
  still kills a session permanently. A builds the identity ground that increment stands on; it does
  not remove the symptom.
- Two known debts pass to the transcript phase: the protocol cannot honestly represent Claude's two
  distinct cache counters (`cache_creation_input_tokens` and `cache_read_input_tokens`) through the
  single `cachedInputTokens` field, and `AdapterFileSystem` offers no directory listing, stat or
  offset read.

**The product claim A supports** remains bounded: LUWI observed operations recorded in the Claude
Code native transcript. It is not a claim that LUWI observes every agentic operation. No graph edge
is created, no disconnected component is asserted to be connected, and unknown relationships stay
unknown.
