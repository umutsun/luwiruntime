# Phase 5 Dashboard Capability Matrix

Date: 2026-08-05

Frontend status meanings: **SUPPORTED** is safe for Phase 5B, **DERIVABLE** requires a
bounded join, **PLANNED** lacks a sufficient read contract, and **REJECTED** is outside the
approved boundary.

| Module                        | REST read                                                                                 | Response evidence                                                                                                           | Realtime evidence                                                                         | Scope and Phase 5A behavior                                                                                             | Status    |
| ----------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------- |
| Runtime health                | `GET /health`, `GET /api/v1/runtime`                                                      | `packages/protocol/src/runtime-http.ts:33-62`; routes `apps/daemon/src/app.ts:325-376`                                      | runtime lifecycle events trigger a full coalesced refresh                                 | Global. Non-2xx health body remains displayable as degraded; transport failure is unavailable.                          | SUPPORTED |
| Projects                      | `GET /api/v1/projects`                                                                    | `packages/protocol/src/project.ts:14-28`; route `apps/daemon/src/app.ts:381`                                                | `project.registered`, `project.updated` in `packages/protocol/src/runtime-event.ts:10-11` | Global collection. Empty means no registered projects.                                                                  | SUPPORTED |
| Agent definitions/bindings    | `GET /api/v1/agents`; `GET /api/v1/projects/:projectId/agents`                            | `packages/protocol/src/control-plane.ts:50-81`; routes `apps/daemon/src/app.ts:924,955`                                     | agent/binding event types start at `packages/protocol/src/runtime-event.ts:26`            | Agent definitions global; bindings project-scoped. A failed binding request is partial, not zero.                       | DERIVABLE |
| Sessions                      | `GET /api/v1/sessions`                                                                    | `packages/protocol/src/session.ts:65-86`; route `apps/daemon/src/app.ts:403`                                                | session events `packages/protocol/src/runtime-event.ts:12-16`                             | Global collection includes explicit online/offline presence. Active means online and non-terminal.                      | SUPPORTED |
| Activity/events               | `GET /api/v1/events?limit=20`                                                             | `packages/protocol/src/runtime-api.ts:14-21`; route `apps/daemon/src/app.ts:451`                                            | `/api/v1/realtime` emits validated normalized events                                      | REST seeds a live view bounded to 200 rows; stream IDs are retained for 512-entry duplicate suppression.                | SUPPORTED |
| Usage summary                 | `GET /api/v1/usage/summary`                                                               | `packages/protocol/src/intelligence.ts:239-261`; route `apps/daemon/src/app.ts:534`                                         | usage event types are in the Phase 4 event enum                                           | Global or filtered. Source rows stay separate; missing token totals are unavailable, not zero.                          | SUPPORTED |
| Context summary/contributions | `GET /api/v1/context/contributions?limit=1000`; pair-scoped `GET /api/v1/context/summary` | `packages/protocol/src/intelligence.ts:279-351`; route `apps/daemon/src/app.ts:541`                                         | context observation event types exist                                                     | Global contribution list is safe for the overview. Pair summary requires project+agent. Boolean `unknown` is preserved. | SUPPORTED |
| Git observations              | `GET /api/v1/projects/:projectId/git` and bounded commit/worktree reads                   | `packages/protocol/src/intelligence.ts:353-404`; route `apps/daemon/src/app.ts:587`                                         | Git observation events exist                                                              | Project-scoped. Missing observation is unavailable; no scan mutation from dashboard.                                    | DERIVABLE |
| Packages                      | `GET /api/v1/projects/:projectId/packages?limit=N`                                        | `packages/protocol/src/intelligence.ts:406-434`; route `apps/daemon/src/app.ts:626`                                         | package observation events exist                                                          | Project-scoped; preserve truncation. No scan mutation.                                                                  | DERIVABLE |
| Technologies                  | `GET /api/v1/projects/:projectId/technologies?limit=N`                                    | `packages/protocol/src/intelligence.ts:436-464`; route `apps/daemon/src/app.ts:637`                                         | technology observation events exist                                                       | Project-scoped; confidence is displayed explicitly.                                                                     | DERIVABLE |
| Operational graph summary     | no global summary read                                                                    | Named node/path/subgraph schemas begin `packages/protocol/src/intelligence.ts:490`; routes `apps/daemon/src/app.ts:649,656` | graph events exist                                                                        | Existing queries require roots/parameters and cannot prove global counts. Empty development route only.                 | PLANNED   |
| Optimization findings         | `GET /api/v1/optimization/findings?limit=N`                                               | `packages/protocol/src/intelligence.ts:666-690`; route `apps/daemon/src/app.ts:699`                                         | optimization events invalidate the bounded finding read                                   | Global or project-scoped bounded list. Pulse reads counts only; no accept/reject/evaluate.                              | SUPPORTED |

