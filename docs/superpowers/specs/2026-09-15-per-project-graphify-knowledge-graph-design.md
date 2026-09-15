# Per-project graphify knowledge graph — design (2026-09-15)

## Problem

Graphify (Python, tree-sitter) builds a `graphify-out/graph.json` per registered project — a
knowledge graph of symbols, communities and typed edges, parsed on-device with no embeddings. ADR
0029 already reads that file into LUWI's operational graph, but it collapses every graphify symbol
into the `file` node it came from, so the community structure, the god/hub nodes and the symbol-level
edges are lost. There is no way in the dashboard to see a single project's graphify knowledge tree the
way graphify itself models it.

The owner shared a Claude Design comp — `temp/Luwi Runtime Dashboard Mockup/Luwi Runtime - Graph.dc.html`
— titled KNOWLEDGE GRAPH: a per-project, community-clustered graph of god/hub/symbol nodes with an
inspector, a project switcher, and a stat strip. This builds that as a **read-only** dashboard view.

## Decisions (owner-approved 2026-09-15)

1. **Read-only explorer.** The comp's write actions (Optimize/Prune, Delete node, Rebuild) are not
   built. LUWI never mutates or runs graphify (AGENTS.md §12/§18/§21); graphify rebuilds through its
   own git hooks (ADR 0029). They are replaced with honest read-only provenance, the ADR 0032 way.
2. **Data source: each project's `graphify-out/graph.json`,** read the same bounded way the ADR 0029
   observer reads it. The operational graph API is too coarse (file/module granularity, no
   communities). Reading a tool's output is within the §12/§18 line ADR 0029 already draws.
3. **New route `#/knowledge`,** additive; the operational `#/graph` stays.
4. **Static community-ring layout** for v1 — a pure, testable model, no requestAnimationFrame force
   simulation. The comp's 3D orbit is deferred (see Out of scope).

## Architecture

Three units, each independently testable:

### A. Bounded reader — `apps/daemon` (beside `graphify-observer.ts`)

A new reader beside `graphify-observer.ts` (which lives in `apps/daemon/src/`, where graphify reading
already lives per §12/§18) that returns graphify's own
structure rather than the file-collapsed projection the observer produces. It reuses the observer's
document read: the `GRAPHIFY_OUTPUT_RELATIVE_PATH`, the `MAX_OUTPUT_BYTES` size cap, and the
`nodeSchema`/`linkSchema` parse. It does **not** run graphify and does **not** execute anything found
in the file.

Output (pre-projection, still bounded by the read cap):

```
KnowledgeGraphDocument = {
  nodes: { id, sourceFile, community?, communityName? }[]   // graphify nodes
  links: { source, target, relation }[]                     // graphify edges
  builtAtCommit?: string
  observedAt: string                                        // graph.json mtime
}
```

`null` when the project has no `graphify-out/graph.json` (an honest absence, not an error). A file that
exceeds the cap or fails to parse throws the existing `GraphifyObserverError` codes.

### B. Bounded projection — `apps/daemon` (pure)

A pure function `projectKnowledgeGraph(document, options)` — co-located with reader A in the daemon,
since the two change together and are graphify-specific — turns the raw document into the bounded
render model. This is where the graph is made small enough to draw (real graphify graphs reach ~20k
nodes; the view shows tens). Deterministic, no I/O, unit-tested in isolation.

Steps:

1. **Degree.** Count undirected degree per node from `links`.
2. **Kind.** `god` = the highest-degree nodes overall (top `GOD_NODE_COUNT`, e.g. 6); `hub` = the
   highest-degree node in each community not already a god; everything else `symbol`. If a future
   graph.json carries graphify's own rank field, prefer it over degree (the schema is `looseObject`,
   so extra fields survive; the projection reads it if present).
3. **Backbone selection.** Keep all god + hub nodes, then fill up to `MAX_RENDER_NODES` (e.g. 40) with
   the next-highest-degree symbols, so the canvas shows the structural backbone, not 20k leaves.
   `summary.truncated` is set when nodes were dropped.
4. **Edges.** Keep only edges whose both endpoints are in the kept set. `relation` in the ADR 0029
   `IMPORT_RELATIONS` set → `kind: 'import'`; anything else → `kind: 'call'`.
5. **Communities.** Aggregate `{ id, name, size }` over _all_ nodes (not just kept ones), sorted desc,
   bounded to `MAX_COMMUNITIES` (e.g. 12).
6. **Summary.** `{ nodeCount, edgeCount, communityCount, hubCount, embeddings: 0, builtAtCommit?,
observedAt, truncated }` — counts are over the whole document, not the bounded subset.

Response schema (`@luwi/protocol`, `knowledgeGraphResponseSchema`, strict, browser-exported):

