# ADR 0012: TypeScript-native code-structure observer

Status: Accepted  
Date: 2026-08-08

## Context

The Phase 4 operational graph (ADR 0009) is derived from normalized Runtime events, canonical
Phase 3 manifests, current projections, local Git observations, and package inventory. It answers
operational questions: which agent worked in which project, which session produced which commit,
which capability is bound where.

It cannot answer structural questions about the code itself. Import and call relationships,
module cohesion, and which files concentrate responsibility are invisible to an event-derived
projection, because no Runtime event describes them. This matters for two reasons already visible
in this repository: `apps/daemon/src/app.ts` is 1256 lines and `packages/redis/src/function-library.ts`
is 954 lines, and section 5 package boundaries are asserted in prose rather than observed.

`Graphify-Labs/graphify` was evaluated as a way to obtain this layer without building it. It
extracts code structure with tree-sitter, clusters it, and exposes the result through a CLI, an
MCP server, and several export formats. It is Apache-2.0, actively developed, and demonstrably
scales to repositories far larger than this one.

It is not adoptable here:

- It is Python-only. There is no npm package and no JavaScript or TypeScript binding, so it cannot
  be imported in process by a Node runtime.
- Its `graph.json` layout is not a documented or versioned contract, and the CLI has no stable
  JSON output contract, so no other program can consume it safely.
- Its persistence targets are files, Neo4j, FalkorDB, and GraphML. It has no Redis backend, which
  section 2 requires for runtime state.
- Adopting it would impose a Python 3.10+ runtime requirement on every user of a Node product.
- Running it would contradict sections 12 and 18, which state that adapters and scanners never
  execute package managers, scripts, hooks, plugins, or MCP definitions.
- Its installer writes hooks into the user's coding-agent configuration directory. Section 2
  requires that LUWI never silently overwrite native files, and this is precisely the class of
  mutation LUWI exists to mediate rather than perform.

Its design nonetheless converges with decisions already made here, which is corroborating evidence
rather than a reason to depend on it. It labels extracted relationships by certainty — explicit,
inferred, and ambiguous — mirroring the exact, correlated, and unknown attribution vocabulary in
section 18. It operates on a serverless in-memory graph at repositories of roughly one million
lines, which supports ADR 0009's conclusion that a dedicated graph database is unjustified at this
scale.

## Decision

Graphify is not adopted as a dependency, a bundled tool, or an executed scanner.

A TypeScript-native code-structure observer is designed instead, to be implemented only when its
phase is explicitly approved under section 21.

- Extraction is AST-based over the repository's own TypeScript sources, using the **TypeScript
  compiler API** (`typescript`, currently 6.0.3). See the dependency section below.
- Extraction is deterministic and local. It contacts no network and calls no model.
- Output is projected into the **existing** Phase 4 Redis operational graph through the existing
  node, edge, and generation keys and the existing shadow-generation rebuild path. No second graph
  and no second datastore is introduced.
- Structural nodes and edges carry `source: "code-structure"` provenance and are distinguishable
  from event-derived relationships at query time. Structural edges never silently merge with
  operational edges.
- Edge certainty reuses the existing `intelligenceConfidenceSchema` (`high`, `medium`, `low`,
  `unknown`) rather than introducing a parallel vocabulary: a statically resolved import is `high`,
  a reference resolved through a re-export or with a single candidate is `medium`, a heuristic
  match is `low`, and an unresolvable reference is `unknown`. Unknown is never converted to a
  stronger claim.
- The existing `file` and `module` node kinds are reused. No `function` node kind is added in the
  first increment; function-level granularity is deferred until a real consumer needs it, per
  section 5. New edge kinds are required and are a `@luwi/protocol` change with schema validation
  and tests, not an ad-hoc string.
- Two structural edge kinds are added: `FILE_IMPORTS_FILE` and `MODULE_DEPENDS_ON_MODULE`. The
  design also proposed `FILE_EXPORTS_SYMBOL`, and it is **not** added. `graphEdgeSchema` requires
  two node endpoints, and a symbol is not a node kind in this increment. The only ways to force it
  are a file-to-itself edge per exported name, which is poor modelling and would inflate the graph,
  or a `symbol` node kind, which is exactly the speculative schema growth this ADR defers. Export
  surface is carried as a bounded `exportCount` on the `file` node instead, which needs no new
  kind and claims nothing the observer did not measure.
