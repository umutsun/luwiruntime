# ADR 0027: Opt-in Windows autostart via a per-user logon task

Status: Accepted  
Date: 2026-09-01

## Context

`AGENTS.md` §21 listed autostart as unapproved, and it was the last item in the completion program's
sequence. The owner approved it in chat on 2026-09-01 (gate G3), so this ADR records the design before
the code.

The need: the LUWI daemon has to be started before an agent can register a session against it, and
today that is a manual `luwi start` after every logon or reboot. A developer who wants the runtime
always-available should be able to opt into having it start on its own — without LUWI becoming a
service the OS supervises, a background process that outlives the user, or anything that changes the
daemon's single-owner semantics.

Three facts from the existing code shape the design:

- **`luwi start` is already idempotent.** An already-healthy compatible runtime is success, not an
  error, and a port conflict or foreign daemon is a bounded safe failure that never kills an
  unverified process (ADR 0025). So invoking `luwi start` again at logon is safe by construction.
- **The daemon holds a single-owner TTL lease.** Two starts racing produce one owner and one bounded
  refusal, so an autostart that races a manual start cannot double-run the daemon.
- **The lifecycle CLI already spawns external commands** through an injected `runCommand` seam (the
  same one that drives Docker Compose for Redis), and it already knows its own `installationRoot`, so
  the CLI entry point is derivable without new configuration.

## Decision

### A per-user Windows Scheduled Task, not a service or a supervisor

Autostart registers a **per-user logon Scheduled Task** (`schtasks /SC ONLOGON`) named `LUWI Runtime`
that runs `luwi start`. Rejected alternatives, each for a stated reason:

- **A Windows Service** would need elevation to install, would run in session 0 detached from the
  user's loopback session, and would carry start/stop/recovery lifecycle the runtime does not want to
  own. The daemon is a single-user, loopback-only process (§4); a service is the wrong shape.
- **A supervisor / watchdog process** is a persistent process that outlives the agent and re-owns the
  daemon — exactly the kind of always-on coordinator §3 keeps LUWI from becoming. The daemon's own
  owner lease and `luwi start`'s idempotence already provide restart-on-next-logon without one.

A logon task is the lightest mechanism: no elevation (a per-user task), no detached session, no
persistent LUWI process — the OS scheduler invokes `luwi start` once per logon and that is all.

### The task runs `luwi start`, idempotently, at logon

The task command is `"<node>" "<installationRoot>/apps/cli/dist/main.js" start` — the same idempotent
start a developer runs by hand, so autostart adds no new startup path to test or trust. **Logon**, not
boot: the daemon binds loopback for the logged-in user and serves that user's agents, so it belongs to
the user session, not the machine. If the daemon is already running when the task fires, `luwi start`
is a no-op success.

### Opt-in through `luwi setup`, never silent

`luwi setup --autostart` registers the task; `luwi setup --no-autostart` removes it; `luwi setup` with
neither reports the current autostart state alongside its other output. Autostart is never installed as
a side effect of anything — the developer asks for it explicitly, matching `setup`'s existing rule that
it writes only what it was asked to and shows the target first.

### Windows-only, and honest about it elsewhere

`schtasks` is Windows. On any other platform `--autostart` / `--no-autostart` report **`unsupported`**
rather than pretending to succeed; a systemd-user unit or a launchd agent would be a separate, measured
addition. This machine is Windows, so the capability is real here.

### Safe by construction, and idempotent

`schtasks` is a known system command — not something discovered and executed (§12/§18) — spawned
through the existing `runCommand` seam with fixed arguments: the task name is a compile-time constant,
and the command is the resolved node executable plus the CLI entry derived from `installationRoot`, so
no user-controlled string reaches the scheduler. Registration uses `/Create /F` (overwrites an existing
task rather than failing), removal uses `/Delete /F` and treats a missing task as already-disabled, and
status uses `/Query`. Enabling twice or disabling a task that was never there are both successful
no-ops. Nothing about the daemon, its owner lease, or its configuration changes.

## Consequences

A developer who wants LUWI always-available runs `luwi setup --autostart` once and the daemon comes up
at every logon; one `luwi setup --no-autostart` takes it back out. Because the task just calls the
idempotent `luwi start`, autostart introduces no second daemon-startup code path and cannot double-run
the daemon — the owner lease and start's own checks already guarantee that. It needs no elevation, no
service, no persistent LUWI process, and no change to the daemon or the datastore.

The limits are stated. It is Windows-only for now, reporting `unsupported` elsewhere rather than
guessing. It starts the daemon but does not start Redis — on this machine Redis is a Windows service
(Memurai) that already starts on its own, and `luwi start` waits for Redis readiness, so a slow Redis
is a bounded wait rather than a failure. And it is per-user by design: it starts LUWI for the logged-in
developer, not machine-wide, which is the correct scope for a single-user local runtime. `AGENTS.md`
§21's autostart sentence is updated in the same change that lands this record.
