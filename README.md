# LUWI Runtime

LUWI Runtime is a local-first, single-user control and coordination runtime for developers
who use multiple AI coding agents across local projects. It coordinates tools such as Codex,
Claude Code, Gemini CLI, and Kimi; it does not replace or impersonate them.

> See every project. Coordinate every agent. Ship without collisions.

## Current status

Phase 5D — read-only project scope and intelligence routes — is implemented on the Phase 5B
realtime Pulse and the Phase 1–4 runtime foundation:

- strict TypeScript/ESM pnpm workspace with `protocol`, `runtime`, and `redis` packages;
- Fastify daemon bound to `127.0.0.1` with an owned lifecycle and explicit readiness states;
- Redis 7 Functions for atomic project/session projection and event transitions;
- canonical local-path project registration with atomic duplicate detection;
- opaque agent IDs, concurrent sessions, heartbeat sampling, TTL presence, and expiry;
- bounded global/project event Streams and a bounded dead-letter Stream;
- consumer-group recovery with continuous `XPENDING`/`XAUTOCLAIM` reinspection, validation,
  poison-entry retries, and post-acceptance acknowledgement;
- persistence-first, server-to-client WebSocket delivery with bounded per-client queues;
- CLI project, session, simulation, event-list, and event-watch commands;
- durable same-project request/reply with deterministic online-session routing;
- message projections, correlation/idempotency indexes, deadlines, and per-session inbox
  Streams;
- pending-until-terminal inbox delivery with `XAUTOCLAIM` recovery;
- delivered, acknowledged, processing, responded, rejected, failed, and timed-out states;
- bounded HTTP waits, timeout race protection, and pending/lag-aware message retention;
- CLI message/inbox commands plus manual, echo, and status-responder bridge simulations;
- a thin bound-session stdio MCP server that uses only the daemon HTTP API;
- filesystem-canonical AgentDefinitions, project-agent bindings, capability packages, and
  profiles with Redis operational projections;
- deterministic global/project inheritance, disable tombstones, dependency and
  compatibility errors, and per-value provenance;
- injected Codex, Claude Code, Gemini CLI, and Kimi adapters for passive detection,
  inspection, context discovery, and support matrices;
- bounded shell-free native version probes with a 2.5 second timeout, separate 64 KiB output
  limits, sibling-safe failure handling, and a Windows-only `.cmd`/`.bat` path that invokes
  only the canonical System32 command processor with fixed `/d /s /c` and literal
  `--version` arguments; native utility selection never searches ambient `PATH`, and bounded
  timeout/output cleanup verifies the exact owned process tree before reporting success;
- tested Codex and Claude Code native render subsets; Gemini CLI and Kimi native writes
  remain read-only;
- redacted ConfigPlans, one-time approvals, explicit unmanaged-file adoption,
  preconditions, bounded local snapshots, staged/fsynced atomic replacement,
  process/filesystem target locks, drift, rollback, and reconciliation;
- plan/artifact binding, snapshot-payload verification, pre-rollback snapshots,
  canonical managed-target ownership, and uncertain Redis-transition recovery;
- owned-startup validation and rebuild of Phase 3 Redis projections from canonical
  manifests;
- static context inventory with exact-hash duplicate groups and clearly labeled generic
  character estimates across instructions and assigned capability artifacts;
- HTTP/CLI management and eight project-bounded read-only Phase 3 MCP tools;
- normalized exact, reported, adapter-extracted, estimated, and unavailable usage records
  with idempotent ingestion and source-separated summaries;
- static context estimates plus explicit session/adapter observations that keep assigned,
  effective, loaded, invoked, and unknown states distinct;
- bounded read-only local Git observation, credential-redacted remotes, exact trailer and
  separately labeled correlated attribution;
- non-executing Node, Python, Dart/Flutter, PHP, Rust, and Go package/technology inventory
  with canonical-root containment, opened-handle `dev`/`ino` identity proof, and an
  independently enforced 2 MiB chunked limit for every manifest read;
- a provenance-bearing Redis operational graph with bounded traversal, failure diagnostics,
  and atomic shadow-generation rebuild;
- deterministic structural context findings and human-approved proposals that reuse Phase 3
  ConfigPlan, approval, snapshot, apply, drift, rollback, and reconciliation;
- non-causal post-change evaluation and project-scoped read-only Phase 4 MCP tools;
- per-project autopilot (ADR 0035): an operator-only mode, a filesystem-canonical policy
  (coordinator, workers, reviewer, operator proxies, protected paths, budgets), goals and tasks with
  compare-and-set Redis Functions (`luwi_v1` v13), two-step idempotent dispatch through the
  existing message path, deterministic verification, reviewer tasks, bounded rework, escalation
  with one open question, retrospectives, and `luwi session bridge orchestrator` — the LUWI-owned
  loop around a LuwiBot WebSocket or headless native brain;
- unit and opt-in Redis integration tests.
- a loopback-served React/TypeScript dashboard whose front door (ADR 0032, 2026-09-11) is an
  overview with five switchable lenses — Board, Flow, Radial, Timeline, Knowledge — over one pure model, a
  docked drill-down for the runtime, a project, an agent or a session, and a stream ticker; the
  twelve detail routes open as drawers over that overview, from the hero stat tiles, the drill-down's
  links and the stream ticker — there is no separate page; every comp claim the runtime
  cannot know (release readiness, lifecycle stage, task leases, 7-day trends, tokens summed across
  grades, a `running` status) is replaced by an observed fact or an honest `—`;
- independently validated observational health, project, session, agent, activity, usage,
  context, and optimization snapshots, plus narrowly isolated configuration, inter-session
  question, and project registration/settings mutations (the last through a `PROJECTS` menu that
  is also a persisted visibility filter with a hide-quiet rule, and projects are registered and edited in place inside the detail drawer);
- explicit loading, empty, partial, degraded, Redis-unavailable, daemon-unavailable, and
  WebSocket connection states;
- validated WebSocket events with first-live and reconnect refresh, bounded reconnect,
  512-stream-ID duplicate suppression, 200-row Activity retention, and 250 ms coalesced REST
  invalidation;
- live Activity follow/pause/resume, local bounded filters, and safe unknown-event display;
- a polite 750 ms aggregate Activity announcement region that ignores history and duplicates;
- read-only Project, Session, and Event inspectors whose selection stores only entity IDs and
  resolves every render from current authoritative snapshots, with bounded related Activity,
  project-coherent known-reference navigation, and bounded text-only payloads; the single
  60-second duration clock exists only for a current nonterminal Session with a finite,
  non-future `startedAt`;
- non-destructive `refreshing` state while retained data is revalidated by first-live,
  reconnect, realtime invalidation, or manual Retry; zero-safe-resource bootstrap is
  unavailable, and completion resolves to current, stale, or unavailable.
- a `#/projects` route with a project registry and on-demand project-scoped evidence: repository
  observation, commit attribution, bound agents, package inventory, and technology inventory, each
  loaded independently so one failure cannot erase its siblings;
- repository evidence rendered at the depth the observation carries — branches, tags, worktrees, and
  recent commits as labelled groups that each carry their own count, every worktree with its head
  and its detached or locked state, and branch and tag names in display-bounded lists that say how
  many were shown of how many exist;
- commit attribution reported as observed rather than asserted: a commit the runtime could not tie
  to a session is shown as unattributed with the reason it could not, never as a guess, and its
  grade is always readable as text;
