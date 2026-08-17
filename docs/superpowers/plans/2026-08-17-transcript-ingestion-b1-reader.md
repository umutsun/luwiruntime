# Transcript ingestion — the reader and usage attribution (B1) — implementation plan

> **For agentic workers:** this plan is executed inline in the session that adopts it. Steps use
> checkbox (`- [ ]`) syntax for tracking. **There are no commit steps** — per `AGENTS.md` §13 the
> owner commits only when they explicitly ask.

**Goal:** Read Claude Code's native transcripts, attribute each request's token usage to the LUWI
session that held the native session at the moment the request was observed, and write one usage
record per `requestId`. B0 made a binding and an interval exist; B1 is what finally makes
`usage.sessionId` answerable.

**Architecture:** A pure, on-demand reader in `@luwi/adapters` walks the transcript tree and returns
parsed request-level observations. A pure attribution function in `@luwi/runtime` maps an observation
to a session by half-open interval containment. The daemon owns the timer, the filesystem root, and
the ingest calls. A new repository read answers "which session held this binding at time T" by
scoring against the links zset that already exists.

**Tech Stack:** TypeScript strict ESM, Zod, Redis Functions (Lua 5.1 under Redis 7), Vitest.

## Global constraints

From `docs/superpowers/specs/2026-08-14-native-transcript-ingestion-design.md` §3–§5, ADR 0023,
ADR 0022 and `AGENTS.md`. Every task inherits these.

- **No conversation content is ever stored or logged** — only counters and identifiers (§4, §7).
  `boundedMetadataSchema` already rejects keys like `prompt` and `response`; that is a backstop, not
  a licence to get close to the line.
- **Nothing discovered is executed** — not a transcript, not a `.meta.json`, not a workflow script
  found beside one (§12, §18).
- **The join key is the in-record `sessionId`, never the filename** (M11). A record without one is
  skipped and counted.
- **A record outside every interval stays unbound** and is never assigned to the nearest session
  (ADR 0022, ADR 0023). Unbound counts are reported, never silently dropped.
- **Usage is per `requestId`, not per record** (M3). `iterations` is never summed (§4).
- **Repository fixtures are synthesised, never copied** from a real transcript (§7).
- `@luwi/protocol` and `@luwi/runtime` must never import `redis`; `@luwi/mcp-server` must never
  import `@luwi/redis`. `@luwi/adapters` must not import `@luwi/redis`.
- Redis data is untrusted input; so is a transcript file. Validate on read (§7, §14).

## Determinations the spec leaves open

### D1 — `luwi_v1` goes to **v12**

The registry's own rule (`packages/redis/src/function-registry.ts:3-8`): the version moves only when
a **stored record shape** changes; a new Function alone forces a reload through the source hash. B0
added a Function and correctly stayed at 11. B1 adds two fields to the stored usage record, which is
exactly a record-shape change, so **v11 → v12**. The comment at that site is rewritten to say so.

### D2 — A new `AdapterTranscriptReader` seam, not two more methods on `AdapterFileSystem`

The spec says `AdapterFileSystem` gains `listDirectory` and `stat` "only". Taken literally that
widens the interface every adapter and both daemon config services must satisfy
(`config-control-service.ts:58`, `control-plane-service.ts:70`, plus `MemoryFileSystem` in tests) for
a capability none of them use. Instead B1 declares a **separate, narrow interface** with exactly
those two operations plus the line reader, defaulted to a Node implementation the way
`createGitObserver` defaults its `runner` (`git-observer.ts:314-327`). This honours the spec's intent
— two read operations, no offset read — without making four unrelated call sites carry them. The
spec's §3 wording is corrected in Task 8 rather than silently diverged from.

### D3 — A duplicate is a normal outcome, not an error

`intelligence-service.ts` converts the Function's `duplicate` status into a **409
`USAGE_RECORD_DUPLICATE` throw**. Re-reading a transcript is the steady state, not an exception, so
the reader's daemon-side driver calls the repository-backed service and treats that code as a
counted `skippedDuplicate`. Any other error escapes.

