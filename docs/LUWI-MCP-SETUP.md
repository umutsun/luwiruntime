# LUWI MCP — Definitive Setup (Claude, Codex, Antigravity)

The one reference for wiring a GUI agent's MCP to LUWI so it **joins its project and
keeps listening** for tasks. Every value here was verified live on this machine.

## Prerequisites (once)

1. **Daemon up:** `luwi status` must print `daemon: ready`. If not: `luwi start`.
2. **Run the agent LOCALLY** on this machine — not a cloud/remote instance. A cloud
   agent (its working directory shows `~/code`) cannot reach the local daemon at
   `127.0.0.1:4782`, so no MCP config will connect it.
3. **Open the agent in the project's folder.** The project an agent coordinates on is
   its **working directory**, not the window title. For LUWI Runtime that folder is
   `C:\xampp\htdocs\luwiruntime`.

## 1) MCP config (in the agent's MCP settings, once per agent)

- **Command:** `node`
- **Arguments** — point at the agent's **launcher**, never at `main.js` directly:
  | Agent       | Argument                                                         |
  | ----------- | ---------------------------------------------------------------- |
  | Claude      | `C:\xampp\htdocs\luwiruntime\scripts\claude-mcp-launch.mjs`      |
  | Codex       | `C:\xampp\htdocs\luwiruntime\scripts\codex-mcp-launch.mjs`       |
  | Antigravity | `C:\xampp\htdocs\luwiruntime\scripts\antigravity-mcp-launch.mjs` |
- **Environment:** `LUWI_DAEMON_URL` = `http://127.0.0.1:4782`
- **Working directory:** leave empty (the launcher finds the session itself) — **never `~/code`**.

> **Why the launcher and not `apps/mcp-server/dist/main.js`?** The MCP server requires exactly one
> binding source: `LUWI_SESSION_ID` for an externally owned stable session, or an absolute
> `LUWI_SESSION_FILE` written by `session attach --session-out`. The Claude, Codex, and Antigravity
> attach launchers supply the file form, so the same long-lived `main.js` re-reads the live ID after
> a rotation instead of retaining the first terminal ID. Three thin per-vendor launchers, one shared
> server — so the version is always uniform.

### Direct native attach pairing

When a native launcher owns `session attach`, give both processes one absolute, per-user path:

```powershell
node apps/cli/dist/main.js session attach `
  --working-directory C:/xampp/htdocs/luwiruntime `
  --session-out "$env:TEMP/luwi-codex-current.out"

$env:LUWI_SESSION_FILE = "$env:TEMP/luwi-codex-current.out"
node apps/mcp-server/dist/main.js
```

The attach helper creates the file privately and replaces it atomically on every registration. Do
not copy `attached` into a long-lived `LUWI_SESSION_ID`; that recreates the stale binding failure.

Codex's launcher owns its `session attach` process after the SessionStart hook publishes the validated
request, so daemon-driven session replacement updates the conversation-scoped file without restarting
the MCP server. The launcher claims the hook record matching its native `CODEX_SESSION_ID` or
`CODEX_THREAD_ID`; it fails closed when neither identity is available. Antigravity uses the same
per-conversation file for rotations and waits only for the current record published by its hook—it
does not select another online session or invent a project/conversation. Its MCP process remains
application-global, however, so changing to a different concurrently active Antigravity conversation
still requires the client to restart/select a new launcher; the file solves rotation of the selected
conversation, not global conversation routing.

## 2) Join + Listen prompt (paste into the agent's chat, once)

```
You are a LUWI inbox worker. Run this loop and DO NOT STOP until I type "stop":

1. Call the MCP tool `luwi_join` with no arguments.
2. If it returns an inbox item (a task/message): do exactly what it asks, then answer
   with `luwi_respond_to_message` using that item's correlationId. If you truly cannot,
   use `luwi_fail_message`.
3. Whether or not there was a task, IMMEDIATELY call `luwi_join` again — no pause.
4. NEVER say "ready when you are" and stop. Always loop back to step 1.

First message: confirm the project name and session id you joined. After that, stay
silent and keep looping, reporting only when you claim or answer a task.
```

`luwi_join` marks the session ready and blocks briefly on its own inbox, returning the next
task; the agent must call it again to keep listening (an MCP tool cannot loop by itself — the
loop is the agent's job, which is why steps 3–4 are non-negotiable).

## The three rules that keep it from breaking

1. **Never start `main.js` without exactly one binding** → use the launcher, or explicitly provide
   `LUWI_SESSION_ID`/absolute `LUWI_SESSION_FILE`.
2. **Cloud/`~/code` cannot reach the local daemon** → the agent must run on this machine.
3. **Project = folder.** The wrong folder means the wrong project, and cross-project tasks never arrive.

## Updating all agents to the latest MCP

An MCP server loads `main.js` once at start and does **not** hot-reload, so a rebuild only
reaches an agent when its server is relaunched. To rebuild and restart every agent's MCP at once:

```bash
node scripts/mcp-reload.mjs
```

Each agent's client then respawns its MCP from the fresh dist, so they all run the same build.

## Reliable fallback — the headless bridge

If a GUI will not sustain the loop, run a bridge for that agent instead. It holds one LUWI
session and processes the inbox in a headless CLI, independent of any GUI turn behavior
(proven live — `BRIDGE_LIVE_OK`). Watch the work in the dashboard / `luwi events`, not the GUI:

```bash
node apps/cli/dist/main.js session bridge native <claude|codex|antigravity> \
  --working-directory C:/xampp/htdocs/luwiruntime
```

(Antigravity's bridge needs `-- --dangerously-skip-permissions` and is started by you, not by Claude.)

## Troubleshooting

| Symptom                                                     | Cause                                                          | Fix                                                                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| MCP reports a missing session binding / exits at once       | Neither binding source was configured, or both were configured | Point at the launcher or configure exactly one of `LUWI_SESSION_ID` and `LUWI_SESSION_FILE`                  |
| `BOUND_SESSION_TERMINAL` after an attach rotation           | The MCP still has a copied static ID                           | Pass the attach helper's absolute `--session-out` path as `LUWI_SESSION_FILE`, rebuild, and restart MCP once |
| `luwi_join` not in the tool list                            | The running MCP is an old build                                | `node scripts/mcp-reload.mjs`, then reconnect the MCP                                                        |
| Joined the wrong project                                    | The agent's folder is not the project you meant                | Open the agent in the correct project folder                                                                 |
| Task stays `queued`, never delivered                        | The agent joined but is not looping                            | Re-paste the Join + Listen prompt, or use the bridge                                                         |
| `codex mcp list: No MCP servers` while local config is fine | Codex is running in the cloud (`~/code`), not locally          | Use local Codex, or the bridge                                                                               |
