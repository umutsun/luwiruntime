# Code-structure observer — design

Status: Draft, not approved for implementation  
Date: 2026-08-08  
Decision record: `docs/decisions/0012-code-structure-observer.md`

This document designs the observer that ADR 0012 proposes. Nothing here is implemented. Section 21
of `AGENTS.md` requires explicit scope approval before a new phase begins, and this design exists
so that approval can be given or refused against something concrete.

## Problem

The Phase 4 operational graph answers "who did what, where, and when". It cannot answer "what
depends on what", because no Runtime event carries that fact. Two consequences are visible today:

- Section 5 package boundaries are asserted in prose. The `no-restricted-imports` rule added to
  `eslint.config.js` proves the import-level subset mechanically, but nothing observes module
  cohesion, fan-in, or where responsibility has concentrated.
- `apps/daemon/src/app.ts` (1256 lines) and `packages/redis/src/function-library.ts` (954 lines)
  are the two obvious concentration points, and they were identified by reading, not by measurement.

## What already exists and must be reused

The current schema in `packages/protocol/src/intelligence.ts` anticipates most of this:

- `graphNodeKindSchema` already includes `file` and `module`.
- `graphEdgeKindSchema` already includes `FILE_BELONGS_TO_MODULE`.
- `graphNodeSchema` and `graphEdgeSchema` already carry `observedAt`, `provenance`, `confidence`,
  `evidenceIds`, and bounded `metadata`.
- `createGraphNode` and `createGraphEdge` in `packages/runtime/src/operational-graph.ts` derive
  deterministic sha256-based identities that already include `projectId` scope.
- Bounded traversal is already enforced: `GRAPH_MAX_NEIGHBOR_LIMIT` 1000, `GRAPH_MAX_PATH_DEPTH` 6,
  `GRAPH_MAX_SUBGRAPH_NODE_LIMIT` 2000.
- Shadow-generation rebuild and its atomic pointer swap already exist via
  `luwi_graph_rebuild_transition_v1`.

The observer is therefore a **new producer for an existing projection**, not a new subsystem. That
is the whole reason this is worth doing and the reason no new package is created.

## Scope of the first increment

File and module granularity only.

Nodes: reuse `file` and `module`. A `module` is a workspace package (`@luwi/protocol`,
`@luwi/daemon`, …); a `file` is a source file within one. Both already exist, so no node-kind
change is needed.

Edges: three new kinds are required in `graphEdgeKindSchema`.

| Edge                       | Meaning                                           | Confidence |
| -------------------------- | ------------------------------------------------- | ---------- |
| `FILE_IMPORTS_FILE`        | Resolved static import between two source files   | see below  |
| `MODULE_DEPENDS_ON_MODULE` | Aggregated package-level dependency               | derived    |
| `FILE_EXPORTS_SYMBOL`      | Public surface of a file, symbol name in metadata | `high`     |

`FILE_BELONGS_TO_MODULE` already exists and is reused unchanged.

Function-level nodes and a call graph are explicitly **deferred**. Section 5 requires two real
consumers before a boundary is created, and the same restraint applies to schema surface: adding a
`function` node kind before anything queries it is speculative.

## Confidence mapping

Reuses `intelligenceConfidenceSchema` — `high | medium | low | unknown`. It does **not** introduce
the `exact | correlated | unknown` vocabulary, which belongs to Git attribution and means something
different.

| Situation                                                                   | Confidence |
| --------------------------------------------------------------------------- | ---------- |
| Static `import` resolved to exactly one file on disk                        | `high`     |
| Resolved through a re-export chain, or one candidate after alias resolution | `medium`   |
| Heuristic match (extensionless path with several plausible targets)         | `low`      |
| Dynamic `import()` with a non-literal specifier; unresolvable path          | `unknown`  |

`unknown` is never upgraded and never silently dropped. A dynamic import that cannot be resolved is
recorded as an unknown-confidence edge with no target, or omitted with a counted diagnostic —
never rewritten into a guess. This mirrors ADR 0010's rule that unknown is not treated as unused.

## Provenance and evidence

Every node and edge sets `provenance` to a string identifying the extractor and its version, so a
generation can be attributed and invalidated. `evidenceIds` reference the source location
(`file:line`), which `graphEdgeSchema` already requires to be non-empty.

Structural edges are distinguishable from event-derived edges at query time by edge kind and
provenance. They must never be merged into an operational edge, because they answer a different
question and have different reliability.

## Bounds and safety

- Records hold identifiers, paths, symbol names, and locations only. Source text, complete file
  contents, prompts, diffs, and credentials are forbidden, exactly as in ADR 0009.
- Paths are canonicalized and containment-checked against the project root, reusing the existing
  canonical-root pattern from the Phase 4 package inventory.
- The observer parses; it never executes. It does not run package managers, scripts, hooks,
  plugins, or MCP definitions, per sections 12 and 18.
- Extraction is bounded per file and per run: a maximum file size, a maximum file count, and a
  wall-clock budget. Truncation is disclosed, not silent — the same rule the package scanner
  already follows.
- Git-tracked paths are preferred when available, with filesystem fallback disclosed.

## Rebuild and refresh

Rebuild writes a shadow generation and swaps the active pointer atomically through the existing
`luwi_graph_rebuild_transition_v1`, validating counts and every edge endpoint before activation.
Incremental refresh atomically replaces changed generation membership so obsolete edges are
removed rather than accumulating — both behaviors are inherited from ADR 0009 rather than
reinvented.

Because structural facts derive from canonical filesystem and Git state rather than from retained
events, a structural generation is fully rebuildable at any time. This satisfies section 2's
requirement that every derived view be rebuildable.

## Dependency question, unresolved

Extraction needs a TypeScript-native parser. Section 6 requires justifying any production
dependency, verifying it is maintained, and keeping it behind an existing package boundary.

Two candidates, neither chosen here:

- **TypeScript compiler API** (already a devDependency at `^6.0.3`). No new dependency, full type
  resolution, accurate re-export following. Heavier at runtime, and the compiler API is not a
  stable public contract across versions.
- **tree-sitter with the TypeScript grammar.** Fast, incremental, tolerant of broken files. Adds a
  native dependency with prebuilt-binary and Windows-build considerations, and resolves nothing
  semantically — re-export chains would need hand-written resolution.

The TypeScript compiler API is the better starting point precisely because it adds nothing new,
and section 6 asks first whether an existing dependency suffices. This must be settled before
implementation, not during.

## Required tests

Following section 15's rule that every transition is tested:

- Deterministic node and edge identity, including project scoping.
- Each confidence tier, with a fixture per row of the mapping table.
- Unresolvable dynamic import produces `unknown` and is never upgraded.
- Containment rejection for a path escaping the project root.
- Bound enforcement and truncation disclosure.
- Shadow-generation swap validates counts and endpoints before activation.
- Incremental refresh removes obsolete membership rather than accumulating it.
- Structural and operational edges remain distinguishable after projection.

## Explicitly out of scope

Function-level call graphs, multi-language extraction, document or PDF ingestion, clustering and
community detection, embeddings, vector search, and any semantic knowledge graph. Section 21
prohibits the last of these outright.