- Bounded traversal, adjacency-scan limits, and examined-edge budgets are inherited from ADR 0009
  rather than redefined.
- Records hold identifiers, locations, and bounded metadata only. Source text, complete file
  contents, prompts, diffs, and credentials are forbidden, as in ADR 0009.
- No new package is created. Section 5 requires two real consumers to prove a boundary first.
- The observer never executes the code it parses, and never executes package managers, scripts,
  hooks, plugins, or MCP definitions.

Neo4j, FalkorDB, NetworkX, GraphML, embeddings, and vector search remain unused. A semantic
knowledge graph remains out of scope under section 21.

### The parser dependency, settled

The design deferred this and required it to be settled before implementation rather than during.
It is settled here: the observer uses the TypeScript compiler API, and `typescript` is promoted
from a root devDependency to a production dependency of `apps/daemon`, which is where the existing
`git-observer` and `package-inventory` scanners live.

The claim that this "adds no new dependency" is only true of the lockfile. Section 6 is about the
production boundary, and there the cost is real and worth stating plainly: `typescript` is 24 MB,
while every current production dependency combined — `zod` 5.7 MB, `fastify` 3.6 MB, `pino`
1.1 MB, `smol-toml` 0.3 MB — is about 10.7 MB. This more than doubles the shipped footprint.

It is accepted anyway, for reasons that outweigh the size on this product:

- The design's own confidence mapping depends on semantic resolution. `medium` is defined as
  "resolved through a re-export chain", which a syntax-only parser cannot determine. Choosing
  tree-sitter would mean hand-writing module resolution, and that is precisely where the defects
  would live — a wrong edge asserted with `high` confidence is the failure this repository works
  hardest to avoid.
- LUWI Runtime is a local-first tool for developers working in TypeScript repositories. Every
  machine that runs it already has a TypeScript toolchain.
- The alternative adds a native dependency with prebuilt-binary and Windows build considerations,
  on a product whose reference machine is Windows.

Two alternatives are rejected explicitly:

- **tree-sitter with the TypeScript grammar.** Faster and incremental, but resolves nothing
  semantically, as above.
- **Loading the observed project's own `typescript` from its `node_modules`.** This would keep
  LUWI's dependency list unchanged and use the exact version the project compiles with, which is
  tempting. It is forbidden: sections 12 and 18 state that scanners never execute code discovered
  in a scanned project, and a hostile or merely broken project could ship anything under that
  name. The observer must not be the hole in that rule.

If the footprint later proves unacceptable, the escape is to move extraction out of the daemon
into an on-demand child process or a separate optional package — not to weaken the resolution
guarantees.

## Consequences

The structural layer becomes queryable through the same bounded named queries as the operational
graph, so a single traversal can connect a session to a project to a module to the function it
changed. Package boundary claims in section 5 become observable rather than asserted, complementing
the `no-restricted-imports` rule that already proves the import-level subset mechanically.

The cost is `typescript` as a production dependency of `apps/daemon`, more than doubling the
shipped dependency footprint, and it is the reason the escape hatch above is written down rather
than left to be improvised. Extraction is bounded by what static analysis can resolve: dynamic
dispatch, runtime registries, and reflective access produce unknown edges, and the graph's
completeness must be reported through that horizon rather than implied.

One inherited limit surfaced during implementation and is recorded rather than worked around.
`module` nodes are derived from the Phase 4 package inventory's `workspaceLocation`, and that
inventory only produces records for manifests that declare at least one dependency. A workspace
package with no dependencies therefore has no `module` node, and every file inside it maps to the
nearest enclosing module instead. `MODULE_DEPENDS_ON_MODULE` is only as complete as that
derivation: a dependency-free package can neither be an endpoint nor be distinguished from its
parent. Fixing it means changing how module roots are derived on the write path, which is a Phase
4 projection change and belongs to whatever phase needs it. File-level edges are unaffected.

Rejecting Graphify means forgoing multi-language extraction, PDF and image ingestion, and the
clustering and reporting it provides. That is accepted: this repository is single-language, and
the operational graph — not a document graph — is the product.

The rejection of Graphify is recorded so that a future reader does not re-evaluate it from
scratch. Implementation of the first increment was approved under section 21 on 2026-08-08 and
begins from `docs/superpowers/specs/2026-08-08-code-structure-observer-design.md`.
