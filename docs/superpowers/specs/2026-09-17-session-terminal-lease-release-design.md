# Session-terminal lease release (P12) — design

**Status:** implemented, 2026-09-17 (owner-approved: release-immediately, `expireLease` reuse, no
`luwi_v1` bump). Built via TDD; §7 (redis-invariants) review clean — folded in below. Uncommitted;
a normal daemon restart deploys it.
**Scope:** when a session becomes terminal, release the work-leases it still holds, at all three
terminal transitions (`closeSession`, `disconnectExpiredSession`, `reapStartingSession`). Nothing
about how a lease is _acquired_ or _renewed_ changes; the daemon just stops leaving a dead holder's
claims standing for up to five minutes.

## Why — the P12 root cause

Codex's Albanoosh pilot register (LRT-P12) reported "native-ref rotation orphans leases." Traced to
root, the mechanism is:

1. **`lease_acquire` denies on expiry alone, never on holder liveness.**
   `function-library.ts:1416` — an overlapping lease is a conflict while `expiresMs > now_ms`,
   full stop. The holder's session status is never consulted.
2. **No terminal transition releases a session's leases.** `session-service.ts` has zero lease
   code; the three terminal transitions in `runtime-repository.ts` (`closeSession` → `completed`,
   `disconnectExpiredSession` → `disconnected`, `reapStartingSession` → `disconnected`) reconcile
   the session's **native link** (`resolveNativeUnlink` / `unlinkedEventId`) but touch no lease.
3. **Renewal keeps a held lease topped up to the full 5-minute TTL** (`LEASE_DEFAULT_DURATION_MS`,
   renewed every half-TTL by the session bootstrap, ADR 0026). So at the instant a session dies its
   leases have up to five minutes left.

Put together: when a session rotates — the common path being a daemon restart (every deploy on the
pilot), where the ~15 s outage lapses presence and `disconnectExpiredSession` marks the old id
`disconnected` — its leases are **orphaned**. They are:

- not renewed (the successor session, a new id, holds none, so the bootstrap's renewal loop renews
  nothing on their behalf);
- not releasable by the successor (`lease_release`/`lease_renew` answer `not_holder` — release is
  holder-only, and the holder is a dead id);
- still blocking every overlapping `lease_acquire`, from any session including the same agent's own
  successor, until the expiry sweep reaches them up to five minutes later.

The overlap-refusal even names the dead session (`conflict.sessionId`), so the pilot sees
"path held by \<disconnected session\>" and cannot clear it.

**Today's `1b6f750` (MCP auto-idle) makes this _more_ exercised, not less.** Before it, an
auto-attached GUI/IDE session sat `starting`, was reaped, and `session attach` **dropped** it
(no rotation). Now the session reaches `idle`, so `readyObserved` is true, so on a daemon-restart
`SESSION_TERMINAL` the attach process **rotates** — which is the exact path that orphans leases.
So P12's first symptom ("attach mutates the session-out file then errors") is already resolved by
`1b6f750`; the lease half is what remains, and rotation is now routine.

### Evidence

- `packages/redis/src/function-library.ts:1416-1425` — acquire's expiry-only conflict check.
- `apps/daemon/src/session-service.ts` — no lease handling anywhere.
- `apps/daemon/src/runtime.ts:158,231` and `session-service.ts:528` — native-link reconciliation
  at each terminal transition, with no lease sibling.
- `packages/protocol/src/lease.ts:22` — `LEASE_DEFAULT_DURATION_MS = 300_000`.
- Live daemon at time of writing: `GET /api/v1/leases` = 0 (quiescent — no active editing, and any
  5-min leases have already lapsed), so no orphan is _sitting_ there this instant; the bug is
  exercised whenever a session holds a lease and the daemon rotates it.

## What the fix does

At each of the three terminal transitions, after the transition succeeds, **release the leases the
terminating session held**, as the runtime's own (holder-less) transition — exactly the shape the
expiry sweeper already uses.

- `leaseService.releaseForSession(sessionId)`: `listSessionLeases(sessionId, LEASE_MAX_ACTIVE_PER_PROJECT)`
  → for each, the same `expireHeldLease` the deadline sweep uses (re-read, expire only if still
  `held`, emit `lease.expired`). It reuses the existing holder-less `lease_expire` Function.
- Wired through a late-bound `releaseSessionLeases` in `startDaemon` (the file's existing
  `refreshProject` pattern) into `sessionService.onClosed` (after `completed`) and into the
  `disconnectExpiredSession` / `reapStartingSession` sweep adapters (after the terminal transition
  returns), reassigned once `leaseService` exists to a wrapper that logs a failure rather than
  throwing — so lease cleanup can never block or lose a terminal transition.
