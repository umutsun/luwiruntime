# Native transcript ingestion — design

Date: 2026-08-14  
ADR: `docs/decisions/0023-native-transcript-ingestion.md`  
Predecessor: `docs/superpowers/specs/2026-08-11-native-session-binding-design.md` (§15 handoff)

Phase B of the sequence `native identity binding → transcript ingestion → automatic lease renewal
→ autostart`. This document specifies B, and specifies B0 to implementation depth.

## 0. Increment split

| Increment | Scope                                                 | Plan                   |
| --------- | ----------------------------------------------------- | ---------------------- |
| **B0**    | Declaration surface for an already-registered session | built, see §8          |
| **B1**    | Transcript reader, usage attribution                  | built, see §10         |
| **B2**    | Tool and file observation into the operational graph  | written when B2 starts |

The A1/A2 precedent applies: a plan is written at the start of its increment.

**Why B0 is a declaration surface and not a reader** — measurement M2. Zero native bindings exist in
either database. A declaration rides only on `POST /api/v1/sessions`, and nothing that registers a
session sends one, so an already-registered session can never declare. Build the reader first and it
attributes nothing, because there is no interval to attribute into.

## 1. Measurements

Two surveys: 2026-08-13 (8 transcripts, ~11 700 records) and 2026-08-14 (33 files, this project's
tree, walked recursively). The second corrected the first twice. Both corrections change behaviour,
which is why they are recorded rather than quietly merged.

| #   | Measurement                   | Result                                                                                               |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| M1  | `CLAUDE_CODE_SESSION_ID`      | inherited by child processes, byte-identical to the transcript stem — so an MCP child can declare it |
| M2  | **Bindings in Redis**         | **zero in db0 and db15**, against 9 sessions — no interval has ever existed                          |
| M3  | Usage granularity             | per `requestId`, not per record; summing per record over-counts by **1.88×**                         |
| M4  | Duplicate agreement           | 1961 requests span >1 record; **362 of them carry differing usage**                                  |
| M5  | `cachedInputTokens`           | schema enforces `<= inputTokens`; Claude is additive (`input 2`, `cache_read 23020`)                 |
| M6  | `usage_ingest` dedupe         | already refuses a duplicate `sourceEventId` and writes nothing                                       |
| M7  | `source` → `confidence`       | fixed map; `adapter-extracted` → `reported` is the honest pair                                       |
| M8  | `SESSION_CHANGED_FILE`        | in the edge enum, **no producer anywhere** — B2 would be the first                                   |
| M9  | **`subagents/` directories**  | **71 exist**, oldest 2026-06-18, at `<sessionId>/subagents/workflows/<wfId>/agent-<id>.jsonl`        |
| M10 | Subagent share                | 24 of 33 files here; **11.3% of distinct requests** (423 of 3728)                                    |
| M11 | Stem vs in-record `sessionId` | equal for top-level files, **never** for subagent files                                              |
| M12 | `<synthetic>` model           | rare, all counters zero — skipped                                                                    |
| M13 | Scale                         | 24 project directories, 3138 `.jsonl` files; largest transcript 10 MB                                |

**M9 corrects the first survey**, which concluded no `subagents/` directory existed. It looked at the
top level of a project directory rather than walking the tree. M10 prices the error: a top-level-only
reader loses 11.3% of requests, or invents a native session per subagent.

**M4 corrects the first survey**, which saw 38 multi-record requests all agreeing and concluded the
usage object always repeats identically. Over a larger sample 18.5% of multi-record requests
disagree, so §4's resolution rule cannot be "any of them".

## 2. B0 — the declaration surface

A live, non-terminal session declares its native identity after the fact. The route takes the same
`native` block `POST /api/v1/sessions` already accepts and routes it into
`evaluateNativeDeclaration`, which is unchanged: the six outcomes, the refusal of a live holder, the
conflict that writes nothing, and `NATIVE_BINDING_INCONSISTENT` for missing or contradictory
evidence all carry over untouched. `unchanged` was written for this surface and finally has a caller.

The Lua half follows A1's contract exactly: it validates a CAS on the monotonic `version` and derives
no key name, every key arrives paired with the identity it must hold, and a refusal writes nothing.
Unlike registration there is no `XGROUP CREATE` to order against — the inbox stream already exists —
so the ordering constraint that shaped A1 does not apply here.

**Who may declare.** Only for the session named by the caller's own bound identity, never an
arbitrary session id, on the same principle that makes the MCP lease tools take the holder from the
bound session and never from input.

## 3. B1 — the reader (built; plan at §10)