- an explicit not-observed state for a project with no recorded Git scan, kept distinct from an
  unavailable read, so an unscanned project is never reported as a fault;
- disclosed truncation on every bounded project collection and per-tier confidence rendered as
  text rather than colour alone;
- project-scoped realtime refresh that runs only for the project currently on screen, with a
  generation guard that drops a response when the selection has moved on;
- dedicated read-only routes for sessions, agent definitions, usage, context, and optimization,
  where usage sources are never summed across differing provenance, context observations are shown
  as four independent counts rather than pipeline stages, and context token figures stay labelled
  as generic character estimates;
- agent kinds rendered verbatim, with no vendor label map or per-vendor branch anywhere in the
  dashboard.

The operational graph now has a bounded global read. `GET /api/v1/graph/summary` reports the
active generation, projection health, and exact per-kind node and edge cardinality, and the
`#/graph` route renders it. A graph that has never been built reports no totals rather than zero.

The graph also carries a code-structure layer. During a rebuild the daemon parses the project's
own TypeScript with the compiler API — it parses and never executes — and projects resolved
file-to-file imports and the module dependencies aggregated from them into the same generation as
the event-derived relationships, kept apart by provenance. An import it cannot resolve is recorded
as unresolved rather than pointed at the nearest plausible file.

ADR 0018 added `#/messages`, a view of inter-agent requests that renders what an
Activity row cannot: who asked whom, the subject and body, why the runtime selected that recipient,
the state, and the response with its own confidence. A rejected message is presented as an answer
rather than as a fault. The Sessions route can now dispatch one bounded `question` from an online
same-project source to an online target and opens the accepted correlation at
`#/messages/<correlationId>`; the daemon and durable inbox remain authoritative and the dashboard
does not inject text into an agent terminal. Selecting a bound agent on the Projects route opens
`#/projects/<id>/agents/<agentId>` and loads the effective configuration with its conflicts and
unsupported capabilities, plus the pair-scoped context summary and footprint — which is what makes
the binding's profile and capability counts openable rather than terminal.

`pnpm seed` populates an isolated fixture runtime over the daemon's own HTTP API so those surfaces
can be looked at before being called done. It refuses to run unless the daemon reports a fixture
workspace, because agent definitions, capabilities and profiles are filesystem-canonical and a
Redis database alone does not isolate them.

ADR 0019 closed the last two of those domains. `#/capabilities` renders the registered inventory —
every package with its kind, scope, source, and compatible agent kinds, and every profile with the
capabilities it names resolved to their real names. A profile reference with no match is reported
as beyond the loaded page or as not registered, which are opposite facts, and as unresolvable when
the catalogue read itself failed. `#/config` renders the native-configuration chain in the order a
reader needs it: drift first, classified from its two recorded hashes as an edit, a removal, an
unexpected file, or nothing at all; then plans with the redacted diff the daemon produced; then the
snapshots, where a file that did not exist before the apply is marked as such, because undoing that
apply is a delete and not a restore. `#/capabilities` offers no control at all; `#/config` was
read-only too until ADR 0021.

Every read-only domain the 2026-08-09 audit listed now has a dashboard consumer.

ADR 0020 added **advisory work leases**, the first coordination capability since request/reply. A
session claims a project-relative path before editing it; a claim that overlaps a held one is
refused and told who holds it, why, and until when. Conflict is containment in either direction, so
a lease over a directory and one over a file inside it are the same collision — while a sibling
whose name merely starts with the same characters is not. Acquire, renew, release and expire are
Redis Functions, so a race between two overlapping claims produces one grant and one denial rather
than two grants. Agents take leases through four MCP tools that derive the holder from the bound
session; the dashboard shows what is held and offers no control over it.

The lease is advisory. LUWI coordinates execution and does not inject into terminals, so an agent
that never asks still edits the file. What the runtime guarantees is an atomic answer and a record —
including `lease.denied`, which is the only evidence that a collision was prevented rather than
merely not observed.

ADR 0021 first made the dashboard capable of writing. `#/config` creates import and
render plans, prepares a rollback plan from a snapshot, rescans drift, and applies a plan behind a
confirmation that names every file the apply will write. Creating a plan touches nothing, so only
the apply is gated; a rollback is itself a plan and must pass the same gate, so an undo cannot skip
the review the forward change needed. The one-time approval token never outlives the gesture — the
client approves and applies inside one function and stores it nowhere — so an already-approved plan
is shown with no control rather than a button that would fail.

Two things followed. A `POST` that carries no `Origin` must now declare `application/json`, which a
browser cannot send cross-site without a preflight the daemon deliberately never answers; `PUT`,
`PATCH` and `DELETE` are unaffected because a cross-site one of those always preflights.
State-changing requests remain isolated: `api/config-mutations.ts` owns the configuration chain,
`api/message-mutations.ts` owns only `POST /api/v1/messages`, `api/project-mutations.ts` (ADR 0033)
registers and edits a project, and `api/coordinator-mutations.ts` (ADR 0035) claims and releases the
coordinator role. The static allowlist admits exactly those four modules.

ADR 0022 added **native session identity**. A client may declare its vendor-native
session reference when it registers a LUWI session; the runtime records a stable binding and an
immutable, time-bounded link for each LUWI session that reference produced. Identity carries no
presence, project or agent — a binding says who, never whether anyone is working. A live holder is
refused rather than evicted, a conflict writes nothing and creates no session, and a binding naming
an unreadable link is reported as inconsistent instead of treated as free. Validation runs before the
inbox stream is created, so a refused declaration leaves no trace at all. All three terminal paths
close the link, and every timestamp comes from one Redis clock.

Link retention bounds a binding at 1000 retained closed links, configurable through
`LUWI_NATIVE_LINK_RETENTION_MAX`. A periodic sweep removes the oldest closed links — at most 32 per
call — taking the index entry, the link record and the session reverse index together; an open link
is never removed, whatever the count.

ADR 0023 approved native transcript ingestion and its first increment is built: **an
already-registered, live session can declare its native identity after the fact** through
`POST /api/v1/sessions/:sessionId/native` (B0). The route takes the same `native` block registration
takes and, by strict schema, nothing else — a body cannot redirect the declaration at another
session. The same policy that decides at registration decides here, unchanged; re-declaring the same
identity returns `unchanged` and writes nothing, so declaring on a timer or at startup is safe. The
CLI's `session register` and `session simulate` accept `--native-adapter`, `--native-session` and
`--native-subagent`, and the seed declares for one seeded session so the fixture holds a binding
and a real attribution interval. The link starts open and may be closed by the normal presence
sweeper when the seeded session expires.

**The transcript reader (B1) is built, so token usage is attributed to sessions.** A background scan
on `LUWI_TRANSCRIPT_SCAN_INTERVAL_MS` (default five minutes) reads Claude Code's native transcripts —
each project tree including its nested `subagents/` directories — and records **one usage entry per
request**, not per record. Each entry is attributed to the LUWI session whose native link interval
contains the moment the request was observed. Claude's additive cache counters are recorded in their
own `cacheCreationInputTokens` and `cacheReadInputTokens` fields. Only counters and identifiers leave
the reader; **no prompt or response text is ever stored or logged**, and nothing found beside a
transcript is executed. Evidence that no interval covers stays **unbound** and is counted rather than assigned
to the nearest session — including a record inside an interval that link retention has trimmed. A
session that never declares its native identity stays unattributed, which is the honest outcome
rather than a defect. Each scan reads at most 2000 changed files and 16 MiB per file by default;
files skipped by the scan cap, byte-truncated files, malformed lines, and files stopped by the
100-malformed-line safety cap are reported separately. These bounds are configurable through
`LUWI_TRANSCRIPT_MAX_FILES_PER_SCAN` and `LUWI_TRANSCRIPT_MAX_FILE_BYTES`; the malformed-line cap is
currently fixed.

