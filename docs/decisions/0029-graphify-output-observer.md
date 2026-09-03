# ADR 0029: Graphify output as a read-only structural source

Status: Accepted  
Date: 2026-09-02

## Context

ADR 0012 evaluated Graphify (`Graphify-Labs/graphify`) and rejected it as a dependency, a bundled
tool, or an executed scanner, then built a TypeScript-native code-structure observer instead. Every
reason given there still holds: it is Python-only, its `graph.json` is not a versioned contract, it
has no Redis backend, and running it — or its installer, which writes hooks into agent configuration
— is exactly what sections 12 and 18 forbid.

What changed is on the developer's side, not LUWI's. On 2026-09-02 the owner installed graphify
0.9.53 on this machine themselves, built a graph for each of the ten registered projects with the
offline extractor (`graphify update`, tree-sitter only, no model), installed graphify's own git hooks
so each project's graph refreshes on commit and checkout, and registered graphify's MCP server at
user scope against its global graph so every coding agent can query symbol-level structure directly.
That was phase A, and it involved no LUWI code.

Phase B is this record. The owner wants the structure graphify extracts joined with what LUWI
already knows — which session changed which file, which commit touched it, which agent ran the
session — in one graph rather than two. ADR 0012's observer sees only TypeScript; the registered
projects also hold PHP, Python and other languages the owner's agents work in every day, and for
those the operational graph has no file layer at all beyond the paths recent commits happen to name.

### Measurement (2026-09-02, this repository at `cb5504f`)

- `graphify-out/graph.json` is 5.4 MB: 4 963 nodes, 7 946 links, 271 communities, every record
  `_origin: "ast"`. Across the ten projects the largest is 13 622 nodes (semantic-bridge); the global
  merge is 44 791 nodes and 82 427 edges.
- **There is no file node kind.** A node is a symbol, a heading, or a page, and every node carries
  `source_file` (477 distinct here, none missing). The file is a property, so the join key is
  `source_file`, never a node id.
- Links are symbol-level: `contains` 3 692, `imports` 1 111, `calls` 931, `re_exports` 920,
  `method` 620, `imports_from` 443, `cites` 64, `extends` 57, `implements` 40, `references` 34,
  `indirect_call` 30, `dynamic_import` 2, `inherits` 2. Confidence is `EXTRACTED` (7 898) or
  `INFERRED` (48). Aggregated to files, the four import-like relations yield 662 cross-file pairs.
- External targets are nodes too, with a `source_file` that is not a path: `node:net` for a Node
  builtin, and package-manifest dependencies whose `source_file` is the manifest itself.
- 59 of 477 files hold symbols from more than one community, so "the file's community" is not
  always defined.
- `built_at_commit` is the head sha at build time, or a non-sha placeholder in a project that is not
  a git repository (glasshouse).

## Decision

LUWI reads graphify's output. It still never runs graphify.

- **Boundary.** The daemon reads exactly one file per registered project,
  `<localPath>/graphify-out/graph.json`, and only if it exists. It never invokes graphify, never
  starts or queries its MCP server, never touches its model backends or its global graph, and never
  installs or edits anything of graphify's. Sections 12 and 18 are unchanged: reading a tool's
  output is the line.
- **Where it runs.** In `projectGraphSnapshot`, beside the ADR 0012 scan — read at rebuild time from
  canonical filesystem state, exactly as the structural observer is. There is no Redis copy of the
  document, no new record type, no Lua Function, no `luwi_v1` bump, no stream, and no new package.
  An absent, oversized (64 MiB) or malformed document contributes no layer, the same rule as a
  failed structural scan: the graph may be incomplete, never wrong.
- **What is read.** Four node fields (`id`, `source_file`, `community`, `community_name`) and five
  link fields (`source`, `target`, `relation`, `confidence`, `source_location`). Every entry is
  validated on its own; a malformed one is skipped and counted. Symbol names never leave the reader
  — the observation holds paths, counts, and a sha, which a test asserts.
- **File level only.** The existing `file` node kind, `FILE_IMPORTS_FILE` and
  `FILE_BELONGS_TO_MODULE` are reused; no node or edge kind is added and `@luwi/protocol` is
  untouched. The four import-like relations (`imports`, `imports_from`, `re_exports`,
  `dynamic_import`) are aggregated to distinct cross-file pairs; `calls`, `extends`, `contains` and
  the rest are counted and not bent into imports. Symbol-level nodes stay deferred as ADR 0012
  deferred them — graphify's own MCP already answers symbol questions, which is what phase A is for.
- **A path counts only if it names a real file inside the project now.** `normalizeLeasePath`
  refuses an absolute or escaping path, a colon is refused outright (on NTFS it would address an
  alternate data stream of a sibling file instead of failing), and the path must `stat` as a regular
  file under the canonical root. That one check drops `node:net`, npm package names, and a file
  deleted since the graph was built, without a separate rule for each.
- **Confidence.** `EXTRACTED` becomes `medium`, `INFERRED` becomes `low`, anything else is not an
  edge. Never `high`: graphify resolves an import target by name and LUWI did not verify it, which
  is precisely the case ADR 0012 reserved `medium` for. A file node is `high` because its existence
  was checked.