### D4 — Attribution is by `observedAt`, and the timestamp comes from the winning record

A request's records may straddle an interval boundary. The observation's timestamp is the one on the
record that wins the §4 disagreement rule, so attribution and counters describe the same record
rather than two different ones.

### D5 — `projectId` and `agentId` come from the session, never from the transcript

`ingestUsage` refuses unless `session.projectId` and `session.agentId` match the request
(`intelligence-service.ts:1135-1146`). The transcript knows neither. Once attribution names a
session, its own record supplies both — which also means a session that no longer exists yields an
unbound observation rather than a guess.

This is a **fourth** unbound case, distinct from Task 3's three: attribution succeeded and the
session then could not be read. It is counted as `skippedSessionMissing` rather than folded into one
of the others, because a link pointing at a session that is gone is an inconsistency worth seeing,
not the ordinary "no interval covered this" outcome.

### D6 — The transcript root is enumerated, not derived from a project path

Nothing in the repo encodes a project path into a `.claude/projects` directory name, and deriving one
is measurably fragile: on this machine the same encoding appears with both a capital and a lowercase
drive letter (`C--xampp-arsha-worktrees-ops` beside `c--xampp-htdocs-luwiruntime`), and worktree
paths produce doubled separators (`...-flybydeniz--claude-worktrees-...`). So the reader **lists the
projects root and treats every subdirectory as a candidate**, joining on the in-record `sessionId`
exactly as M11 requires. This costs nothing — the join key was never the path — and it removes an
encoding guess that would silently read zero files when it got the case wrong.

### D7 — The reader is bounded, and what it drops it says

Per-file byte cap, per-scan file cap, and a per-file malformed-line cap, each with a default and each
reported. A reader that silently stops at a limit misrepresents how complete the ingestion was —
the same rule the spec applies to unbound records.

## File structure

```text
packages/protocol/src/intelligence.ts                     +2 usage fields, +2 composition fields
packages/protocol/src/native-session.ts                   the point-in-time link query result
packages/adapters/src/transcript-reader.ts                the walker and parser (new)
packages/adapters/src/transcript-reader.test.ts           (new)
packages/adapters/src/node-collaborators.ts               NodeTranscriptFileSystem
packages/adapters/src/types.ts                            TranscriptFileSystem, observation types
packages/adapters/src/index.ts                            exports
packages/runtime/src/native-attribution.ts                interval containment (new)
packages/runtime/src/native-attribution.test.ts           (new)
packages/runtime/src/usage-intelligence.ts                the two new summable fields
packages/redis/src/redis-keys.ts                          no change — the zset already exists
packages/redis/src/runtime-repository.ts                  findNativeLinkAt
packages/redis/src/intelligence-repository.ts             numericDeltas gains the two fields
packages/redis/src/function-registry.ts                   version 11 -> 12, D1 note
packages/redis/src/runtime-repository.integration.test.ts point-in-time coverage
apps/daemon/src/config.ts                                 LUWI_TRANSCRIPT_SCAN_INTERVAL_MS etc.
apps/daemon/src/transcript-ingest-service.ts              the driver (new)
apps/daemon/src/transcript-ingest-service.test.ts         (new)
apps/daemon/src/runtime.ts                                the sixth timer + both teardown paths
```

## Task 1: The protocol change

**Files:** `packages/protocol/src/intelligence.ts`, `packages/protocol/src/intelligence.test.ts`

- [x] Add `cacheCreationInputTokens` and `cacheReadInputTokens` to `usageFields`, both
      `tokenValueSchema.optional()`.
- [x] Add both to `usageSourceCompositionSchema` so a composition can report them.
- [x] **Leave `cachedInputTokens` and its `<= inputTokens` invariant untouched**, and add no new
      invariant tying the cache counters to `inputTokens` — Claude's model is additive (M5) and an
      invariant would re-import the contradiction the new fields exist to escape.
