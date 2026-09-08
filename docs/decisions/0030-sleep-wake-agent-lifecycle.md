# ADR 0030: Sleep/wake-safe agent lifecycle

Status: Accepted  
Date: 2026-09-07

## Context

The daemon-owner and session-presence keys both use 15-second TTLs, while their renewals run from
Node.js timers. Machine sleep pauses those timers but not Redis expiry, so a sleep can outlast both
TTLs. A running daemon must be able to resume observation when its own owner key has expired without
becoming a second owner; a LUWI session that expired during sleep must likewise be recoverable without
claiming that it is the old session.

`session attach` is a long-lived helper. Every daemon request it makes must be bounded so a network or
daemon failure cannot keep its serialized bootstrap operation or cleanup path waiting indefinitely.
LUWI also needs to distinguish the native-agent end signals it actually owns from the ones a vendor
does not expose.

## Decision

### Recover an expired owner key only when it is vacant

A daemon lease instance that previously acquired ownership may recover only by atomically issuing
`SET luwi:v1:runtime:daemon-owner <existing-token> NX PX <ttl>`. It reuses its existing token and
may claim only an absent key. If another token exists, the old daemon drains; it never overwrites,
deletes, or adopts the competing token.

Recovery first verifies the current token. A successful vacant-key reacquisition is recovery by the
same daemon process, not startup: its `runtimeInstanceId` remains stable and it appends no second
`runtime.started` event. Larger TTLs, elapsed-time sleep detection, wake tasks, services, and
watchdogs remain rejected. LUWI uses the observable Redis state rather than inferring sleep from a
timer gap.

### Bound every attach-side daemon request

`luwi session attach` uses `AbortController` deadlines for project discovery, session registration,
heartbeat, session close, held-lease listing, and lease renewal. `--connect-timeout-ms` defaults to
2,000 ms and accepts integer values from 100 through 30,000 ms.

The attach helper installs `SIGINT` and `SIGTERM` handling before initial bootstrap registration. On
stop it disarms its heartbeat and lease-renewal timers before attempting the deadline-bound,
best-effort remote close. A remote cleanup failure therefore cannot keep the helper alive forever.

### Keep session and native-agent boundaries explicit

`SESSION_NOT_FOUND` and `SESSION_TERMINAL` continue to rotate observation to a new LUWI session using
the original registration input. The terminal historical session remains terminal and its work leases
do not transfer to the replacement.

Managed cleanup follows the liveness evidence actually available: `agent run` owns an exact child-exit
signal, and Claude supplies an exact `SessionEnd` signal. Antigravity exposes no exact end event, so
its attach supervisor remains bounded by the existing 30-minute inactivity limit. Manual
`session attach` remains explicit: it ends through Ctrl+C, `SIGINT`, `SIGTERM`, or a launcher that
knows the native lifecycle. LUWI adds no generic sleep detector and does not stop, restart, signal,
or inject input into a native agent as part of recovery.

## Consequences

A live native agent is neither stopped nor restarted when LUWI recovers from sleep-related expiry.
An existing daemon can regain a vacant owner key and resume its normal recovery checks, while a
competing daemon is never overwritten and forces the old instance to drain.

An expired LUWI session can be replaced after wake, so a replacement may temporarily appear beside
the terminal historical session. It begins with no transferred work leases. Bounded attach I/O and
timer-first shutdown mean an unavailable daemon or Redis cannot leave a managed helper running
forever; this does not invent an exact Antigravity end signal where none exists.

The daemon remains the only Redis client process. No service, watchdog, wake task, new datastore,
Redis Function, API route, protocol version, or power-management integration is introduced. Real
Redis integration verification remains opt-in through an explicit `LUWI_TEST_REDIS_URL`; it never
falls back to a developer's default Redis database.
