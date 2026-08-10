# Phase 5 Dashboard Capability Matrix

Date: 2026-08-05

Frontend status meanings: **SUPPORTED** is safe for Phase 5B, **DERIVABLE** requires a
bounded join, **PLANNED** lacks a sufficient read contract, and **REJECTED** is outside the
approved boundary.

| Module                        | REST read                                                                                 | Response evidence                                                                                       | Realtime evidence                                                                         | Scope and Phase 5A behavior                                                                                             | Status    |
| ----------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------- |
| Runtime health                | `GET /health`, `GET /api/v1/runtime`                                                      | `packages/protocol/src/runtime-http.ts:33-62`; routes `apps/daemon/src/app.ts:325-376`                  | runtime lifecycle events trigger a full coalesced refresh                                 | Global. Non-2xx health body remains displayable as degraded; transport failure is unavailable.                          | SUPPORTED |
| Projects                      | `GET /api/v1/projects`                                                                    | `packages/protocol/src/project.ts:14-28`; route `apps/daemon/src/app.ts:381`                            | `project.registered`, `project.updated` in `packages/protocol/src/runtime-event.ts:10-11` | Global collection. Empty means no registered projects.                                                                  | SUPPORTED |
| Agent definitions/bindings    | `GET /api/v1/agents`; `GET /api/v1/projects/:projectId/agents`                            | `packages/protocol/src/control-plane.ts:50-81`; routes `apps/daemon/src/app.ts:924,955`                 | agent/binding event types start at `packages/protocol/src/runtime-event.ts:26`            | Agent definitions global; bindings project-scoped. A failed binding request is partial, not zero.                       | DERIVABLE |
| Sessions                      | `GET /api/v1/sessions`                                                                    | `packages/protocol/src/session.ts:65-86`; route `apps/daemon/src/app.ts:403`                            | session events `packages/protocol/src/runtime-event.ts:12-16`                             | Global collection includes explicit online/offline presence. Active means online and non-terminal.                      | SUPPORTED |
| Activity/events               | `GET /api/v1/events?limit=20`                                                             | `packages/protocol/src/runtime-api.ts:14-21`; route `apps/daemon/src/app.ts:451`                        | `/api/v1/realtime` emits validated normalized events                                      | REST seeds a live view bounded to 200 rows; stream IDs are retained for 512-entry duplicate suppression.                | SUPPORTED |
| Usage summary                 | `GET /api/v1/usage/summary`                                                               | `packages/protocol/src/intelligence.ts:239-261`; route `apps/daemon/src/app.ts:534`                     | usage event types are in the Phase 4 event enum                                           | Global or filtered. Source rows stay separate; missing token totals are unavailable, not zero.                          | SUPPORTED |
| Context summary/contributions | `GET /api/v1/context/contributions?limit=1000`; pair-scoped `GET /api/v1/context/summary` | `packages/protocol/src/intelligence.ts:279-351`; route `apps/daemon/src/app.ts:541`                     | context observation event types exist                                                     | Global contribution list is safe for the overview. Pair summary requires project+agent. Boolean `unknown` is preserved. | SUPPORTED |
| Git observations              | `GET /api/v1/projects/:projectId/git` and bounded commit/worktree reads                   | `packages/protocol/src/intelligence.ts:353-404`; route `apps/daemon/src/app.ts:587`                     | Git observation events exist                                                              | Project-scoped. Missing observation is unavailable; no scan mutation from dashboard.                                    | DERIVABLE |
| Packages                      | `GET /api/v1/projects/:projectId/packages?limit=N`                                        | `packages/protocol/src/intelligence.ts:406-434`; route `apps/daemon/src/app.ts:626`                     | package observation events exist                                                          | Project-scoped; preserve truncation. No scan mutation.                                                                  | DERIVABLE |
| Technologies                  | `GET /api/v1/projects/:projectId/technologies?limit=N`                                    | `packages/protocol/src/intelligence.ts:436-464`; route `apps/daemon/src/app.ts:637`                     | technology observation events exist                                                       | Project-scoped; confidence is displayed explicitly.                                                                     | DERIVABLE |
| Operational graph summary     | `GET /api/v1/graph/summary`                                                               | `graphSummarySchema` at `packages/protocol/src/intelligence.ts:672`; route `apps/daemon/src/app.ts:654` | `graph.*` events invalidate the summary                                                   | Global. Exact per-kind cardinality on the active generation; an unbuilt graph withholds totals instead of showing zero. | SUPPORTED |
| Optimization findings         | `GET /api/v1/optimization/findings?limit=N`                                               | `packages/protocol/src/intelligence.ts:666-690`; route `apps/daemon/src/app.ts:699`                     | optimization events invalidate the bounded finding read                                   | Global or project-scoped bounded list. Pulse reads counts only; no accept/reject/evaluate.                              | SUPPORTED |

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

