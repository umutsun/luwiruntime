# CLAUDE.md — LUWI Runtime

LUWI Runtime is a local-first, single-user control and coordination runtime for developers who run
multiple AI coding agents across local projects. It coordinates Codex, Claude Code, Gemini CLI, and
Kimi; it does not replace or impersonate them.

## Where the binding rules live

`AGENTS.md` (1036 lines) is the single source of truth for this repository's architecture. It is
binding. This file does not restate it — it routes to it and adds only what is specific to running
Claude Code on this machine.

| Question                                                | Read                  |
| ------------------------------------------------------- | --------------------- |
| Redis Streams, consumer groups, `XAUTOCLAIM`, Functions | `AGENTS.md` §7        |
| Runtime event envelope and event types                  | `AGENTS.md` §8        |
| Package boundaries, what may not become a package       | `AGENTS.md` §5        |
| Loopback-only security, `Host`/`Origin`, logging bans   | `AGENTS.md` §4        |
| Redis-only datastore rule, derived-view rebuildability  | `AGENTS.md` §2        |
| Session Bridge and MCP boundary                         | `AGENTS.md` §12       |
| Git safety rules                                        | `AGENTS.md` §13       |
| Required test coverage per transition                   | `AGENTS.md` §15       |
| Definition of done                                      | `AGENTS.md` §19       |
| Phase scope and explicit "do not add" lists             | `AGENTS.md` §18, §21  |
| Architecture decisions                                  | `docs/decisions/*.md` |

When a change touches Redis Streams, consumer groups, or Redis Functions, read §7 before editing.
Those rules are non-obvious and easy to violate silently.

## Repository state — read this before any git operation

History is short and every commit is a large checkpoint:

| Commit    | Contents                                                       |
| --------- | -------------------------------------------------------------- |
| `31c4f54` | Phase 1 Redis-native projects and sessions                     |
| `7b50738` | Phases 2–5C: messaging, control plane, intelligence, dashboard |
| `c7d03c4` | Claude Code configuration and ADR 0012                         |
| `3a7dc9b` | Phase 5D read-only intelligence routes                         |
| `dc1b270` | Repository-state documentation correction                      |
| `32c3e7f` | Bounded graph summary, ADR 0013, and the `#/graph` route       |
| `ea487d9` | Documentation cleanup after the graph-summary phase            |
| `6f20aec` | ADR 0012 first increment: TypeScript code-structure layer      |
| `c462293` | ADR 0014 projection-input fixes                                |
| `f25d208` | Repository-state and status sync                               |
| `716369b` | Explicit test budgets for the two load-sensitive tests         |
| `77c6e0a` | ADR 0015: internal validation failures are server errors       |
| `1feb515` | Read-only dashboard UX pass and the light theme                |
| `7ffd35a` | ADR 0016: rooted, bounded graph exploration                    |
| `915d004` | Graph node labels and selective labelling                      |
| `757b267` | Light-theme readability and the token drift guard              |
| `cdd7084` | The 2026-08-09 dashboard UI audit                              |
| `f06f718` | The audit's small findings: skip link, truncation, loading     |
| `b476a73` | The audit's medium findings: counts, focus, bootstrap seams    |
| `677fe98` | ADR 0017: git attribution, observation depth, two defect fixes |
| `292fbcd` | ADR 0018: seeded fixture, messaging, project-agent pair scope  |
| `89d0ef0` | ADR 0019: capability catalogue, config chain, truncation fix   |
| `0e76bf4` | ADR 0020: advisory work leases, `luwi_v1` v10, four MCP tools  |
| `fdf69a2` | ADR 0021: dashboard config mutations (7 commits, this first)   |
| `80f3939` | ADR 0022 A1: native session identity, `luwi_v1` v11            |
| `02fb41e` | ADR 0022 and the native session binding status                 |
| `fd2a498` | ADR 0022 A2: link retention, plus two A1 boundary fixes        |

Phases 2 through 5C landed as one commit because they are not separable at file level: protocol
schemas, Redis repositories, and daemon services each carry several phases' concerns in the same
modules, and the intermediate states never existed. Do not try to reconstruct them.

Working rules:

