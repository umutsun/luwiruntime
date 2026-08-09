# ADR 0016: Rooted graph exploration in the dashboard

Status: Accepted  
Date: 2026-08-09

## Context

The `#/graph` route renders the ADR 0013 summary: counts by node and edge kind, as tables. That
answers "how big is the graph" and nothing else. It cannot show that a module depends on another
module, that a session touched a file, or that a commit and a context source meet at the same
project — which is the entire reason the operational graph exists, and specifically what ADR 0012's
code-structure layer added.

The read contracts for that view already exist and predate this record. ADR 0009 specified named
bounded queries and `apps/daemon/src/app.ts` serves them: `GET /api/v1/graph/subgraph`,
`/graph/nodes/:kind/:id`, `/graph/nodes/:kind/:id/out|in`, and `/graph/path`. The dashboard simply
never consumed any of them. Nothing about the daemon needs to change.

Two facts constrain what the view can be, and both are load-bearing:

**Every traversal read is rooted.** `graphSubgraphQuerySchema` requires `nodeKind` and `nodeId`;
`maxDepth` is capped at 6 and defaults to 2; `nodeLimit` is capped at 2000 and defaults to 250.
There is no endpoint that returns the whole graph, and ADR 0013 exists precisely because the only
global answer obtainable without traversal was set cardinality. A "render the entire graph" view is
not available and is not being added.

**Node lookups key on `entityId`, not on the node's `id`.** `createGraphNode` derives
`id` as `node-${digest([kind, projectId, entityId])}`, but the Redis key is
`graph:generation:<g>:node:<kind>:<entityId>` and edge endpoints carry `entityId` too — verified
live, where project nodes key on the project UUID. So the dashboard can seed a root directly from
a project, session, or agent it already holds in the Pulse snapshot, with no id derivation and no
new listing endpoint. Modules and files have synthetic entity ids and are unreachable as seeds;
they are reached by traversing from a project, which is how they are found in practice.

## Decision

The Graph route becomes a rooted, bounded explorer: choose a root from entities the snapshot
already carries, fetch one bounded subgraph, render it as a node-link diagram, and expand or
re-root by selecting a node. The ADR 0013 summary stays on the same route as the projection's
global state — it answers a different question and is not replaced.

### Layout uses `d3-force`; rendering does not

`d3-force` is added as a dashboard dependency for force simulation only. Marks are drawn as SVG by
the same React code that draws the rest of the dashboard, so the graph inherits the existing
tokens, focus treatment, and theme. The simulation is seeded through `simulation.randomSource` and
run for a fixed tick count, which makes layout a deterministic pure function of its input and
therefore testable without a DOM.

A full graph library — cytoscape.js, sigma.js — was rejected: it would roughly double a 360 kB
bundle to supply pan, zoom, and a style engine for a read-only panel of at most a few hundred
nodes. A hand-written simulation was also rejected: it saves about 10 kB gzipped and costs layout
quality precisely where the graph is densest, which is where the view has to earn its place.

### Three encodings, each carrying a distinction the graph already makes

- **Node kind** selects both fill and shape. Kind is never carried by color alone, so the diagram
  survives color-vision deficiency, forced-colors mode, and print.
- **Edge confidence** selects stroke style: `high` solid, `medium` dashed, `low` dotted, `unknown`
  dotted and dimmed with the word in its accessible description. ADR 0012 made confidence a
  first-class property of structural edges; rendering `unknown` as though it were `high` would be
  the exact conversion AGENTS.md section 18 forbids.
- **Provenance** separates the code-structure layer from event-derived relationships. Edges whose
  provenance is `code-structure-observer@1` are drawn in a distinct hue, because ADR 0012 requires
  structural edges to stay distinguishable from operational ones rather than silently merging.

Node kinds and edge kinds are rendered verbatim. The dashboard owns no label map for them, so a
new kind needs no dashboard change — the same rule the Agents route already follows.

### The root's incoming edges are read separately

`graphSubgraph` traverses `out` only — hardcoded in `apps/daemon/src/intelligence-service.ts`. That
is fine for a source kind and wrong for a sink: `module` has no outgoing edges at all, so an
outgoing-only read of a module returns one node and zero edges. Rendering that as "no
relationships" would be a false statement about a node with nine of them, measured live.

The view therefore issues a second bounded read, `GET /graph/nodes/:kind/:id/in`, for the root only,
and merges it. Expanding inward at every depth was rejected: it multiplies requests without a bound
the daemon enforces, where one read of the root buys the honest immediate neighbourhood. If the
incoming read fails, the view degrades to the outgoing half rather than failing the panel — the
outgoing half is a true answer on its own.

### Truncation is stated, never hidden

`graphSubgraphResponseSchema` carries `truncated`. When it is true the view says so, names the
limit that produced it, and offers the depth and node-limit controls that would change it. A
bounded read rendered as though it were complete is a lie about coverage, and this is the one
failure mode a graph picture makes easy.

### What is not built

- **No global graph view.** It has no endpoint, and ADR 0009 forbids the unbounded traversal that
  would produce one.
- **No mutation.** The rebuild endpoint exists and stays unreachable from this view; provoking a
  projection from a read surface is what section 12 forbids and what the product-independence test
  already enforces.
- **No node search.** Seeding from snapshot entities covers the reachable graph, and a search
  endpoint is new daemon scope with no second consumer.
- **No physics toy.** Dragging, zooming, and free panning are not implemented. The value is in
  which relationships exist, not in arranging them.

## Consequences

The Graph route stops being a table of totals and starts answering the questions the graph was
built for, including the ones ADR 0012's layer added. It does so entirely within ADR 0009's
bounds, against endpoints that already shipped and were until now untested by any consumer — which
also means this view is the first real exercise of those routes, and a defect in them surfaces here
rather than staying theoretical.

Building it surfaced a live condition worth recording, because it limits what the view can show
and is not a defect to fix here. The active generation holds two disconnected components: one
running developer → agent → session → project → package/technology/repository, and one running
commit → file → module, which is where ADR 0012's code-structure layer lives. The edge kind that
would join them, `SESSION_ASSOCIATED_WITH_COMMIT`, is emitted only for a git attribution that
carries a `sessionId`, and on this machine all sixteen attributions record
`insufficient-session-correlation` with confidence `unknown`. That is section 18 working as
intended — an unproven correlation is not upgraded into an edge — but it means a root seeded from
a project, agent, or session cannot reach the code-structure layer today, in either direction.
Rooting inside that component still works and shows it correctly; the components will join on
their own once one session can be correlated to one commit. Giving the view a seed for every node
kind would need a bounded node-listing endpoint, which is new daemon scope under section 21 and is
not taken here.

The cost is one dependency, about 10 kB gzipped, two bounded reads per root instead of one, and a
view whose honesty depends on the
`truncated` flag being rendered every time. A dense project will hit the 250-node default
immediately; the default is kept low deliberately, because a slow, unreadable first paint teaches a
reader to distrust the view faster than a stated bound does.

Layout determinism is a testing decision with a visible consequence: the same subgraph always
produces the same picture, so a reader who returns to a root recognizes it. It also means layout
quality cannot be improved by re-running the simulation, only by changing its parameters.
