# ADR 0013: Bounded global operational-graph summary

Status: Accepted, partly superseded by ADR 0014  
Date: 2026-08-08

## Context

ADR 0009 established the Phase 4 operational graph as a Redis projection with named, bounded
queries. Every one of those queries is rooted: `/api/v1/graph/nodes/:nodeKind/:nodeId`,
`/api/v1/graph/path`, and `/api/v1/graph/subgraph` each require a starting node and parameters,
and each is bounded by a neighbour limit of 1000, a depth limit of 6, and a subgraph node limit
of 2000.

Three questions therefore have no answer at all:

- how large the active graph is, by node kind and edge kind;
- which generation is currently active, and how many generations are retained;
- whether the projection has recorded a failure.

None of these is derivable from a rooted query. A caller cannot reach every node by traversing
from an arbitrary root — the graph is not connected, and a disconnected component is invisible to
any traversal that does not start inside it. Summing rooted results would produce a number that
looks like a total and is not one.

This is why `Graph` is a disabled navigation label in the dashboard rather than an empty route,
and why `AGENTS.md` section 21 states that a global graph summary requires its own ADR before it
is built. Rendering a count that no read contract proves would be a fabricated claim, which is a
worse defect than a missing feature.

This decision extends the Phase 4 graph surface. It is not Phase 5 dashboard work: the contract,
its schema, and its route belong to the operational graph, and the dashboard route added
alongside it is one consumer of a contract that stands on its own.

## Decision

One read-only route is added: `GET /api/v1/graph/summary`.

It is answered from index cardinality on the active generation, never from traversal:

- `GET` the active-generation pointer;
- `GET` the projection-health key;
- `SCARD` each per-kind node index, one per node kind;
- `SCARD` each per-kind edge index, one per edge kind.

That is three commands plus one per kind — 58 today, with 29 node kinds and 26 edge kinds. The
count is fixed by the `@luwi/protocol` kind enumerations rather than by how much data the graph
holds, so it moves only when the protocol does, and a unit test pins it so that movement is
deliberate. No `SSCAN`, no node or edge hydration, no adjacency read, and no traversal occurs.
The ADR 0009 traversal limits are neither re-derived nor relaxed, because nothing on this path
traverses.

The response does **not** report a retained-generation count, even though `ZCARD` on the
generations index would cost one more constant-time command. That index is written only by
`putGraphNode` and `putGraphEdge`; the incremental `replaceGraphSnapshot` path does not add to
it, and `setInitialGraphGeneration` sets the pointer without indexing anything. On the live
runtime this repository targets, the index is therefore empty while the active generation holds
229 nodes and 339 edges. A field reading `0` beside those totals is not a subtle caveat, it is a
contradiction on the face of the response, and shipping it would have been the same class of
error as rendering an unobserved graph as zero. Reporting how many generations exist requires
fixing the index on the write path, which is a projection change and belongs to whatever phase
needs generation history.

**Superseded by ADR 0014.** That phase arrived immediately: every write path now records its
generation, so the index no longer misrepresents reality and the summary reports
`retainedGenerationCount` again. The reasoning above stands as the reason it was withheld while
the index was wrong, and the command budget is 58 rather than 57 because of the restored `ZCARD`.

Honesty rules that bind the response shape:

- An absent active-generation pointer means the graph has never been built. The summary reports
  that as an unobserved state, and the counts are **absent**, not zero.
- Within an existing generation, a kind missing from the per-kind list is an observed zero: the
  membership set for that kind is genuinely empty. The two cases are distinguishable in the
  payload and are rendered differently.
- Counts are exact. `SCARD` reports full set cardinality, so nothing here truncates, and no
  truncation flag is invented to imply a bound that does not apply. If a later change makes any
  part of this response truncating, it must report that truncation in the payload.
- Projection health reports whether a failure has been recorded, not positive proof that the
  projection is correct. A healthy reading alongside no active generation means "nothing has
  failed", not "the graph is built".

The response carries counts, the generation identifier, and health only. It carries no node ids,
edge ids, entity ids, metadata, provenance strings, or evidence ids, so ADR 0009's record-content
prohibitions are unaffected.

The route is read-only and never triggers a projection. `POST /api/v1/graph/rebuild` is not called
from this path, from the dashboard, or from any other read surface, per section 12.

No new package, dependency, datastore, or Redis key is introduced. Only keys that the graph
projection already writes are read.

### Rejected alternatives

**Counters maintained on write.** Incrementing a stored node/edge counter on every projection
write would answer in one command instead of 58. It is rejected because it creates a second
source of truth for a fact the membership sets already hold. Under a partial failure the counter
and the sets diverge, and the divergence is silent. Section 2 requires derived views to be
rebuildable from authoritative state; a cardinality read from the set is derived from the very
thing it describes and cannot drift from it.

**Reading `nodeCount` and `edgeCount` from the last rebuild operation.** Those fields already
exist on `GraphRebuildOperation` and would cost one read. They are rejected because they describe
the shadow generation as it stood when that rebuild completed. Incremental refresh changes
generation membership afterwards, so the numbers go stale without any signal that they have. A
stale-but-plausible total is precisely the fabricated claim this ADR exists to prevent.

**Reading the generation and counting what comes back.** `readGraphGeneration` already exists,
but it hydrates and validates up to 2000 nodes and 8000 edges of JSON, and it truncates at those
bounds. Counting its result would report a truncated sample as a total — wrong in exactly the
direction that matters — and would make an overview request the most expensive read in the
daemon.

**A global node-listing route.** Enumerating every node would also answer the question, but the
question is how large the graph is, not what everything in it is. An unbounded enumeration
contradicts the bounded-query rule that ADR 0009 exists to enforce.

**RediSearch or Redis Stack aggregation.** Already rejected by ADR 0009, and unavailable on the
Memurai instance this runtime targets.

**Reporting the most recent rebuild operation.** Deliberately deferred rather than approximated.
The rebuild index is an unordered Set with no time ordering, so "the latest rebuild" cannot be
answered without scanning it. Answering it cheaply would require a sorted index, which is a
projection change rather than a read change, and belongs to whatever phase needs rebuild history.

Neo4j, RedisGraph, RediSearch, Redis Stack, and a general graph query language remain unused.

## Consequences

The size, active generation, and recorded health of the operational graph become provable from a
single bounded read, so the `Graph` navigation label can stop being disabled and the route can
render facts rather than estimates. The per-kind breakdown is obtained at no extra cost, because
the per-kind index sets are what is being measured.

The cost is 58 Redis round trips per request. On a loopback, single-user runtime that is
acceptable, and it is acceptable specifically because it is constant: a graph ten times larger
costs the same. Nothing caches the result, so a caller that polls pays it every time. The
dashboard therefore loads it only while `#/graph` is open, following the on-demand pattern Phase
5D established for collections that only one route needs.

The answer is scoped to the active generation. Historical generations, generation counts, rebuild
history, and per-project counts are not answered. None of these is a read-side omission that
could be fixed inside this route: the projection maintains per-kind indexes but no per-project
index, and its generations index is not maintained by every write path. Answering either would
mean changing the projection, which is out of scope here and needs its own decision.

Cost grows if the graph gains kinds, since the command count follows the schema enumerations —
55 kinds today. ADR 0012's two structural edge kinds moved it there within a day of this
record, and the pinned unit test made that movement visible rather than silent. Growth is bounded
by protocol changes, which are reviewed, rather than by runtime data, which is not.
