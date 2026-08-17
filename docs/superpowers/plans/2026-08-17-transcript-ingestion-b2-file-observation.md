# Transcript ingestion — tool and file observation (B2) — implementation plan

> **For agentic workers:** this plan is executed inline in the session that adopts it. Steps use
> checkbox (`- [ ]`) syntax for tracking. **There are no commit steps** — per `AGENTS.md` §13 the
> owner commits only when they explicitly ask.

**Goal:** Turn the file-changing tool calls already present in native transcripts into
`SESSION_CHANGED_FILE` edges on the operational graph, so the runtime can answer "which session
touched this file" from evidence it observed rather than from a guess. That edge kind sits in
`graphEdgeKindSchema` today with **no producer anywhere**; B2 is the first.

**Architecture:** The B1 transcript reader gains a second, independent extraction pass that emits
file-change observations beside the usage observations it already produces. Attribution reuses
`attributeObservation` unchanged — same binding, same half-open interval, same four unbound
outcomes. A new daemon path projects the attributed observations as graph edges through the
existing incremental-projection seam. **No new node kind and no new edge kind**, exactly as ADR 0012
did: existing kinds are filled with a distinct provenance.

**Tech Stack:** TypeScript strict ESM, Zod, Redis Functions (Lua 5.1 under Redis 7), Vitest.

## Global constraints

From `docs/superpowers/specs/2026-08-14-native-transcript-ingestion-design.md` §6, ADR 0023,
ADR 0022, ADR 0012 and `AGENTS.md`. Every task inherits these.

- **No conversation content is ever stored or logged** — only counters, paths and identifiers (§4,
  §7). A tool's `input` carries prose (`Write.content`, `Edit.new_string`); **only the path is ever
  read out of it**, never the payload.
- **Nothing discovered is executed** (§12, §18).
- **The join key is the in-record `sessionId`, never the filename** (M11).
- **A record outside every interval stays unbound** and is never assigned to the nearest session.
  Unbound counts are reported, never silently dropped.
- **No new node or edge kind.** `SESSION_CHANGED_FILE` and the `file` node kind both already exist.
- **Repository fixtures are synthesised, never copied** from a real transcript (§7).
- `@luwi/protocol` and `@luwi/runtime` must never import `redis`; `@luwi/adapters` must not import
  `@luwi/redis`.
- A transcript is untrusted input. Validate on read (§7, §14).

## Measurements

Taken 2026-08-17 over 20 transcript files of this project's tree, before any of this was designed.
They are recorded with their numbers so a layout change shows up as a failed expectation.

| #   | Measurement                     | Result                                                           |
| --- | ------------------------------- | ---------------------------------------------------------------- |
| N1  | Tool calls appear as            | `tool_use` content blocks on an `assistant` record, with `name`  |
| N2  | Mutating tools carrying a path  | `Edit` 116, `Write` 24 — `file_path`; `NotebookEdit` uses        |
|     |                                 | `notebook_path`                                                  |
| N3  | Reading tools carrying a path   | `Read` 278 — **not** a file change, and must not become one      |
| N4  | Path shape                      | **100% absolute**, zero relative (140 of 140)                    |
| N5  | Paths outside this project      | **16 of 140** mutating paths are absolute paths elsewhere        |
| N6  | `tool_result` pairing           | **418 of 418** `tool_use` ids with a path have a matching result |
| N7  | Failure signalling              | `is_error: true` on the result; **2 real cases** in the sample   |
| N8  | `SESSION_CHANGED_FILE` producer | none anywhere — `packages/protocol/src/intelligence.ts:545` only |

**N5 and N7 are the two that change behaviour.** Without N5 the graph would gain `file` nodes for a
developer's unrelated repositories; without N7 a refused edit would be recorded as a change that
never happened.

## Determinations the spec leaves open

### E1 — Only a tool that changed a file produces an edge

`Read` and `Grep` carry `file_path` too (N3) and are not changes. The producer takes an explicit
**allowlist** of mutating tool names (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) rather than
"any tool with a path", so a new read-only tool cannot silently start claiming changes. An
unrecognised tool name is counted, not guessed at.

### E2 — A failed tool call is not a change

N7 shows `is_error: true` occurs. An observation is emitted only when the paired `tool_result` is
present and not an error. A `tool_use` with **no** result — the transcript was cut mid-turn — is
counted as `skippedUnresolved` rather than assumed either way, because assuming success would
invent evidence and assuming failure would lose it.

### E3 — The file must belong to a registered project

N5: 16 of 140 mutating paths are outside this project. An edge is written only when the path is
inside a registered project's `canonicalPath`, and the `projectId` comes from that match. A path
outside every project is counted as `skippedOutsideProject`. This also gives the `file` node the
project-scoped identity ADR 0012 established, rather than a machine-global one.

