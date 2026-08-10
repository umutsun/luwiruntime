# ADR 0020: Advisory work leases

Status: Accepted  
Date: 2026-08-10

## Context

The product promise in `AGENTS.md` section 1 is three clauses: see every project, coordinate every
agent, ship without collisions. After ADR 0019 the first was complete — every read domain the
2026-08-09 audit listed has a consumer. The third had nothing behind it at all. The only `lease` in
the codebase was `daemon-ownership.ts`, which keeps two daemons off one Redis, and a file lock in
the config engine. Two agents editing the same file was a state the runtime could observe after the
fact and never prevent.

Section 7 anticipated this: "Future tasks, leases, activity, lifecycle progress, and rankings may
use additional sorted sets **only when their phases are approved**." This phase is that approval.

## Decision

### The lease is over a project-relative path

Two alternatives were considered and rejected. A free-text work intent is cheap and can refuse
nothing, which makes it a bulletin board wearing the word "lease" — and this repository's whole
discipline is against surfaces that look like a measurement and are not. A hybrid that checks paths
when given and records intent otherwise gives one endpoint two different guarantees.

A path can be checked. Two leases conflict when one path contains the other, and the runtime
**refuses** the second rather than granting it with a warning. A hold that never says no teaches
its callers to stop asking.

### Advisory means unenforceable, not indefinite

Section 3 is explicit that LUWI coordinates execution and does not inject into terminals. An agent
that ignores a denial still edits the file, and no design here changes that. What the runtime
guarantees is narrower and still worth having: a definite, atomic answer to "is anyone already
working there", and a record of who holds what and why.

This is why the denial is a **200 with a body** rather than a 409. The runtime answered the question
correctly; an error status would make a working collision check look like a broken request to every
generic client between the daemon and the agent.

### The trailing separator is the whole conflict algorithm

`normalizeLeasePath` produces two values: the path as written, for display, and a match form that is
lowercased, forward-slashed, and **terminated by a separator**. Conflict detection is then a plain
prefix comparison in both directions.

That separator is what makes the comparison segment-aware. Without it `src/app` prefixes
`src/appendix` and the runtime refuses a lease over an unrelated sibling — the classic prefix bug,
and the reason it has its own test at every layer. A whole-project lease normalizes to the empty
match form, which prefixes everything, which is exactly the semantics wanted.

Case is folded deliberately. On this platform `src/App.ts` and `src/app.ts` are one file, so a
case-sensitive comparison would miss a real collision. The opposite error — refusing two genuinely
distinct files on a case-sensitive filesystem — costs a retry. Missing a collision costs the thing
the feature exists to prevent.

Normalization, case folding and the separator convention live in `@luwi/protocol`. The Lua compares
already-normalized strings and nothing else, which is section 7's rule that Functions carry no
product policy.

### Four Functions, six declared keys, no derived key names

`luwi_v1` moves to version 10 with `lease_acquire`, `lease_renew`, `lease_release` and
`lease_expire`. Acquire has to read the project's held leases, compare, write the record, index it,
and append its event as one step; two sessions asking for overlapping paths at the same instant must
produce one grant and one denial, and an integration test issues exactly that race.

The project's held leases are **one hash** keyed by lease id whose values carry only what a conflict
answer needs — match form, holder, expiry. A first attempt derived each other lease's key from the
candidate's key with a `gsub`, which works on one node and is precisely the kind of undeclared key
access section 7 exists to prevent. The hash keeps the scan to a single declared key.

An entry past its expiry is skipped rather than deleted during acquire. Removing it is the sweep's
job, and the sweep owns the `lease.expired` event that goes with it.

### `lease.denied` is an event

A refused acquire records no state change, and it is the only evidence that a collision was
prevented rather than merely not observed. Without it the runtime could never show that the feature
did anything. It appears in Activity with no dashboard change, because Activity renders event types
verbatim.

### Expiry is swept, not TTL'd

A TTL key would delete the record, and the record has to survive expiry to stay readable and to
carry the transition that tells observers the path is free. `deadline:leases` is a sorted set scored
by expiry, swept on the same interval as message timeouts, following the existing sweeper exactly.

### Surfaces

| Surface   | What it does                                                                       |
| --------- | ---------------------------------------------------------------------------------- |
| HTTP      | `POST /api/v1/leases`, `…/renew`, `…/release`, `GET /api/v1/leases`, `GET …/:id`   |
| MCP       | `luwi_acquire_lease`, `luwi_renew_lease`, `luwi_release_lease`, `luwi_list_leases` |
| Dashboard | A read-only "Work leases" panel on the Projects route                              |

No MCP lease tool takes a session id. The holder is always the session the server is bound to, so
an agent cannot take or drop a hold on another's behalf. This sits inside the boundary section 12
already draws: MCP may write coordination state — it has written messages since Phase 2 — and may
not write control-plane state.

The dashboard panel offers **no control at all**. It shows held leases only; a list mixing in
released and expired ones would make a free path look taken. A dashboard that could break a lease
would be enforcing a hold the runtime deliberately keeps advisory.

## Consequences

`CLAUDE.md` described the MCP server as exposing "32 read-only `luwi_*` tools". That was wrong
before this change: 22 of the 32 were reads and 10 wrote coordination state. The correction matters
here because it is the precedent the lease tools rest on.

Only a `completed` session is refused a lease. `disconnected` is presence loss, not an ending — that
session may reconnect and renew, and if it does not, the sweep frees the path. Refusing on
disconnect would hand the path to someone else the moment a heartbeat was missed.

A project may hold 100 leases at once. The bound exists because acquire scans the held set inside a
Function call, and it is reported to the caller as a conflict rather than silently absorbed.

Verified against the seeded fixture, not only in tests: `src/api` granted, `src/api/client.ts`
refused with the holder named, `src/apiary` granted because it is a sibling and not a child, a
one-second lease expired by the sweep, and the path re-acquirable afterwards. `lease.acquired` and
`lease.denied` both appear in Activity.

Looking at it caught one thing tests did not: five columns in a half-width panel wrapped the session
identifier onto two lines. The session moved under the agent, which is the pattern the rest of the
dashboard already uses for an identity plus its id.

**Not built, deliberately.** Leases are not renewed automatically for a live session, there is no
queue or notification when a held path is released, and nothing correlates a lease with the commits
made under it. Each is a separate scope under section 21.