- Per §13, **commit only when the user explicitly asks**. Between asks, uncommitted work has no
  recovery point, which is what the `PreToolUse` guard exists for.
- `git reset --hard`, `git clean -f`, `git stash`, and `git checkout/restore .` are blocked by
  `.claude/hooks/guard-bash.mjs`. Do not work around it; if a block is wrong, fix the rule and its
  test.
- `git stash list` and `git stash show` remain allowed for inspection.

`.git` is owned by a different Windows SID (`CodexSandboxOffline`) than the current user. This is
already handled via `git config --global --add safe.directory C:/xampp/htdocs/luwiruntime`. If git
suddenly reports "dubious ownership" again, that config was lost — re-add it rather than using
`takeown`.

Two traps that have already cost time here:

- **Writing a file from Python or a shell heredoc produces CRLF on this machine.** Prettier
  silently repairs it for files it formats, but `AGENTS.md` is in `.prettierignore`, so a Python
  rewrite of it leaves CRLF behind. Prefer the editing tools; if you must script an edit, normalise
  line endings afterwards.
- **`git status` can report a file modified when its content is identical**, right after a write,
  because git distrusts same-second mtimes. Confirm with `git diff` or by comparing
  `git rev-parse :<path>` against `git hash-object <path>` before believing it.

## This machine

Verified, and different from what `AGENTS.md` §17 assumes:

| Thing  | Reality                                                                  |
| ------ | ------------------------------------------------------------------------ |
| Node   | v26.3.0 (`engines` requires >=22)                                        |
| pnpm   | 11.9.0, installed globally via npm — `corepack` is absent in Node 26     |
| Redis  | **Memurai Developer 4.1.2** (`redis_version:7.2.5`) as a Windows service |
| Docker | **not installed** — `docker compose up -d redis` does not work here      |
| jq     | not installed — do not write hooks or scripts that depend on it          |

Memurai supports Redis Functions fully; `luwi_v1` (23 functions) is already loaded on the server.

## Tools and shells

- **Bash tool = Git Bash (POSIX sh).** Use `$VAR`, forward slashes, heredocs.
- **PowerShell is a separate tool** with its own syntax. PowerShell 5.1 has no `&&` — use
  `A; if ($?) { B }`.
- Do not mix them. PowerShell syntax fed to the Bash tool is a parse error, and vice versa.

## Commands

Run these from the repository root.

| Command                 | Notes                                                         |
| ----------------------- | ------------------------------------------------------------- |
| `pnpm format`           | `prettier --check .` — `AGENTS.md` is in `.prettierignore`    |
| `pnpm format:write`     | `prettier --write .`                                          |
| `pnpm lint`             | `eslint .`                                                    |
| `pnpm typecheck`        | Two legs: dashboard, then `tsc -b`                            |
| `pnpm test`             | Unit only; **includes** dashboard tests                       |
| `pnpm test:integration` | Requires Redis env vars — use `/redis-it`                     |
| `pnpm build`            | Two legs: dashboard `vite build`, then `tsc -b`               |
| `pnpm dev`              | Daemon on `127.0.0.1:4782`                                    |
| `pnpm dev:dashboard`    | Vite on `127.0.0.1:4783`; daemon needs `LUWI_ALLOWED_ORIGINS` |

Two traps worth stating explicitly:

- **`tsc -b` alone does not cover `apps/dashboard`.** The root `tsconfig.json` `references` array
  omits it deliberately. That is why `typecheck` and `build` each have a separate dashboard leg.
- **`pnpm test` already covers dashboard tests.** `vitest.config.ts` `include` contains
  `apps/**/*.test.tsx`, and `apps/dashboard/src` holds 30 test files. There is no separate
  dashboard test leg to run.

Use `/verify` to run the §19 definition-of-done sequence in the correct order.

## Current implementation status

Phases 5A through 5D are implemented on the Phase 1–4 foundation: native realtime Pulse, bounded
Activity, read-only inspectors, project scope, and the sessions, agents, usage, context, and
optimization routes. ADR 0013 then added `GET /api/v1/graph/summary` and enabled `#/graph`, so the
navigation rail no longer carries a disabled destination. ADR 0012's first increment added the
non-executing TypeScript code-structure layer to the operational graph, and ADR 0014 fixed its two
projection-input defects. ADR 0017 added commit attribution as a fifth project-scoped read and
rendered the branch, tag, and worktree evidence the Git observation was already delivering.
`README.md` "Current status" is accurate and maintained.