Lives in `@luwi/adapters`, driven by a daemon timer on its own `LUWI_TRANSCRIPT_SCAN_INTERVAL_MS`
(default 300000). The read surface is **a separate `TranscriptFileSystem` interface** carrying
`listDirectory`, `stat` and a bounded `readLines` — no offset read. This corrects what this section
said before it was built ("`AdapterFileSystem` gains `listDirectory` and `stat` only"): widening the
shared interface would have forced every adapter and both daemon config services to satisfy two
operations none of them invoke, for no gain. The intent — two read operations, no byte offsets — is
unchanged; only the interface it lands on is. The per-file cursor is `mtime + size` and exists solely
to skip unchanged files; correctness comes from the dedupe guard of M6, never from the cursor.

Discovery **enumerates the projects root** rather than deriving a directory name from a project path.
Nothing encodes that mapping today, and deriving it is fragile in a measured way: on this machine the
same encoding appears with both a capital and a lowercase drive letter, and worktree paths produce
doubled separators. Since the join key is the in-record `sessionId` (M11), the path was never
identity and enumerating costs nothing. Each project directory is walked recursively, **including its
nested `subagents/` tree** (M9). Every `.jsonl` file is a candidate regardless of name.

Parsing is line-oriented and tolerant per line: a malformed line is skipped and counted, never fails
the file, because a transcript being appended to while it is read presents a partial final line. A
record with no `sessionId` is skipped. `<synthetic>` records are skipped (M12).

## 4. B1 — usage, dedupe and the disagreement rule

One usage record per `requestId` (M3). `sourceEventId = <adapterId>:<nativeSessionId>:<requestId>`,
so `usage_ingest` refuses a repeat and re-reading a whole transcript is safe by construction (M6).

Where the records of one request disagree (M4), **the record with the greatest `output_tokens` wins**,
because output accumulates across a streamed response and the largest is the completed message; ties
resolve to the last record in file order. This is a rule with a test, not an accident of iteration
order. `iterations` is never summed — it repeats the same counters per inference step and adding it
would double-count on top of M3.

`source` is `adapter-extracted` and `confidence` is `reported` (M7). `agent-exact` would claim a
channel LUWI does not have: it parsed a file, it was not told.

## 5. B1 — the protocol change

Add `cacheCreationInputTokens` and `cacheReadInputTokens`. **Leave `cachedInputTokens` untouched**,
including its `<= inputTokens` invariant — the new fields exist precisely because that invariant
contradicts Claude's additive model (M5), so overloading the old field would propagate the
contradiction. **Leave `totalTokens` unset**: the validator forces it to input + output, which would
exclude cache tokens and mislead exactly where honesty is the point.

Existing usage records were written without the distinction and are not retroactively assigned one.
What was never observed stays unobserved — ADR 0017's rule.

## 6. B2 — tool and file observation (specified, not planned)

Fills `SESSION_CHANGED_FILE`, which exists in the edge enum with no producer (M8). B2 adds **no new
node or edge kind**; it fills existing ones with a distinct provenance, as ADR 0012 did. Attribution
follows ADR 0022 unchanged: a record outside every interval, or inside a trimmed one, stays
**unbound** and is never assigned to the nearest session. Unbound counts are reported
(`skippedUnbound`, `skippedOutsideInterval`, `skippedAmbiguous`), never silently dropped — a domain
that hides what it cannot attribute misrepresents how complete it is.

## 7. Non-goals

No autostart, no lease renewal, no MCP self-registration, no control of any agent process, and no
claim about Codex, Gemini CLI or Kimi layouts — none were measured. **No conversation content is ever
stored or logged**; only counters and identifiers. Repository fixtures are synthesised, never copied
from a real transcript. Nothing discovered is executed (§12, §18).

## 8. B0 plan

`docs/superpowers/plans/2026-08-14-transcript-ingestion-b0-declaration.md`.

## 9. Verification

B0 is done under §19 when format, lint, typecheck, test and build pass; the route has tests for each
`evaluateNativeDeclaration` outcome including the live-holder refusal and the conflict that writes
nothing; a Redis integration test proves the CAS refusal leaves no partial write; and a test proves a
caller cannot declare for a session other than its own bound one.

B1 adds: the reader joins on the in-record `sessionId` for a subagent file whose stem is an agent id;
one request spanning records with differing `output_tokens` yields a single observation carrying the
greatest; attribution binds at `linkedAt` and refuses at `unlinkedAt`; an unattributable observation
is counted and **never assigned to the nearest session**; a re-read counts a duplicate instead of
throwing; and the ingested record leaves `cachedInputTokens` and `totalTokens` unset so neither
existing invariant can fire.

## 10. B1 plan

`docs/superpowers/plans/2026-08-17-transcript-ingestion-b1-reader.md`.
