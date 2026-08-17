# Phase C — session self-registration and capability observation — implementation plan

> **For agentic workers:** this plan is executed inline in the session that adopts it. Steps use
> checkbox (`- [ ]`) syntax for tracking. **There are no commit steps** — per `AGENTS.md` §13 the
> owner commits only when they explicitly ask.

**Goal:** Make a running Claude Code, Codex or Gemini CLI session appear in Pulse **by itself**,
and make the skills and capabilities those sessions actually load observable. Today the runtime
holds nine sessions in the real database and **zero of them are live**, while nine `claude.exe`
processes run on this machine — so the product's first promise, "see every project, coordinate every
agent", is answered only for projects.

**Architecture:** A session registers itself at startup from the identity its own process already
carries, heartbeats while it lives, and closes on exit. That is a **client-side bootstrap plus one
daemon surface**, not an agent supervisor: per `AGENTS.md` §3 LUWI coordinates execution and never
injects into terminals. Capability observation reuses the existing control-plane scan; nothing new
is invented to hold it.

**Tech Stack:** TypeScript strict ESM, Zod, Redis Functions (Lua 5.1 under Redis 7), Vitest.

## Why this is a new phase and not a bug fix

`AGENTS.md` §21 forbids beginning unapproved work. The owner approved this scope on 2026-08-17
after seeing the dashboard show no live sessions while many agents were running. It follows B in the
sequence `A native identity → B transcript ingestion → C self-registration → D autostart`, and it
does **not** authorise autostart, process supervision, prompt injection, or anything else on §21's
prohibited list.

## Measurements

Taken 2026-08-17 on this machine, before the design. Recorded so a layout change fails an
expectation instead of silently producing nothing.

| #   | Measurement                   | Result                                                                  |
| --- | ----------------------------- | ----------------------------------------------------------------------- |
| C1  | Live sessions in db0          | **0** presence keys against 9 session records                           |
| C2  | Running agent processes       | **9 `claude.exe`**, 1 `codex.exe`, 2 Codex helpers — none registered    |
| C3  | Claude session identity       | `CLAUDE_CODE_SESSION_ID` **is in the environment**, equals the          |
|     |                               | transcript stem; `CLAUDECODE=1` and `CLAUDE_PID` are there too          |
| C4  | Codex session layout          | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, **119 files** |
| C5  | Gemini session layout         | `~/.gemini/history/<project>/`, **29 files** — a different shape again  |
| C6  | Skills on disk                | **17 global** (`~/.claude/skills`) + 1 project (`.claude/skills`)       |
| C7  | Capabilities LUWI knows       | **3** (1 plugin, 1 skill, 1 mcp) — all seeded, none scanned from disk   |
| C8  | Presence TTL                  | 15 s (`LUWI_SESSION_PRESENCE_TTL_MS`), so a heartbeat is mandatory      |
| C9  | Existing registration surface | `POST /api/v1/sessions` plus the CLI's `session register` with          |
|     |                               | `--native-adapter/--native-session/--native-subagent` (B0)              |

**C3 is what makes this buildable.** The identity a Claude session needs to declare is already in
its own environment, byte-identical to its transcript stem — so registration needs no discovery, no
process inspection, and no guessing. **C6 against C7 is the second gap:** eighteen skills exist and
LUWI can see three seeded records, so "which skills does this agent actually carry" is unanswerable
today.

## Determinations the design leaves open

### C-D1 — The session registers itself; LUWI does not discover it

LUWI must not scan for processes and invent sessions for them. A process list cannot tell you which
project a session is working on, and a session LUWI invented could never be closed honestly. The
runtime keeps answering only for clients that speak to it — which is also what keeps §3's boundary
intact.

### C-D2 — One bootstrap module, three thin vendor adapters

Claude, Codex and Gemini differ only in **where their identity comes from** (C3/C4/C5). Registration,
heartbeat, terminal close and failure handling are identical, so they live in one module and each
vendor contributes a `resolveIdentity()` that returns a native ref or `undefined`. A vendor whose
identity cannot be resolved registers **without** a native block rather than fabricating one — B0's
`native` field is already optional, and a wrong binding is worse than none.

