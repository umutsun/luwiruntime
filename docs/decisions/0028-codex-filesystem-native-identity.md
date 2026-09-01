# ADR 0028: Codex native identity from the rollout tree; Gemini's measured absence

Status: Accepted  
Date: 2026-09-01

## Context

ADR 0022 built native session identity and Phase 3 of the completion program added an extensible,
per-vendor resolver registry (`packages/adapters/src/native-identity.ts`). That registry resolves a
vendor whose session id sits in the **environment**, exactly as Claude Code's does
(`CLAUDE_CODE_SESSION_ID`). The Phase 3 measurement
(`docs/superpowers/specs/2026-09-01-codex-gemini-identity-measurement.md`) then found that two of the
three vendors the owner wanted supported are not environment-resolvable on this machine:

- **Codex** records a per-session `session_id` in its rollout file
  (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`), but every Codex on this machine is
  launched by Codex Desktop or the VSCode extension, which export **no** session-id variable. The id
  is real and stable; it just lives only on disk.
- **Gemini CLI** keeps history per project (`~/.gemini/tmp/<project>/`, git-backed) with **no
  per-session identity at all**.

Phase 3 therefore shipped the measurement plus an env-ready registry, and deliberately did **not**
add a filesystem resolver for Codex, because the design's rule is "an unusable value resolves to
nothing, never to a guess" — a wrong binding attributes one session's tokens to another. On
2026-09-01 the owner explicitly granted permission to add Codex and Gemini resolvers beyond the
environment path. This ADR records what that permission makes buildable, and what it does not.

A fresh re-measurement (2026-09-01) refined one fact the Phase 3 spec got slightly wrong and that the
resolver depends on: the rollout **filename uuid equals the file's own `id`, not its `session_id`**. A
resumed Codex session writes a new rollout file whose `id` differs from `session_id`, while
`session_id` stays the stable root of the resume chain (confirmed across a four-file chain, all
sharing one `session_id` linked by `parent_thread_id`). The logical session identity is `session_id`.

## Decision

### Codex: an owner-approved filesystem fallback, bounded so a wrong binding stays impossible except in one named case

`packages/adapters/src/native-identity-disk.ts` adds `resolveNativeIdentityFromDisk(kind, context)`, a
**strict fallback** tried only when the environment resolver returns nothing. Its only entry is Codex.
`session attach` calls the environment resolver first and the disk resolver second, so a future Codex
that exports `CODEX_SESSION_ID` is resolved deterministically and never touches disk.

The Codex resolver recovers `session_id` from the rollout tree under four guards, each closing off a
way a binding could be wrong:

1. **Environment precedence.** Disk is a fallback, never the first choice.
2. **cwd match.** A rollout is a candidate only if its recorded `cwd` equals the attaching session's
   working directory (normalized, case-insensitive on Windows). A Codex session in another project is
   never bound to this one.
3. **Freshness gate.** A rollout whose file has not been written within a freshness window
   (default 15 minutes, `LUWI_CODEX_SESSION_FRESHNESS_MS`) is treated as not-the-current-session and
   skipped, so an attach in a directory where Codex ran earlier binds nothing rather than a dead
   session. A file dated more than a small tolerance (a couple of seconds) in the **future** is skipped
   for the same reason: its mtime cannot pass the gate honestly, and a backup restore or a clock-ahead
   copy can leave a dead session's file dated ahead of now, which must not be admitted as fresh or
   allowed to win the freshest-sort. That tolerance is deliberately small — it is the only window in
   which a future-dated ghost could still outrank a live session, so a clock step-back larger than it
   rejects the ghost and any concurrently-live file alike (an honest absence, corrected on the next
   attach) rather than risking a wrong binding. The stat is checked before the file is read.
4. **The logical id.** The binding takes `session_id`, the stable root of a resume chain, never the
   per-file `id` or the filename.

Freshness on mtime — not a fixed count of day directories — is the real bound on the scan, because a
rollout's `YYYY/MM/DD` directory is fixed at creation while a session open across several days keeps
one file in an older directory with a current mtime. The scan therefore walks day directories
newest-first (across month and year boundaries), stats each rollout, and lets the freshness window
select candidates; enumeration is capped at roughly one year purely so an unbounded tree cannot stall
an attach. It reads only the first line (`session_meta`, measured up to ~46 KB) of each candidate —
never conversation content (§12/§18). Any failure to read the tree is an honest absence of evidence:
the resolver returns `undefined` and never throws, so identity resolution cannot break an agent's
startup.

**The one residual, owner-accepted risk** is two live Codex sessions sharing a single working
directory: "freshest" then names one of them. This is the only case for which the environment
resolver's "never guess" rule is relaxed, it is bounded to it, and it is far narrower than the
original rejected heuristic (match by `cwd` + "latest" with no freshness gate, which would also bind
long-dead sessions).

### Gemini: no resolver, because there is no per-session identity to resolve

Permission does not create data that does not exist. Re-measurement (2026-09-01) confirms
`~/.gemini/tmp/<project>/` holds only `.project_root`; there is no session file, no session id, in the
environment or on disk. A filesystem resolver would have nothing to read. Binding a Gemini session to
its **project** instead was considered and rejected: a project is not a session, so two Gemini
sessions in one project would declare the same native id, and the identity model refuses the second
(a live holder is never evicted) — turning a normal second session into a `NATIVE_BINDING_INCONSISTENT`
refusal. Gemini therefore keeps its measured-absence resolver (`resolveGemini` returns `undefined`)
and registers with no native block, which is the honest state. The moment a Gemini build exposes a
session id — in the environment or a session file — it is one registry entry, wired the way Codex is.

## Consequences

A Codex session launched at a project's root and attached through `luwi session attach --agent-kind
codex` now declares its native `session_id` and is attributed, where before it registered
unattributed — closing the largest gap in "coordinate every agent" for this machine's Codex setup.
The env-first ordering means a future env-exporting Codex upgrades to the deterministic path with no
code change.

The limits are explicit and tested. The fallback is Codex-only; Claude stays environment-resolved and
Gemini stays honestly unbound. The freshness window is a tunable heuristic, not a proof; the concurrent
same-directory case is the residual risk the owner accepted. Nothing here changes the daemon, the
protocol, the datastore, or `luwi_v1` — it is a client-side resolver plus two injected `session attach`
dependencies (`transcriptFileSystem`, `now`). `agent run` still declares no native identity, because
the wrapper's launch environment is the parent's, not the child agent's.