**Tool and file observation (B2) is built too**, so `SESSION_CHANGED_FILE` has a producer at last. A
second extraction over the same one file read pairs each `tool_use` with its `tool_result` and turns
an allowlisted mutating tool call (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) with a present,
non-error result into a file-change observation, reading only the path out of the tool input — never
its prose. The daemon attributes each change through the same native-link interval usage uses, scopes
the absolute path to a registered project, and persists a bounded per-(session, file) aggregate; the
operational-graph rebuild reads those aggregates and projects `SESSION_CHANGED_FILE` edges onto the
same `file` node the code-structure layer already produces, so a tool call observed in a transcript —
which is not the same as observing the filesystem — becomes an edge without a new node or edge kind. A
session that never declares its native identity still contributes nothing.

Automatic drift reconciliation, Git mutation, lifecycle/release scoring, release readiness,
unified search, GitHub integration, prompt injection, a semantic knowledge graph, memory
federation, cloud accounts, and authentication are not implemented. Task orchestration is
implemented as per-project autopilot (ADR 0035, `docs/guides/autopilot.md`): an operator-held
mode, a canonical policy, goals and tasks, a LUWI-owned orchestrator loop with a pluggable brain,
and human-in-the-loop approval through the CLI or a LuwiBot session named as an operator proxy;
it has no dashboard section yet. Optimization
accept/reject/evaluate, graph rebuild, lease release and `config/reconcile` (interrupted-apply
recovery, run at daemon start) exist on the HTTP API and CLI but are deliberately not dashboard
mutations. Dashboard writes are the config plan chain, bounded question creation, project
registration and settings (ADR 0033: name, remote and default branch; never the path), and
coordinator assignment (ADR 0035); it does not acknowledge, process, answer, retry, cancel, or inject
a message. Work leases are renewed automatically by their holder (ADR 0026) but do not notify when a
held path frees and are not correlated with the commits made under them.

ADR 0025 then landed the CLI-first tranche. `luwi doctor|setup|start|status|stop|reset` is the
recommended golden path; `stop` reaches the daemon through a token-gated `POST /api/v1/runtime/stop`
that refuses a daemon it did not start (`DAEMON_LIFECYCLE_UNMANAGED`) and a caller whose ownership
token does not match (`DAEMON_LIFECYCLE_FORBIDDEN`), the token compared in constant time.
`luwi reset --runtime-state` clears operational state through a daemon-boundary maintenance entry
that only ever removes keys under `luwi:v1:` and refuses while a daemon is running, so a non-LUWI key
in the same Redis database survives it. `luwi project discover` reads one directory level, dry-run
first, and applies through the existing project HTTP API. Capability observation scans declared roots
read-only, marks what it finds `observed`, executes nothing it discovers, and feeds a real
`capabilities/scan` mutation. The dashboard's list-to-detail surfaces now open in a genuinely modal
detail drawer instead of a docked Inspector column; the bounded Ask flow the two-module allowlist
above already names is reachable from Pulse. An experimental `session bridge deepseek` registers one
DeepSeek Harness ACP process as one ordinary LUWI session — fresh sessions only, no history import, no
ACP-time MCP injection, and no DeepSeek dependency outside the CLI.

ADR 0026 then made work-lease renewal automatic and holder-side. The session bootstrap that keeps an
`agent run` or `session attach` session alive gained a second timer beside the heartbeat: it renews
every lease the current session holds at half the default lease TTL, listing the held-only
session-lease index each tick and re-reading the bound session id so a rotation never renews a dead
session's lease. A clean exit stops renewing and lets the leases lapse, exactly as a crash does; a
failed renewal is surfaced once and never retried forever. It reuses the existing renew endpoint and
Redis Function unchanged — no protocol or datastore change, just a `--lease-renew-ms` client setting.
Notification when a held path frees and lease-to-commit correlation are deferred with reasons in the
decision record.

ADR 0027 then added **opt-in Windows autostart**, the last item in the completion sequence.
`luwi setup --autostart` registers a per-user logon Scheduled Task named `LUWI Runtime` that runs the
same idempotent `luwi start`; `luwi setup --no-autostart` removes it; and `luwi setup` with neither
reports the current state without changing it, so autostart is never a side effect. It is a task, not a
service or a supervisor — no elevation, no detached session, no persistent LUWI process, and no change
to the daemon, its owner lease, or the datastore. `schtasks` is a fixed system command spawned through
the existing command seam with a constant task name and the CLI entry derived from the installation
root, so no user-controlled string reaches the scheduler. It is Windows-only and reports `unsupported`
elsewhere rather than pretending to succeed.

ADR 0028 then recovered **Codex's native session identity from disk**. Codex Desktop and the VSCode
extension export no session-id variable, so after the environment resolver returns nothing a strict
filesystem fallback matches the freshest Codex rollout for the working directory and binds its stable
`session_id`; a stale, absent or foreign match binds nothing. Gemini CLI has no per-session identity
and stays honestly unbound. No daemon, protocol or datastore change.

ADR 0029 then made **graphify's output a read-only structural source**. Where a registered project
holds `graphify-out/graph.json` — built by the developer with graphify's offline extractor, refreshed
by graphify's own git hooks — the graph rebuild reads it beside the TypeScript observer and projects
file nodes and file-level import edges into the existing kinds, so sessions, commits and agents join
code structure in every language graphify covers. LUWI never runs graphify, its MCP server or its
model backends; the reader validates every entry, drops any path that is not a real file inside the
project, carries imports at `medium` or `low` (never `high`, since graphify resolves by name), and
fills gaps without replacing what the structural observer resolved. The Graph explorer names the
origin "Graphify output — read, never run". Its first live rebuild also fixed two latent defects: the
rebuild lock is now renewed for as long as a rebuild runs and a failed rebuild records why, and the
projection no longer stalls the event loop long enough to lose the daemon owner lease on a
20 000-file project.

The Runtime route then gained **what the machine has and what LUWI costs on it**: CPU model, cores
and busy share, memory, the free space on the volume holding LUWI's state, NVIDIA GPUs when
`nvidia-smi` answers, the daemon's own resident memory and CPU share, and Redis memory and key count
— over `GET /api/v1/runtime/resources`, refreshed every ten seconds. Everything is read from the
standard library, the daemon's own process and two Redis replies; the one command is a fixed
`nvidia-smi` query, and a source that is absent leaves its field absent rather than reporting a zero.