### C-D3 — Heartbeat is owned by the bootstrap, not the caller

Presence TTL is 15 s (C8) and a lapse is **terminal with no way back** (`disconnected` has no
transition out). So the bootstrap owns an interval at a safe fraction of the TTL, and a missed beat
is retried rather than left. This is the single most likely source of a "session vanished" report,
so it gets explicit tests for the lapse and the recovery.

### C-D4 — Exit closes the session, and a crash is allowed to lapse

A clean exit calls `close`. A crash cannot, so presence expiry is the backstop and the session goes
`disconnected` — which is honest. The bootstrap does **not** try to survive its own process.

### C-D5 — Capability observation reuses the control-plane scan

`GET /api/v1/capabilities` and the context scan already exist. C6/C7's gap is that nothing points
them at the developer's real skill directories. This phase makes that a **scan of declared roots**,
not a new subsystem, and it never executes anything it finds (§12, §18).

### C-D6 — What "optimization" means here, and what it does not

The owner asked for skills optimisation. This phase delivers the **evidence** for it: which skills
are assigned, which were actually loaded, and what they cost in context. It does **not** deliver
automatic pruning — ADR 0010's rule stands, and automatic optimisation apply is on §21's prohibited
list. Turning that evidence into a proposal is the existing optimization domain's job, and a
proposal still goes through the Phase 3 approve/apply chain.

### C-D7 — Registration must not depend on a daemon being up

An agent starts whether or not LUWI is running. A failed registration is logged once and the session
continues **without** LUWI rather than failing the agent's own startup. LUWI is a coordinator; it
must never become a precondition for the developer's tools.

## File structure

```text
packages/runtime/src/session-bootstrap.ts          registration + heartbeat lifecycle (new)
packages/runtime/src/session-bootstrap.test.ts     (new)
packages/adapters/src/native-identity.ts           per-vendor resolveIdentity (new)
packages/adapters/src/native-identity.test.ts      (new)
packages/adapters/src/index.ts                     exports
apps/cli/src/session-cli.ts                        `luwi session attach`
apps/cli/src/cli.test.ts                           attach coverage
apps/daemon/src/control-plane-service.ts           capability roots scan
apps/daemon/src/config.ts                          LUWI_CAPABILITY_ROOTS
docs/decisions/0024-session-self-registration.md   the ADR this phase needs (new)
```

**`packages/protocol` is expected to need no change**: `POST /api/v1/sessions` already accepts
everything registration needs, including B0's optional `native` block. If a schema change turns out
to be required, stop and record why — that would mean the phase is larger than approved.

## Task 0: The ADR

- [x] Write `docs/decisions/0024-session-self-registration.md` — context (C1/C2: agents run, none
      visible), decision (C-D1 through C-D7), consequences. **This phase is not started until the
      ADR is accepted**, per §21's rule that shipping one phase does not authorise the next.

## Task 1: Vendor identity resolution

**Files:** `packages/adapters/src/native-identity.ts`, `packages/adapters/src/native-identity.test.ts`

- [x] `resolveNativeIdentity(kind, env)` returning `NativeSessionRef | undefined`, pure, with the
      environment injected — never read from `process.env` inside the function.
- [x] Claude: `CLAUDE_CODE_SESSION_ID` → `{ adapterId: 'claude-code', nativeSessionId }` (C3). When
      `CLAUDE_CODE_CHILD_SESSION=1` is also set, the process is a subagent of that session; record it
      as `nativeSubagentId` rather than inventing a second main session.
- [x] Codex and Gemini: return `undefined` for now and **say so in the code**, because C4 and C5
      show their identity lives in a file layout rather than the environment, and a resolver that
      guessed would produce a binding that never matches a transcript.
- [x] Tests: a Claude environment resolves; a child session resolves with a subagent id; an empty
      environment resolves to `undefined`; a malformed id (not matching `nativeIdSchema`) resolves to
      `undefined` rather than throwing, because a bad environment must not break an agent's startup.

## Task 2: The bootstrap lifecycle