Unchanged and still `PLANNED` at the time of Phase 5C: the operational graph summary.
`/api/v1/graph/nodes/:nodeKind/:nodeId`, `/api/v1/graph/path`, and `/api/v1/graph/subgraph` all
require a root node and parameters, so no global count or health figure could be proven, and
`Graph` remained a disabled navigation label. ADR 0013 later added the summary read that changed
this; see the graph section below.

### Project scope request set

Selecting a project issued four independent bounded reads at Phase 5C and issues five since
ADR 0017 added commit attribution. Selecting none issues zero. Each result carries its own `ready`,
`not-observed`, or `unavailable` state so one failure cannot erase its siblings, matching the Pulse
snapshot rule.

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

## Phase 5D delta — intelligence routes

Date: 2026-08-08

Five prepared labels became routes. Four read data the Pulse snapshot already fetched and
discarded at render time; two added a bounded read.

| Route            | Reads                                                                               | New request |
| ---------------- | ----------------------------------------------------------------------------------- | ----------- |
| `#/sessions`     | snapshot `sessions`                                                                 | no          |
| `#/agents`       | snapshot `agents`, now typed rather than counted                                    | no          |
| `#/usage`        | snapshot `usage`                                                                    | no          |
| `#/context`      | snapshot `context` plus `GET /api/v1/context/sources?limit=100`                     | yes         |
| `#/optimization` | snapshot `findings`, now typed, plus `GET /api/v1/optimization/proposals?limit=100` | yes         |

The two new collections load only while their route is open, so the overview never pays for them.

## Operational graph route

`Graph` was the last disabled label. `/api/v1/graph/nodes/:nodeKind/:nodeId`,
`/api/v1/graph/path`, and `/api/v1/graph/subgraph` all require a root node, so no global count,
generation, or health figure could be proven, and rendering one would have been a fabricated
claim rather than a missing feature.

ADR 0013 added `GET /api/v1/graph/summary`, which answers the global question from index
cardinality on the active generation — 58 constant-time Redis commands, no traversal and no
scan — so `#/graph` now renders proven facts and the rail has no disabled destination left.

The response reports a retained-generation count again. ADR 0013 withheld it because the
generations index was written by only one path; ADR 0014 fixed that, so the number is honest.

| `#/graph` panel | Source                            | Loads on demand |
| --------------- | --------------------------------- | --------------- |
| Projection      | `GET /api/v1/graph/summary`       | yes             |
| Nodes by kind   | same response, `nodeCountsByKind` | yes             |
| Edges by kind   | same response, `edgeCountsByKind` | yes             |

Three states stay distinct on this route, which is the whole reason it waited for a contract:

- the read failed → `Unavailable`;
- the graph has never been built → `Never built`, and both totals render as `Not observed`
  rather than `0`;
- a generation exists and holds nothing → a real `0`, because that is an observed answer.

Counts are exact rather than bounded, so this is the one route that carries no truncation note.
It says so explicitly, because every neighbouring route does carry one and silence would read as
an omission.

## Git attribution and observation depth