Sessions then started **binding themselves from the launcher's side**. `luwi session attach` takes no
arguments inside a registered project: the project is the one containing the working directory, the
vendor is the first identity that resolves, and `--native-adapter` / `--native-session` let a
launcher that already holds the vendor's own id declare it outright, skipping every resolver. Two
hook scripts under `scripts/` use that: `claude-attach-hook.mjs` attaches a Claude Code session on
`SessionStart` and stops it on `SessionEnd`, forwarding the hook's session id; and
`antigravity-attach-hook.mjs` attaches an Antigravity conversation on `PreInvocation` — Antigravity
signals no session start or end, so the hook is idempotent per conversation and its supervisor lets
the session lapse after thirty minutes without a transcript change. Neither script is installed by
LUWI; the developer registers them in `~/.claude/settings.json` and `~/.gemini/config/hooks.json`.
Both now exit at once when they inherit a `LUWI_SESSION_ID`, so a process launched under a LUWI
session never registers a second, reader-less one.

ADR 0031 then made an agent's inbox **answer itself**. `luwi session bridge native <claude|codex|gemini>`
holds one long-lived LUWI session (through the same bootstrap `agent run` uses) and, for each message
it claims, runs the native CLI once headless — `claude --print`, `codex exec`, `gemini --prompt` —
inheriting `LUWI_SESSION_ID` so the child's own `luwi-runtime` MCP server completes the message. The
bridge writes only what the child left unfinished, as an honest `failed` naming the exit code,
deadline, or operator stop; it never writes `answered`. Everything after `--` reaches the native CLI
unchanged as its whole permission model, and the bridge starts a new process rather than typing into
any terminal. A message to a bridged agent is now picked up within one claim block instead of waiting
for a human to say "check your inbox", and because the bridge keeps its session `idle`, target
selection has one clear candidate instead of the newest arbitrary heartbeat. It adds no daemon,
protocol, Redis, or dependency change. `agy` is not installed on this machine, so only claude and
codex are proven live; the `gemini` shape is carried, not verified.

**Sleep/wake-safe lifecycle:** if sleep expires a daemon owner key, the existing daemon can
atomically reacquire that key only when it is vacant; it never replaces another owner's token. If
session presence expired, `SESSION_NOT_FOUND` or `SESSION_TERMINAL` rotates observation to a new
LUWI session without transferring work leases. `luwi session attach` bounds discovery, registration,
heartbeats, cleanup, lease listing, and lease renewal with `--connect-timeout-ms` (2,000 ms by
default), and disarms its timers before its bounded best-effort cleanup. `agent run` and Claude have
exact native-end signals; Antigravity has none, so its existing helper remains bounded by 30 minutes
without activity. An attach-owned MCP process uses the absolute `--session-out` path as
`LUWI_SESSION_FILE`; the MCP server re-reads that atomically replaced file for every tool call, so a
rotation does not strand it on the terminal predecessor. Claude, Codex, and Antigravity launchers use
this path for the attach sessions they own. Antigravity's application-global MCP remains limited to
the conversation selected when that launcher starts; file rotation does not add cross-conversation
routing.

**Dashboard overview, lenses, and the knowledge graph:** the dashboard is a single overview at
`#/pulse` rendered from one pure model, with a 56 px header, a docked drill-down, and a stream
ticker. The main canvas is one of five switchable lenses over that model: Board, Flow, Radial,
Timeline, and Knowledge. The Knowledge lens shows one project's graphify knowledge graph, read-only:
nothing focused draws the projects as clickable discs, and focusing one opens its bounded
god/hub/symbol community graph read from `graphify-out/graph.json`; LUWI reads that output and never
runs graphify. The twelve detail routes (sessions, agents, usage, context, optimization, graph,
messages, capabilities, config, projects, runtime, activity) open as drawers over the always-mounted
overview — from the hero stat tiles, the drill-down's links and the stream ticker — and their hashes
still deep-link and reload; a message, package, profile, plan or snapshot detail opens inline inside its
drawer rather than as a second one.
The dashboard writes only its own four mutation surfaces: config plan/approve/apply/rollback,
message transitions, project registration and settings (name, remote, and default branch, never
the path), and coordinator claim and release. A reader that never became ready is dropped rather
than left as a zombie, and `luwi_join` revives a dropped session from its own record so a GUI agent's
inbox keeps answering after a restart.

**Fleet coordination (ADR 0035 and the 2026-09-16 tranche):** a project may have **one
coordinator** — an enforced single-holder role in `luwi:v1:project:{id}:coordinator`, claimed and
released through two Redis Functions behind `POST`/`DELETE`/`GET
/api/v1/projects/:projectId/coordinator`. A live holder is refused with `409 COORDINATOR_CONFLICT`
naming it, a terminal holder is taken over, and a release is holder-only. Each claim carries its own
nonce, so a takeover decided against a dead holder can never evict a newer live one that happened to
reuse the same version number. The sessions view assigns and releases the role and badges the live
holder, and the overview's session drill-down offers the same switch where the reader is looking;
that is the fourth and last dashboard write module. The native bridge now prepends the work
leases **other** sessions hold to each headless worker's prompt, so a worker sees which paths are
locked before it edits — best-effort, and never a reason to fail a message. Every `ask` states its
`delivery`: `live` when the target is a bridge (a continuous reader), `deferred` when it is a
turn-based GUI whose inbox is read only on its next turn — and `luwi_ask_agent` returns at once for
a deferred target instead of burning its wait into a false timeout. The overview's hero tile reports
delivery **facts** — answered share, p50 latency, failed-or-timed-out share — never a score. Each
session also states how it reached the runtime (`cli`, `gui`, `ide` or `bridge`): from an explicit
marker where the launcher knows it, otherwise derived from the signals the runtime already carries;
the sessions view shows it as a chip and the radial node carries it in its hover hint. Orchestrating
an implement → verify chain stays **outside** the repository, in a script that sends independent
correlated messages as the coordinator and stops before any merge; the daemon still orchestrates
nothing.

**Registering projects from the dashboard, and two operational knobs:** the `PROJECTS` menu's
"Scan a folder…" lists one directory level under a typed root through
`GET /api/v1/projects/discover?root=` — the same one-level discovery the CLI's `project discover`
uses, now shared from `@luwi/runtime` — marks what is already registered or cannot be registered,
and registers each ticked folder through the ordinary `POST /projects`, one at a time, so a refusal
is reported on its own row. There is no folder picker, because a browser cannot read the machine's
directories. The dashboard also watches the build it is served: an open tab that outlives a
`pnpm build` shows `NEW BUILD · RELOAD` in its header instead of silently running stale code. On the
daemon, the heartbeat and inbox-claim routes log at `warn`, so a healthy poll no longer writes two
lines per request into `daemon.log`, and `LUWI_GRAPHIFY_OUTPUT_PATH` names where graphify's
`graph.json` is read inside each project — relative, and kept inside the project.

**Unregistering a project:** `DELETE /api/v1/projects/:projectId`, `luwi project unregister <id>
--yes`, and "Unregister…" in the dashboard's project drawer make the registry forget a project and
the evidence LUWI collected about it — sessions, leases, messages, usage and its project- and
session-scoped counters, git observations and commits, attributions, file-change observations,
packages, technologies, context contributions, findings and proposals, the project's bindings and
capabilities, and the coordinator role — while the project's files and its `.luwi` directory stay
exactly as they are. The daemon refuses, naming what blocks it, while a session is not terminal, a
lease is held, a coordinator is live or a message is in flight; there is no force. The canonical
manifest is untracked first, so a restart cannot re-register the project; the leaves go in
re-runnable batches that read every blocker before writing anything; and one Function ends it
atomically, refusing if a session registered in between, and appends `project.unregistered` to the
global stream only. The operational graph heals at its next rebuild; native bindings, released
lease records and the agent- and workspace-scoped counters are left alone; and the folder can be
registered again at once.

