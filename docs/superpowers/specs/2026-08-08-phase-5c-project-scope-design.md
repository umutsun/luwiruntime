# Phase 5C — Project scope design

Status: Draft  
Date: 2026-08-08

## Context

Phase 5B shipped `#/pulse` and `#/activity`. The navigation rail in `apps/dashboard/src/app.tsx:18`
carries nine disabled `Planned` labels: Projects, Agents, Sessions, Usage, Context, Graph, Git,
Packages, Optimization.

Auditing the daemon's registered routes against those labels shows that eight of the nine already
have sufficient read contracts. Only **Graph** does not: `/api/v1/graph/nodes/:nodeKind/:nodeId`,
`/api/v1/graph/path`, and `/api/v1/graph/subgraph` all require a root node and parameters, so no
global summary can be proven. This matches `docs/phase5-dashboard-capability-matrix.md`, which
classifies the operational graph summary as `PLANNED` for exactly that reason.

Everything the capability matrix marks `DERIVABLE` — agent bindings, Git observations, packages,
technologies — is project-scoped. It "requires a bounded join" because there is no global endpoint
for any of it. The dashboard currently performs only global reads.

The mockup in `temp/Luwi Runtime Dashboard Mockup` states the intended interaction directly:
_"Click a project to scope the dashboard."_ Project scope is the missing spine, and adding it is
what converts four `DERIVABLE` classifications into rendered evidence.

## Decision

Phase 5C adds **project scope**: a `#/projects` route with a project list and an on-demand,
bounded, read-only project detail view.

This is the smallest increment that is independently useful and unlocks the project-scoped read
surface. It introduces no new phase-level domain.

### Not in scope

Explicitly excluded, with reasons rather than omission:

- **Stage and Release columns.** The mockup's project table shows `{{ p.stage }}` and
  `{{ p.release }}`. `docs/phase5-dashboard-mockup-audit.md` classifies project lifecycle stage and
  release readiness as `PLANNED` — "No lifecycle or release-scoring domain exists" — and AGENTS.md
  section 21 prohibits lifecycle/release scoring without separate approval. These columns are not
  rendered and no substitute is invented.
- **Operational graph.** No global summary contract exists. `Graph` stays a disabled `Planned` label.
- **Any mutation.** `POST /api/v1/projects/:projectId/git/scan` and
  `POST /api/v1/projects/:projectId/packages/scan` exist and are deliberately not called. Phase 5
  is read-only; a scan button would be a mutation surface.
- Tasks, leases, ownership, GitHub state, unified search, agent execution, config apply/rollback.

### Routes

The route union widens from `'pulse' | 'activity'` to include `'projects'`. Route parsing moves out
of the inline `initialRoute()` in `app.tsx` into a tested module, because a third route makes the
current two-branch ternaries untenable and the hash may now carry a project id.

- `#/projects` — the project list.
- `#/projects/<projectId>` — list with that project's detail loaded.

An unknown or malformed project id resolves to the list with an explicit not-found state. It never
throws and never renders a partially-populated detail.

### Project list

Columns, all from data already in the Pulse snapshot — no new request:

| Column          | Source                                                       |
| --------------- | ------------------------------------------------------------ |
| Project         | `GET /api/v1/projects` name                                  |
| Local path      | `localPath`, middle-abbreviated with a full accessible title |
| Active sessions | existing derived count in `buildPulseSnapshot`               |

Because the list needs no new fetch, it is available immediately and stays correct under the
existing realtime invalidation for `projects` and `sessions`.

### Project detail

Loaded on demand when a project is selected. Four independent bounded reads, each with its own
availability state so one failure cannot erase its siblings — the same rule the Pulse snapshot
already follows:

| Panel        | Request                                           | Bound      |
| ------------ | ------------------------------------------------- | ---------- |
| Git          | `GET /api/v1/projects/:id/git`                    | single     |
| Packages     | `GET /api/v1/projects/:id/packages?limit=100`     | 100        |
| Technologies | `GET /api/v1/projects/:id/technologies?limit=100` | 100        |
| Bound agents | `GET /api/v1/projects/:id/agents`                 | collection |

Project sessions are filtered from the existing global session snapshot rather than fetched from
`/api/v1/projects/:id/sessions`, because the data is already present and validated. Issuing a
second request for a subset of data already held would be a redundant read.

### The `not-observed` state

`GET /api/v1/projects/:projectId/git` returns **404 `GIT_REPOSITORY_NOT_FOUND`** when no
observation has been recorded (`apps/daemon/src/intelligence-service.ts:1346`). This is
categorically different from a transport failure or a malformed response.

Phase 5C distinguishes them:

- **404** → `not-observed`. Rendered as "Not observed" with an explanation that no Git scan has run
  for this project. This is a true, complete answer, not a degraded one.
- transport / other HTTP / invalid body → `unavailable`. Rendered as unavailable and retryable.

Collapsing 404 into `unavailable` would tell the user something is broken when nothing is. This
follows ADR 0010's rule that a missing value stays absent rather than being converted into a
different claim.

### Truncation is disclosed

`packageCollectionSchema` and `technologyCollectionSchema` both carry a `truncated` boolean.
When true, the panel states that the list is bounded and incomplete. Truncation is never silent —
the same requirement the Phase 4 package scanner already carries.

### Confidence is labelled, never colour-only

`technologyRecordSchema.confidence` is `high | medium | low | unknown`. It renders as text plus
tone, consistent with the mockup audit's accessibility correction that "status always includes
text, not only a colored dot". `unknown` renders as `Unknown`, never as an absent or zero value.

### Realtime

Project-scoped resources join the existing invalidation coordinator. Git, package, and technology
observation events invalidate the corresponding panel for the **currently selected project only**.
An event for another project does not trigger a fetch, because nothing for that project is
displayed.

On reconnect, the selected project's resources refresh through the same coalescing controller as
the global snapshot. Failure preserves the last good data and marks it stale, exactly as Phase 5B
does.

### Protocol surface

`packages/protocol/src/browser.ts` currently exports six schemas. Phase 5C adds
`gitObservationSchema`, `packageCollectionSchema`, and `technologyCollectionSchema` from
`intelligence.js`, plus the project-agent binding collection schema from `control-plane.js`.

Both modules are already loaded by the existing browser entry, so this widens the export surface
without widening the module graph, and the browser entry still never evaluates the Node
runtime-event factory.

## Security

No change to the boundary. All reads are same-origin loopback GETs against the existing daemon
API. No mutation endpoint is called. Local paths and remote URLs render through React text nodes;
`gitObservationSchema.remoteUrl` is already credential-redacted by the Phase 4 Git observer before
it reaches the API. No Redis URL, credential, or raw HTML sink is introduced.

`apps/dashboard/src/product-independence.test.ts` continues to enforce this statically and is
extended to cover the new modules.

## Testing

Following AGENTS.md section 15:

- Route parsing: `#/projects`, `#/projects/<id>`, unknown id, malformed hash, and the existing two
  routes still resolving.
- Project list: rendering, active-session counts, empty state, path abbreviation with full title.
- Detail loader: independent per-panel availability, abort on selection change, generation-safe
  rejection of obsolete responses.
- The 404 → `not-observed` mapping, proven distinct from transport failure.
- Truncation disclosure for packages and technologies.
- Confidence rendering for every tier including `unknown`.
- Invalidation scoped to the selected project; an event for another project performs no fetch.
- Stale preservation on refresh failure.
- No horizontal overflow at 1280, 1440, and 1728 px.
- Product independence: no Redis, filesystem, vendor SDK, mutation request, or raw HTML sink.
