# CLAUDE.md — LUWI Runtime

LUWI Runtime is a local-first, single-user control and coordination runtime for developers who run
multiple AI coding agents across local projects. It coordinates Codex, Claude Code, Gemini CLI, and
Kimi; it does not replace or impersonate them.

## Where the binding rules live

`AGENTS.md` (886 lines) is the single source of truth for this repository's architecture. It is
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

Memurai supports Redis Functions fully; `luwi_v1` (21 functions) is already loaded on the server.

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
  `apps/**/*.test.tsx`, and `apps/dashboard/src` holds 14 test files. There is no separate
  dashboard test leg to run.

Use `/verify` to run the §19 definition-of-done sequence in the correct order.

## Current implementation status

Phase 5B is implemented (native realtime Pulse, bounded Activity, read-only inspectors) on the
Phase 1–4 foundation. `README.md` "Current status" is accurate and maintained.

Not implemented, and per §21 still explicitly out of scope without approval: dashboard mutations,
lifecycle/release scoring, task/lease systems, semantic or vector knowledge graph, memory
federation, GitHub integration, prompt injection, cloud accounts, authentication, remote
control-plane work.

`apps/daemon/src/app.ts` is the canonical route list (80+ endpoints). `AGENTS.md` §10 lists the
initial subset only.

## MCP — opt-in, not automatic

There is deliberately **no `.mcp.json`**. `apps/mcp-server/src/main.ts` calls
`verifyBoundSession()` _before_ connecting the transport, so it exits 1 without ever speaking MCP
unless the daemon is running and `LUWI_SESSION_ID` names a live, non-terminal session. Session IDs
are runtime identity, not configuration — they go stale on every daemon restart.

To use the project's own 32 read-only `luwi_*` tools, after `pnpm build` and with the daemon up
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