**Files:** `packages/runtime/src/session-bootstrap.ts`, `packages/runtime/src/session-bootstrap.test.ts`

- [x] `createSessionBootstrap({ client, identity, projectId, agentId, workingDirectory, heartbeatIntervalMs, now, setInterval, clearInterval })`
      with `start()` and `stop()`. Timer functions are injected, following `daemon-ownership.ts`'s
      precedent, so the tests drive it without real time.
- [x] `start()` registers once, then heartbeats on an interval **well inside** the 15 s TTL (C8).
- [x] A failed registration logs once and leaves the bootstrap inert (C-D7). A failed heartbeat is
      retried on the next tick rather than ending the session.
- [x] `stop()` closes the session; a crash is left to presence expiry (C-D4).
- [x] Tests: registration happens exactly once; heartbeats continue on the injected clock; a
      registration failure does not throw to the caller; a heartbeat failure does not stop later
      beats; `stop()` closes; `stop()` before `start()` is a no-op.

## Task 3: The CLI entry point

**Files:** `apps/cli/src/session-cli.ts`, `apps/cli/src/cli.test.ts`

- [x] `luwi session attach --project <id> --agent <id>` — resolves identity from the environment,
      registers, heartbeats, and closes on `SIGINT`/`SIGTERM`. This is the surface a developer or a
      shell hook can call, and it is the one thing that turns C2's nine processes into live sessions.
- [x] `--dry-run` prints what it would register and exits, so an owner can verify the identity
      before anything is written.
- [x] Tests: attach registers with the resolved native ref; attach without a resolvable identity
      still registers, with no native block (C-D2); a daemon that is down exits non-zero **with a
      clear message** and never hangs.

## Task 4: Capability roots

**Files:** `apps/daemon/src/config.ts`, `apps/daemon/src/control-plane-service.ts`

- [ ] Add `LUWI_CAPABILITY_ROOTS` — a list of directories to scan for skills, defaulting to the
      native home's `.claude/skills` plus the project's own `.claude/skills` (C6).
- [ ] Scan them into the existing capability catalogue with a provenance that marks them
      **observed** rather than declared, so a scanned skill is distinguishable from one the owner
      registered.
- [ ] **Nothing found is executed** — the scan reads a manifest and stops (§12, §18).
- [ ] Tests: a directory of skills is catalogued; a malformed manifest is skipped and counted, not
      fatal; a skill outside every declared root is not catalogued; the scanner never invokes a
      command runner.

## Task 5: Making the evidence visible

**Files:** `apps/dashboard/src/…`

- [ ] Pulse shows a live session with its native binding, so the answer to "is this agent visible"
      is on the first screen rather than in a route.
- [ ] The agent pair route shows assigned versus **loaded** capabilities, which is the evidence
      C-D6 says this phase delivers and the optimisation domain later consumes.
- [ ] Long panels on these routes use the collapsible `Panel` added on 2026-08-17, so the route
      does not become another page-length stack.

## Task 6: Full verification

- [ ] `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`
- [ ] `/redis-it` for the integration leg.
- [ ] **Live proof, and this is the one that matters:** attach a real session from this machine and
      show it in Pulse as `online`, then let it lapse and show it go `disconnected`. Do not tick this
      without the evidence — C1 is exactly the claim that went unverified before.
- [ ] Report per §19, including how many of C2's processes are now visible and how many are not.

## Regression coverage map

| Risk                                                 | Covered by                             |
| ---------------------------------------------------- | -------------------------------------- |
| LUWI inventing sessions from a process list          | C-D1, no discovery code exists         |
| A wrong native binding from a guessed identity       | Task 1 undefined-for-Codex/Gemini test |
| An agent failing to start because LUWI is down       | Task 2 + Task 3 daemon-down tests      |
| A session silently lapsing to `disconnected`         | Task 2 heartbeat tests (C8)            |
| A crash leaving a session `online` forever           | C-D4, presence expiry is the backstop  |
| A scanned skill executing something                  | Task 4 no-execution assertion          |
| Automatic optimisation apply sneaking in             | C-D6, evidence only                    |
| A schema change widening the phase past its approval | File-structure note, stop-and-record   |
