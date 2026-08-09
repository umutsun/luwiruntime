# ADR 0017: Consume the git attribution read, defer the zero-data domains

Status: Accepted  
Date: 2026-08-10

## Context

`docs/2026-08-09-dashboard-ui-audit.md` item 10 lists five read-only domains the daemon serves and
the dashboard never reads: inter-agent messaging, the capability and profile catalogue, effective
agent configuration and its conflicts, git attribution, and config drift with its plans and
snapshots. Every one of them already streams events into Activity, so a user sees that something
happened without being able to see what. None was in the Phase 5 capability matrix, so building any
of them is new scope under section 21 rather than a defect fix.

The audit ranked them by user loss and put messaging first. That ranking is correct on its own
terms and incomplete, because it never asked whether the data exists.

Measured against the live Memurai instance, `luwi:v1:*`, 3072 keys, by namespace:

| Namespace               | Records | Read by the dashboard |
| ----------------------- | ------: | --------------------- |
| `graph`                 |    2669 | yes                   |
| `package`               |      42 | yes                   |
| `git`                   |      28 | partly                |
| `attribution`           |      17 | no                    |
| `session`               |       9 | yes                   |
| `project`               |       1 | yes                   |
| `message`               |       0 | no                    |
| `capability`, `profile` |       0 | as a count only       |
| `config`                |       0 | no                    |
| `context`               |       0 | yes, empty            |
| `usage`, `optimization` |       0 | yes, empty            |

Four of item 10's five domains hold nothing on the only machine that runs this dashboard. A view
over any of them would render an empty table, could not be looked at, and would have to be accepted
on its tests alone. This repository has already paid that bill: the 2026-08-09 audit found two real
defects that three sessions of green tests had missed, and both were visible the moment someone
opened the page.

The audit named the pair-scoped context reads as the cheapest honest place to start, because
`docs/phase5-dashboard-capability-matrix.md` already counts them in scope. That is true
about scope and does not survive the same test: the `context` namespace is empty too.

Git attribution is the one item-10 domain with records. ADR 0016 already recorded the shape of
those records while explaining why the operational graph has two disconnected components — every
attribution reports `insufficient-session-correlation` with confidence `unknown`, so the
`SESSION_ASSOCIATED_WITH_COMMIT` edge that would join the components is never emitted. That
condition still holds, now across 17 records rather than 16.

## Decision

Consume `GET /api/v1/projects/:projectId/git/attributions` as a fifth project-scoped read and
render it on the `#/projects` route. Defer messaging, the capability and profile catalogue,
effective agent configuration, config drift, and the pair-scoped context reads until each has data
that makes the resulting surface verifiable.

Alongside it, render the branch, tag, and worktree evidence the Git observation already delivers
and the dashboard was discarding. That half is not new scope: the Git observation row has been
`SUPPORTED` since Phase 5C, the arrays arrive in a response the dashboard already parses, and
rendering them costs no request.

### Why attribution is worth building when every row says unknown

The panel will report, for all 17 rows, that the runtime observed a commit and could not tie it to
a session. That is the point rather than a shortfall.

The runtime computes attribution on every git scan and the dashboard throws the result away at its
boundary. Surfacing "attempted, not correlated" states something true about the runtime that no
surface states today, and it makes visible the exact condition ADR 0016 had to describe in prose to
explain a disconnected graph. A reader who wonders why the graph has two components can now see the
reason in the same route as the repository it belongs to.

The panel says so explicitly. A column of `Unknown` with no explanation reads as a broken feature;
the note and the reason column make it read as an honest negative result, which is what section 18
requires.

### What defers, and on what condition

Each deferred domain becomes buildable when it holds records, not when someone finds time:

- **Messaging** needs two sessions exchanging a request and reply. The endpoints and the eight
  `message.*` event types already exist and are exercised by the integration suite; only the
  developer runtime has never produced one.
- **Capability and profile catalogue, effective agent configuration** need a project-agent binding
  with capabilities bound to it. The `profileCount` and `capabilityCount` numbers on the Projects
  route currently read `0`, so the dead end the audit identified — a number whose contents cannot
  be opened — is presently a dead end into nothing.
- **Config drift, plans and snapshots** need a config inspection to have run.
- **Pair-scoped context reads** need context contributions or sources to have been observed.

A seeding path that exercises the daemon's own write endpoints would make all of them verifiable at
once. That is verification tooling rather than product scope and is not decided here.

### What is not decided here

No mutation endpoint becomes reachable. No new daemon route is added; the attribution read has been
served since Phase 4 and already parses `attributionCollectionSchema`. No dependency and no
datastore is added. The four deferred domains are deferred, not rejected — this record exists so
the next session inherits the measurement rather than the ranking alone.

## Consequences

Selecting a project costs five bounded reads instead of four. The fifth is `limit=100` against an
index the daemon already maintains, and it follows the same rule as its siblings: an empty
collection is the empty answer, a failure is `unavailable`, and neither is rendered as the other.

`packages/protocol/src/browser.ts` re-exports one more schema. That entry point resolves to
`dist/browser.js` for the dashboard's Vite build while the test runner aliases it to source, so
adding an export requires the protocol package to be rebuilt before `pnpm build`'s dashboard leg
runs. The root `build` script orders the dashboard leg first, so an incremental build after a
protocol export change fails until `tsc -b` has run once. This is pre-existing and is recorded here
because this change is the first to hit it.

Attribution confidence needed its own chip. `attributionConfidenceSchema` grades
`exact | correlated | estimated | unknown`, which is not the `high | medium | low | unknown`
intelligence scale, so sharing `ConfidenceChip` would have mislabelled one of them. The rule they
share is kept: the grade is text first and the tone only reinforces it.

The branch and tag lists introduce a distinction the codebase did not previously need — a display
bound as opposed to a read bound. `TruncationNote` asserts that records exist which were not read;
the observation's arrays arrive complete, so a shortened list says `Showing the first 25 of N`
instead. Collapsing the two would have made a complete answer look partial.

Deferring four domains means the Activity row stays the terminal surface for messaging, config, and
capability events. A user still sees that something happened and still cannot see what. That is a
known, recorded gap rather than an oversight, and it is bounded by a condition that can be checked
rather than by a judgement that has to be re-argued.
