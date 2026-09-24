# LUWI Runtime — session prompt (2026-09-15)

You are working in LUWI Runtime (`C:/xampp/htdocs/luwiruntime`), Umut's local multi-agent
coordination daemon + dashboard + CLI. Talk to Umut in Turkish; code, commits, ADRs, comments in
English. This is Umut's repo: commit on the working branch, **never push without his say-so**, keep
ADR-style commit messages. Trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

Read `CLAUDE.md` (routes to `AGENTS.md`, the binding architecture) and the memory index
(`MEMORY.md` → `luwi-project-position.md`) first. Everything below is the state as of 2026-09-15.

## Where things stand

- Branch `claude/fleet-routing-prefer-bridge-worker`, HEAD `8c327a3` (`fix(cli): strip
--approve-for-me on codex exec resume` — committed by another session on top of my work).
- **18 commits ahead of the remote main and NOT pushed.** The branch is local-only. Main branch is
  `codex/deepseek-session-bridge`.
- Daemon LIVE on `http://127.0.0.1:4782`, `ready (managed)`, running the `890464a` build. Only
  untracked: `.claude/skills/graphify/` (intentional).
- Gate: full unit suite ~1793 pass; the ONLY failure is the pre-existing untracked
  `apps/cli/src/codex-mcp-launcher.test.ts` (baseline for weeks — expect exactly this one).

## Shipped this session (all deployed, verified live)

| Commit                        | What                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `3c7717e`                     | Codex GUI thread-name titles (daemon title service, per-adapter `sources`)                            |
| `34ad1c9`/`a0c72b3`/`12758d2` | Radial-lens hover tooltip: GUI title else `Session <id>`, no agent/status prefix                      |
| `a739cba`                     | Antigravity A1: title reader over `~/.gemini/antigravity/agyhub_summaries_proto.pb` + daemon source   |
| `22e2719`                     | Antigravity A2: token/context from the per-conversation SQLite `gen_metadata` + a 3rd ingest instance |
| `ac2e5cd`                     | EVENTS/MIN stat kept on one line (2xl + nowrap)                                                       |
| `890464a`                     | **Presence fix** (LIVE-PROVEN): the starting-reaper spares GUI attaches, reaps only bridges           |

## Architecture you'll touch (read first)

- **Native titles** (daemon): `apps/daemon/src/native-title-service.ts` takes a per-adapter
  `sources: Record<adapterId, (nativeSessionId) => Promise<title>>`, wired in `runtime.ts` (~900)
  with claude-code (ccd store), codex (`~/.codex/session_index.jsonl`), antigravity
  (`agyhub_summaries_proto.pb`). One 60s `nativeTitleTimer`. Writes only online, non-terminal, `main`
  binding, title-absent; one heartbeat write per session.
- **Antigravity readers** (`packages/adapters/src/`): `antigravity-native.ts` (`findAntigravityTitle`),
  `antigravity-usage-reader.ts` (`parseGenMetadataUsage`/`parseStepTimestampMs`/`createAntigravityUsageReader`),
  `node-antigravity-store.ts` (`NodeAntigravityUsageStore`, `node:sqlite`), `protobuf-wire.ts` (shared
  schema-less wire walker). Field map (measured, validated): `#1.#4.#2`=input, `#1.#4.#5`=cache-read,
  `#1.#4.#3`=output (=`#4.#9+#4.#10`), `#1.#19`=model, `#1.#20` kv `request_id`+`last_step_index`;
  observedAt from `steps[last_step_index]` epoch-seconds Timestamp; join key = conversation id (.db stem).
- **Usage ingest** (daemon): `createTranscriptIngestService` in `runtime.ts` — three instances
  (claude-code, codex, antigravity) on `transcriptScanTimer`/`codexScanTimer`/`antigravityScanTimer`
  (default 300000ms; first fire ~5 min after start). `deriveNativeBindingId({adapterId, nativeSessionId})`
  resolves the binding; attribution is per-generation time via `findNativeLinkAt(observedAt)`. Any new
  `xxxTimer = setInterval(` must be added to `runtime.test.ts`'s two timer-guard lists.