## Pulse request set

The initial snapshot issues independent, same-origin bounded reads for health, projects,
sessions, agents, events, usage summary, context contributions, and optimization findings.
Project-binding reads are not part of Phase 5B. Each result carries its own `ready`, `empty`,
or `unavailable` status so one failure cannot erase valid siblings. HTTP responses are
validated with browser-safe `@luwi/protocol` schemas or narrow equivalent boundary schemas
before mapping.

Phase 5B validates the same-origin WebSocket envelope, appends accepted events to a bounded
Activity buffer, deduplicates by `streamId`, and maps implemented event families to a 250 ms
coalesced authoritative REST refresh. The first and every later transition into `live`
refresh all snapshot resources and the Activity seed; duplicate `live` notifications are
inert. It retains last successful resources on refresh error and marks them stale. Project
and Session inspectors expose only snapshot fields plus up to 20 newest retained matching
events. Active duration is bounded by the current time; terminal duration is unavailable
without an end timestamp. Event inspection uses the validated envelope and an 8 KiB text
preview, and navigates only to project/session snapshots that are present.

## Phase 5C delta — project scope

Date: 2026-08-08

Phase 5C adds the `#/projects` route and on-demand project-scoped reads. Four rows above changed
status because the "bounded join" they required now exists.

| Module                     | Previous  | Now       | What changed                                                                                   |
| -------------------------- | --------- | --------- | ---------------------------------------------------------------------------------------------- |
| Agent definitions/bindings | DERIVABLE | SUPPORTED | `GET /api/v1/projects/:projectId/agents` is read when a project is selected.                   |
| Git observations           | DERIVABLE | SUPPORTED | `GET /api/v1/projects/:projectId/git` is read; 404 renders as not-observed, not as a failure.  |
| Packages                   | DERIVABLE | SUPPORTED | `GET /api/v1/projects/:projectId/packages?limit=100`; `truncated` is disclosed.                |
| Technologies               | DERIVABLE | SUPPORTED | `GET /api/v1/projects/:projectId/technologies?limit=100`; confidence renders as text per tier. |

Unchanged and still `PLANNED`: the operational graph summary. `/api/v1/graph/nodes/:nodeKind/:nodeId`,
`/api/v1/graph/path`, and `/api/v1/graph/subgraph` all require a root node and parameters, so no
global count or health figure can be proven. `Graph` remains a disabled navigation label.

### Project scope request set

Selecting a project issues four independent bounded reads. Selecting none issues zero. Each result
carries its own `ready`, `not-observed`, or `unavailable` state so one failure cannot erase its
siblings, matching the Pulse snapshot rule.

Project sessions are filtered from the global session snapshot rather than fetched from
`GET /api/v1/projects/:projectId/sessions`, because that data is already present and validated.

`not-observed` exists only for the Git read. It is produced by HTTP 404
(`GIT_REPOSITORY_NOT_FOUND`, `apps/daemon/src/intelligence-service.ts:1346`) and means no scan has
been recorded. Transport failure, other non-2xx statuses, and invalid bodies remain `unavailable`.
The bounded collections have no not-observed answer: an empty list is the empty answer.

### Realtime

`projectResourcesForEvent` in `apps/dashboard/src/api/project-scope.ts` maps `git.*` to the
repository panel, `package.*` to packages, `technology.*` to technologies, `project.agent.*` to
bindings, and `runtime.*` to all four. Refresh runs only when the event carries no project id or
names the selected project, so an event for another project costs no request.

`project.registered` and `project.updated` map to nothing here: they change the global project
list, which the Pulse coordinator already refreshes.

### Not rendered

The mockup's project table shows `{{ p.stage }}` and `{{ p.release }}`. Both remain unrendered.
No lifecycle or release-scoring domain exists, and AGENTS.md section 21 prohibits adding one
without separate approval. `apps/dashboard/src/product-independence.test.ts` asserts that no
production module references a lifecycle stage or release-readiness field.

No mutation endpoint is called. `POST .../git/scan` and `POST .../packages/scan` exist and are
deliberately not invoked; the same test asserts that no production module issues a non-GET request.
