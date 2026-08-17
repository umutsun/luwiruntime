# ADR 0024: Session self-registration and capability observation

Status: Accepted  
Date: 2026-08-17

## Context

The product promise in `AGENTS.md` §1 is "see every project, coordinate every agent, ship without
collisions". Measured on this machine on 2026-08-17, the first clause is answered and the second is
not: eleven real projects are registered and scanned, while **nine `claude.exe` processes, one
`codex.exe` and two Codex helpers were running with none of them visible to the runtime**.

The gap is not a defect in Pulse. The event stream is live and was observed carrying real
`package.inventory.updated` events from the owner's own repositories while this was investigated.
The gap is that **nothing registers those sessions**. The working database holds nine session
records and **zero presence keys**; the fixture holds ninety-six and zero. Every one of them is
`disconnected`, which is the honest state for a session that registered once and never heartbeat
again.

ADR 0022 and ADR 0023 built the identity and attribution machinery that a live session would feed:
a `NativeSessionBinding` per vendor session, an immutable `NativeSessionLink` over
`[linkedAt, unlinkedAt)`, and a transcript reader that attributes token usage into those intervals.
B1 closed with live evidence. But all of it only answers for sessions that **declare**, and today the
only things that ever declare are the CLI's `session register`, `session simulate` and the seed.

Two facts make this buildable now rather than speculative.

**A Claude session already carries its own identity.** `CLAUDE_CODE_SESSION_ID` is present in the
environment of a running session — verified directly, not inferred — and is byte-identical to the
transcript stem that ADR 0023's reader joins on. `CLAUDECODE=1` and `CLAUDE_PID` sit beside it, and
`CLAUDE_CODE_CHILD_SESSION=1` marks a subagent. So registration requires no discovery, no process
inspection and no guessing.

**The other two vendors do not.** Codex keeps sessions at
`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl` (119 files) and Gemini at
`~/.gemini/history/<project>/` (29 files). Their identity lives in a file layout rather than an
environment variable, and the layouts differ from each other and from Claude's.

Separately, the capability catalogue is nearly empty against reality: **seventeen skills exist in
`~/.claude/skills` and one in this project's `.claude/skills`, while the runtime knows three
capability records — all seeded, none scanned from disk.** "Which skills does this agent actually
carry, and what do they cost?" is therefore unanswerable, which is the evidence the optimization
domain needs before it can propose anything.

## Decision

### Session self-registration is approved as scope; the standing deferrals are not

`AGENTS.md` §21 forbids beginning unapproved work and states that shipping one phase does not
authorize the rest. This ADR approves session self-registration and capability observation. Autostart
— the next item in the sequence — remains unapproved, as do automatic drift reconciliation,
lifecycle/release scoring, task orchestration, a semantic knowledge graph, memory federation, GitHub
integration, prompt injection, automatic optimization apply, cloud accounts, authentication and
remote control-plane work.

### The session registers itself; LUWI never discovers it

The runtime does not scan for processes and create sessions for what it finds. A process list cannot
say which project a session is working on, and a session the runtime invented could never be closed
honestly — it would linger until presence expiry and report a lapse that never happened. LUWI keeps
answering only for clients that speak to it, which is also what keeps §3's boundary intact: LUWI
coordinates execution and does not inject into terminals.

This is a **client-side bootstrap plus the existing daemon surface**, not an agent supervisor.
`POST /api/v1/sessions` already accepts everything registration needs, including ADR 0022's optional
`native` block, so no protocol change is expected.

### Identity resolution is per vendor, and an unresolved identity registers without one

Registration, heartbeat, terminal close and failure handling are identical across vendors; only the
source of identity differs. Each vendor contributes a resolver that returns a native reference or
nothing. **A vendor whose identity cannot be resolved registers without a `native` block rather than
fabricating one.** A wrong binding is worse than no binding: it would attribute one session's tokens
to another, and ADR 0022's whole design rests on a binding meaning what it says.

Claude resolves from the environment today. Codex and Gemini resolve to nothing until their file
layouts are measured the way ADR 0023 measured Claude's — which is a later increment, not a guess
made now.

### A lapsed heartbeat is terminal, so the bootstrap owns the heartbeat

Presence TTL is 15 seconds and `disconnected` has **no transition out**. A session that misses its
beats is dead permanently, so the heartbeat cannot be left to the caller to remember. The bootstrap
owns an interval well inside the TTL and retries a failed beat rather than abandoning the session.

A clean exit closes the session. A crash cannot, so presence expiry is the backstop and the session
goes `disconnected` — which is the honest outcome. The bootstrap does not try to outlive its own
process.

### LUWI must never become a precondition for the developer's tools

An agent starts whether or not the runtime is running. A failed registration is logged once and the
session continues **without** LUWI. A coordinator that can prevent the tools it coordinates from
starting has inverted its own relationship to them.

### Capability observation is a scan of declared roots, and it executes nothing

The capability catalogue and the context scan already exist; what is missing is that nothing points
them at the developer's real skill directories. This phase adds declared roots to scan, marks what it
finds as **observed** rather than declared so a scanned skill stays distinguishable from a registered
one, and executes nothing it discovers — no skill, hook, plugin, script or MCP definition, per §12
and §18.

### This phase delivers optimisation evidence, not optimisation

It answers which skills are assigned, which were actually loaded, and what they cost in context. It
does **not** prune anything. ADR 0010's rule stands and automatic optimization apply is on §21's
prohibited list; turning this evidence into a proposal belongs to the existing optimization domain,
and a proposal still travels the Phase 3 approve/snapshot/apply path.

## Consequences

A running Claude Code session becomes visible in Pulse for the first time, and the identity it
declares is the one ADR 0023's reader already joins on — so its token usage attributes to it without
any further work. A Codex or Gemini session can register and be seen, but contributes no native
binding until its layout is measured, and its transcript usage therefore stays unattributed. That is
a bounded, stated limitation rather than a silent one.

Sessions that never run the bootstrap stay invisible. The runtime does not claim to see every agent;
it claims to see every agent that registers, which is what it can honestly observe.

The capability catalogue stops being a seeded fixture and starts describing the machine. Nothing is
executed to achieve that, and the observed/declared distinction means a scan cannot quietly
overwrite what the owner registered.

The measurements above are specific to this machine and these vendor versions. They are recorded with
their numbers so that a layout change surfaces as a failed expectation rather than as sessions that
silently stop registering — the same discipline ADR 0023 adopted after one survey reached a
conclusion a second had to correct.