```
{
  summary: { nodeCount, edgeCount, communityCount, hubCount, embeddings, builtAtCommit?, observedAt, truncated }
  communities: { id, name, size }[]          // <= MAX_COMMUNITIES
  nodes: { id, label, sourceFile, community?, communityName?, kind, degree }[]  // <= MAX_RENDER_NODES
  edges: { source, target, kind }[]
}
```

`label` is the node id's terminal segment (graphify ids are path-like); the view never re-derives it.

### C. Daemon route

`GET /api/v1/projects/:projectId/knowledge-graph` — resolves the project (404 if unknown), reads its
`canonicalPath`, runs reader A then projection B, and answers the response schema. When the reader
returns `null` the route answers `200` with an empty projection (`nodeCount: 0`, empty arrays) and no
`observedAt`, so the client renders the empty state without treating absence as a fault. A read that
throws `GRAPHIFY_OUTPUT_TOO_LARGE`/`_INVALID` is a `502`-class server error naming the code (ADR 0015:
an internal read failure is a server error, not a client one). Loopback-only (§4). It is a read; no
Redis, protocol-Redis, or `luwi_v1` change.

## Dashboard view — `#/knowledge/<projectId>`

A detail route rendered in the existing dashboard shell (route head + back-to-Overview), reached from
the overview project drill-down ("Knowledge graph" link, carrying the focused project id) and Ctrl-K.
Its own bootstrap scope, loaded only while the route is open — the overview never pays for it (the rule
the intelligence/messages scopes already follow).

Layout, matching the comp within the dashboard's tokens:

- **Context row:** KNOWLEDGE GRAPH eyebrow · **project switcher** (reuses the overview's project list;
  changing it navigates `#/knowledge/<id>`) · provenance line **built `<commit>` · observed `<time>`**.
- **Stat strip:** nodes · edges · communities · hubs · embeddings 0 (from `summary`). Legend: god
  node / module hub / symbol.
- **Canvas (SVG):** the static community-ring layout (below). Nodes styled by kind (god = filled ink,
  hub = ringed paper, symbol = dim), edges by kind (import solid, call dashed). Clicking a node selects
  it (highlights it + its neighbors, dims the rest); clicking empty space clears.
- **Inspector (docked 360px):** nothing selected → project summary (communities bars + god/hub list,
  each row navigating to select that node); node selected → eyebrow `project · community`, title label,
  kind badge, `sourceFile`, facts (degree · kind · community), and the connected-edges list.
- **`$ graphify query "…"`** static hint (non-executing), as in the comp.

Pure model in `apps/dashboard/src/knowledge/model.ts`:

- `layoutKnowledge(response)` → node screen positions. Communities are placed evenly on a ring; each
  community's nodes are placed in a small cluster around its ring point (god/hub near the centre of the
  cluster, symbols around them). Deterministic (seeded by node id, like the overview's radial layout),
  no animation. Returns `{ nodes: {…, x, y, r}, edges: {…, x1,y1,x2,y2}, communityLabels }`.
- `knowledgePanel(response, selectedId)` → the inspector model (summary vs node detail).

The comp's write buttons and GRAPH OPS ticker are **not** rendered.

## Empty and error states

- No `graphify-out/` for the project → empty projection → the canvas shows "No graphify output for
  this project" with the read-only guidance to run `graphify build` (LUWI does not offer to run it).
- Read too large / invalid → the route returns the error code; the view shows the usual resource
  error (retryable), not a blank canvas.

## Testing

- **Projection (runtime):** degree, kind assignment (god/hub/symbol, rank-field preference), backbone
  bounding + `truncated`, edge filtering to kept nodes, import/call classification, community
  aggregation + bound.
- **Reader (adapters):** reuse the observer's fixtures — a present graph.json, an absent one (`null`),
  an oversized one (throws), an invalid one (throws).
- **Route (daemon):** an inject test for a project with output, one without (empty), one unknown (404).
- **View (dashboard):** `model.test.ts` for `layoutKnowledge`/`knowledgePanel`; a render test for the
  empty state and a selected node; tokens + class-coverage guards for every new class; the
  product-independence guard stays green (no new write module).

## Boundaries

- The daemon only **reads** `graphify-out/graph.json`, already sanctioned by ADR 0029. It never runs
  graphify, and it never executes or follows anything inside the file (§12, §18).
- Loopback-only, read-only (§4). No `luwi_v1`, Redis, or protocol-Redis change. No new dashboard write
  module, so `product-independence.test.ts` is unaffected.
- `graphify-out/` is gitignored; the view degrades to the empty state where it is absent.

## Out of scope (deferred, not "missing")

- The comp's 3D-orbit force simulation (v1 is static; add a force layout later if motion is wanted).
- On-demand node expansion (a `?node=<id>` neighbor read, à la ADR 0016) — v1 renders one bounded
  backbone and selects within it; add expansion if the backbone proves too small.
- Prune/Delete/Rebuild — mutating graphify's graph is out of scope and would need a separate
  owner-approved ADR (§21).
- Surfacing graphify's own query/path/explain results (graphify MCP) inside LUWI.