Not implemented, and per §21 still explicitly out of scope without approval: `config/reconcile`,
lifecycle/release scoring, task orchestration, semantic or vector knowledge graph, memory
federation, GitHub integration, prompt injection, cloud accounts, authentication, remote
control-plane work.

ADR 0018 then removed the reason those domains were deferred. `pnpm seed` populates an isolated
fixture runtime, and three of them were built on it: `#/messages`, effective agent configuration,
and the pair-scoped context reads, the last two on `#/projects/<id>/agents/<agentId>`.

ADR 0019 built the last two: `#/capabilities` (the package and profile inventory, with profile
references resolved to names) and `#/config` (drift, plans, snapshots — read-only; every mutation
in that domain writes the developer's own agent configuration files). **No item-10 read domain is
open any more.** It also fixed a hardcoded `truncated: false` on `GET /api/v1/capabilities`.

ADR 0020 then built the first thing that is not a read: **advisory work leases**. A session claims a
project-relative path before editing it, and an overlapping claim is refused with the holder named.
`luwi_v1` is at version 10 with four lease Functions; `deadline:leases` is swept for expiry; four
MCP tools take the holder from the bound session and never from input; the Projects route shows what
is held. ADR 0022 then added **native session identity**. A client may declare its vendor-native
session reference at registration; the runtime records a stable binding plus an immutable,
time-bounded link per LUWI session. Identity carries no presence, project or agent; a live holder is
refused rather than evicted; a conflict writes nothing; missing evidence is
`NATIVE_BINDING_INCONSISTENT`. Policy is a pure `@luwi/runtime` function and Lua only validates a
CAS on a monotonic `version`, **before `XGROUP CREATE`** so a refusal leaves no inbox stream.
`luwi_v1` is at **v11**.

ADR 0023 then approved the next item in the sequence — **native transcript ingestion** — and
specified it as B0 / B1 / B2, with only B0 planned. **Nothing of it is built.**

The fact that orders the phase: there are **zero native bindings in either Redis database**, against
nine sessions. A declaration rides only on `POST /api/v1/sessions` and nothing that registers a
session sends one — not the CLI, not the seed — so an already-registered session can never declare.
That is why **B0 is a declaration surface, not a reader**: build the reader first and it attributes
nothing. B1 is the reader; B2 fills `SESSION_CHANGED_FILE`, which is in the edge enum with no
producer.

Two measured traps for anyone touching this. `subagents/` directories exist at
`<sessionId>/subagents/workflows/<workflowId>/agent-<id>.jsonl` and hold 11.3% of distinct requests,
so a reader that walks only the top level of a project directory loses a ninth of the evidence — and
their filename stem is an agent id, so **the join key is the `sessionId` inside each record, never
the filename**. And usage is per `requestId`, not per record: summing per record over-counts by
1.88×, and 362 of 1961 multi-record requests carry _differing_ usage, so dedupe needs a stated
winner rather than whichever record is read last.

**Both increments are built, so A is complete.** A2 bounds a binding at 1000 retained closed links
(`LUWI_NATIVE_LINK_RETENTION_MAX`). `native_link_trim` takes `2 + 2N` keys, trims at most 32 per
call, removes index entry, link hash and session reverse index together, and never touches an open
link. It emits no event and rides the existing retention interval rather than a timer of its own.
Every key is declared with the identity it must hold; any mismatch is refused with nothing written.
The sweep finds bindings through `index:session:{sessionId}:native` — there is no binding index, and
adding one would have pushed `session_register` past its 14 keys.

Advisory means the runtime cannot enforce it — §3 keeps LUWI out of terminals — only that
it answers atomically and records who holds what.

ADR 0021 then made the dashboard write. **`#/config` is no longer read-only**: it creates import and
render plans, prepares a rollback plan from a snapshot, rescans drift, and applies a plan behind a
confirmation dialog that names every target file. `approve` and `apply` run inside one function so
the one-time token never outlives the gesture, which is why an already-`approved` plan is shown with
no control — the state machine mints no second token.

Two consequences to know before touching the daemon or the dashboard:

- **An `Origin`-less `POST` must send `content-type: application/json`**, or it is refused with
  `403 REQUEST_ORIGIN_REJECTED`. `PUT`, `PATCH` and `DELETE` are unaffected — a cross-site one of
  those always preflights and the daemon answers no preflight. A test that injects a bodyless POST
  now fails; real callers pass `{}`, which is what makes Fastify's `inject` set the header.
- **`apps/dashboard/src/api/config-mutations.ts` is the only dashboard module allowed to write.**
  `product-independence.test.ts` is an allowlist of exactly one and fails if that module goes
  missing, so it cannot pass vacuously. A mutation anywhere else is a test failure by design.

To look at any of it, start a fixture daemon — `REDIS_URL`, `LUWI_HOME`, `LUWI_NATIVE_HOME` and
`WORKSPACE_ID=fixture-…` **together**, because Redis alone is not isolation: per ADR 0007 agent
definitions, capabilities and profiles are filesystem-canonical and land in the real `~/.luwi`
otherwise. `scripts/seed-runtime.ts` refuses to run unless the daemon reports a `fixture` workspace.

Two capture traps worth knowing. `chrome --virtual-time-budget` accelerates timers while the
network stays real, so the dashboard's reconnect timer aborts every on-demand read and the panels
never leave "Loading" — that is the screenshot lying, not the page. Capture over the DevTools
protocol with a real wait instead. And the daemon serves the dashboard build, so screenshots need
`pnpm build` first and a restart; the owner lease also needs ~15 s to expire before it will start
again.

`apps/daemon/src/app.ts` is the canonical route list (80+ endpoints). `AGENTS.md` §10 lists the
initial subset only.

## MCP — opt-in, not automatic

There is deliberately **no `.mcp.json`**. `apps/mcp-server/src/main.ts` calls
`verifyBoundSession()` _before_ connecting the transport, so it exits 1 without ever speaking MCP
unless the daemon is running and `LUWI_SESSION_ID` names a live, non-terminal session. Session IDs
are runtime identity, not configuration — they go stale on every daemon restart.

The server exposes 36 `luwi_*` tools, and "read-only" was never accurate for all of them: by the
daemon method each one calls, **25 are reads and 11 write** coordination state — the messaging
transitions, a bounded optimization analysis request, and since ADR 0020 three of the four
work-lease tools. Counting the messaging, optimization and lease families whole gives 14, but three
of their members only read: `luwi_await_response` and `luwi_get_message` are `GET
/api/v1/messages/…`, and `luwi_list_leases` is `GET /api/v1/leases`. Control-plane writes (config
approval/apply, rollback, graph rebuild, Git mutation) are never exposed, per `AGENTS.md` §12.

To use them, after `pnpm build` and with the daemon up
and a session registered:

```text
claude mcp add --scope local luwi-runtime \
  --env LUWI_DAEMON_URL=http://127.0.0.1:4782 \
  --env LUWI_SESSION_ID=<registered-online-session-id> \
  -- node C:/xampp/htdocs/luwiruntime/apps/mcp-server/dist/main.js
```

Name it `luwi-runtime`, not `luwi-mcp` — that name refers to a different HTTPS server in another
project on this machine.

## Working here

- **Never claim a command passed unless it actually ran and succeeded** (§19). For a command that
  cannot run, report the exact command, the error, the likely cause, and the next safe action.
- Do not label planned or designed behavior as implemented.
- `@luwi/mcp-server` must never import `@luwi/redis`; `@luwi/protocol` and `@luwi/runtime` must
  never import `redis`. An ESLint `no-restricted-imports` rule enforces this — if it fires, the
  design is wrong, not the rule.
- Redis data is untrusted input. Validate on read (§7, §14).
- Adapters and scanners never execute discovered skills, hooks, plugins, scripts, or MCP
  definitions (§12, §18).

Generic engineering discipline — TDD, systematic debugging, verification before claiming
completion, code review — is already provided by the globally installed Superpowers skills. This
file intentionally does not restate it.