- [x] Tests: a record carrying `inputTokens: 2` with `cacheReadInputTokens: 23020` parses (the real
      shape from M5); the two new fields are optional; `cachedInputTokens > inputTokens` still fails.

## Task 2: The point-in-time link query

**Files:** `packages/redis/src/runtime-repository.ts`, `packages/protocol/src/native-session.ts`,
`packages/redis/src/runtime-repository.test.ts`

The links zset is already scored by `linkedAt` in epoch milliseconds
(`function-library.ts:136`), so containment needs a read, not a new index.

- [x] Add `findNativeLinkAt(bindingId: string, atMs: number): Promise<NativeSessionLink | null>`:
      `ZRANGE <links> <atMs> -inf BYSCORE REV LIMIT 0 1` to get the greatest `linkedAt <= atMs`, then
      `HGETALL` the link and return it only when `unlinkedAt` is absent or `> at`.
- [x] A member whose hash is gone returns `null` — follow `listOldestNativeLinks`'s precedent of not
      guessing at a record the caller cannot declare.
- [x] Tests: a timestamp inside a closed interval resolves; the instant of `unlinkedAt` does **not**
      (half-open `[linkedAt, unlinkedAt)`); a timestamp before the first link returns `null`; an open
      link matches any timestamp at or after its `linkedAt`.

## Task 3: The attribution function

**Files:** `packages/runtime/src/native-attribution.ts`, `packages/runtime/src/native-attribution.test.ts`

Pure, no Redis, mirroring how `evaluateNativeDeclaration` isolates policy.

- [x] `attributeObservation({ observedAt, binding, link })` returning
      `{ outcome: 'bound'; sessionId } | { outcome: 'unbound'; reason: 'no-binding' | 'outside-interval' | 'trimmed' }`.
- [x] `trimmed` is distinguished from `outside-interval` when the binding's
      `oldestRetainedLinkedAt` is later than the observation — evidence lost to retention is a
      different fact from evidence that never had an interval, and ADR 0023 asks for both counts.
- [x] Tests: containment at both edges; a timestamp before `oldestRetainedLinkedAt` reports
      `trimmed`; no binding reports `no-binding`; **no case returns a nearest-session fallback** —
      assert it explicitly, because that is the invariant most likely to be "helpfully" broken later.

## Task 4: The transcript reader

**Files:** `packages/adapters/src/types.ts`, `packages/adapters/src/transcript-reader.ts`,
`packages/adapters/src/node-collaborators.ts`, `packages/adapters/src/index.ts`,
`packages/adapters/src/transcript-reader.test.ts`

- [x] Declare `TranscriptFileSystem` with `listDirectory(path)`, `stat(path)` and a line-reading
      `readLines(path, maxBytes)` (D2). Add `NodeTranscriptFileSystem` beside
      `NodeAdapterFileSystem`, returning `undefined` for `ENOENT`/`EACCES` and rethrowing the rest,
      matching the existing convention exactly.
- [x] `createTranscriptReader({ fileSystem?, maxFileBytes?, maxFilesPerScan?, maxMalformedLinesPerFile? })`
      following `createGitObserver`'s options shape.
- [x] List the projects root and walk **every** subdirectory (D6) — no path-to-directory-name
      encoding is derived, because the case of the drive letter varies on this machine and a wrong
      guess reads zero files while looking like a clean scan.
- [x] Walk each project directory **recursively**, including the nested
      `<sessionId>/subagents/workflows/<workflowId>/agent-<id>.jsonl` tree (M9) — a top-level-only
      walk loses 11.3% of requests (M10). Every `.jsonl` is a candidate regardless of name (M11).
- [x] Parse line by line, tolerantly: a malformed line is skipped and counted, never fails the file,
      because a transcript being appended to while it is read presents a partial final line.
- [x] Skip a record with no `sessionId` (measured: `file-history-delta`, `file-history-snapshot`,
      `started`, `result` carry none) and a `<synthetic>` model record (M12, all counters zero).
