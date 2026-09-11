# ADR 0033: Project settings from the dashboard, and a project update transition

Status: Accepted  
Date: 2026-09-11

## Context

The dashboard had two write surfaces, each approved on its own: the configuration plan chain
(ADR 0021) and bounded question creation (ADR 0018). `product-independence.test.ts` allowlists
exactly the modules that may issue a non-GET request, so a third one is a decision, not a drift.

Reviewing the new overview (ADR 0032) on 2026-09-11, the owner asked for two things the console
could not do: register a new project, and edit a project's details — "project settings". The daemon
already had `POST /api/v1/projects`, the same registration the CLI uses, with canonical-path
duplicate detection and Git metadata detection. It had **no** update path at all: `project.updated`
existed as an event type, but nothing wrote the project hash after registration, and `AGENTS.md` §7
requires that a projection change and its event be one atomic transition, which here means a Redis
Function.

## Decision

### A `project_update` Function, no library version bump

`luwi_project_update_v1` joins `luwi_v1`. It takes the project hash and the two event streams, a
patch of `name`, `repositoryUrl` and `defaultBranch` — `null` clears an optional field, an absent
key leaves it alone — the workspace id and the event id. It validates the patch and the key types
first, answers `not_found` for a project the runtime does not hold, refuses an empty patch, then
reads the hash and refuses a record that is not a whole project or whose stored id is not the
key's project (`REDIS_STATE_INVALID`, nothing written), answers `unchanged` with nothing written
when the patch matches what is stored, and only then writes the fields, moves `updatedAt`, reads the record back, and appends
one `project.updated` event to the global and the project stream. Anything it refuses leaves no
partial state and no event. The local path, the canonical path and the identity hash are not in the
patch: the path is the project's identity, and changing it would be a different project.

The library version stays at 12. Per the registry's own rule the version moves only when a stored
record's shape changes; a new function already changes the source hash and the function-name list,
which forces a reload. **A running daemon does not have the function until it restarts** — a
`PATCH` against a daemon started before this change fails with a Redis function-not-found error,
which is honest and loud rather than silent.

### `PATCH /api/v1/projects/:projectId`

Validated by `projectUpdateRequestSchema` (strict; at least one field), run under `withMutation`
like registration, answering the stored record or `PROJECT_NOT_FOUND`. Registration is unchanged.

### The dashboard's third write module

`apps/dashboard/src/api/project-mutations.ts` — `register` and `update`, the same bounded
fetch-and-validate shape as the other two — is added to the allowlist. A plain inline `ProjectForm`
serves both, held by the detail drawer the shell already has — there is no modal dialog, which the
owner's review of the first cut found foreign to the design. **Register a project** from the foot
of the `PROJECTS` menu opens the drawer with the form. **Edit project** sits at the top of a
project's detail drawer, which the drill-down's **Detail** link opens over the overview at
`#/pulse/<id>/detail` (the same drawer the registry route opens at `#/projects/<id>`; the scoped
reads load for either, and closing returns to wherever it was opened from). The form edits only
what changed, sends `null` to clear a field, shows the local path as identity and never lets it be
edited, and on success asks the shell to re-read the snapshot; a project just registered becomes
the focus.

Both entry points exist only when the shell is given the mutation capability, exactly as the config
and message capabilities are threaded: a shell constructed without it is a read-only overview.

## Consequences

- `luwi_v1` gains a function; the owner restarts the daemon once to load it.
- The dashboard's write scope is now three modules; README, `CLAUDE.md` and the guard say so.
- The Function is covered by a Redis integration test (update, clear, not found, empty patch refused
  with no write); the service by unit tests; the form and the mutation module by unit tests; the
  shell's two entry points by `app.test.tsx`. The route itself mirrors registration and, like it,
  has no fake-gateway test.
- Nothing about sessions, messages, leases or the MCP surface changed; control-plane writes are
  still not exposed to MCP (§12).