Date: 2026-08-10

ADR 0017 added the first read from the audit's item 10 and rendered the Git evidence the project
scope was already fetching and discarding.

| Module             | REST read                                                    | Response evidence                                                                                                | Realtime evidence                             | Scope and behavior                                                                                                         | Status    |
| ------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------- |
| Commit attribution | `GET /api/v1/projects/:projectId/git/attributions?limit=100` | `attributionCollectionSchema` at `packages/protocol/src/intelligence.ts:485`; route `apps/daemon/src/app.ts:620` | `attribution.recorded`, `attribution.updated` | Project-scoped bounded list. An empty collection is the empty answer; there is no 404 and therefore no not-observed state. | SUPPORTED |

`git.` deliberately does not also invalidate this panel. A git scan emits one `attribution.recorded`
per record it writes, so the precise prefix covers everything a scan produces and mapping both would
refresh one panel twice for one cause.

The Git observation row above changed in substance without changing status. `branches`, `tags`, and
`worktrees` were reduced to `.length` at the dashboard boundary and those three counts were rendered
nowhere, so the loss was total. They are now carried whole and rendered as labelled groups, each
headed by its noun and its count: branches and tags as pill lists, worktrees as a table with their
head, branch, and detached or locked state. The label is load-bearing rather than decorative —
unlabelled, branches and tags are two identical rows of pills that a reader cannot tell apart,
which is what the first rendering did. This costs no request — the arrays were always in the
response body — and it is why
`GET /api/v1/projects/:projectId/git/worktrees` remains redundant rather than becoming a sixth read.

### Display bound versus read bound

The branch and tag lists show the first 25 names and say `Showing the first 25 of N`. This is a
distinct claim from the `truncated` note every neighbouring collection carries: `truncated` means
records exist that were not read, while these arrays arrive complete and only the list is
shortened. Wording them the same way would have made a complete answer look partial.

### Deferred, with the condition that would change it

ADR 0017 defers the other four item-10 domains — messaging, the capability and profile catalogue,
effective agent configuration, config drift — and the pair-scoped context reads that line 17 of this
document counts as in scope. The reason is uniform and checkable: each holds zero records on the
runtime that serves this dashboard, so a view over it could not be verified by looking at it. The
condition for building each is stated in ADR 0017 rather than left to judgement.

## Messaging and the project-agent pair

Date: 2026-08-10

ADR 0018 built three more of the audit's item-10 domains, on data produced by `pnpm seed` into an
isolated fixture runtime.

| Module                        | REST read                                             | Scope and behavior                                                                                                                         | Status    |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| Inter-agent messages          | `GET /api/v1/messages?limit=101`                      | Global bounded list on `#/messages`. The response carries no `truncated` flag, so the read asks for one more than the page and derives it. | SUPPORTED |
| Effective agent configuration | `GET /api/v1/projects/:p/agents/:a/effective-config`  | Pair-scoped. `valid: false` renders as `Unresolved` with its conflicts and unsupported capabilities, never as an empty config.             | SUPPORTED |
| Pair context summary          | `GET /api/v1/context/summary?projectId&agentId`       | Pair-scoped. Six independent counts; `unknown` keeps its own, per ADR 0010.                                                                | SUPPORTED |
| Pair context footprint        | `GET /api/v1/projects/:p/agents/:a/context-footprint` | Pair-scoped. Categories ordered by weight; duplicate groups are byte-identical content, never a similarity score.                          | SUPPORTED |

The three pair reads load only while `#/projects/<id>/agents/<agentId>` is open, and both halves of
the pair are checked by the generation guard before a response is applied — a slow read must never
paint one pair's configuration under another pair's name.

`message.` maps to the message list alone. `capability.`, `profile.`, `project.agent.` and
`agent.definition.` map to the effective configuration, because each changes what is bound;
`context.` maps to both pair context reads, because they measure the same thing.

## Work leases

Date: 2026-08-10