- [x] Group by `requestId` and emit **one observation per request** carrying `nativeSessionId` (the
      in-record `sessionId`), `requestId`, `model`, `observedAt`, and the four token counters.
- [x] Apply the §4 disagreement rule: **greatest `output_tokens` wins; ties resolve to the last
      record in file order** — and take `observedAt` from that same winning record (D4). Never sum
      `iterations`.
- [x] Per-file cursor is `mtime + size`, used **only** to skip unchanged files; correctness comes
      from the ingest dedupe (M6), never from the cursor.
- [x] Tests, all against synthesised fixtures (§7): a subagent file's tokens attribute to the
      in-record `sessionId`, not the `agent-<id>` filename stem; a request spanning three records
      with differing `output_tokens` yields one observation carrying the greatest; a malformed final
      line is counted and the rest of the file still parses; `<synthetic>` and `sessionId`-less
      records are skipped; two consecutive scans of an unchanged file do the same work twice with the
      same result (determinism, the house habit); **the reader never invokes a command runner** —
      assert with `expect(run).not.toHaveBeenCalled()`, the existing no-execution proof.

## Task 5: The daemon driver

**Files:** `apps/daemon/src/transcript-ingest-service.ts`,
`apps/daemon/src/transcript-ingest-service.test.ts`, `apps/daemon/src/config.ts`

- [x] Add `LUWI_TRANSCRIPT_SCAN_INTERVAL_MS` (`z.coerce.number().int().min(60_000).max(86_400_000).default(300_000)`)
      next to `LUWI_GIT_SCAN_INTERVAL_MS`, plus the bound defaults from D7, mapped to camelCase
      config fields the same way.
- [x] The transcript root resolves from `nativeHome ?? homedir()` — the same conditional-injection
      pattern as `control-plane-service.ts:220`, so a fixture run stays isolated.
- [x] For each observation: derive the binding id with `deriveNativeBindingId`, read the binding,
      call `findNativeLinkAt`, run `attributeObservation`; on `bound`, load the session and build the
      ingest request with **`projectId`/`agentId` from the session** (D5).
- [x] Map counters: `inputTokens` ← `input_tokens`, `outputTokens` ← `output_tokens`,
      `cacheCreationInputTokens`, `cacheReadInputTokens`. **Leave `cachedInputTokens` unset and
      `totalTokens` unset** (§5) — that is what keeps both existing invariants from ever firing.
- [x] `source: 'adapter-extracted'`, `confidence: 'reported'` (M7) — the only pair the validator
      accepts for an adapter that parsed a file rather than being told.
- [x] `sourceEventId = <adapterId>:<nativeSessionId>:<requestId>`; the repository SHA-256s it before
      keying, so the shape is safe.
- [x] Catch `USAGE_RECORD_DUPLICATE` and count it as `skippedDuplicate` (D3); let everything else
      escape.
- [x] Return and log a summary: `filesScanned`, `filesSkippedUnchanged`, `requestsObserved`,
      `ingested`, `skippedDuplicate`, `skippedNoBinding`, `skippedOutsideInterval`, `skippedTrimmed`,
      `skippedSessionMissing`, `malformedLines`, `filesStoppedMalformedCap`, `truncatedFiles` — no
      identifiers, no content (§4).
      The first three `skipped*` attribution counters correspond one-to-one with Task 3's three
      `reason` values and `skippedSessionMissing` is D5's fourth case, so no catch-all can hide one;
      their sum is the unbound total ADR 0023 asks to be reportable.
- [x] Tests with a fake filesystem and a fake repository: an observation inside the interval ingests
      with the session's project and agent; one outside it counts `skippedOutsideInterval` and
      **ingests nothing**; a duplicate counts and does not throw; a bound session that no longer
      exists counts unbound rather than guessing.

## Task 6: The timer

**Files:** `apps/daemon/src/runtime.ts`