**Flow roles and skills (ADR 0036):** a project-agent binding carries, beside its free-text `role`,
`flowRoles` — `implementer` and/or `verifier` — which the repository-external implement→verify
script reads to choose who implements and who verifies; the coordinator stays a session claim, not
a binding role, and the daemon records the roles without enforcing how many verifiers a project
has. Set them with `luwi projects agent update <projectId> <bindingId> --body
'{"flowRoles":["verifier"]}'` or with the toggles in the project drawer's "Bound agents" table. The
same drawer's Skills panel now enables or disables a capability package (not an observed one — its
`SKILL.md` is the truth), assigns or unassigns it to the project or to the selected agent, and
rescans the native skill directories, all through the existing capability endpoints. LUWI never
writes a `SKILL.md`.

**Re-dispatch links and evidence (ADR 0037):** a message may declare `retryOf`, the correlation id
of an earlier exchange it re-asks (`luwi message ask --retry-of <id>`, `luwi_ask_agent` `retryOf`);
the daemon refuses a link to a missing, foreign or still-running exchange and records the rest as a
fact. The overview's Delivery tile states how many recent exchanges were re-dispatched and what
share of answered ones carry `test_result` or `build_result` evidence, and `#/messages` lists the
evidence types a response attached. Nothing re-dispatches on its own and nothing validates the
evidence; the repository-external flow script declares the link and asks its verifier to attach
what it ran.

## Architecture and security

Redis is the only runtime datastore. It is the operational database, durable event bus,
coordination fabric, and projection store. Git and the local filesystem are canonical only
for source code and configuration.

Only the daemon receives Redis credentials. HTTP and WebSocket clients use the versioned
local API. The daemon:

- accepts only `HOST=127.0.0.1`;
- validates exact loopback `Host` and browser/WebSocket `Origin` values;
- rejects wildcard origins and `Origin: null`;
- requires `content-type: application/json` on a `POST` that carries no `Origin`, and serves no CORS
  header and no `OPTIONS` handler, so a cross-site mutation cannot pass the preflight it needs;
- does not log Redis URLs, secrets, complete prompts, or unbounded payloads;
- atomically acquires, and may atomically reacquire only a vacant, TTL-backed single-daemon owner
  lease before bootstrap mutation; neither operation replaces another owner's token.

After `pnpm build`, the daemon serves the dashboard overview at `http://127.0.0.1:4782/`. For frontend
development, start the daemon with
`LUWI_ALLOWED_ORIGINS=http://127.0.0.1:4782,http://localhost:4782,http://127.0.0.1:4783`, then
run `pnpm dev:dashboard` in a second terminal. Vite binds to `127.0.0.1:4783`; `/api` proxies
HTTP and WebSocket traffic to `127.0.0.1:4782`, while `/health` proxies HTTP only. The
proxy normalizes only the upstream Host; the browser Origin is still validated exactly. The
development origin is explicit and is not part of production defaults. See the [Phase 5 dashboard architecture](docs/phase5-dashboard-architecture.md),
[realtime contract](docs/phase5-dashboard-realtime-contract.md), and
[capability matrix](docs/phase5-dashboard-capability-matrix.md).

Redis Streams are durable and recoverable. WebSocket delivery is best-effort realtime
delivery: an `XACK` confirms validated relay processing and queue acceptance, not browser
rendering or network receipt. Clients obtain current project/session snapshots after
connecting.

See [the architecture overview](docs/architecture/overview.md), [ADR
0004](docs/decisions/0004-redis-only-local-runtime.md), and [ADR
0005](docs/decisions/0005-redis-native-operational-core.md). Phase 3 configuration safety
and inheritance are defined by [ADR 0007](docs/decisions/0007-filesystem-canonical-agent-config.md)
and [ADR 0008](docs/decisions/0008-capability-scope-and-inheritance.md).
Phase 4 graph, optimization, and local Git boundaries are defined by [ADR
0009](docs/decisions/0009-event-derived-operational-graph.md), [ADR
0010](docs/decisions/0010-context-optimization-feedback-loop.md), and [ADR
0011](docs/decisions/0011-local-git-observation-and-attribution.md). The code-structure observer,
its parser dependency, and the alternatives rejected for it are recorded in [ADR
0012](docs/decisions/0012-code-structure-observer.md). The bounded global graph summary, and the
alternatives rejected for it, are recorded in [ADR
0013](docs/decisions/0013-bounded-global-graph-summary.md), and the projection-input gaps it
left behind — with the two that were deliberately not built — in [ADR
0014](docs/decisions/0014-complete-graph-projection-inputs.md).

## Prerequisites

- Node.js 22 or newer;
- pnpm 11;
- Git;
- standard Redis 7 or newer through `REDIS_URL`.

Docker is optional. `compose.yaml` provides standard Redis with AOF and a persistent volume.

## Install

```text
pnpm install --frozen-lockfile
```

The daemon reads environment variables directly; it does not load a real `.env` file. Copy
the relevant values from `.env.example` into your shell or process manager.

Defaults:

```text
HOST=127.0.0.1
PORT=4782
REDIS_URL=redis://127.0.0.1:6379
LOG_LEVEL=info
WORKSPACE_ID=local
```

`LUWI_HOME` and `LUWI_NATIVE_HOME` are optional. Normal operation uses `~/.luwi` and the OS
home. Tests and the Phase 3 demo set both to temporary sandbox roots.

Remote binding is intentionally unsupported in local mode.

## CLI-first local lifecycle

Build once, then use the lifecycle CLI as the recommended local path:

```text
pnpm build
pnpm --filter @luwi/cli dev -- doctor
pnpm --filter @luwi/cli dev -- setup
pnpm --filter @luwi/cli dev -- start
pnpm --filter @luwi/cli dev -- status
```

`setup` shows the exact LUWI-owned target and asks before writing. `--yes` is the scoped
non-interactive approval. It writes a versioned `runtime/config.json` under `LUWI_HOME`
(normally `~/.luwi`) and never edits `.env` or Claude, Codex, or Gemini files. Optional
wrapper examples are printed by `setup --print-hooks` for manual use.

For the default `redis://127.0.0.1:6379`, `start` uses the existing `compose.yaml`, waits for
Redis, starts the built daemon, and records private lifecycle ownership only after the daemon
reports ready with the expected startup identity. A bounded atomic lifecycle lock prevents
concurrent `start`/`stop` ownership races. A compatible daemon already running is success but is
not silently adopted. An external loopback Redis URL is never started or stopped by LUWI.

Stop the CLI-owned daemon while keeping Redis and its AOF-backed state warm:

```text
pnpm --filter @luwi/cli dev -- stop
```

Stop the Compose Redis container too, without deleting its named volume:

```text
pnpm --filter @luwi/cli dev -- stop --with-redis
```

A runtime-only clean installation is explicit and dry-run-first. The daemon must be stopped:

```text
pnpm --filter @luwi/cli dev -- reset --runtime-state --json
pnpm --filter @luwi/cli dev -- reset --runtime-state --yes --json
pnpm --filter @luwi/cli dev -- start
```

