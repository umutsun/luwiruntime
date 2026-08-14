# ADR 0023: Native transcript ingestion

Status: Accepted  
Date: 2026-08-14

## Context

ADR 0022 built native session identity and stopped exactly where attribution begins. It records a
`NativeSessionBinding` per vendor-native session and an immutable `NativeSessionLink` over
`[linkedAt, unlinkedAt)` for every LUWI session that identity produced, and it says plainly what it
did not solve: `usage.sessionId` is unattributed, transcript ingestion has not begun, and a record
inside a trimmed interval stays unbound rather than being assigned to the nearest session.

**Nothing uses the mechanism.** Both Redis databases hold **zero** native bindings — against nine
sessions in the working database — because a declaration rides only on `POST /api/v1/sessions`, and
nothing that registers a session sends one. Neither the CLI's `session register`, nor
`session simulate`, nor the seed script declares a native reference. An already-registered session
has no way to declare at all. So every transcript record on this machine falls outside every
interval, not because attribution is hard, but because no interval has ever existed.

That single fact orders the phase. A reader built first would parse thousands of records and
attribute none of them.

The native transcript layout was measured rather than assumed, over two surveys. The second
corrected the first on one point and refined it on another; both corrections are load-bearing and
are recorded in the design document with their numbers.

**Subagent transcripts exist and carry real tokens.** The first survey concluded no `subagents/`
directory existed on this machine. It does: 71 of them, the oldest dating from 2026-06-18, nested at
`<sessionId>/subagents/workflows/<workflowId>/agent-<id>.jsonl`. In this project's directory 24 of 33
transcript files are of that shape and they hold **11.3% of distinct requests**. A reader that walks
only the top level of a project directory silently loses a ninth of the evidence.

**Usage is per request, not per record, and the repeats are not always identical.** One `requestId`
spans several `assistant` records; summing per record over-counts by **1.88×**. The first survey saw
the usage object repeat identically across a request and concluded it always does. Over a larger
sample it does not: of 1961 requests spanning more than one record, **362 carry differing usage**. So
deduplication cannot assume the duplicates agree, and must state which one wins.

**The single cached-token field is structurally unable to carry Claude's counters.** The schema
enforces `cachedInputTokens <= inputTokens`, a subset invariant, while Claude's model is additive — a
real record carries `input_tokens: 2` with `cache_read_input_tokens: 23020`. The conflict is not
precision loss, it is a contradiction.

## Decision

### Ingestion is approved as scope; the three prior deferrals are not

`AGENTS.md` §21 forbids beginning unapproved work and states that shipping one phase does not
authorize the rest. This ADR approves native transcript ingestion and nothing else. `config/reconcile`,
lifecycle scoring, task orchestration, a semantic knowledge graph, memory federation, GitHub
integration, prompt injection, cloud accounts, authentication and remote control-plane work remain
out of scope, as do automatic lease renewal and autostart — the two items that follow ingestion in
the sequence.

### B0 is a declaration surface, not a reader

Because no binding exists, the first increment gives an **already-registered, live** session a way to
declare its native identity, creating the binding and the open link that everything downstream joins
on. This is deliberately not new policy: `evaluateNativeDeclaration` already decides the six
outcomes, and its `unchanged` result was written for exactly this surface. B0 adds a route and a
Function that reuses that policy, and no more.

### B1 attributes usage; B2 observes tools and files

**B1** reads transcripts and writes usage records. **B2** turns tool and file activity into graph
edges, filling `SESSION_CHANGED_FILE` — which exists in the edge enum today with no producer
anywhere — so B2 adds no new node or edge kind, exactly as ADR 0012 did.

### The join key is the record's `sessionId`, never the filename

The filename stem equals the session id for top-level transcripts and never for subagent ones, whose
stem is an agent id. The reader treats the in-record `sessionId` as authoritative and the filename as
nothing at all. A record without a `sessionId` is skipped, which is correct for the transcript
bookkeeping types that never carry one. A file's position in the tree, `isSidechain`, and the sibling
`.meta.json` are attributes of the work, never identity — so a subagent's tokens belong to the
session that spawned it rather than to an invented one.

### A request is the unit, and a duplicate is resolved explicitly

Usage is recorded once per `requestId`, never once per record. Where the records of one request
disagree, the resolution rule is stated in the design and tested; it is not left to whichever record
happens to be read last. `usage_ingest` already refuses a duplicate `sourceEventId` and writes
nothing, so re-reading a whole transcript is safe by construction rather than by careful bookkeeping,
and the per-file cursor exists only to skip unchanged files — never for correctness.

### The two cache counters are added; the existing fields are left alone

The usage record gains `cacheCreationInputTokens` and `cacheReadInputTokens`. `cachedInputTokens`
keeps its meaning and its subset invariant, and nothing folds a Claude counter into it. `totalTokens`
is left unset, because the validator forces it to input + output, which would exclude cache tokens
and mislead precisely where the new fields exist to be honest.

### Attribution is interval containment, and unbound is a real outcome

ADR 0022 already decided the hard cases and this ADR does not reopen them: a record outside every
interval, or inside one that link retention has trimmed, **stays unbound and is never assigned to the
nearest session**. Unbound records are counted and reportable, so the dashboard can show how much
evidence no session can claim.

### The observer reads, and executes nothing

Per §12 and §18 nothing discovered is executed — not a transcript, not a `.meta.json`, not a workflow
script found beside one. Only counters and identifiers are stored. **No prompt or response text is
ever stored or logged**, and §4's logging bans cover everything read. Repository fixtures are
synthesised, never copied from a real transcript.

## Consequences

`usage.sessionId` becomes answerable for Claude Code, and only for the sessions that declare. A
session that never declares stays unattributed, which is the honest outcome and not a bug. No claim
is made about Codex, Gemini CLI or Kimi, whose native layouts were not measured.

The product claim stays bounded as ADR 0022 bounded it: LUWI reports operations it observed in the
native transcript. Ingesting a subagent's tokens does not make LUWI an observer of every agentic
operation.

Reading the developer's transcripts widens what the runtime touches even though it stays loopback-only
and read-only, which is why the no-content rule above is a decision and not an implementation detail.

The measurements are specific to this machine and this version of Claude Code. They are recorded with
their numbers so that a layout change shows up as a failed expectation rather than as silently
missing usage — and because one survey already reached a wrong conclusion that a second corrected.
