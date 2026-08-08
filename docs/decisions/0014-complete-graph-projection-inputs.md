# ADR 0014: Completing the operational graph's projection inputs

Status: Accepted  
Date: 2026-08-08

## Context

Building the bounded graph summary (ADR 0013) and the code-structure layer (ADR 0012) exposed four
gaps in what the Phase 4 projection writes. All four are write-path gaps: no read could close them,
because the information was never recorded. They were documented at the time rather than fixed,
and this record separates the two that are defects from the two that are not.

**Module nodes are derived from dependency records.** `moduleRoots` in the graph rebuild is built
from the `workspaceLocation` of each `PackageRecord`, and the package inventory only produces
records for manifests that declare at least one dependency. A workspace package with no
dependencies therefore has no `module` node at all, and every file inside it is attributed to the
nearest enclosing module. This is wrong rather than merely incomplete: a file is reported as
belonging to a module it is not in. It also silently weakens `MODULE_DEPENDS_ON_MODULE`, because
an import that genuinely crosses a package boundary collapses into a single module and disappears.
The defect was found by a fixture with two workspace packages that produced one module node.

**The generations index is not maintained by every write path.** `luwi:v1:index:graph:generations`
is written by `putGraphNode` and `putGraphEdge` only. `replaceGraphSnapshot`, which is the
incremental path the running daemon actually uses, never adds to it, and
`setInitialGraphGeneration` sets the active pointer without recording the generation anywhere. On
the live runtime the index was empty while the active generation held hundreds of nodes. Retention
reads that index to decide what to remove, so a generation it does not contain is invisible to
retention, and ADR 0013 had to withhold a generation count rather than publish a zero that
contradicted the node totals.

**Rebuild history has no ordering** — `graphRebuildsIndex` is an unordered Set, so "the most
recent rebuild" cannot be answered without scanning it.

**Per-project counts have no index** — the projection maintains per-kind indexes only.

## Decision

The first two are defects in shipped behaviour and are fixed here. The last two are not, and are
explicitly not built.

### Module roots come from discovered manifests, not from dependency records

The package inventory reports every workspace location whose manifest it parsed, independently of
whether that manifest declared a dependency. Those locations are persisted alongside the package
and technology records and replaced atomically with them, so they are rebuildable from the same
scan and cannot drift from it. The graph rebuild derives `moduleRoots` from that set.

A `module` is a workspace package. Which workspace packages exist is a fact about manifests, and
the package inventory is the component that reads manifests. Deriving it instead from the
code-structure observer's filesystem walk was rejected: that observer answers what the TypeScript
sources import, and making module identity depend on it would both smudge the boundary and make
module nodes disappear for a project whose sources fail to parse.

### Every write path records its generation

`replaceGraphSnapshot` and `setInitialGraphGeneration` add their generation to the generations
index, as `putGraphNode` and `putGraphEdge` already do. Retention already protects the active
generation explicitly, so indexing it changes nothing about what retention removes.

Because the index no longer misrepresents reality, `GET /api/v1/graph/summary` reports
`retainedGenerationCount` again. ADR 0013 removed that field for one reason — the index lied — and
that reason is now gone. Existing deployments carry generations that predate this change and are
still unindexed; the incremental path runs on every refresh, so the index self-heals on the first
projection write rather than requiring a rebuild or a migration.

### Rebuild ordering and per-project counts are not built

Both would be straightforward. Neither has a consumer. Section 5 requires two real consumers before
a boundary is created, ADR 0012 applied the same restraint to schema surface, and section 21
forbids beginning scope that has not been approved. Adding a sorted rebuild index or a per-project
index set per kind would add write cost and key cardinality to every projection write in order to
answer a question nothing asks.

Per-project counts are the more expensive of the two by a wide margin: the per-kind indexes are
already 55 sets, and making them per-project multiplies that by the project count on every write.
That is a cost to accept when a caller needs it, with measurements, not in advance.

## Consequences

Module attribution becomes correct for dependency-free workspace packages, which makes
`FILE_BELONGS_TO_MODULE` trustworthy and lets `MODULE_DEPENDS_ON_MODULE` see boundaries it
previously collapsed. The cost is one more persisted set per project and one more read during
rebuild, both bounded by the number of workspace packages.

Generation accounting becomes true, retention sees every generation it is responsible for, and the
summary regains a field it had to drop. The command budget for the summary returns to 58.

The two deferred gaps remain unanswerable, and that stays visible: `AGENTS.md` section 21 continues
to record them rather than leaving a reader to discover the absence. Whichever phase needs rebuild
history or per-project breakdown will find the reasoning here instead of re-deriving it.