### E4 — Attribution reuses B1's function unchanged

`attributeObservation` already decides containment and the four unbound outcomes. B2 calls it with
its own observations and adds no policy. If B2 seems to need a new attribution rule, the design is
wrong.

### E5 — The edge is per (session, file), not per tool call

A session editing one file forty times is one relationship, not forty. The projection deduplicates
on the edge identity the graph already derives from endpoints and kind, and carries the observation
count and the last `observedAt` as bounded metadata. This keeps edge cardinality proportional to
work done rather than to keystrokes.

### E6 — Its own cursor namespace, and its own counters

The usage scan and the file scan read the same files but answer different questions, and a change to
one must not silently skip the other. They share one directory walk and one parse, and each keeps
its own counters in the summary. **One scan, two extractions** — re-reading every transcript twice
would double an already-bounded cost for nothing.

### E7 — Ingestion stays idempotent by construction

B1 leans on `usage_ingest` refusing a duplicate `sourceEventId`. Graph edges have no such guard, so
B2's projection must be **write-idempotent on its own**: projecting the same observation twice
produces the same edge with the same identity, never a second one. This is asserted directly rather
than assumed from the dedupe of a neighbouring domain.

## File structure

```text
packages/adapters/src/transcript-reader.ts        second extraction pass, shared walk
packages/adapters/src/transcript-reader.test.ts   file-observation cases
packages/adapters/src/types.ts                    TranscriptFileObservation, summary counters
packages/adapters/src/index.ts                    exports
apps/daemon/src/transcript-ingest-service.ts      attribute + project file observations
apps/daemon/src/transcript-ingest-service.test.ts driver cases
apps/daemon/src/intelligence-service.ts           SESSION_CHANGED_FILE projection entry point
apps/daemon/src/intelligence-service.test.ts      projection cases
docs/decisions/0023-native-transcript-ingestion.md  status line only
```

`packages/protocol` is expected to need **no change**: both the edge kind and the `file` node kind
already exist. If a schema change turns out to be required, stop and record why before making it —
that would mean B2 is adding a kind after all, which this plan forbids.

## Task 1: The reader's second extraction

**Files:** `packages/adapters/src/types.ts`, `packages/adapters/src/transcript-reader.ts`,
`packages/adapters/src/transcript-reader.test.ts`

- [ ] Add `TranscriptFileObservation`: `nativeSessionId`, `toolName`, `absolutePath`, `observedAt`,
      and nothing else. No tool input payload, ever.
- [ ] Extend `TranscriptScanResult` with `fileObservations` plus its own counters:
      `fileChangesObserved`, `skippedUnresolved`, `skippedUnknownTool`.
- [ ] In the existing per-line parse, walk `message.content` for `tool_use` blocks; record
      `tool_result` blocks by `tool_use_id` so E2 can pair them within the file.
- [ ] Emit an observation only for an allowlisted mutating tool (E1) whose paired result exists and
      is not an error (E2). Read `file_path`, falling back to `notebook_path` (N2). Count an
      unresolved pair and an unrecognised tool separately.
- [ ] Tests, all against synthesised fixtures: an `Edit` with a successful result emits one
      observation; a `Read` with a path emits **none**; an `Edit` whose result carries
      `is_error: true` emits none and is not counted as a change; a `tool_use` with no result counts
      `skippedUnresolved`; `NotebookEdit` is read from `notebook_path`; the observation carries no
      field from the tool's input other than the path — assert with
      `expect(JSON.stringify(result)).not.toContain('<fixture prose>')`.
- [ ] Test that the walk is still **one pass**: a scan producing both usage and file observations
      calls `readLines` once per file (E6).

## Task 2: Project scoping

**Files:** `apps/daemon/src/transcript-ingest-service.ts`,
`apps/daemon/src/transcript-ingest-service.test.ts`

- [ ] Resolve each observation's absolute path against the registered projects' `canonicalPath`,
      longest match wins, and derive the project-relative path from it (E3).
- [ ] A path inside no project counts `skippedOutsideProject` and produces nothing.
- [ ] Compare case-insensitively on Windows and normalise separators, because transcripts carry
      backslashes while `canonicalPath` is stored with forward slashes — the same normalisation the
      lease domain already applies to project-relative paths. Reuse it rather than writing a second
      one.
- [ ] Tests: a path under the project resolves with the right `projectId` and relative path; a path
      under an unrelated absolute root counts `skippedOutsideProject`; a path differing only in
      drive-letter case still matches.

## Task 3: Attribution and the summary