ADR 0020 added the first dashboard surface over a coordination capability rather than an
observation.

| Module      | REST read                                | Scope and behavior                                                                                                                                         | Status    |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Work leases | `GET /api/v1/leases?projectId&limit=100` | Project-scoped, loaded with the rest of the project scope. Held leases only — a list including released or expired ones would make a free path look taken. | SUPPORTED |

`lease.` maps to this read alone, including `lease.denied`, which changes no record and is the
strongest signal that someone is working in this project right now. The panel offers no control:
taking, extending and releasing are the holder's, through MCP.

A lease with an unreadable expiry reports `Not recorded` rather than a computed zero, and one still
held past its expiry reports `Expiring` rather than `0s` — the sweep has not reached it yet, and
saying zero would imply it is still holding for a moment longer.

## The catalogue and the config chain

Date: 2026-08-10

ADR 0019 built the last two item-10 domains, each on its own route because both are whole-runtime
inventories that no project or pair frame contains.

| Module              | REST read                            | Scope and behavior                                                                                                                                    | Status    |
| ------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Capability packages | `GET /api/v1/capabilities?limit=100` | Global bounded list on `#/capabilities`, filterable by kind, scope and enabled state. The response's own `truncated` flag is trusted, not re-derived. | SUPPORTED |
| Capability profiles | `GET /api/v1/profiles`               | Global. Each reference resolves to a package name, or reports itself beyond the loaded page, not registered, or unresolvable — never merely missing.  | SUPPORTED |
| Configuration drift | `GET /api/v1/config/drift`           | Global, on `#/config`. Classified from the two recorded hashes as edited, removed, appeared, unchanged, or unrecorded.                                | SUPPORTED |
| Configuration plans | `GET /api/v1/config/plans`           | Global. Renders the daemon's own redacted diff and its warnings. A plan with no snapshot reports `Not applied` rather than a blank cell.              | SUPPORTED |
| Config snapshots    | `GET /api/v1/config/snapshots`       | Global. A file with `existed: false` is marked as created by the apply, because undoing it is a delete and not a restore.                             | SUPPORTED |

`capability.` and `profile.` map to their own halves of the catalogue by exact event type, not by
prefix: `context.capability.loaded` records an agent loading a skill and changes no catalogue row.
`config.drift.` maps to drift, the plan transitions to plans, and apply, rollback and reconcile to
all three, because one operation moves the plan, writes a snapshot, and can clear drift together.

Both routes are strictly read-only, and the config one most deliberately: plan, approve, apply,
rollback, drift scan and reconcile all write the developer's own agent configuration files.

Neither list has an unbounded read. The three config collections take no limit and carry no
`truncated` field, so beyond the repository's cap of 1000 they would shorten in silence; the views
therefore make no completeness claim.

### Honesty rules encoded in these routes

- **Usage sources are never summed.** Exact, reported, adapter-extracted, and estimated records
  carry different provenance, and `unavailable` records have no token value. A combined figure
  would be a number the runtime never observed. An absent `totalTokens` renders as `Not reported`,
  worded differently from the `unavailable` source label so the two facts are not confused.
- **Context observations are not pipeline stages.** Assigned, effective, loaded, and invoked render
  as four independent counts. A source can be observed as loaded without having been observed as
  effective, so a funnel would assert a relationship that was never measured. `unknown` keeps its
  own count, per ADR 0010.
- **Context token figures are labelled as generic character estimates**, matching
  `estimationMethod` on the record, and must not be read as measured consumption.
- **Optimization is read-only.** Accept, reject, evaluate, and analyze endpoints exist and are
  deliberately not called; acceptance leads to a Phase 3 ConfigPlan apply, which section 12 keeps
  off every read surface.
- **Agent kinds render verbatim.** `agentDefinitionSchema.kind` carries vendor identifiers, and
  `product-independence.test.ts` forbids those names in dashboard source. There is no label map and
  no per-vendor branch, so a new agent kind needs no dashboard change and no existing one is
  privileged.
