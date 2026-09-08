# Sleep/Wake-Safe Agent Lifecycle

Status: Approved  
Date: 2026-09-07

## Purpose

LUWI must remain an observer and coordinator when a development machine sleeps. A live native agent
must continue running after wake while LUWI restores its daemon ownership and session observation.
When the native agent has ended, LUWI's heartbeat, lease-renewal, attach, and hook helper processes
must stop within a defined bound instead of waiting forever or interfering with operating-system
sleep or shutdown.

This design strengthens the existing lifecycle. It does not introduce a service, watchdog, new
datastore, Redis Function, protocol version, or dependency.

## Evidence and current failure modes

The daemon owner key and session presence keys both have 15-second TTLs. Their renewals run from
Node.js interval callbacks. Operating-system sleep suspends those callbacks while Redis expiry time
continues to advance. After a sleep longer than the TTL:

1. `RedisDaemonOwnershipLease.renewOnce()` can observe that the daemon owner key is absent, mark
   ownership lost, and enter runtime recovery.
2. Runtime recovery calls `ownsLease()`. An absent key is currently treated the same as a key held by
   another daemon, so the still-running daemon drains and exits.
3. A session heartbeat can find its old session terminal after presence expiry. The shared session
   bootstrap already handles `SESSION_NOT_FOUND` and `SESSION_TERMINAL` by registering a replacement
   session on a later tick.
4. `agent run` bounds its daemon HTTP calls, but `session attach` uses unbounded `fetch` calls for
   project discovery, registration, heartbeat, close, lease listing, and lease renewal. A request
   stranded across sleep can leave the bootstrap's serialized operation permanently occupied. An
   unbounded close can also keep an attach helper alive after its native agent has ended.

The failure is therefore not solved by one larger TTL. Ownership recovery and attach I/O both need
bounded, explicit behavior.

## Required behavior

### Live agent

- The native agent process is never stopped because LUWI slept, lost Redis temporarily, or rotated a
  LUWI session.
- If the existing daemon's owner key expired and no other daemon owns the runtime, that daemon
  atomically reclaims ownership and returns to `ready`.
- If another daemon owns the runtime, the old daemon drains and exits. LUWI never permits two active
  owners.
- If a session became terminal during sleep, the session bootstrap registers a new LUWI session from
  the original project, agent, working-directory, native-reference, and metadata input.
- A pending HTTP operation has a fixed deadline. Timeout releases the serialized bootstrap slot, is
  reported as degraded observation, and is retried through the existing bounded backoff.
- Work leases are not transferred to a replacement session. The old session's leases expire under
  ADR 0026, and the replacement session starts with no claims.

### Ended agent

- `agent run` stops session observation when its owned child exits.
- Claude's `SessionEnd` hook stops the detached attach process.
- Antigravity has no end event. Its helper remains bounded by the existing 30-minute no-activity
  limit; the next `PreInvocation` can attach again if a sleep or inactivity boundary ended the prior
  observation.
- A stop request clears heartbeat and lease-renewal timers before attempting remote cleanup.
- Remote close is best effort and deadline-bound. Redis or daemon failure cannot keep a helper alive
  indefinitely.
- LUWI processes do not request sleep inhibition and do not install power-event listeners merely to
  keep themselves alive. Normal operating-system termination remains authoritative.

Manual `session attach` has no reliable way to infer that an unrelated external process ended. Its
lifetime remains explicit: Ctrl+C, SIGINT/SIGTERM, or a launcher lifecycle hook. The no-orphan
guarantee applies to the managed `agent run`, Claude hook, and bounded Antigravity hook paths; it
does not fabricate process ownership LUWI does not possess.

## Design

### 1. Atomically reclaim an expired daemon owner key

Extend the daemon-ownership abstraction with a recovery operation that attempts:

```text
SET luwi:v1:runtime:daemon-owner <existing-owner-token> NX PX <owner-ttl>
```

The operation is allowed only for a lease instance that previously acquired ownership. It returns
one of two outcomes:

- `reacquired`: the key was absent, this process atomically restored it, `isOwned` becomes true, and
  the existing renewal timer continues;
