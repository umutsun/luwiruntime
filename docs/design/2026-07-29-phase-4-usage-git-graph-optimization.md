# Phase 4 design: Usage Intelligence, Git Activity Graph, and Context Optimization

Status: approved for implementation on 2026-07-30.

This design applies the Phase 4 prompt alongside `AGENTS.md`, ADR 0004 through
ADR 0008, and the implemented Phase 1 through Phase 3 behavior. If this
document is ambiguous, the more restrictive security, durability, and
human-approval rule wins.

## Scope

Phase 4 adds local, evidence-backed intelligence:

- normalized exact, reported, extracted, estimated, and unavailable usage;
- static versus observed context contributions;
- read-only local Git observation and bounded attribution;
- package and technology inventory without package execution or network access;
- a Redis-derived operational graph with provenance and bounded traversal;
- structural context findings, proposals, Phase 3 ConfigPlan handoff, and
  post-change evaluation.

It does not add a dashboard, lifecycle scoring, GitHub integration, Git
mutation, package installation, prompt storage, semantic analysis, LLM
rewriting, autonomous configuration changes, another datastore, Redis
modules, or Pub/Sub.

## Chosen architecture

The intelligence features remain modules inside the existing packages:

- `@luwi/protocol` owns wire contracts, bounds, labels, and safe errors.
- `@luwi/runtime` owns deterministic normalization, aggregation, attribution,
  graph identity/query policy, finding rules, proposal state, and evaluation.
- `@luwi/redis` owns keys, validated projections, indexes, aggregate hashes,
  graph generations, rebuild metadata, and retained evidence.
- `@luwi/adapters` may describe telemetry support but never becomes a second
  store.
- the daemon owns ingestion, filesystem and Git observation, scanning,
  orchestration, readiness, and HTTP routes.
- the CLI remains an HTTP client.
- the MCP server remains a bounded daemon client and exposes only the approved
  read operations plus an optional analysis request.

No `metrics`, `graph`, `git`, or `optimization` package is created. This keeps
the repository boundary aligned with ADR 0004 and ADR 0005 until independent
reuse is demonstrated.

### Alternatives rejected

1. A dedicated graph or analytics package/database would create an unproven
   boundary and weaken the Redis-only contract.
2. A daemon-only implementation would mix protocol, policy, persistence, and
   transport and make rebuilding and testing less reliable.
3. A general graph query language would be difficult to secure and bound.
   Phase 4 exposes only named bounded traversals.

## Usage telemetry

`UsageRecord` contains stable project, agent, and session identifiers; model
metadata when supplied; optional input, output, cached-input, reasoning, total,
and context token fields; a source; confidence; observation period;
`sourceEventId`; and bounded metadata.

The accepted source labels are:

- `agent-exact`;
- `agent-reported`;
- `adapter-extracted`;
- `luwi-estimated`;
- `unavailable`.

Unknown fields remain absent. They are never coerced to zero. Totals are
accepted only when they are consistent with supplied compatible components.
Records are immutable and deduplicated by record ID and, when supplied, source
event identity. Source composition is preserved in every aggregate so exact,
reported, extracted, estimated, and unavailable observations cannot be
silently blended.

Usage ingestion atomically persists the record, indexes, compatible aggregate
deltas, and normalized global/project events through an owned Redis Function.
Graph projection follows the authoritative event and may fail independently.

## Context contributions

Static Phase 3 context estimates remain separate from observed usage.
`ContextContribution` records:

- source and capability identity;
- loading mode: always, session-start, conditional, on-demand,
  reference-only, or unknown;
- assigned, effective, loaded, and invoked as distinct facts;
- optional static estimates and reported observations;
- evidence IDs, source, confidence, and observation time.

An assignment never proves loading, and lack of observed invocation never
proves non-use. Generic static estimates retain
`source: luwi-estimated` and `method: generic-character-estimate`. Adapter or
session observations are stored alongside rather than overwriting them.

## Local Git observation

The daemon invokes Git through an exact argument-template allowlist with a
working directory, timeout, output bounds, and no shell interpolation. Allowed
read-only templates cover repository root, status, branch/HEAD, configured
default/remote data with credential redaction, bounded log metadata and
trailers, tags, and worktrees. Matching a top-level verb alone is insufficient;
network-capable, mutating, and alternate argument forms are rejected.

Git observations are canonical snapshots of local Git facts. Redis stores
bounded derived observations and indexes. Source contents and complete diffs
are never stored.

Attribution levels are:

- `exact`: an internally consistent explicit LUWI trailer set or another
  future validated explicit commit/worktree report;
- `correlated`: a bounded match based on time, branch, working directory, and
  changed paths;
- `estimated`: a weaker declared estimate;
- `unknown`: insufficient evidence.

Correlated attribution is never presented as authorship.

## Package and technology inventory

The scanner reads bounded canonical files directly. It never starts a package
manager, package script, hook, plugin, MCP server, or network request.
Git repositories use the exact read-only tracked-file list; non-Git scans label
their evidence as filesystem-wide. Every scan reports whether its file bound
was reached.

Initial ecosystems:

