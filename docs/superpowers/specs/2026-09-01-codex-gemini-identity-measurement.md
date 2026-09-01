# Codex / Gemini / Kimi native identity — measurement (2026-09-01)

**Status:** Measured on this machine (`C:\Users\umuts`), 2026-09-01. This is the measurement the
completion program's Phase 3 required before writing any resolver. It **corrects the assumption** the
existing `native-identity.ts` comment and the completion program both carried — that Codex and Gemini
have a session layout a `resolveNativeIdentity(kind, environment)` resolver could read. They do not,
for the reasons recorded here. Recorded with the numbers so a layout change surfaces as a failed
expectation rather than as a silently wrong binding.

## How Claude resolves, for comparison

`resolveClaudeCode` reads `CLAUDE_CODE_SESSION_ID` from the **environment** the CLI runs in. This
works because `session attach --agent-kind claude-code` is run **from within** the agent's own
session (by a hook or the session itself), so that session's id is in the environment. Confirmed
directly: a live Claude Code session on this machine carries `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_CHILD_SESSION`, and `CLAUDE_PID` in its environment. A resolver that reads the
environment can therefore resolve Claude with no discovery and no guess.

The whole question for Codex and Gemini is the same one: **when a session runs `session attach`, does
its own native session id sit in the environment?**

## Codex — session id exists, but only in a file; not in the environment here

| #   | Measurement                     | Result                                                                                                                                                                                         |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | Session store                   | `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl` (present, many files from 2026-07 on)                                                                                             |
| X2  | Session id location             | First line is `{"type":"session_meta","payload":{"session_id":"<uuid>", ...}}`; the `<uuid>` equals the filename's uuid                                                                        |
| X3  | Session id format               | UUIDv7-style, e.g. `019f839b-20be-7480-be44-f9c4446b59a1`                                                                                                                                      |
| X4  | Launcher (`originator`)         | **`Codex Desktop` (30 of 40 sampled), `codex_vscode` (10)** — GUI / IDE, **no CLI-launched session**                                                                                           |
| X5  | Session-id environment variable | **None.** No `CODEX_SESSION_ID` / `CODEX_*_ID` / `CODEX_*ROLLOUT*` in `config.toml` or `.codex-global-state.json`. The only `CODEX_*` reference found is `CODEX_HOME` (the home-dir override). |

**Conclusion (Codex):** the session id is real and stable, but it lives **only in the rollout file**,
and the Codex instances on this machine are launched by Codex Desktop and the VSCode extension, which
do not export a session-id environment variable for a `session attach` to read. An environment-based
resolver mirroring `resolveClaudeCode` therefore has nothing to read. The only way to recover the id
is to read the filesystem — find the rollout file whose `cwd` matches and whose timestamp is latest —
and that is a **guess**: two Codex sessions can share a `cwd`, and "latest" can name the wrong one. The
design's own rule (`native-identity.ts`) is that an unusable value resolves to nothing, never to a
guess, because a wrong binding attributes one session's tokens to another. So Codex stays unresolved
here, and correctly so.

## Gemini — no per-session identity at all

| #   | Measurement                     | Result                                                                                                                                                                  |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Store                           | `~/.gemini/history/<project>/` — keyed by **project**, not session                                                                                                      |
| G2  | Project mapping                 | `~/.gemini/projects.json` maps absolute path → project name (`c:\xampp\htdocs\luwiruntime` → `luwiruntime`)                                                             |
| G3  | Contents of a project's history | `~/.gemini/history/luwiruntime/` holds only `.project_root` (the absolute path); `flybydeniz/` additionally holds a `.git/` — history is **git-backed, project-scoped** |
| G4  | Per-session id                  | **None anywhere.** No session file, no session id in the layout                                                                                                         |

**Conclusion (Gemini):** Gemini CLI's history is organised by project and versioned with git; there
is **no per-session native identity** to resolve. There is nothing for a resolver to return, from the
environment or the filesystem. This is not a "not measured yet" gap — it is a measured absence.

## Kimi — not installed