The first reset command only reports the number of keys matching the fixed `luwi:v1:*`
namespace. Without `--yes`, JSON mode cannot delete anything. The approved command uses bounded
`SCAN` plus `UNLINK`; it never accepts a caller-controlled namespace and never calls `KEYS`,
`FLUSHDB`, or `FLUSHALL`. It deletes LUWI runtime projections and history, while preserving
canonical LUWI files, every project file, the Redis database/volume, and all non-`luwi:v1:*`
keys. On restart, canonical projects are restored before project-agent bindings and other
dependent control-plane projections.

Project discovery is one-level, passive, and also dry-run-first. For the approved XAMPP layout,
review the JSON output before adding `--apply`:

```powershell
pnpm --filter @luwi/cli dev -- project discover C:\xampp\htdocs `
  --exclude dashboard --exclude img --exclude webalizer --exclude xampp `
  --exclude luwi-clients --exclude luwi-themes-inspect `
  --name "arshahomes=Arsha Homes" --name "corenine=Corenine" `
  --name "flybydeniz=Fly by Deniz" --name "glasshouse=Glasshouse" `
  --name "luwi-dev=LUWI Dev" --name "luwilisting=LUWI Listing" `
  --name "luwipress=LUWI Press" --name "luwiruntime=LUWI Runtime" `
  --name "luwistudio=LUWI Studio" --name "semantic-bridge=Semantic Bridge" --json
```

Repeat the same command with `--apply` only after the selected, excluded, and invalid arrays are
correct. Apply registers only missing canonical paths, reports existing paths as `unchanged`, and
runs the existing read-only Git observation for each selected project. A non-Git folder is reported
as `not_git`; project contents are never changed.

The lifecycle CLI never uses Redis protocol credentials. Redis connectivity and Function
compatibility are accepted only after the daemon verifies them. Shutdown uses a private
loopback ownership token and the daemon's existing graceful drain path; stale or mismatched
ownership is refused rather than converted into an unverified PID kill. See the [CLI
lifecycle guide](docs/guides/cli-lifecycle.md) for recovery and file locations.

## Start Redis

With Docker:

```text
docker compose up -d redis
docker compose ps
```

The service publishes only `127.0.0.1:6379`, enables `appendonly yes` with
`appendfsync everysec`, and stores `/data` in `luwi-redis-data`. `docker compose down` keeps
the volume.

An existing standard Redis server also works:

```text
REDIS_URL=redis://127.0.0.1:6379
```

Do not expose Redis on a non-loopback interface.

## Run on Windows PowerShell

Windows native-probe cleanup uses validated canonical paths under the canonical Windows
system directory for `cmd.exe`, `taskkill.exe`, and the fixed non-interactive process-snapshot
PowerShell helper. It never falls back to a same-named program on `PATH`. A timed-out or
output-limited probe has a five-second total cleanup budget: taskkill alone is not success;
the runner must verify that the root and all known descendants are absent, or return
`failure: cleanup`. The reusable early-root-close stress proof runs 25 iterations by default:

```powershell
pnpm test:windows-cleanup-stress
```

Terminal 1:

```powershell
$env:REDIS_URL = "redis://127.0.0.1:6379"
pnpm --filter @luwi/daemon dev
```

Terminal 2:

```powershell
Invoke-RestMethod http://127.0.0.1:4782/health
pnpm --filter @luwi/cli dev runtime
```

## Run on macOS or Linux

Terminal 1:

```sh
export REDIS_URL=redis://127.0.0.1:6379
pnpm --filter @luwi/daemon dev
```

Terminal 2:

```sh
curl --fail-with-body http://127.0.0.1:4782/health
pnpm --filter @luwi/cli dev runtime
```

## CLI examples

```text
pnpm --filter @luwi/cli dev -- doctor --json
pnpm --filter @luwi/cli dev -- status --json
pnpm --filter @luwi/cli dev -- agent run claude -- <native arguments>
pnpm --filter @luwi/cli dev -- agent run codex -- <native arguments>
pnpm --filter @luwi/cli dev -- agent run gemini -- <native arguments>
pnpm --filter @luwi/cli dev -- capability scan

pnpm --filter @luwi/cli dev project register --name "LUWI Runtime" --path .
pnpm --filter @luwi/cli dev project list
pnpm --filter @luwi/cli dev project get <projectId>

pnpm --filter @luwi/cli dev session register --project <projectId> --agent codex-sim --working-directory .
pnpm --filter @luwi/cli dev session list --online
pnpm --filter @luwi/cli dev session heartbeat <sessionId>
pnpm --filter @luwi/cli dev session status <sessionId> tool_running
pnpm --filter @luwi/cli dev session close <sessionId>

pnpm --filter @luwi/cli dev message ask --source <sourceSessionId> --target-agent gemini-sim --kind question --content "Project status?" --wait-ms 30000
pnpm --filter @luwi/cli dev message list --project <projectId>
pnpm --filter @luwi/cli dev message get <correlationId>
pnpm --filter @luwi/cli dev message await <correlationId> --wait-ms 30000

pnpm --filter @luwi/cli dev inbox claim --session <targetSessionId> --bridge-instance manual-1
pnpm --filter @luwi/cli dev message acknowledge <correlationId> --session <targetSessionId>
pnpm --filter @luwi/cli dev message processing <correlationId> --session <targetSessionId>
pnpm --filter @luwi/cli dev message respond <correlationId> --session <targetSessionId> --answer "Simulated answer."

pnpm --filter @luwi/cli dev session bridge simulate --session <targetSessionId> --bridge-instance gemini-bridge --mode status-responder

pnpm --filter @luwi/cli dev lease acquire --project <projectId> --session <sessionId> --path src/app.ts --reason "editing the shell"
pnpm --filter @luwi/cli dev lease list --project <projectId>
pnpm --filter @luwi/cli dev lease renew <leaseId> --session <sessionId>
pnpm --filter @luwi/cli dev lease release <leaseId> --session <sessionId>

pnpm --filter @luwi/cli dev events list --limit 100
pnpm --filter @luwi/cli dev events watch

pnpm --filter @luwi/cli dev agent detect
pnpm --filter @luwi/cli dev agent list
pnpm --filter @luwi/cli dev project agent effective <projectId> <agentId>
pnpm --filter @luwi/cli dev capability list --project <projectId>
pnpm --filter @luwi/cli dev profile list
pnpm --filter @luwi/cli dev config inspect --body '{"agentId":"codex-main","projectId":"<projectId>"}'
pnpm --filter @luwi/cli dev context footprint <projectId> codex-main