- `contended`: a value already exists, `isOwned` remains false, and this process must drain.

A Redis error remains an error and goes through the existing reconnect backoff. Recovery does not
overwrite any token, compare a token non-atomically, or create a second renewal timer. Successful
reacquisition resets the one-shot lost notification so a later genuine loss is observable.

Runtime recovery first reconnects all three Redis connections, then checks the current owner token.
If it is still owned, recovery proceeds unchanged. If it is absent or different, recovery attempts
the atomic reclaim:

- a vacant key lets the same runtime instance continue through Function verification, Stream-group
  recovery, canonical reconciliation, intelligence checks, and the transition back to `ready`;
- contention triggers the existing draining shutdown;
- Redis failure retains `degraded`/`recovering` behavior and retries within the existing bounds.

Reacquisition is recovery by the same process, not a new daemon start. It does not append a second
`runtime.started` event and does not change the daemon's runtime instance ID.

### 2. Give `session attach` the same bounded daemon client as `agent run`

Add `--connect-timeout-ms` to `session attach`, with the same 2,000-ms default and 100–30,000-ms
validation already used by `agent run`. Route every attach-side daemon operation through the
existing `boundedRequest` helper:

- project discovery;
- session registration;
- heartbeat;
- session close;
- held-lease listing;
- lease renewal.

The timeout uses `AbortController`, produces the existing safe `DAEMON_REQUEST_TIMEOUT` error, and
contains no daemon connection details. No new protocol route or server configuration is required.

The attach command installs its idempotent SIGINT/SIGTERM stop listener before awaiting initial
registration. Shutdown clears the local timers first and then performs the deadline-bound close.
Registration or close failure is reported but never blocks the native agent or leaves the helper in
an unbounded wait.

### 3. Preserve session-bootstrap recovery semantics

`createSessionBootstrap` remains the owner of heartbeats and session rotation. Its existing rules
continue to apply:

- transient errors retain the current session and use capped exponential backoff;
- only `SESSION_NOT_FOUND` and `SESSION_TERMINAL` discard the current LUWI session ID;
- replacement registration reuses the immutable original registration input;
- late operations cannot resurrect a stopped lifecycle generation;
- a rotated session never renews leases held by its predecessor.

No operating-system sleep detector is added. Timer delay alone cannot distinguish sleep from CPU
pressure, debugger suspension, or event-loop starvation. The observable facts—expired ownership,
terminal session, request timeout—are sufficient and safer to act upon.

### 4. Keep launcher cleanup bounded and honest

No new persistent supervisor is introduced.

- `agent run` already owns the child process and therefore has an exact exit signal. Its bounded
  bootstrap client remains the reference behavior.
- Claude supplies exact `SessionStart` and `SessionEnd` events. The end hook signals the attach
  helper; bounded close guarantees that the helper can finish even while the daemon is unavailable.
- Antigravity supplies `PreInvocation` but no end event. Its current detached supervisor therefore
  keeps the 30-minute transcript/activity bound. It may end observation while the machine sleeps;
  the next invocation starts a fresh observation. LUWI does not claim immediate close detection that
  the vendor does not expose.

The daemon itself remains an opt-in logon-started local runtime under ADR 0027. Recovering its own
expired owner key removes the need for a Windows wake task, service, or watchdog.

## State flow

```text
machine wakes
  -> daemon renewal/recovery checks owner key
     -> own token present: continue recovery
     -> key vacant: atomic NX reclaim -> recover -> ready
     -> other token present: drain old daemon

  -> live attach heartbeat runs with request deadline
     -> old session still live: renew presence
     -> old session terminal/missing: clear id -> register replacement
     -> daemon unavailable/timeout: bounded backoff -> retry

native agent ends
  -> owned-child exit or launcher end signal
  -> clear local heartbeat and lease timers
  -> bounded best-effort session close
  -> helper exits
```

## Concurrency and safety

