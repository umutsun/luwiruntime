# ADR 0009: Event-derived operational graph

Status: Accepted  
Date: 2026-07-30

## Context

LUWI needs bounded answers about relationships among projects, agents, sessions, commits,
files, packages, capabilities, and configuration operations. These relationships are
operational facts with provenance. They are not semantic embeddings and do not justify a
second database.

## Decision

The Phase 4 graph is a Redis projection derived from normalized Runtime events, canonical
Phase 3 manifests, current project/session projections, local Git observations, and package
inventory.

- Hashes store validated nodes and edges.
- Sets store node/edge indexes and incoming/outgoing adjacency.
- Project-owned entity identities include project scope; raw commit SHAs and source IDs are
  retained as metadata rather than used as cross-project identities.
- Every edge includes observation time, provenance, confidence, and evidence IDs.
- Records contain identifiers and bounded metadata only. Source text, prompts, responses,
  complete diffs, credentials, and memory documents are forbidden.
- Queries are named and bounded: node, incoming/outgoing neighbors, shortest path, and
  subgraph. Depth, result, adjacency-scan, and examined-edge limits are enforced.
- Incremental refresh atomically replaces changed generation membership so obsolete
  relationships are removed rather than accumulating until rebuild.
- Rebuild validates retained Runtime events, merges canonical/current projections, records
  the retained Stream watermark, and writes a shadow generation. Stored counts and every
  edge endpoint are validated before the active-generation pointer changes atomically
  through `luwi_graph_rebuild_transition_v1`.
- Projection failures do not rewrite authoritative events. They produce bounded diagnostics
  and degraded graph health in one atomic Redis Function transition.

Neo4j, RedisGraph, RediSearch, Redis Stack, and a general graph query language are not used.

## Consequences

The active graph remains readable while a replacement is built, and projections can be
recovered without making the graph authoritative. Retention can remove stale generations
incrementally while preserving the active and newest safe generations. Historical
completeness is limited by retained normalized observations and is reported through the
available observation horizon rather than implied.