pnpm --filter @luwi/cli dev usage summary --project <projectId>
pnpm --filter @luwi/cli dev context analyze --project <projectId> --agent codex-main
pnpm --filter @luwi/cli dev git scan --project <projectId>
pnpm --filter @luwi/cli dev package scan --project <projectId>
pnpm --filter @luwi/cli dev graph rebuild
pnpm --filter @luwi/cli dev graph neighbors project <projectId> --direction out
pnpm --filter @luwi/cli dev optimize analyze --project <projectId> --agent codex-main
```

`agentId` is a validated opaque logical identifier. Session registration does not require or
create an AgentDefinition record.

The complete two-session acceptance walkthrough is in [the Phase 1 demo
guide](docs/guides/phase-1-demo.md).

The Phase 2 request/reply and MCP walkthrough is in [the Phase 2 demo
guide](docs/guides/phase-2-agent-communication-demo.md).

The sandboxed Phase 3 walkthrough, including Phase 1/2 regressions and uncertain Redis
completion recovery, is in [the Phase 3 demo
guide](docs/guides/phase-3-agent-capability-demo.md). After `pnpm build`, run
`pnpm demo:phase3` against an explicit local Redis test URL.

The Phase 4 temporary-repository intelligence and optimization walkthrough is in [the Phase
4 demo guide](docs/guides/phase-4-intelligence-demo.md). After `pnpm build`, run
`pnpm demo:phase4`. It labels all telemetry as simulated, applies configuration only through
an explicitly approved Phase 3 plan, and cleans its run-specific Redis/filesystem state.

### Experimental DeepSeek Harness ACP bridge

The CLI can opt one DeepSeek Harness ACP process into LUWI as one ordinary session. This is
an edge adapter: the daemon, Runtime, protocol, Redis model, and native configuration remain
unchanged, and LUWI does not depend on a DeepSeek package. The CLI alone uses the official
vendor-neutral ACP SDK version used by the current DeepSeek Harness implementation.

The DeepSeek Harness repository currently provides its ACP server through `pnpm run
demo:acp`. With the daemon running, a registered project, and the DeepSeek repository already
installed and configured with its own provider credentials, a PowerShell launch looks like:

```powershell
pnpm --filter @luwi/cli dev -- session bridge deepseek `
  --project <projectId> `
  --agent deepseek-harness `
  --working-directory C:/absolute/project/path `
  --bridge-instance deepseek-bridge-1 `
  --command pnpm.cmd `
  --args-json '["--dir","C:/absolute/deepseek-harness","run","demo:acp"]'
```

The command registers the LUWI session, starts one ACP process, creates one fresh ACP
session, declares its returned id as `deepseek-harness-acp-v1`, heartbeats, consumes the
durable inbox serially, and closes both sides on `SIGINT`/`SIGTERM`. It prints identifiers and
lifecycle facts only, never prompt or answer bodies. ACP permission requests default to
`reject`; `--permission allow-once` is an explicit opt-in and selects only an offered
one-shot allow choice.

ACP startup, cancellation, protocol-frame size, response size, and each prompt's durable LUWI
message deadline are bounded. A recovered request already in `processing` is failed without
replaying potentially side-effecting ACP work. On Windows, planned shutdown uses LUWI's
existing creation-time-verified owned-process-tree cleanup; an unexpected root exit is
reported as unverified cleanup rather than silently treated as clean.
Signal handlers are active before ACP initialization and abort startup through the same
rollback path. Valid JSON is admitted to the ACP SDK only after its supported inbound envelope
and parameters validate; invalid frames are rejected with a redacted error.
Only the typed, fully cleaned startup-cancellation path exits quietly; an unverified process or
LUWI-session cleanup is propagated as a command failure.

DeepSeek Harness currently rejects non-empty ACP `mcpServers`, so this bridge does not inject
LUWI tools during `session/new`. To give that DeepSeek composition LUWI MCP tools, configure
its existing `@deepseek-ai/dsh-mcp-client` plugin to launch
`apps/mcp-server/dist/main.js`. Map `LUWI_SESSION_ID` and `LUWI_DAEMON_URL` from the parent
process in that Cordis configuration; the bridge sets both before it starts DeepSeek. This is
an explicit DeepSeek-side configuration choice and LUWI never edits it.

This surface is experimental because DeepSeek Harness is in developer preview and supports
fresh ACP sessions only. It intentionally does not resume/import history, manage Cordis,
install MCP configuration, or add a general orchestration framework.

### MCP server

The MCP server is a stdio process bound to one existing online LUWI session. Use exactly one binding
source: a static ID for a session whose lifecycle is owned elsewhere, or an absolute rotating file
written by `session attach --session-out`:

```text
LUWI_DAEMON_URL=http://127.0.0.1:4782
LUWI_SESSION_ID=<registeredSourceSessionId>
# or: LUWI_SESSION_FILE=C:/absolute/per-user/session.out
LUWI_MCP_REQUEST_TIMEOUT_MS=30000
pnpm --filter @luwi/mcp-server dev
pnpm --filter @luwi/mcp-server harness
```

It exposes project/session discovery, ask/await/get, durable inbox claim, responder tools,
and project-bounded read-only AgentDefinition/capability/effective-config/context/drift,
usage, Git, package, technology, graph, and optimization-inspection tools. A bounded
optimization-analysis request is available, but proposal acceptance, plan approval/apply,
rollback, graph rebuild, and Git mutation are not exposed. The server never connects to
Redis, accepts a source/responder override for bound mutations, or starts for a missing,
offline, or terminal bound session. It revalidates that binding before every tool
operation. File-backed mode reads one secure filesystem snapshot per operation and rejects symbolic
links, malformed or oversized content, non-regular files, and non-private POSIX modes. The startup
session's project remains the immutable project boundary across rotations. Build first, then pass a
tool name and JSON object to `harness` for a concrete
stdio test.

Every tool advertises and validates an output schema. Successful results use MCP
`structuredContent` plus a concise bounded text summary; project and session discovery
results are capped at 100 entries and explicitly report truncation.

The inventory is 37 tools: 25 read and 12 write coordination state (the seven messaging
transitions, `luwi_join`, a bounded optimization-analysis request, and three of the four
work-lease tools). Control-plane writes — config approval and apply, rollback, graph rebuild, Git
mutation — are never exposed. The graph surface carries the two rooted reads (neighbors
and path); the whole-runtime summary and subgraph reads stay on the HTTP API and CLI.

To register the server with Claude Code, build first (`pnpm build`), have the daemon
running and a session registered, then either use the CLI:

```text
claude mcp add --scope local luwi-runtime \
  --env LUWI_DAEMON_URL=http://127.0.0.1:4782 \
  --env LUWI_SESSION_ID=<registered-online-session-id> \
  -- node <repo>/apps/mcp-server/dist/main.js
```

or, on a machine without the `claude` CLI, hand-edit the local scope in `~/.claude.json`
— the entry lives under `projects.<absolute repo path>.mcpServers`:

```json
{
  "luwi-runtime": {
    "type": "stdio",
    "command": "node",
    "args": ["<repo>/apps/mcp-server/dist/main.js"],
    "env": {
      "LUWI_DAEMON_URL": "http://127.0.0.1:4782",
      "LUWI_SESSION_ID": "<registered-online-session-id>"
    }
  }
}
```

Two facts make a naive static registration fail. A session id is runtime identity, not
configuration: it goes stale after presence loss. A long-lived attach integration must therefore
start `session attach --session-out <absolute-private-path>` and configure that same path as
`LUWI_SESSION_FILE`, not copy its first value into `LUWI_SESSION_ID`. The server verifies the initial
binding before connecting the transport; later tool calls fail closed while the file is absent or
invalid and resume against the replacement ID after the attach helper publishes it. Changing from
static to file-backed binding requires rebuilding and restarting the MCP process once; rotations
after that require no MCP restart. Since ADR 0034 the file also carries the native reference the
attach declared, and a session the runtime dropped while still `starting` is not re-registered by
the attach: `luwi_join` registers its successor and the MCP server keeps that one alive itself.

## HTTP and WebSocket API

```text
GET  /health
GET  /api/v1/runtime

GET  /api/v1/projects
POST /api/v1/projects
GET  /api/v1/projects/:projectId
PATCH /api/v1/projects/:projectId