- Reclaim uses Redis `SET NX PX`; a check-then-set sequence is forbidden.
- A competing owner always wins over the old process's desire to recover.
- The existing owner token is reused only by the in-memory lease object that originally acquired it.
- Browser, CLI, MCP, and coding-agent processes still receive no Redis credentials.
- Reacquisition changes no canonical configuration and writes only the existing TTL owner key.
- Session replacement uses the existing registration transition and event envelope.
- No stale session is changed back from `disconnected`; terminal state remains terminal.
- No expired work lease is revived or moved between sessions.

## Error handling and observability

- Successful owner reclaim produces one structured informational log carrying the runtime instance
  identifier, with no Redis connection details or secrets.
- Contention produces the existing ownership-loss/draining path.
- Attach request timeouts use `DAEMON_REQUEST_TIMEOUT` and flow through the existing degraded
  observation channel. They do not fail or terminate the native agent.
- Session replacement continues to emit the existing `recovered` bootstrap change, allowing
  `agent run` diagnostics and dashboards to distinguish the new LUWI session.
- Cleanup errors are reported once and then discarded after the deadline; local exit does not depend
  on remote acknowledgement.

## Tests

### Daemon ownership unit tests

- An acquired lease whose key disappeared can reclaim it with the same token using `SET NX PX`.
- Reclaim does not overwrite a competing token and reports contention.
- Reclaim reuses the existing renewal timer rather than arming a second timer.
- Redis failure does not mark the lease owned.
- A successful reclaim permits a later ownership loss to notify exactly once again.

### Daemon runtime tests

- Recovery with a missing owner key reclaims ownership and returns to `ready` without calling
  shutdown.
- Recovery with a competing owner drains the old runtime.
- Reclaim failure remains degraded and follows reconnect backoff.
- A recovered process does not append a second `runtime.started` event.

### Session bootstrap and CLI tests

- A long clock advance followed by `SESSION_TERMINAL` rotates to a replacement session with the
  original registration input.
- `session attach` validates `--connect-timeout-ms` with the same bounds as `agent run`.
- Discovery, register, heartbeat, close, lease-list, and lease-renew attach requests carry an abort
  signal and cannot occupy the loop after their deadline.
- A timed-out heartbeat is retried through existing backoff.
- A stop requested during initial registration reaches one cleanup path.
- A close request that never answers is aborted and the attach command completes.
- Stop clears both heartbeat and lease-renewal timers before remote close.

Relevant package tests run first, followed by root formatting, lint, typecheck, test, and build.
Redis integration tests are required only if the ownership repository's Redis behavior changes
beyond the already standard `SET NX PX` command; otherwise the command shape is covered by the
ownership unit tests and the existing ownership integration suite is rerun when
`LUWI_TEST_REDIS_URL` is available.

## Rejected alternatives

### Increase TTLs

Long TTLs merely move the failure boundary and make stale daemon ownership, presence, and work claims
linger. They cannot distinguish a sleeping live process from a crashed process.

### Add a Windows wake Scheduled Task

A wake trigger would be platform-specific, could race the still-bound old daemon port, and would add
a second startup policy beyond ADR 0027's opt-in logon task. Atomic in-process reclaim solves the
actual ownership gap on every platform.

### Add a watchdog or service

A persistent supervisor would change LUWI's execution-plane boundary and contradict the accepted
single-user, local, non-service architecture. The existing process can recover safely without one.

### Detect sleep from elapsed wall time

A large timer gap is ambiguous and introduces policy based on inference. Recovery should respond to
validated Redis ownership, session state, and bounded I/O outcomes instead.

## Acceptance criteria

1. After a sleep longer than both 15-second TTLs, a running daemon with no competitor returns to
   `ready` without process replacement.
2. A live attached agent receives a fresh LUWI session when its prior session expired.
3. A competing daemon is never overwritten; the stale process drains.
4. No attach-side daemon request can wait forever.
5. Ending a managed native agent leaves no indefinitely running LUWI attach or renewal loop.
6. Sleep/wake recovery never stops, restarts, or injects input into the native coding agent.
7. No new dependency, datastore, Redis Function version, protocol route, service, watchdog, or
   power-management integration is introduced.
