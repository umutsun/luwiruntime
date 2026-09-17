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
| `3699fde` | Seed re-runnability and the missing four MCP lease handlers    |
| `ff2f25d` | ADR 0023: transcript ingestion approved, B0/B1/B2 specified    |
| `09b152a` | Dashboard redesign phases 1–2: shell tokens, docked inspector  |
| `98daefc` | The phase 3 panel anatomy written into the redesign plan       |
| `4404b1a` | Redesign phases 3–6: pulse rows, runtime route, palette, scope |
| `9b6e351` | scp-style git remotes admitted; detected-remote write guard    |
| `3d2a679` | Redesign completion and remote-schema fix recorded             |
| `62d5a54` | Project evidence docked into the inspector column              |
| `ddc1d02` | CLI lease family, MCP registration docs, drawer UX contract    |
| `5f1bd98` | ADR 0023 B0: post-registration native session declaration      |
| `0411b53` | ADR 0023 B1: transcript reader and usage session attribution   |

The table stops at ADR 0023 B1. The checkpoints since — ADR 0024 through 0035, the overview
redesign, the Faz 2/3 fleet coordination, the client kind — are in `git log` and summarised under
**Current implementation status** below and in `README.md`.

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

Memurai supports Redis Functions fully; `luwi_v1` (34 registered Functions since F3's `luwi_project_unregister_v1` — the library version is still 12, so a daemon started before a new Function needs one restart to load it; the daemon started 2026-09-17 holds 33) is already loaded on the server.

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

Not implemented, and per §21 still explicitly out of scope without approval: automatic drift
reconciliation (distinct from the implemented `POST /api/v1/config/reconcile`, which recovers
interrupted apply operations at daemon start), lifecycle/release scoring, task orchestration,
semantic or vector knowledge graph, memory federation, GitHub integration, prompt injection,
cloud accounts, authentication, remote control-plane work.

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
is held. **ADR 0026 (2026-09-01) then made renewal automatic and holder-side:** the session bootstrap
renews every lease the current session holds on a second timer beside the heartbeat (at half the
default lease TTL), listing the held-only session-lease index and re-reading the bound session id each
tick so a rotation never renews a dead session's lease; a clean exit lets the leases lapse
(crash-consistent) and a failed renewal is surfaced once. It reuses the renew endpoint and
`lease_renew` unchanged — no `luwi_v1` bump — as a `--lease-renew-ms` client setting on `agent run`
and `session attach`. ADR 0022 then added **native session identity**. A client may declare its vendor-native
session reference at registration; the runtime records a stable binding plus an immutable,
time-bounded link per LUWI session. Identity carries no presence, project or agent; a live holder is
refused rather than evicted; a conflict writes nothing; missing evidence is
`NATIVE_BINDING_INCONSISTENT`. Policy is a pure `@luwi/runtime` function and Lua only validates a
CAS on a monotonic `version`, **before `XGROUP CREATE`** so a refusal leaves no inbox stream.
`luwi_v1` is at **v12** (B1 moved it; see below).

ADR 0023 then approved the next item in the sequence — **native transcript ingestion** — and
specified it as B0 / B1 / B2. **B0, B1 and B2 are all built.**

The fact that ordered the phase: at approval there were **zero native bindings in either Redis
database**, against nine sessions. A declaration rode only on `POST /api/v1/sessions` and nothing
that registers a session sent one — not the CLI, not the seed — so an already-registered session
could never declare. That is why **B0 was a declaration surface, not a reader**: build the reader
first and it attributes nothing. B0 added `POST /api/v1/sessions/:sessionId/native` (the same
`native` block registration takes, strict, so a body cannot name another session), the
`native_declare` Function (library still v11 — a new function forces a reload without a bump),
`--native-*` options on `session register`/`session simulate`, and one seeded declaration so the
fixture holds a binding and a real attribution interval. The link starts open and may be closed by
the normal presence sweeper when the seeded session expires; the live B0 fixture exercised both
transitions. `evaluateNativeDeclaration` is unchanged; `unchanged` is a 200, not an error.

**B1 then built the reader, so `usage.sessionId` is answerable** — for declaring sessions only. The
reader lives in `@luwi/adapters` behind its own `TranscriptFileSystem` seam (`listDirectory`, `stat`,
a bounded `readLines`; **not** two more methods on `AdapterFileSystem`, which nothing else would
call). It **enumerates** the projects root rather than deriving a directory name from a project path:
the drive-letter case varies on this machine (`C--xampp-…` beside `c--xampp-…`), and since the join
key is the in-record `sessionId`, the path was never identity. `attributeObservation` in
`@luwi/runtime` decides containment against `findNativeLinkAt(bindingId, atMs)`, a
`ZRANGE … BYSCORE REV LIMIT 0 1` over the links zset — which was already scored by `linkedAt` in
epoch ms, so no new index was needed. Four unbound cases are counted apart and never resolved to a
nearby session. The daemon runs a sixth timer on `LUWI_TRANSCRIPT_SCAN_INTERVAL_MS` (default 300000,
min 60000; `LUWI_TRANSCRIPT_MAX_FILE_BYTES` and `LUWI_TRANSCRIPT_MAX_FILES_PER_SCAN` bound it), and
a `runtime.test.ts` guard now asserts **every** timer is cleared on both teardown paths.
`USAGE_RECORD_DUPLICATE` is counted, not thrown, because re-reading a transcript is the steady state.
`luwi_v1` went to **v12**: the usage record gained `cacheCreationInputTokens` and
`cacheReadInputTokens`, and per the registry's own rule the version moves only on a record-shape
change.

**B2 then built the `SESSION_CHANGED_FILE` producer.** The reader gained a second extraction over the
same one file read (E6): it pairs `tool_use` with `tool_result` in a file and emits a file
observation only for an allowlisted mutating tool (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`) whose
paired result is present and not an error, reading **only the path** out of the input. The daemon
attributes each change through the same `attributeObservation`, scopes the absolute path to a
registered project (longest `canonicalPath` prefix, drive-letter case-insensitive; the relative
remainder reuses the lease domain's `normalizeLeasePath`), and persists a per-(session, file)
aggregate whose `changeCount` advances only on a strictly newer `observedAt`. That aggregate is the
persisted source `projectGraphSnapshot` reads to project edges onto the **same** `file` node the
ADR 0012 structural layer already produces — no new node or edge kind. The B2 plan assumed no
protocol/redis change, but the graph is a full-rebuild projection from persisted sources (git
observations feed `COMMIT_TOUCHES_FILE` the same way), so B2 added a bounded observation store
(`sessionFileChangeObservationSchema` plus a plain HSET+SADD `put`/`list` — **no Lua Function, no
`luwi_v1` bump, no stream**, recorded in the plan and owner-approved 2026-09-01, with SADD before
HSET so a crash self-heals). The store has no retention: a project past `GRAPH_REBUILD_MAX_INPUTS`
distinct (session, file) records fails its rebuild loudly rather than dropping edges.

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
- **Four dashboard modules may write, and only those:** `api/config-mutations.ts` (ADR 0021),
  `api/message-mutations.ts` (ADR 0018), `api/project-mutations.ts` (ADR 0033: register a
  project, edit its name/remote/default branch — never its path) and
  `api/coordinator-mutations.ts` (ADR 0035: claim or release the per-project coordinator role).
  `product-independence.test.ts` is an allowlist of exactly those four and fails if one goes
  missing, so it cannot pass vacuously. A mutation anywhere else is a test failure by design.
  ADR 0033 also added the first project _update_ transition — `luwi_project_update_v1`, one
  atomic Function for the hash fields and the `project.updated` event, behind
  `PATCH /api/v1/projects/:projectId`; the library version stays 12 (a new function reloads on its
  own), so **a daemon started before it must be restarted once** before a PATCH can succeed.

To look at any of it, start a fixture daemon — `REDIS_URL`, `LUWI_HOME`, `LUWI_NATIVE_HOME` and
`WORKSPACE_ID=fixture-…` **together**, because Redis alone is not isolation: per ADR 0007 agent
definitions, capabilities and profiles are filesystem-canonical and land in the real `~/.luwi`
otherwise. `scripts/seed-runtime.ts` refuses to run unless the daemon reports a `fixture` workspace,
and also wants `LUWI_SEED_CONFIRM=1`. Point `LUWI_HOME` at the **same** directory a previous seed
used: db15 keeps capability projections whose manifests live on disk, so a fresh home against an old
database makes `POST /api/v1/context/scan` fail `ENOENT` and answer 500 — the same
filesystem-canonical rule seen from the other side.

**A mutation no longer waits for the operational graph.** Every intelligence mutation used to end in
`await projectIncrementally(...)`, which despite its name rescans the whole project with the
TypeScript compiler API and then reads the active generation one `HGET` per node and per edge. On a
fixture holding 15 093 nodes and 25 409 edges that was ~40 500 sequential reads for a single request:
`POST /api/v1/context/contributions` logged `incoming request`, never logged `request completed`, and
the seed died at step 14 with `TypeError: fetch failed`. The reprojection now goes to the daemon's
`backgroundWork` tracker through the injected `deferProjection` seam — still tracked, still logged,
still drained at shutdown — and the same request answers in ~47 ms while daemon startup dropped from
42 s to about 1 s. It is best-effort by construction (it swallows failures into a projection-failure
record and returns `void`), so awaiting it never told the caller anything.

**ADR 0029 (2026-09-02) reads graphify's output into the operational graph.** Graphify (Python,
tree-sitter) was installed on this machine by the owner, has built `graphify-out/graph.json` for all
ten registered projects, and refreshes them through its own git hooks; its MCP server is registered
at user scope in `~/.claude.json` as `graphify`. LUWI's part is `apps/daemon/src/graphify-observer.ts`,
read at rebuild beside the ADR 0012 scan, and it never runs graphify. Three measured traps: **graphify
writes no file node** — every node is a symbol, heading or page carrying `source_file`, so the join is
on that field, never on node ids; external targets are nodes too (`node:net`, manifest dependencies)
and are dropped by the "must be a real file inside the project" check; and the snapshot's `addNode`
is last-writer-wins, so a second structural layer must go through `addNodeIfAbsent`/`addEdgeIfAbsent`
or it silently replaces the ADR 0012 node (a commit path used to do exactly that; fixed). `graphify-out/`
is gitignored; `graphify install --platform codex` writes into `AGENTS.md` and is never run unasked.
**The live rebuild exposed a latent trap:** the rebuild lock (`luwi:v1:graph:rebuild:lock`, a
five-minute `SET NX PX`) was never renewed, and a rebuild on this machine can take longer than that —
the lock lapsed, activation and then the failure record were refused as `GRAPH_REBUILD_OWNERSHIP_LOST`,
and the operation stayed `running` with "Graph rebuild failed." as its only trace. The running rebuild
now renews the lock every 60 s, a failed renewal aborts the write loop, and `failureSummary` carries the
real reason. **And a second one:** `runtime.stopping` is not only a signal — the recovery path stops the
runtime when the daemon owner lease (15 s, renewed every 5 s) is gone, so one synchronous stall longer
than that kills the daemon mid-rebuild. The projection's per-file `exportCount` filter was such a stall
(8.7 s on the 20 000-file `flybydeniz` scan) and is now a map; keep the projection's synchronous work
per project well under the lease.

**ADR 0031 (2026-09-08) makes an agent's inbox answer itself.** `luwi session bridge native
<claude|codex|gemini>` holds one long-lived LUWI session via the same bootstrap `agent run` uses, and
runs the native CLI once headless per claimed message (`claude --print` / `codex exec` /
`gemini --prompt`) with `LUWI_SESSION_ID` inherited so the child's own MCP server completes the
message. The bridge completes only what the child left unfinished — an honest `failed` naming the exit
code, deadline, or operator stop — and never `answered`. Everything after `--` reaches the native CLI
unchanged as its whole permission model; the bridge spawns a process and injects into no terminal, so
§3 and §21 both hold. No daemon, protocol, Redis, `luwi_v1`, or dependency change: it lives in
`@luwi/cli` beside the DeepSeek bridge and shares its daemon-client (`bridge-daemon.ts`). Two supporting
facts landed with it: both attach hooks now exit when they inherit a `LUWI_SESSION_ID` (headless
`claude -p` fires `SessionStart` too, and `agent run` strips the inherited id before spawning — together
that produced reader-less ghost sessions), and the process runner grew a `captureOutput` seam that pipes
stdout/stderr for the bridge's failure tail. Measured motive: the 2026-09-08 Albanoosh run delivered all
14 messages with zero daemon errors yet timed out 4, every one on a 3–5 min deadline a human had to feed;
and `selectMessageTarget` ranks by status before heartbeat while nothing left `starting`, so a reader-less
manual attach was a guaranteed-timeout target. `agy` is not installed here, so claude and codex are proven
live and the `gemini` shape is carried, not verified.

Two capture traps worth knowing. `chrome --virtual-time-budget` accelerates timers while the
network stays real, so the dashboard's reconnect timer aborts every on-demand read and the panels
never leave "Loading" — that is the screenshot lying, not the page. Capture over the DevTools
protocol with a real wait instead. And the daemon serves the dashboard build, so screenshots need
`pnpm build` first and a restart; the owner lease also needs ~15 s to expire before it will start
again.

**ADR 0032 (2026-09-11) rebuilt the dashboard as an overview with four switchable lenses.** The
owner shared four Claude Design comps (`temp/Luwi Runtime Dashboard Mockup/Luwi Runtime -
{Board,Flow,Radial,Timeline}.dc.html`); `#/pulse` now renders a 56 px header, the chosen lens, a
docked 360 px drill-down and a stream ticker, all from one pure model in
`apps/dashboard/src/overview/model.ts`. The rail, command bar, scope select, snapshot line and the
old Pulse panels are gone; the twelve detail routes stay, reached from the drill-down's links and `Ctrl K` (a `Details` menu was tried and removed the same day on the owner's read), and
inherit the new mono palette through `tokens.css`. Every comp claim the runtime cannot know has a
stated replacement in the ADR — release readiness became a session-derived badge, the lifecycle stage
the observed branch, Flow's release column the status vocabulary, and tokens are never summed across
grades. The bootstrap activity read grew from `limit=20` to `limit=200` (the store's own cap) so a
rate, a histogram and Timeline marks can be drawn. Three facts for anyone touching it: vitest's jsdom
here exposes **no `localStorage`** (the view and theme hooks tolerate it; `app.test.tsx` stubs one for
the persistence assertions); `overview.css` and every overview view are registered with
`tokens.test.ts` and `class-coverage.test.ts`, so a raw pixel in a spacing or font property, an opaque
colour literal, or a className no rule matches fails the guard; and the daemon reads `dist/` per
request, so a dashboard-only `pnpm build` needs **no daemon restart** — only a cache-busting query
string in the browser. Three owner-driven follow-ups the same afternoon: the session drill-down's
three facts now read the usage records' own counters — Model is the newest record's model, Tokens
is one grade's total or else output and input (fresh plus cache written) summed each on its own,
and Context is the newest request's prompt size (input plus cache), which is how large the
session's context has grown; nothing is summed across grades and no total is fabricated. `#/runtime`
opens as a drawer over the overview rather than a page. And the project detail drawer gained
**Skills** (the project-scoped capability packages, with the path each file lives at, read through
`GET /api/v1/capabilities?scope=project&projectId=…` as a sixth project-scope resource) and
**Optimization** (this project's findings from the snapshot's bounded set, linking to
`#/optimization` and `#/config`; acting on one stays behind the config plan chain).

**Knowledge is the fifth lens (2026-09-15).** The per-project graphify knowledge graph first shipped
as a separate `#/knowledge/<id>` route with a static ring layout; the owner rejected it as a page
disconnected from the overview and unlike the `Graph.dc.html` comp. It is now a `VIEW_CHOICE` beside
Board/Flow/Radial/Timeline, drawn in the same frame (uniform stat strip, ticker, the docked aside
swapped for a knowledge inspector on the `drill__*` anatomy). **There is no project switcher:** with
nothing focused the lens draws the projects themselves as clickable discs in the centre (the picker),
and a click focuses one (`onFocus({kind:'project'})`, so the hash follows and every lens agrees) and
opens its graph; the focused project sits at the centre as an ink core disc that clicks back to the
picker. `GET /api/v1/projects/:id/knowledge-graph` is read only while the lens is open and once per
project (graphify output changes on git hooks, not per snapshot), through a `loadKnowledge` prop
threaded like `loadSessionUsage`. The canvas is the comp's 3D-orbit force simulation ported verbatim
as a pure, seeded model (`overview/knowledge-model.ts`); the view steps it on
`requestAnimationFrame` and writes positions into the SVG through refs, so no frame goes through
React; jitter scales with alpha so a cooled layout only orbits (no perpetual tremor), the orbit
advances by wall time (one speed on every refresh rate), it settles before first paint and never
orbits under `prefers-reduced-motion`. **Edges are curved paths** bowed outward from the core with an
animated flow dash (the Flow lens's language, a selection brightens and quickens its own), and a slow
dashed orbit ring frames the graph (the Radial lens's). **Nothing on the canvas carries a text label
— every name is a hover tooltip:** a node's tooltip shows its label, source file, kind, degree and
community; a picker disc carries only initials and shows its project name on hover. The
non-functional `$ graphify query` hint was removed; only the `built <commit> · observed <time>`
provenance line remains. The daemon endpoint, reader, projection and protocol schema were correct
and are unchanged. **All eleven registered
projects have graphify output**, so the `graphify build` empty state is covered by unit tests only. **The Flow lens now moves on observed activity** (`OverviewSession.live`): a ribbon
animates when its session has a retained event in the last ten minutes that is not
`session.heartbeat`/`registered`/`native.linked`/`native.unlinked`, because turn-based GUI agents
never report `thinking` and heartbeats alone would animate every online session forever; the board
says so in words.

**Every detail route is a drawer over the overview (2026-09-15, Phase 1 complete).** The owner's
direction is a single unified overview with no separate pages: the twelve detail routes are
`DetailDrawer`s over an always-mounted `#/pulse`, the way `#/runtime` first did. `app.tsx` drives it —
`routeDrawer` is every route name but `pulse`, `foldedRouteView(name)` renders the route's view inside
one general drawer branch, and `WIDE_DRAWER_ROUTES` (sessions, messages, capabilities, config, projects)
take the `wide` variant (`--detail-drawer-width-wide`, 72rem) because their tables run six to eight
columns. `main.tsx`/`bootstrap.ts` loaders and `routing.ts`/`routeTitles` **did not change** — the hashes
stay for deep-link/reload; drawer-vs-page was purely an `app.tsx` render decision, and the
`.route`/`.route-head`/`.route-body`/`.page--route` page shell is **deleted**. **The inner details became
inline panes:** a message, a package, a profile, a plan and a snapshot open as a `DetailPane` (the drawer
header's anatomy as a labelled `region` stacked under its list, no portal, no focus trap, no scroll lock;
it scrolls itself into view because a drawer caps its tables) instead of a second `DetailDrawer`, so no
route nests two `aria-modal` surfaces. The two **gates** stay modal over their drawer — `AskSessionDialog`
(sessions) and `ConfirmDialog` (config apply) — because a confirmation is not evidence; their own Escape
handlers stop propagation, so the drawer's trap never fights them. `#/projects` is the registry drawer;
picking a project navigates to `#/projects/<id>`, which is the project drawer (one drawer at a time, so
the registry yields and is remounted on Close — focus lands on its Close, not on the row). **Openers (the
owner's choice):** the five hero stat tiles open their domain drawer (Sessions→`#/sessions`,
Projects→`#/projects`, Events→`#/activity`, Tokens→`#/usage`, Context→`#/context`; each `Stat` carries a
`route`), the runtime-focus drill-down adds Graph/Optimization beside Runtime/Agents, and the stream
ticker links a message row to `#/messages/<correlationId>`, which opens the routed message inline. No menu
or palette (both were removed). `app.test.tsx` asserts every route as a `dialog` named by its heading with
Close → the focused overview hash. **One harness trap:** jsdom fires `hashchange` from a zero timer, so a
synchronous test never lets one run and they pile up until the first test that awaits — a burst of
dozens of identical events tripped React's nested-update limit; `afterEach` now awaits one timer turn so
each test's events fire with nothing mounted.

**Two sides of one rule, 2026-09-11: a session that never becomes ready is dropped, and not
re-created.** A session registers as `starting` and leaves it only when a reader binds — the
native-headless bridge's poll loop, or the MCP server's `luwi_join`; the message router skips
`starting`. The daemon's starting-session reaper (`81a6f30`, `LUWI_SESSION_STARTING_GRACE_MS`,
default 180 000) makes a session still `starting` past the grace `disconnected`, because its
heartbeat alone would keep it alive forever. That exposed the other half: `createSessionBootstrap`
treated every `SESSION_TERMINAL` as "rotate", so an attached GUI session was reaped and
re-registered as a fresh `starting` zombie every grace period (measured live: six sessions per
cycle across two projects). The bootstrap now has `recoverUnready` — `session attach` passes
`false` and reads the session status after each heartbeat while it is still `starting`; a lost
session that was never observed leaving `starting` is reported as `dropped` and nothing replaces
it (the bridges keep the default `true`: they are their own reader). **ADR 0034 then closes the
loop from the reader's side:** `luwi_join` on a dropped session registers a successor copied from
the dropped record and the MCP server keeps it alive with its own bootstrap (`session-revival.ts`,
`@luwi/mcp-server` now depends on `@luwi/runtime`); every other tool answers
`BOUND_SESSION_TERMINAL` until that join, startup tolerates a dropped binding, and a new attach in
the session file supersedes the successor. A running `session attach` and a running MCP server
both keep the code they started with, so a GUI gets the fix only after both restart.

**ADR 0035 (2026-09-16) added the per-project coordinator role, and the same tranche the fleet
coordination it serves.** One enforced holder per project in `luwi:v1:project:{id}:coordinator`:
`coordinator_claim`/`coordinator_release` are read/decide/validate CAS Functions like ADR 0022,
behind `POST`/`DELETE`/`GET /api/v1/projects/:projectId/coordinator` — a live holder answers
`409 COORDINATOR_CONFLICT`, a terminal holder is taken over, release is holder-only. **Trap both
reviews caught:** a release `DEL`s the key, so `version` restarts at 1 and is a _reused_ token; the
takeover CAS therefore asserts a per-claim `claimId` nonce, never the version alone. The library
version stays 12, so **a daemon started before it must be restarted once** before a claim can
succeed. The sessions view claims and releases through `api/coordinator-mutations.ts` (the fourth
write module). The native bridge prepends the leases _other_ sessions hold to each worker prompt
(best-effort; dropped, never failed, when it would push the prompt past the 30 KB cap). Every ask
carries `delivery: 'live' | 'deferred'` — `live` only when the target has a non-empty
`metadata.bridge` **and** is online and non-terminal (a dead bridge once read `live` and produced
false timeouts); `luwi_ask_agent` returns immediately for a deferred target. Sessions carry a client
kind (`cli`/`gui`/`ide`/`bridge`): `deriveClientKind` in `pulse/model.ts` honours `metadata.client`,
else `bridge` → title→`gui` → `cli`; `agent run`, the native bridge and the Antigravity hook stamp
theirs, while the claude/codex hooks deliberately do not (threading a flag through their
dry-run→launcher plumbing is not worth the risk to live attribution) and derive `gui` from their
title. Implement→verify orchestration is a repository-external script (`flow.mjs` in the Albanoosh
scaffold) that chains correlated messages as the coordinator and stops before any merge — §21 still
forbids a daemon-side flow engine.

**The 2026-09-17 gap-closing tranche, built while a parallel session piloted LUWI on Albanoosh (so
the live daemon was never restarted).** The coordinator switch now also lives in the overview's
session drill-down (`Overview.coordinatorByProject`, `coordinatorFact`, a `coordinator` panel link
the drill-down renders only when the shell wires the mutation). **Stale-tab trap, fixed:** the
daemon serves `index.html` with `no-store` and hashed assets `immutable`, so a reload always gets the
current build — but an open tab never learns of one; twice the owner read a stale tab as feedback
being ignored. `use-build-watch.ts` polls `index.html` (mount, 60 s, tab visible), compares the
hashed bundle to the running module script, and the header shows `NEW BUILD · RELOAD`. **Version
bump trap:** `LUWI_RUNTIME_VERSION` (`packages/protocol/src/version.ts`) is a `z.literal` in the
health/runtime response schemas, so a bumped CLI or dashboard dist _rejects_ an older daemon's
`/health` — bump, build and restart are one atomic step, and even `tsc -b` from `pnpm typecheck`
leaks a bump into dist. **Measured on the 0.2.0 deploy:** the freshly built CLI could not even
_stop_ the old daemon — it read the old `/health`, failed the literal, and reported
`DAEMON_PORT_CONFLICT` ("occupied by an incompatible listener") for both `stop` and `start`. The way
through is the same endpoint the CLI uses, called directly: `POST /api/v1/runtime/stop` with
`x-luwi-lifecycle-token` from `~/.luwi/runtime/daemon-owner.json` (`token` field) and
`content-type: application/json`, then `luwi start` with the new dist. And `luwi start` reporting
`DAEMON_START_TIMEOUT` is not proof the daemon died: the readiness deadline is shorter than a cold
start with a warm Redis, so check `/health` before retrying (the 0.2.0 daemon was up ten seconds
after that message). **Prepared, not deployed** (a lifecycle restart is needed): the heartbeat
and inbox-claim routes log at `warn` (the in-run driver of the 979 MB `daemon.log`; `buildDaemon`'s
`logger` option takes a `stream` so a test can read what would have been written),
`LUWI_GRAPHIFY_OUTPUT_PATH` (relative, no `..`/absolute/drive/UNC, refused at config time), and
`GET /api/v1/projects/discover?root=` — one directory level, read-only, the CLI's discovery moved to
`@luwi/runtime` so both share it — behind the `PROJECTS` menu's "Scan a folder…" (typed root, no
folder picker; each ticked folder registered through the existing `project-mutations.register`, so
no fifth write module). Until that restart the live daemon answers the discover route with 404 and
the panel shows the daemon's words.

**F3 (2026-09-17) added project unregister** — `DELETE /api/v1/projects/:projectId`, `luwi project
unregister <id> --yes`, "Unregister…" in the project drawer behind a `ConfirmDialog`; spec at
`docs/superpowers/specs/2026-09-17-project-unregister-design.md`. Unregister only: the files and
`.luwi` stay. `project-unregister-service.ts` refuses (409, scalar `details`) while a session is not
terminal, a lease is held, a coordinator is live or a message is in flight — **no force** — then
untracks the manifest first (`canonicalStore.untrackProject`; the opposite order lets a restart
re-register the project under a new id), purges the leaves through `packages/redis/src/project-purge.ts`
(plain commands, re-runnable, every key from `redis-keys.ts`), and ends with
`luwi_project_unregister_v1` (7 declared keys; refuses `raced` while the project's session set has a
member; appends `project.unregistered` to the global stream only). Three traps measured while
building it: `ApplicationError.details` admits scalars only — blocker id lists travel as one
comma-separated string; a one-pass purge that checked each session as it went deleted the first
terminal session before refusing on the second (the db15 zero-residue test caught it) — every
family now reads all its blockers before writing anything; and the usage metric counters are
**not** all aggregate — `metrics:project:<id>:…` and `metrics:session:<id>:…` (all-time and per
`day:`) carry the id in the key and go with the project, while agent- and workspace-scoped ones
stay. Released lease records were never indexed by project and stay (a retention concern).
The §7 review then added four guards: message hashes are **field-based** (`message_request` HSETs
them; a `json` read is always null), so the purge reads them with `HMGET` and refuses on a
non-terminal `state`; a blocker the purge meets after the untrack re-tracks the manifest and
answers the same 409 (not a 500 with the project silently untracked); the service waits, bounded
(10 s), for the background project refresh a session close schedules, so no scan writes evidence
after the project is gone; and an index member that fails `isSafeKeyPart` is removed from its index
and counted (`unsafeMembersDropped`) rather than interpolated into a key. Only `luwi_v1` stays
loaded on this server: integration runs load a per-run `luwi_test_run_<id>_v1` library and delete
it at teardown, so the live daemon keeps the Function set it started with.

`apps/daemon/src/app.ts` is the canonical route list (80+ endpoints). `AGENTS.md` §10 lists the
initial subset only.

## MCP — opt-in, not automatic

There is deliberately **no `.mcp.json`**. `apps/mcp-server/src/main.ts` calls
`verifyBoundSession()` _before_ connecting the transport, so it exits 1 without ever speaking MCP
unless the daemon is running and `LUWI_SESSION_ID` names a live, non-terminal session. Session IDs
are runtime identity, not configuration — they go stale on every daemon restart.

The server exposes 37 `luwi_*` tools, and "read-only" was never accurate for all of them: by the
daemon method each one calls, **25 are reads and 12 write** coordination state — the messaging
transitions, a bounded optimization analysis request, since ADR 0020 three of the four work-lease
tools, and since ADR 0034 `luwi_join`, which registers a successor for a dropped session. Counting
the messaging, optimization and lease families whole plus `luwi_join` gives 15, but three of their
members only read: `luwi_await_response` and `luwi_get_message` are `GET
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