GET  /api/v1/sessions
POST /api/v1/sessions
GET  /api/v1/sessions/:sessionId
POST /api/v1/sessions/:sessionId/native
POST /api/v1/sessions/:sessionId/heartbeat
POST /api/v1/sessions/:sessionId/status
POST /api/v1/sessions/:sessionId/close
GET  /api/v1/projects/:projectId/sessions

GET  /api/v1/events?limit=100
GET  /api/v1/realtime  (WebSocket upgrade)

POST /api/v1/messages
GET  /api/v1/messages
GET  /api/v1/messages/:correlationId
GET  /api/v1/messages/:correlationId/wait?waitMs=30000
POST /api/v1/messages/:correlationId/acknowledge
POST /api/v1/messages/:correlationId/processing
POST /api/v1/messages/:correlationId/respond
POST /api/v1/messages/:correlationId/reject
POST /api/v1/messages/:correlationId/fail
POST /api/v1/sessions/:sessionId/inbox/claim

GET/POST/PATCH /api/v1/agents...
GET/POST/PATCH/DELETE /api/v1/projects/:projectId/agents...
GET/POST/PATCH /api/v1/capabilities...
GET/POST/PATCH /api/v1/profiles...
GET /api/v1/projects/:projectId/agents/:agentId/effective-config
POST /api/v1/config/{inspect,import-plan,render-plan,reconcile}
GET/POST /api/v1/config/{plans,snapshots,drift}...
GET/POST /api/v1/context...

POST /api/v1/usage
GET  /api/v1/usage
GET  /api/v1/usage/summary
GET/POST /api/v1/context/contributions
GET  /api/v1/context/summary
POST /api/v1/context/analyze
GET/POST /api/v1/projects/:projectId/git...
GET/POST /api/v1/projects/:projectId/packages...
GET  /api/v1/projects/:projectId/technologies
GET/POST /api/v1/graph...
GET/POST /api/v1/optimization...
```

`POST /api/v1/projects` returns `409 PROJECT_ALREADY_REGISTERED` and a `Location` header
when the same canonical local path already exists. It never merges metadata on conflict.

Only runtime state `ready` accepts mutations. Redis or ownership loss changes the runtime to
`degraded`; health returns 503 and mutations return `RUNTIME_NOT_READY` until owned recovery
finishes. Projection/history reads also return 503 while current Redis state is unavailable.

## Development and verification

```text
pnpm build
pnpm dev
pnpm lint
pnpm format
pnpm typecheck
pnpm test
pnpm test:integration
pnpm clean
```

Integration tests never choose a developer Redis implicitly. Use a dedicated Redis server
when possible. A dedicated database on a disposable local server can be enabled explicitly:

PowerShell:

```powershell
$env:LUWI_TEST_REDIS_URL = "redis://127.0.0.1:6379/15"
$env:LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS = "true"
pnpm test:integration
```

macOS/Linux:

```sh
LUWI_TEST_REDIS_URL=redis://127.0.0.1:6379/15 \
LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS=true \
pnpm test:integration
```

Redis Function libraries are server-scoped rather than database-scoped. The override is
therefore required when the test server is shared. Tests use run-specific keys and Function
names, never call `FLUSHDB`/`FLUSHALL`, and clean only their own state.

## Persistence and retention

The global Stream is `luwi:v1:events:global`; each project has
`luwi:v1:events:project:{projectId}`. Transition Functions do not trim Streams. A periodic
retention service applies configurable approximate limits.

Each session has `luwi:v1:inbox:session:{sessionId}` and group
`luwi-session-inbox-v1`. Inbox entries remain pending until a terminal message transition;
retention defers while the group has pending work or lag. Terminal projections are retained
for seven days by default, idempotency indexes for one day, and inboxes are bounded to
10,000 entries only when recovery metadata is safe.

For standard Redis versions before 8.2, global trimming occurs only when the realtime group
reports valid metadata, zero pending entries, zero lag, and a healthy relay. Otherwise LUWI
defers trimming so recoverable entries are not destroyed. Project and dead-letter Streams
have independent bounds.

AOF with `everysec` improves local durability but is not a backup and may lose roughly the
most recent second during a host failure.

Native-config snapshots are local filesystem artifacts rather than Redis values. Completed
snapshots are bounded to 50 by default and can be configured with
`LUWI_CONFIG_SNAPSHOT_RETENTION_COUNT`. Pruning considers only validated LUWI snapshot
manifests; incomplete or foreign directories are left for manual review.

Global and project imports use the same approved, snapshotted file engine as native renders.
Global imports update AgentDefinition defaults; project imports update agent-specific
project-manifest defaults. On owned startup, canonical AgentDefinitions, capabilities,
profiles, capability bindings, and project-agent bindings are validated and used to rebuild
missing or stale Redis projections before the runtime becomes ready.

Phase 4 raw usage observations default to 30 days, superseded Git observations to 100 per
project, and graph generations to the active/newest safe pair. Retention preserves
source-separated usage aggregate totals, source-event deduplication, optimization
baselines/evaluations, active graph metadata, and normalized Stream provenance. Supported
global/project/agent/session aggregate summaries survive raw-record cleanup; arbitrary time,
capability, or combined filters cover at most 1,000 retained raw records and return an
explicit unsupported-filter error if that bounded summary would be incomplete. Raw lists
report truncation. Responses expose the earliest retained usage observation rather than
claiming unavailable history is complete.

Package inventory canonicalizes the project root and each candidate manifest before opening
it. After opening, LUWI canonicalizes and contains the candidate again, compares non-zero
bigint `dev` and `ino` identity from the handle and final path, then reads the validated handle
in 64 KiB chunks up to 2 MiB plus one detection byte. Symlinks and junctions that resolve
outside the root, ABA identity changes, broken links, directory targets, unsupported identity,
and files that start or grow oversized fail closed. In-root links to a stable regular file
remain readable; scanners still never execute package managers or project code.

## Package boundaries

- `@luwi/protocol`: validated versioned wire schemas and event envelopes.
- `@luwi/runtime`: Redis-independent paths, status/readiness, usage aggregation, Git
  attribution, graph query policy, structural findings, and evaluation.
- `@luwi/adapters`: passive native-agent adapters and deterministic file proposals.
- `@luwi/redis`: Redis client boundary, keys, Functions, repositories, Streams, ownership,
  retention, and recovery primitives.
- `@luwi/daemon`: lifecycle, security, HTTP/WebSocket transport, relay, and sweeper.
- `@luwi/cli`: local HTTP/WebSocket client and simulations.
- `@luwi/mcp-server`: official-SDK stdio adapter over loopback daemon HTTP.

No separate packages exist for IRIS, sessions, lifecycle, metrics, memory, Git
intelligence, or graphs. Those features remain modules inside existing boundaries until real
consumers prove a package split.

## Roadmap disclaimer

Pulse began as a tested read-only shell and now has two narrow mutation boundaries: the approved
configuration plan chain and durable question creation between eligible sessions. Native realtime
invalidation, bounded Activity, and supported inspectors remain observational. Lifecycle/release
intelligence, global search, broader ACP orchestration, GitHub, and additional mutation surfaces
remain deferred. Future work must not bypass daemon-owned
Redis access, execute discovered code, convert unknown evidence to non-use, or describe
estimates/correlations as exact facts.