**Files:** `apps/daemon/src/transcript-ingest-service.ts`,
`apps/daemon/src/transcript-ingest-service.test.ts`

- [ ] Attribute each file observation with `attributeObservation`, unchanged (E4), against the same
      binding lookup and `findNativeLinkAt` the usage path already uses.
- [ ] Extend the summary with `fileChangesObserved`, `fileEdgesProjected`, `skippedOutsideProject`,
      `skippedUnresolved`, `skippedUnknownTool`, and file-specific unbound counters that mirror the
      four usage ones. Counters only — no path and no identifier reaches the log (§4).
- [ ] Tests: an observation inside the interval projects; one outside it counts and projects
      nothing; a session that cannot be read counts `skippedSessionMissing`; the summary carries no
      path — assert the serialized summary does not contain the fixture path.

## Task 4: The projection

**Files:** `apps/daemon/src/intelligence-service.ts`, `apps/daemon/src/intelligence-service.test.ts`

- [ ] Add the entry point that turns attributed file observations into `SESSION_CHANGED_FILE` edges
      between the existing `session` and `file` node kinds, with a provenance that names the
      transcript observer so it is distinguishable from event-derived and structural edges.
- [ ] Deduplicate per (session, file) (E5), carrying `changeCount` and the latest `observedAt` as
      bounded metadata. Do not carry the tool name list unbounded — cap it, and say so.
- [ ] Ensure the `file` node exists with the project-scoped identity ADR 0012 uses, so a file the
      structural layer already projected is the **same** node rather than a second one. This is the
      single most likely defect in this task; assert it directly.
- [ ] Route the projection through the same deferred seam the other mutations now use, so a scan
      never holds a request or a timer tick open.
- [ ] Tests: an observation produces one edge; projecting the same observation twice produces one
      edge, not two (E7); a file already projected by the code-structure layer gains the edge on the
      existing node rather than a duplicate; the edge kind is `SESSION_CHANGED_FILE` and no new kind
      appears in the enum — assert against `graphEdgeKindSchema.options` so a new kind fails the
      test.

## Task 5: Integration coverage

**Files:** `packages/redis/src/intelligence-repository.integration.test.ts`

- [ ] Redis integration test through `/redis-it`, never against `db0`: projecting a
      `SESSION_CHANGED_FILE` edge writes the edge hash and both adjacency indexes, and projecting it
      again leaves the counts unchanged.
- [ ] Assert the graph summary counts the new edge kind, so the dashboard's existing per-kind counts
      pick it up with no dashboard change.

## Task 6: Documentation

**Files:** `README.md`, `AGENTS.md` §21, `CLAUDE.md`,
`docs/decisions/0023-native-transcript-ingestion.md`,
`docs/superpowers/specs/2026-08-14-native-transcript-ingestion-design.md`

- [ ] Record B2 as built and `SESSION_CHANGED_FILE` as having a producer at last. State plainly what
      it does **not** claim: LUWI observed a tool call in a transcript, which is not the same as
      observing the filesystem, and a session that never declares still contributes nothing.
- [ ] Update the spec's §6 to match what was built, the way §3 was corrected in B1, rather than
      leaving prose that no longer describes the code.
- [ ] `CLAUDE.md`: the measurements above, so the next reader does not re-derive them.

## Task 7: Full verification

- [ ] `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`
- [ ] `/redis-it` for the integration leg.
- [ ] Exercise it live on the fixture the way B1 was closed: synthesised transcripts, a real
      interval, and a reported summary. **Do not tick this item without the numbers.**
- [ ] Report per §19, including how many observations stayed unbound and how many paths fell outside
      every project.

## Regression coverage map

| Risk                                                  | Covered by                                |
| ----------------------------------------------------- | ----------------------------------------- |
| A `Read` recorded as a file change                    | Task 1 read-only-tool test (N3, E1)       |
| A failed edit recorded as a change                    | Task 1 `is_error` test (N7, E2)           |
| A cut-off transcript silently assumed successful      | Task 1 `skippedUnresolved` test (E2)      |
| A developer's unrelated repository entering the graph | Task 2 outside-project test (N5, E3)      |
| Tool input prose reaching Redis or the log            | Task 1 + Task 3 serialization assertions  |
| Edge cardinality growing per keystroke                | Task 4 dedupe test (E5)                   |
| A second `file` node beside the structural layer's    | Task 4 shared-identity assertion          |
| A re-scan doubling the edges                          | Task 4 + Task 5 idempotence tests (E7)    |
| A new edge or node kind sneaking in                   | Task 4 enum assertion                     |
| Attribution policy quietly forked from B1             | Task 3 reuses `attributeObservation` (E4) |
| The scan reading every transcript twice               | Task 1 one-pass test (E6)                 |
