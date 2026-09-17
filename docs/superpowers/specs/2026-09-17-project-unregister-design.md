# Project unregister (F3) — design

**Status:** implemented, 2026-09-17 (owner-approved with a spec and a §7 review; the review's
findings are folded in below).
**Scope:** `DELETE /api/v1/projects/:projectId`, `luwi project unregister`, and an
"Unregister…" control in the dashboard's project drawer. Unregister-only: nothing on disk is
touched — the project's files and its `.luwi/` directory stay exactly as they are (§13).

## Why

A project registered by mistake, moved, or finished stays in the registry forever: the
overview keeps drawing it, `project discover` keeps marking it registered, and the manifest
re-registers it at every daemon start. There is no way to take a project out short of
`luwi reset --runtime-state`, which takes everything else out with it.

## What "unregister" means

The registry forgets the project and the evidence LUWI collected about it. Concretely, the
daemon removes:

- the project record and the path index that makes the same folder a duplicate
  (`:project:<id>`, `:index:project:path:<hash>`), and the id from `:index:projects`;
- the project's own event stream (`:events:project:<id>` — it has no consumer group and no
  reader; the global stream keeps its copy of every event);
- every per-project index family and the records they enumerate: sessions (terminal ones only
  — see refusals), leases, messages, usage records, git observations and commits, commit
  attributions, session-file-change observations, packages, technologies, workspace locations,
  context contributions, optimization findings and proposals, project-agent bindings, the
  project-scoped context sources / capabilities / capability bindings / profiles, context
  footprints, and the coordinator hash;
- the matching members of the global indexes those records sit in (`usageIndex`,
  `gitObservationsIndex`, `attributionsIndex`, `contextContributionsIndex`,
  `optimizationFindingsIndex`, `optimizationProposalsIndex`, the message and lease deadline
  zsets, `heartbeatDeadlines`, and the agent- and session-side mirrors).

It deliberately leaves alone:

- **the operational graph** — a full-rebuild projection from `projects.list()`; its stale
  `project` node disappears at the next rebuild (ADR 0012/0029), so the delete records that a
  rebuild is due rather than editing a generation;
- **native session bindings and links** — they carry no `projectId` and a native conversation
  is not provably one project's; they are bounded by retention already. The purged sessions'
  reverse index (`:index:session:<id>:native`) goes with the session, so those bindings become
  unreachable to the link-retention sweep and the transcript scanner counts requests inside
  their intervals as `skippedSessionMissing` — visible, not silent;
- **usage tombstones** — a usage record retention already turned into a tombstone was removed
  from the project's usage index at that point, so the purge never sees it; an old project can
  leave those behind, and they are duplicate guards, not evidence;
- **config plans, operations and drift records** — receipts on disk under `~/.luwi/operations`
  outlive the project on purpose;
- **the agent- and workspace-scoped usage metric counters** (`:metrics:agent:<id>:…`,
  `:metrics:workspace:…`) — they aggregate other projects too, and decrementing them from
  partial knowledge would fabricate a total. The project- and session-scoped counters, all-time
  and per day, describe only this project and go with it;
- **released and expired lease records** (`:lease:<id>`) — never indexed by project, reachable by
  id only; the held-lease index and the sessions' lease sets go, the records are a retention
  concern, not an unregister one.

## Refusals (409, nothing written)

The daemon refuses, naming what blocks it in `details`, while any of these hold:

| Condition                                        | Code                            |
| ------------------------------------------------ | ------------------------------- |
| a session that is not `completed`/`disconnected` | `PROJECT_HAS_ACTIVE_SESSIONS`   |
| a lease in state `held`                          | `PROJECT_HAS_HELD_LEASES`       |
| a live coordinator holder                        | `PROJECT_COORDINATOR_HELD`      |
| a message that is not terminal                   | `PROJECT_HAS_INFLIGHT_MESSAGES` |

No `force`. The reader ends or releases what is live, then unregisters; the dashboard shows the
refusal in the daemon's words. This is the same honesty as `COORDINATOR_CONFLICT`.

## Order of operations (crash-safe, re-runnable)

