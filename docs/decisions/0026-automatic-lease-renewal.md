# ADR 0026: Automatic, holder-side work-lease renewal

Status: Accepted  
Date: 2026-09-01

## Context

ADR 0020 built advisory work leases: a session claims a project-relative path before editing it, an
overlapping claim is refused with the holder named, and the lease carries a TTL
(`LEASE_DEFAULT_DURATION_MS` = 300 000 ms). A lease that is not renewed before its deadline is swept
to `expired` — the daemon's expiry sweeper reaps it within ~1 s of `expiresAt`, and the path frees.

Renewal today is **manual only**: `POST /api/v1/leases/:leaseId/renew`, the `lease renew <leaseId>`
CLI command, and the `luwi_renew_lease` MCP tool. Nothing renews on its own, so a session that holds
a path for longer than one TTL loses its claim mid-work unless the agent remembers to renew — which
defeats the point of claiming the path in the first place. `AGENTS.md` §21 lists automatic lease
renewal as unapproved; the 2026-09-01 completion directive approves it as the next item after
transcript ingestion.

Two facts about the existing surface shape this decision, both measured from the code:

- **Leases are session-bound and acquired by the agent through MCP**, never by the CLI wrapper. The
  holder is always the bound session (`LUWI_SESSION_ID`), taken from the session and never from tool
  input (ADR 0020). The `agent run` wrapper and `session attach` do not touch leases; they keep the
  **session** alive through `createSessionBootstrap`'s heartbeat. So "renew every lease the session
  holds" is answerable entirely from the session id the bootstrap already owns.
- **`GET /api/v1/leases?sessionId=<id>` reads a held-only index** (`index:session:{id}:leases`, which
  the lease transition `SREM`s on release/expire), so it returns exactly the leases that currently
  need renewing — no client-side filtering, and a lease that already expired simply is not in the
  next listing.

There is prior art in the codebase: the daemon-ownership singleton lock already auto-renews on a
timer (`createDaemonOwnershipLease({ ttlMs, renewIntervalMs })`). This decision mirrors that pattern
for advisory work leases, on the client side.

## Decision

### Renewal is holder-side and lives in the session bootstrap

The renewal loop is added to `createSessionBootstrap` (`@luwi/runtime`), as a **second timer armed
alongside the heartbeat**, reusing the same injected `setInterval`/`clearInterval` seam and disarmed
together in `stop()`. `§3` keeps LUWI out of terminals and leases are advisory, so **the daemon gets
no renewal timer** — only a live holder renews, exactly as only a live session heartbeats. The
bootstrap is the one component that already represents "this session is alive", and it drives both
`agent run` and `session attach`, so both paths gain renewal from one place. Leases the agent
acquired through MCP are bound to the same session id, so they are renewed by the same loop; the MCP
server — which is purely reactive over stdio and holds no between-call lease state — gets no timer of
its own.

### The loop renews every lease the current session holds, at half the default TTL

Each tick reads the leases the **current** session holds
(`GET /api/v1/leases?sessionId=<current sessionId>`) and renews each one, reusing its own duration so
a renewal preserves the acquirer's intended TTL rather than silently extending it. The tick interval
defaults to **half the default lease TTL** (150 000 ms), well inside the 300 000 ms deadline and far
above the heartbeat's 5 s cadence — reusing the heartbeat interval would hammer the renew endpoint
~60× more often than a 300 s lease needs. The interval is a client setting
(`leaseRenewIntervalMs`, exposed as `--lease-renew-ms` beside `--heartbeat-ms`), **not** a new daemon
config, protocol field, or env var. Renewal drives the existing `POST /api/v1/leases/:leaseId/renew`
and the existing `lease_renew` Redis Function unchanged: renewal is a plain expiry bump with no
record-shape change, so `luwi_v1` stays at v12 and no new Function is loaded.

### The current session id is re-read every tick, so session rotation cannot mis-renew

The bootstrap's session id **rotates** when a lapsed heartbeat forces a re-registration (a new
session id). Because the loop lists by the _current_ session id each tick, a rotation is handled for
free: the old (now-dead) session's leases are never in the new session's listing, so they are not
renewed and expire on their own, and the fresh session holds nothing until the agent re-acquires.
The loop never renews a lease across a re-registration, which would return `LEASE_NOT_HELD_BY_SESSION`
against the wrong holder.

### Clean shutdown stops renewing and lets the leases expire

On `stop()` the renewal timer is disarmed and **no explicit release is issued** — the leases lapse
through their own TTL, exactly as they do after a crash that cannot run `stop()` at all. This keeps
one mental model (a lease outlives its holder by at most one TTL, however the holder ended) rather
than two, and avoids a best-effort release step that a crash can never perform anyway. The cost is
stated: after a clean exit a path stays claimed for up to one lease TTL (default 5 minutes) before a
collaborator can take it. Explicit release-on-clean-exit is a possible future refinement, recorded
here as deliberately **not** taken now.

### A failed renewal is surfaced once, never retried forever

A renewal that fails — the lease is gone (`404`), held by another session or already expired
(`409`), or the daemon is unreachable — is reported once to the terminal through the same
observation channel the bootstrap already uses for session changes, and the tick moves on to the
other leases. There is no per-lease retry loop: the next tick re-reads the held-only index, so a
lease that vanished is simply absent from the next listing rather than retried against a daemon that
will keep refusing it. This is what "surfaced, not silently retried forever" means here.

### The two neighbouring gaps are deferred, with reasons

`AGENTS.md` names two gaps next to renewal. Both are **deferred**, not silently dropped:

- **Notification when a held path frees** (so a session waiting on a claimed path learns it is now
  free) is a new coordination signal — a watch/notify surface on the lease domain — not part of
  keeping a live holder's own claims alive. It belongs with a broader lease-notification design and
  would widen Phase 2 well past renewal.
- **Lease↔commit correlation** (tying a claim to the commits made under it) depends on the Git
  attribution domain (ADR 0017) and the transcript file-change evidence (ADR 0023 B2), and is a
  read-side analytics join rather than a holder-side keep-alive. It is a separate phase.

Neither is required for a lease to outlive its TTL without manual renewal, which is this phase's
whole promise.

## Consequences

A long-running `agent run` or `session attach` session keeps its claimed paths for as long as it
lives, without the agent renewing anything by hand — the point of claiming a path in the first
place. The renewal is honest about its limits: it is advisory (LUWI still cannot stop an agent that
never claimed the path from editing it), it is best-effort (a renewal that races a just-expired lease
loses, and the path frees), and it targets the default TTL — a lease acquired with a duration shorter
than the renewal cadence can still expire between ticks, which the loop handles by simply not finding
it next time.

Because the loop lives in the bootstrap and lists by the live session id, it needs no new daemon
state, no new Redis Function, no `luwi_v1` version change, and no protocol change — it reuses the
renew endpoint and the held-only session-lease index exactly as they are. The one new knob is a
client-side interval flag, defaulted so the common case needs no configuration.

The costs are the ones named above: a clean exit still leaves a path claimed for up to one TTL
(deliberately, for crash-consistency), and the two neighbouring coordination features stay unbuilt.
Both are recorded rather than hidden, and `AGENTS.md` §21's "automatic lease renewal … remain
unapproved" sentence is updated in the same change that lands this record, so no reader is left
believing renewal is still forbidden.