No `~/.kimi` directory exists on this machine, and no Kimi binary is on `PATH`. Kimi's session layout
is **not measurable here**; its resolver stays absent, exactly as the completion program's Phase 3
instruction allows ("only if evidence of an installation exists; otherwise record 'not measurable
here'").

## What this means for the resolver — an extensible registry (owner intent, 2026-09-01)

The owner's direction: support Claude, Codex, and Gemini now, and make adding future agents easy.
That shapes the implementation into a **per-vendor registry** keyed by `AgentKind`, so supporting a
new agent is one entry plus a resolver — not a new branch in a switch:

```ts
const RESOLVERS: Partial<Record<AgentKind, NativeIdentityResolver>> = {
  'claude-code': resolveClaudeCode, // env CLAUDE_CODE_SESSION_ID (+ child/subagent)
  codex: resolveCodex, // env CODEX_SESSION_ID via envSessionResolver
  'gemini-cli': resolveGemini, // measured absence: returns undefined
};
```

- **Claude** resolves from `CLAUDE_CODE_SESSION_ID`. Unchanged, confirmed working.
- **Codex** is wired to `CODEX_SESSION_ID` through the shared `envSessionResolver` helper — the same
  env-variable path Claude uses. On this machine that variable is absent (Codex is GUI/IDE-launched,
  X4/X5), so a Codex session registers unattributed today; the instant a Codex build exports its
  `session_id` (X2/X3) as `CODEX_SESSION_ID`, it resolves with **no code change**. A filesystem
  resolver was rejected: matching a rollout file by `cwd` + "latest" would name the wrong session
  when two share a working directory, which the design's "never guess a binding" rule forbids.
- **Gemini** has no per-session identity to resolve (G4), so `resolveGemini` returns `undefined` for a
  measured reason and ignores any spurious variable. If a future Gemini grows a session id, it is
  wired the way Codex is.
- **Kimi** and **other** have no registry entry and register without a native block — the honest
  state for an unreadable identity. A future Kimi is added as one registry entry once its layout is
  measurable here.

Adding a new agent is therefore: measure whether its session id is in the environment; if so, add
`kind: envSessionResolver('<adapterId>', '<VAR>')` to the registry; if its rules are richer (a
subagent, a non-env source), give it its own resolver function. The `session attach` path already
calls `resolveNativeIdentity(kind, environment)`, so a newly-registered vendor needs no wiring beyond
the registry. (`agent run` deliberately does **not** declare native identity: the wrapper's
environment at launch is the launching context, not the child agent's, so reading it would attribute
the child to the parent's id.)

The honest deliverable of a measurement-first phase whose measurement shows two of three targets are
not env-resolvable is the measurement itself plus an **extensible structure that resolves them the
moment their identity becomes readable**, rather than a resolver that fabricates a binding now.

## Correction and outcome (owner-approved filesystem fallback, 2026-09-01 — ADR 0028)

Two things changed after this measurement was first written.

**X2 correction.** The claim that the filename uuid equals the `session_id` holds only for a session's
**root** rollout. Re-measurement across a real four-file resume chain showed the filename uuid equals
the file's own `id` (per-rollout), while `session_id` stays the **stable root** of the chain, carried
forward through `parent_thread_id`:

| file `id` (= filename uuid) | `session_id` | `parent_thread_id` |
| --------------------------- | ------------ | ------------------ |
| `01a05c7d` (root)           | `01a05c7d`   | —                  |
| `01a05c7e`                  | `01a05c7d`   | `01a05c7d`         |
| `01a05c7f`                  | `01a05c7d`   | `01a05c7d`         |
| `01a05c80`                  | `01a05c7d`   | `01a05c7f`         |

The logical Codex session identity is therefore `session_id`, and a resolver must read that field —
not the filename and not `id`.

**Codex conclusion superseded.** The owner granted explicit permission (2026-09-01) to recover Codex
identity from the filesystem. ADR 0028 adds an owner-approved disk fallback
(`native-identity-disk.ts`), tried only after the environment resolver returns nothing: it matches a
rollout by `cwd`, gates it by a freshness window (default 15 min), reads `session_id` from the first
line only, and binds nothing when the match is stale, absent, or in another project. The residual,
owner-accepted risk is two live Codex sessions in one working directory. The "Codex stays unresolved
here" conclusion above is thus superseded for the fallback path; the environment path stays the
preferred, deterministic resolver.

**Gemini conclusion stands.** Re-measurement confirmed G4: `~/.gemini/tmp/<project>/` holds only
`.project_root`, no session id anywhere. There is nothing for a filesystem resolver to read, so Gemini
keeps its measured-absence resolver. Binding a Gemini session to its project instead was rejected in
ADR 0028 (a project is not a session; it would collide and refuse a normal second session).