- **Presence/reaper** (the `890464a` fix): `packages/redis/src/runtime-repository.ts`
  `findStartingSessionsPastGrace` returns only bridge sessions (`isBridgeSession` = non-empty
  `metadata.bridge`); GUI attaches stay present while heartbeating (router still skips `starting`, so
  never a routing target), disconnected only by the presence sweeper on heartbeat lapse — which closes
  the native link (the correct usage-attribution boundary). `@luwi/redis` may import `@luwi/protocol`
  only (NOT `@luwi/runtime`), so the predicate lives in the redis repo.
- **Binding is produced upstream, the MCP carries it**: GUI attaches declare native identity via
  `session attach --native-adapter <x> --native-session <id>` (claude/codex resolve their id from
  env/disk; antigravity's IDE hook `scripts/antigravity-attach-hook.mjs` passes the conversationId).
  The bridge (`apps/cli/src/cli.ts` `declareCodexNativeOnce`) declares only for codex. The MCP server
  reads the native ref from `LUWI_SESSION_FILE` and reuses it on revival; it does NOT resolve identity.

## Open items, recommended order

1. **Fleet worker token/name binding (highest value).** Headless fleet workers get no native binding
   except codex. claude/antigravity fleet workers show no title (headless, expected) and no tokens.
   Safe fix: resolve native identity from the agent's OWN env at MCP-join (or in the bridge) and
   declare it — claude & codex expose a per-process session id, so it's safe (no disk guessing).
   **Antigravity headless is impossible** (vendor gives the process no conversation id; only the GUI
   IDE hook binds). Do NOT resolve antigravity's conversation from disk in a fleet worker — it shares
   the cwd with the GUI IDE and would steal its conversation (mis-attribution). This was tried and
   removed on purpose.
2. **Push** — 18 local commits, owner's call.
3. **A2 attribution now covers whole GUI sessions** thanks to the presence fix (link stays open); if
   antigravity cumulative tokens still look short, confirm the GUI session stayed present across the
   conversation.

## Explicitly out of scope (CLAUDE.md §21 — needs owner approval, not "missing")

Automatic drift reconciliation, lifecycle/release scoring, task orchestration, semantic/vector
knowledge graph, memory federation, GitHub integration, prompt injection, cloud accounts,
authentication, remote control-plane.

## Verify empirically

- Typecheck: `pnpm exec tsc -b --pretty false` (plain `tsc` not on PATH). Tests from repo root:
  `pnpm exec vitest run <root-relative path>`. `pnpm test` = unit only, no Redis, INCLUDES dashboard.
  `pnpm build` = dashboard `vite build` + `tsc -b`. `pnpm format` / `pnpm lint`.
- Integration tests need Redis: use `/redis-it` (Memurai on 127.0.0.1:6379; **db15 only**, never db0;
  `LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS=true`; command is `pnpm test:integration <filter>`, config
  excludes `*.integration.test.ts` from the default run).
- Live: `curl -s http://127.0.0.1:4782/api/v1/sessions` (metadata.title, presence/status);
  `?agentId=<x>&limit=50` on `/api/v1/usage` for token attribution (large limits time out — keep small).
- CSS guards: `apps/dashboard/src/styles/tokens.test.ts` + `class-coverage.test.ts` (a raw pixel or
  unlisted className fails). Dashboard build needs no daemon restart (dist served per request), only a
  cache-busting query string.

## Deploy (daemon restart)

Only a `runtime.ts`/daemon-dist change needs a restart; dashboard-only changes don't. Restart ONLY at
a zero-in-flight window (the Albanoosh fleet PM dispatches back-to-back; a restart mid-message fails
that message since bridge children inherit a static `LUWI_SESSION_ID`). Procedure: check
`/api/v1/messages?limit=200` for `state==processing|pending` = 0; `node apps/cli/dist/main.js stop`;
then `start` with retries (`LIFECYCLE_BUSY` for ~10s after stop — retry 3-4x with 4s sleeps; foreground
`sleep` is blocked, run the restart script in the background); `status` → `daemon: ready (managed)`.
The daemon loads local dist, so `tsc -b`/`pnpm build` before restart. Managed-agents fleet reconnects
by itself. Pre-check `/api/v1/config/drift` = `{"drifts":[]}` before stop — a non-empty drift means a
`CONFIG_RECONCILIATION_REQUIRED` startup lockout (the 2026-09-13 outage; the durable fix
`onUpdated→trackProject` is in-tree now).

Start: confirm branch @ `8c327a3` and daemon `ready`; read the files above; take item 1 as a bounded,
tested, mirrored slice; verify live before declaring done.