- Node/pnpm and safe existing npm/yarn lock metadata;
- Python (`pyproject.toml`, `requirements*.txt`);
- Dart/Flutter (`pubspec.yaml`);
- PHP/Composer (`composer.json`);
- Rust (`Cargo.toml`);
- Go (`go.mod`).

Package records distinguish direct from transitive only when the parsed
evidence proves it. Technology signals come from tracked extensions, direct
dependencies, and bounded file-pattern evidence and always include provenance
and confidence.

## Operational graph

The graph is a derived operational projection, not a semantic knowledge graph.
It stores identifiers, bounded metadata, provenance, confidence, evidence IDs,
and observation timestamps—never source text, prompts, responses, complete
diffs, credentials, or memory documents.

Nodes and edges use deterministic IDs from normalized kind and identity.
Node identities include project scope for project-owned entities so equal package names,
paths, context-source IDs, or commit SHAs in different projects cannot collide. Hashes hold
node/edge projections; sets hold node-kind and edge-kind indexes
and incoming/outgoing adjacency. A generation segment is included in graph
keys. `luwi:v1:graph:generation:active` points to the readable generation.

Incremental projection updates the active generation after authoritative
events through an atomic changed-membership replacement that removes obsolete
relations. Failures atomically create bounded projection-failure diagnostics,
mark graph health degraded, and leave the source event untouched.

Rebuild:

1. creates an operation and shadow generation;
2. reads and validates retained normalized events, records their Stream
   watermark/count, and merges current canonical/projection inputs;
3. writes deterministic nodes and edges into the shadow generation;
4. validates counts, failures, and every edge endpoint;
5. atomically swaps the active-generation pointer only on success;
6. retains the previous generation for bounded cleanup.

The active graph is never cleared before a replacement is complete.

Queries are fixed and bounded: node lookup, incoming/outgoing neighbors,
edge-kind and time/project filters, shortest path, and subgraph. Result limits,
bounded `SSCAN`, and examined-edge budgets apply. Defaults and maximums follow
the Phase 4 prompt. Unbounded traversal is rejected.

## Metrics

UTC day buckets and justified current totals are Redis projections derived
from normalized usage and runtime events. Summaries may be grouped by project,
agent, session, model, capability, context source, repository, module, and UTC
date. Each summary exposes source composition and earliest retained
observation. Token volume is not treated as code quality or an agent ranking.

## Optimization loop

Only structural findings are produced. Each finding includes bounded evidence,
an observation window, confidence, and careful language such as “not
observed.” Semantic duplicate detection and claims of obsolescence are out of
scope.

Proposal flow:

1. record a baseline of effective configuration hashes, context hashes,
   footprint, sessions, usage-source composition, observations, and Git HEAD;
2. analyze deterministic structural rules;
3. create a draft or ready proposal;
4. require explicit acceptance; acceptance changes no file;
5. create a Phase 3 ConfigPlan for an approved deterministic action;
6. use Phase 3 approval, one-time token, snapshot, apply, and rollback rules;
7. collect a configurable minimum post-change window;
8. evaluate as verified, inconclusive, or failed.

Phase 4 has no filesystem writer. It delegates approved deterministic changes
to the existing Phase 3 ConfigPlan path. Evaluation reports observations and
does not claim causal improvement in model or code quality.

## HTTP, CLI, and MCP

The daemon exposes the bounded usage, context-intelligence, Git, package,
technology, graph, rebuild, finding, proposal, and evaluation routes specified
in the Phase 4 prompt. Mutations require runtime state `ready`.

The CLI maps one command to each route and labels source and attribution
provenance. Simulated demo data is explicitly labeled.

MCP preserves earlier tools and adds only the approved project-bound,
read-oriented intelligence tools plus bounded analysis request. MCP does not
accept proposals, approve/apply ConfigPlans, rebuild graphs, mutate Git, read
Redis directly, or bypass project/session scope.

## Retention and recovery

Raw usage, superseded Git observations, completed rebuild diagnostics, rejected
proposals, and stale derived generations have configurable bounded retention.
Source-separated aggregate totals, necessary provenance, baselines/evaluations, and
generation metadata are preserved. Aggregate summaries survive raw cleanup for their
supported scope; arbitrary filters that require individual observations cover the retained
raw horizon. When retained events no longer permit a full historical rebuild, responses
expose the earliest available observation instead of claiming completeness.

Redis loss preserves the existing lifecycle contract: health is 503, mutations
return `RUNTIME_NOT_READY`, and recovery revalidates ownership, Functions,
Streams, groups, pending relay work, and intelligence projection health before
returning to `ready`.

## Test and demonstration contract

Implementation follows red-green-refactor in the prompt order. Unit tests cover
schemas and deterministic policies. Temporary repositories cover Git behavior.
Redis integration tests use an explicit dedicated test database and unique
namespace. Daemon, CLI, and MCP tests prove transport bounds and security.

The reproducible demo creates only temporary repositories and fake telemetry,
labels all provenance, exercises the complete optimization handoff through
Phase 3, and runs the Phase 1 through Phase 3 regression demos. It never touches
real developer configuration or the legacy repository.