- **Best-effort and post-transition, not folded into the terminal Lua.** A native unlink is one
  event and rides inside the terminal Function atomically; a session holds up to
  `LEASE_MAX_ACTIVE_PER_PROJECT` (100) leases — all in its own project, since acquire enforces
  same-project — i.e. up to 100 per-lease stream appends, which must not go inside one fixed-key
  Function (§7). Releasing after the transition, one `expireLease` per lease, keeps each in its own
  project stream.
- **Crash-safe by construction.** If the daemon dies between the terminal transition and the lease
  release, the existing 5-minute expiry sweeper is still the backstop — the exact behaviour we
  have today. The fix only makes the common case immediate.

### Reuse, no new machinery

- **Reuses `expireLease` / the existing `lease_expire` Function** (`lease-repository.ts:234`,
  holder-less by design — see its comment at :238). Emitting `lease.expired` a little early is
  harmless: the path is genuinely free, and the dashboard already handles that event.
- **No `luwi_v1` bump.** No new Function, no stored-record shape change. A normal daemon restart
  picks up the new daemon code.
- **No protocol or Redis-key change.** The session lease set (`index:session:{id}:leases`) already
  exists and already survives a terminal transition (leases are not removed on disconnect today).

## What it deliberately does NOT do

- **No lease inheritance by the successor.** Leases are advisory and short; the MCP server
  re-acquires per edit (`luwi_acquire_lease`). Transferring a holder id across a rotation is more
  code for no benefit the agent can observe.
- **No acquire-side "steal from a dead holder."** That would push a session-liveness read into
  `lease_acquire`'s single-declared-key scan (§7) — a worse fit than releasing at the source.
- **No TTL change.** Shortening the lease TTL is a band-aid that trades a smaller orphan window for
  more renewal churn; it does not fix the root.
- **No new `lease.released`-by-runtime event.** Considered (call `releaseLease` with an empty
  holder, which the Function already accepts) — rejected because observers act identically on
  `lease.expired` and a new event shape is avoidable surface.
- **§3 unchanged.** Leases stay advisory; LUWI still cannot enforce them, only answer atomically.

## Tests (§15) — what was built

The release logic is identical across all three transitions (the same `releaseForSession` →
`expireHeldLease` → `lease_expire`); only the trigger differs, and each trigger is independently
integration-proven. So the coverage is: the shared release proven end-to-end through one transition,
the other two triggers proven to invoke it, and the release path itself unit-covered.

- **Unit — `leaseService.releaseForSession`** (`lease-service.test.ts`): expires every lease in the
  session's set (one `expireLease` each, with the `lease.expired` event); re-runnable — a lease no
  longer `held` between the list and the re-read is left alone, counted as not expired; best-effort
  — one failing `expireLease` does not abort the rest; a session with no leases is a no-op.
- **Unit — the two sweep adapters** (`runtime.test.ts`): each calls `releaseSessionLeases` with the
  session id after a successful terminal transition (disconnect, reap) and not when the transition
  changed nothing (unchanged / skipped).
- **Integration — close, end to end** (`runtime.integration.test.ts`, `/redis-it`): a holder takes
  a lease, an overlapping acquire from a second session is denied (naming the holder), the holder is
  closed, and the overlapping acquire then **succeeds** — the observable that was broken, proven
  against real Redis. Confirmed to fail with the release disabled.
- **Disconnect / reap E2E** are covered by composition rather than a dedicated (slow, presence-TTL)
  daemon test: the wiring passes the _same_ reassigned `releaseSessionLeases` to all three sites
  (unit-proven called on disconnect/reap), the release→real-`lease_expire`→path-freed step is proven
  by the close integration test above, and the two triggers themselves are proven by
  `session-presence.integration.test.ts` and `session-reap.integration.test.ts`. Reap is bridge-only
  and rare.
- **Regression:** the standalone `LeaseExpirySweeper` backstop is unchanged (existing
  `lease-transitions.integration.test.ts` and the `expire` unit tests still pass); `expire` now
  delegates to the extracted `expireHeldLease` with identical behaviour.

## §7 (redis-invariants) review

Reviewed and **clean — no §7/§14 violation**. Verified: the reused `lease_expire` Function
preflights `stream_appendable` before any mutation (no partial "projection changed, event did not");
the release runs as separate FCALLs after the terminal Function commits, opening no new event-loss
hole (the deadline sweep remains the durable backstop); idempotent by the `state === 'held'`
re-read; validate-on-read holds through `getLease`/`workLeaseSchema`; no `luwi_v1` bump, no new
stream/consumer-group, and `lease.expired` volume is bounded by the same events the sweep would emit.

## Decision

Owner-approved 2026-09-17: release immediately — the root fix, reusing existing machinery, no
`luwi_v1` bump, no widened boundary. Implemented.