- **Precedence: fill, never replace.** The layer is added through `addNodeIfAbsent` and
  `addEdgeIfAbsent`. A file or import the ADR 0012 observer already resolved keeps its provenance,
  confidence and metadata; graphify supplies what that observer could not see. The same rule now
  applies to the `file` node a commit path proves: it used to be added last with plain `addNode`,
  silently replacing the richer structural node (and its `exportCount`) for every recently committed
  file. That was a defect, and it is fixed here rather than reproduced for a second layer.
- **Metadata on a graphify file node.** `relativePath`, `symbolCount` (graphify nodes rooted in the
  file), `communityCount`, `community` (the name, only when every node in the file is in one
  community — a derived majority would be a claim graphify did not make), and `builtAtCommit` when
  it is a sha. `observedAt` is the document's mtime: when the structure was observed, not when LUWI
  read it.
- **Provenance** is `graphify-graph-json@1`, versioning LUWI's reader since graphify does not
  version its format. The dashboard's Graph explorer names it "Graphify output — read, never run" in
  the origin column and the legend, apart from "Code structure — parsed, never executed", and draws
  it with the structural stroke.

Not done, with reasons: no configurable output directory (graphify has one default; add it when a
project needs another); no `MODULE_DEPENDS_ON_MODULE` from graphify pairs (a `medium` module
dependency inferred from a name-resolved import is more claim than the evidence carries); no
community node kind (nothing consumes it yet, and section 5 wants a consumer before a kind); no
freshness verdict against the git observation's `headSha` (`builtAtCommit` is carried so a reader
can compare); no read of graphify's global graph (LUWI's graph is project-scoped, and the global
file is graphify's cross-repository convenience for its MCP).

## Consequences

For every non-TypeScript project the operational graph gains a file layer with import edges, so
session, commit and agent edges land on files the graph previously did not know. For TypeScript
projects the layer adds the files ADR 0012's observer skips (Markdown, JSON, `.mjs`) and nothing
else, because the structural observer's claims win.

A rebuild now parses one JSON document per project (5–15 MB measured) and stats each distinct path
once — 0.6 s for all ten projects — well under the cost of the TypeScript scan it sits beside.

**Measured on the live rebuild (2026-09-02, db0, ten projects).** The active generation went from
25 406 nodes / 42 630 edges to 27 265 / 48 105. Graphify contributed 2 501 `file` nodes the
structural observer could not see — Kotlin, Dart, PHP, Markdown and the rest; 878 in flybydeniz,
398 in semantic-bridge — and 3 319 `FILE_IMPORTS_FILE` edges at `medium`, while the structural
observer's 22 651 file nodes and 14 369 `high` import edges were untouched. Commit-path file nodes
fell from 2 159 to 759, because a commit no longer replaces a structural node. The rebuild took about
ten minutes on this machine with the lock renewed throughout, roughly three of them in the
20 000-file TypeScript scan of flybydeniz.

**Found during the live rebuild (2026-09-02).** The first rebuild of the owner's real datastore with
this layer failed — not on the layer, which read all ten projects' output in 0.6 s, but on the rebuild
lock. `beginGraphRebuild` took the lock with a fixed five-minute `SET NX PX` and nothing renewed it,
while a rebuild's duration grows with the data and the machine's load: on this machine it has passed
five minutes, and two operations from earlier the same day were already stuck `running` from the same
cause, before this layer existed. When the lock lapsed, activation was refused as
`GRAPH_REBUILD_OWNERSHIP_LOST`, the failure transition was refused for the same reason, and the
operation stayed `running` with its real reason replaced by a constant. Two fixes ship with this ADR:
the repository gained `renewGraphRebuildLock` — the same compare-and-expire the daemon owner lease
uses — and a rebuild renews its lock every minute for as long as it runs, stopping before it writes a
generation it could not activate when a renewal fails; and a failed rebuild now records the underlying
reason in `failureSummary` and carries it in the thrown error even when the failure record itself is
refused. One residual stays, made rare rather than closed: a lock genuinely lost to another holder
(a machine asleep past the TTL, then a second daemon) still leaves the first record `running`, because
the failure transition is ownership-checked by design; recording a failure without ownership needs
the Function to skip its `DEL` in that branch — a `luwi_v1` change deferred until it is seen. Some
projects also carry graphify nodes with no `source_file` at all (609 in corenine, 308 in luwilisting);
they and their links are skipped and counted, which is what the counters are for.

**A second finding from the same rebuild, once the lock held.** With the lock renewed, the daemon
still stopped itself minutes into the rebuild — twice, at different offsets — and the log said only
`runtime.stopping`, which is not only a signal: the recovery path stops the runtime when the daemon
owner lease is gone. The lease lives 15 s and is renewed every 5 s on the same event loop as the
projection, and ADR 0012's projection filtered the whole export list once per file
(`structure.exports.filter(...)`), which on the 20 000-file `flybydeniz` scan is 8.7 s of synchronous
work in one tick; under load the renewal landed too late, the lease lapsed, and the rebuild died with
the daemon. The count is now taken once from a map, which takes 11 ms. The rest of a project's
synchronous projection work measures well under a second (20 000 nodes and 40 000 edges validate in
0.3 s), so no yield was added.

The reader is deliberately strict about what it reads and permissive about what it ignores, which is
the only stable posture against an unversioned format: a graphify release that renames
`source_file` makes the layer vanish — loudly in the counts, visibly in the explorer — rather than
project something wrong. `graphify-out/` stays gitignored in every project; it is graphify's,
refreshed by graphify's hooks, and LUWI treats it as untrusted input it happens to be able to read.
