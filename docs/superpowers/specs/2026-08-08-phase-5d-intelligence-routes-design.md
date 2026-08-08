# Phase 5D — intelligence routes design

Status: Draft  
Date: 2026-08-08

## Context

After Phase 5C the navigation rail carries five disabled `Planned` labels: Agents, Sessions, Usage,
Context, and Optimization. All five are classified `SUPPORTED` in
`docs/phase5-dashboard-capability-matrix.md`, and the Pulse snapshot already fetches the data for
four of them.

Pulse renders each as a single aggregate — a count, a five-row usage table, a four-number context
tally. The evidence behind those aggregates is fetched, validated, and then discarded at render
time. Phase 5D gives each its own route so the underlying records are readable.

Two model fields are currently `Availability<unknown[]>` in `apps/dashboard/src/pulse/model.ts`:
`agents` and `findings`. They are counted but never typed, which is why no view can render them.

## Decision

Five read-only routes, built in two verified batches.

**Batch A — no new request.** `#/sessions` and `#/agents` render records the snapshot already
holds.

**Batch B — two new bounded reads.** `#/usage`, `#/context`, and `#/optimization`. Context adds
`GET /api/v1/context/sources`, and Optimization adds `GET /api/v1/optimization/proposals`; both are
bounded read-only collections that already exist on the daemon.

### Product independence constrains the Agents route

`agentDefinitionSchema.kind` is an enum of vendor identifiers. `product-independence.test.ts`
forbids those names from appearing in dashboard production source, and that rule is correct: the
dashboard must not special-case a vendor.

So the Agents route renders `kind` verbatim as data arriving from the API. There is no label map,
no per-vendor icon, and no conditional on agent identity. A vendor whose name never appears in the
source cannot be privileged by it.

### Routes and content

| Route            | Source                                                                          | New read |
| ---------------- | ------------------------------------------------------------------------------- | -------- |
| `#/sessions`     | snapshot `sessions`                                                             | no       |
| `#/agents`       | snapshot `agents`, typed; session counts joined from `sessions`                 | no       |
| `#/usage`        | snapshot `usage`                                                                | no       |
| `#/context`      | snapshot `context` plus `GET /api/v1/context/sources?limit=100`                 | yes      |
| `#/optimization` | snapshot `findings`, typed, plus `GET /api/v1/optimization/proposals?limit=100` | yes      |

**Sessions** lists every session, not only the active subset Pulse shows. Presence, status, project
name, and timestamps. An unknown status renders as `Unknown` rather than being dropped, reusing the
existing `labelSessionStatus`.

**Agents** lists definitions: display name, kind, adapter, enabled state, detected version, and the
number of sessions observed for that agent. A missing `detectedVersion` renders as `Undetected`,
never as an empty cell.

**Usage** expands the Pulse summary. Each of the five sources keeps its own row, and a source whose
`totalTokens` is absent renders as `Unavailable` rather than `0`. The route states plainly that
`unavailable` records are excluded from any total, because summing across sources of different
provenance would invent a number the runtime never observed.

**Context** renders the assigned, effective, loaded, invoked, and unknown distinction as separate
counts rather than a funnel, because they are not nested stages — a source can be loaded without
having been observed as effective. The sources table adds per-source evidence. `unknown` is a
first-class value, never coerced to false.

**Optimization** lists findings with kind, state, confidence, and evidence window, plus proposals
with their state. Both are read-only. No accept, reject, evaluate, or analyze control is rendered;
those endpoints exist and are deliberately not called.

### Shared primitives

`Panel` and `ResourcePanel` currently live inside `projects-view.tsx`. They move to
`components/panel.tsx` unchanged so five more routes reuse them rather than restating the
ready/empty/unavailable branching. `ProjectResourceState` moves with them under a neutral name,
since it is no longer project-specific.

### Unchanged

`Graph` stays disabled. Lifecycle, release readiness, tasks, leases, unified search, GitHub state,
and every mutation surface stay absent.

## Testing

Per AGENTS.md section 15:

- Route parsing for all eight routes plus href round-tripping.
- Each view: populated, empty, and unavailable states, kept distinct.
- Agents: no vendor name in production source; `kind` rendered verbatim; undetected version labelled.
- Usage: absent token totals render as unavailable, not zero.
- Context: `unknown` preserved as its own value.
- Optimization: every finding state and confidence tier; no mutation control rendered.
- New loaders: bounded query strings, per-resource independence, abort forwarding.
- No page-level horizontal overflow at 1280, 1440, and 1728 px.