1. **Read and decide** in the service: load the project and the four blocker sets. Then wait,
   bounded, for any background writer keyed by this project — a session close schedules a git
   and package scan, and one still running would write evidence after the project is gone,
   where no re-run could reach it.
2. **Untrack the manifest first**: `canonicalStore.untrackProject(projectId)` (new; the mirror
   of `trackProject`). If anything after this fails, the service re-tracks the project at once
   (a purge that meets a blocker the pre-check did not see answers the same 409), and the next
   reconcile's second loop (`projectService.list()` → `trackProject`) would restore it anyway —
   nothing is lost. The opposite order would let a restart re-register the project from the
   manifest under a fresh id.
3. **Delete leaves in bounded batches** through the existing generic batch Function
   (`luwi_intelligence_batch_transition_v1`: `delete` / `set_remove`, ≤100 000 operations,
   keys by index). A crash here leaves a still-registered project with partly-removed evidence;
   running the delete again finishes it. No event is appended by these batches.
4. **One atomic final step** in a new Function `luwi_project_unregister_v1` (a new function
   reloads on its own; no record shape changes, so the library stays at version 12). Inside
   Lua, before any write: the project hash must still exist and `SCARD` of the project's
   sessions set must equal the count the daemon read (a session registered between read and
   delete makes the call refuse, `PROJECT_UNREGISTER_RACED`, and the daemon re-reads). Then:
   `DEL` project hash, path index and coordinator hash; `SREM` `:index:projects`; `UNLINK` the
   project stream; append `project.unregistered` to the **global** stream only.
5. `ProjectService.remove` awaits `options.onDeleted` (already-untracked manifest is a no-op)
   and answers `204`.

Every key the Function touches is declared and validated for the identity it must hold (§7);
a mismatch refuses with nothing written. The redis-invariants reviewer runs on the change.

## Surfaces

- **HTTP:** `DELETE /api/v1/projects/:projectId` → `204`; `404 PROJECT_NOT_FOUND`; the 409s
  above with scalar `details` (public error details carry no arrays): `count` plus the first
  20 blocking ids as one comma-separated `sessions` / `leases` / `messages` string, or the
  `coordinator` session id. Inside `withMutation`, next to `PATCH`.
- **Protocol:** `project.unregistered` event type; a `projectUnregisterRefusalSchema` for the
  details is not needed — `publicErrorResponseSchema.details` already carries safe values.
- **CLI:** `luwi project unregister <projectId> [--yes]`; without `--yes` it prints what would
  be removed and the blockers and exits 1 (`CLI_CONFIRMATION_REQUIRED`, the `reset` precedent).
- **Dashboard:** `api/project-mutations.ts` gains `remove(projectId)` (`send` learns `DELETE`
  with no body; still the allowlisted module — no fifth). The project drawer's Settings area
  gains "Unregister…" → `ConfirmDialog` listing what is removed and what stays, then the call;
  a refusal is shown with its details; success calls `onProjectMutated` and focuses the
  runtime. The `PROJECTS` filter drops the id from `luwi.projects` if it held it.

## Tests

- `project-service.test.ts`: the refusal matrix (each blocker alone), untrack-before-delete
  ordering, `onDeleted` awaited, a failed final step leaves the project registered.
- `canonical-store.test.ts`: `untrackProject` removes the entry, rewrites the content hash,
  and is idempotent.
- `project-unregister.integration.test.ts` (db15, via `/redis-it`): register a project, give
  it a terminal session, a released lease, a terminal message, usage, git observations,
  packages, a context contribution, a finding; unregister; `SCAN luwi:test:<run>:*` for the
  project id → **zero residue**; then the blocker cases refuse and leave everything; then the
  race guard (a session added between read and the final step) refuses.
- `app-phase1.test.ts`: `DELETE` 204 / 404 / 409 shape through `inject`.
- Dashboard: `project-mutations.test.ts` (DELETE, no body, 204 → ok), a drawer test that the
  confirm names the project and a refusal is rendered.

## Out of scope

Deleting files, `.luwi/`, or git worktrees (§13). Bulk unregister. Cascading a graph rebuild
(the next scheduled or manual rebuild handles it). Force-releasing blockers.