- [x] Add the sixth `setInterval` after the git scan block, using the identical tick pattern:
      re-entrancy boolean, `readiness.state !== 'ready'` gate, `backgroundWork.run` with an
      `onError` logger, `if (!scheduled)` reset, and `.unref?.()`.
- [x] Clear it in **both** teardown paths — the startup-failure catch and `shutdownRuntime` — because
      missing either leaks a timer past shutdown.
- [x] Test: a tick during drain is skipped; a failing tick logs and does not kill the timer.

## Task 7: Redis Function library version and aggregates

**Files:** `packages/redis/src/function-registry.ts`, `packages/redis/src/intelligence-repository.ts`,
`packages/runtime/src/usage-intelligence.ts`, `packages/redis/src/intelligence-repository.integration.test.ts`

- [x] Bump `version: 11` → `12` in both the type and `createFunctionRegistry`, and rewrite the
      comment to record D1's reasoning (a stored record shape changed).
- [x] Add the two fields to `numericDeltas` (`intelligence-repository.ts:298-313`) and `numericFields`
      (`usage-intelligence.ts:41-49`) so aggregates and compositions include them.
- [x] Integration test through `/redis-it`, never against `db0`: ingesting a transcript-shaped record
      with cache counters increments the metric hash by those counters, and a second ingest of the
      same `sourceEventId` returns `duplicate` and writes nothing.

## Task 8: Documentation

**Files:** `README.md`, `AGENTS.md` §21, `CLAUDE.md`,
`docs/superpowers/specs/2026-08-14-native-transcript-ingestion-design.md`

- [x] `README.md`, `AGENTS.md` §21: B1 built, B2 still specified and not started. **`usage.sessionId`
      is now answerable for declaring Claude Code sessions only** — a session that never declares
      stays unattributed, which is the honest outcome and not a bug.
- [x] Correct spec §3's "`AdapterFileSystem` gains `listDirectory` and `stat` only" to describe the
      separate reader seam, with D2's reasoning. A spec that no longer matches the code is a trap for
      the next reader.
- [x] `CLAUDE.md`: the new env var, and `luwi_v1` at v12; add the commit-table row when the owner
      commits.

## Task 9: Full verification

- [x] `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`
- [x] `/redis-it` for the integration leg.
- [ ] Exercise it live against the fixture runtime (`REDIS_URL`, `LUWI_HOME`, `LUWI_NATIVE_HOME`,
      `WORKSPACE_ID=fixture-…` **together**), whose seeded binding holds a real closed interval, and
      report the ingestion summary honestly — including how many observations were unbound.
      Deferred because the fixture seed currently hangs indefinitely at
      `POST /api/v1/context/contributions`; B1's unit and Redis integration legs do not use that
      route, and this unchecked item must not imply a live E2E run happened.
- [x] Report per §19: what ran, what passed, and what is still unattributed.

## Regression coverage map

| Risk                                                       | Covered by                              |
| ---------------------------------------------------------- | --------------------------------------- |
| Subagent tokens lost, or attributed to an invented session | Task 4 subagent test (M9/M10/M11)       |
| Usage over-counted 1.88× by summing records                | Task 4 one-observation-per-request test |
| Duplicate records resolved by iteration order              | Task 4 greatest-`output_tokens` test    |
| An unbound record assigned to the nearest session          | Task 3 explicit no-fallback assertion   |
| The `cachedInputTokens <= inputTokens` invariant firing    | Task 1 + Task 5 leave both fields unset |
| `totalTokens` excluding cache tokens and misleading        | Task 5 leaves it unset (§5)             |
| Re-reading a transcript throwing 409 and aborting a scan   | Task 5 duplicate test (D3)              |
| A stale Function library after a record-shape change       | Task 7 version bump (D1)                |
| Conversation content reaching Redis or the log             | Task 5 summary carries counters only    |
| A silent truncation reading as complete coverage           | Task 5 explicit bound counters          |
| A leaked timer past shutdown                               | Task 6 both-teardown-paths test         |
