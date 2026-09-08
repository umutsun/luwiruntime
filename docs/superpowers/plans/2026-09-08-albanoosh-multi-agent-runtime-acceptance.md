# Albanoosh Multi-Agent LUWI Runtime Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex, Claude Code, and Google Antigravity visible as bounded Albanoosh sessions in LUWI Runtime and prove durable request/reply communication across all three identities.

**Architecture:** Keep LUWI's loopback daemon and Redis database as the coordination plane. Launch each native agent through LUWI when MCP access is required so the child process inherits a fresh `LUWI_SESSION_ID`; use Antigravity's already-configured hook only for passive visibility when it is launched outside LUWI. Prove the transport deterministically with the bound MCP harness, then run read-only native-client smoke prompts without editing Albanoosh.

**Tech Stack:** Node.js 26, pnpm 11.9.0, LUWI daemon/CLI/MCP server, Redis 7.2-compatible Memurai on `127.0.0.1:6379`, Codex CLI 0.153.4, Claude Code 2.1.229, Antigravity CLI (`agy`).

**Spec:** `C:\xampp\htdocs\albanoosh\docs\STAGING.md` and `C:\xampp\htdocs\albanoosh\AGENTS.md`

## Global Constraints

- Preserve every existing LUWI and Albanoosh working-tree change; do not reset, clean, overwrite, stage, or commit user work.
- Keep the daemon on `127.0.0.1:4782` and coordination Redis on `127.0.0.1:6379`; never reuse Albanoosh application Redis port `6380`.
- Do not store API keys, tokens, static LUWI session IDs, or full prompts in repository configuration or logs.
- Do not edit Albanoosh product code during this acceptance run; native smoke prompts may only inspect LUWI session state and return a bounded marker.
- Use project id `1f840b3c-23ba-4e74-a33d-462d05cab33c` and canonical path `C:\xampp\htdocs\albanoosh`.
- Treat the untracked `scripts/antigravity-attach-hook.mjs` and overlapping LUWI source changes as pre-existing user work; test them but do not rewrite them.
- No Git commit is authorized by this request.

---

### Task 1: Verify the Existing LUWI and Antigravity Lifecycle Surface

**Files:**

- Inspect: `C:\xampp\htdocs\luwiruntime\scripts\antigravity-attach-hook.mjs`
- Test: `C:\xampp\htdocs\luwiruntime\apps\cli\src\cli.test.ts`
- Verify: `C:\xampp\htdocs\luwiruntime\apps\cli\dist\main.js`

**Interfaces:**

- Consumes: the live daemon, existing `session attach` implementation, and pre-existing Antigravity hook.
- Produces: verified CLI/build artifacts safe to use in the acceptance run.

- [ ] Run `node --check C:\xampp\htdocs\luwiruntime\scripts\antigravity-attach-hook.mjs`; require exit code `0`.
- [ ] Run `pnpm exec vitest run apps/cli/src/cli.test.ts -t "session attach"`; require all selected tests to pass.
- [ ] Run `pnpm typecheck` and `pnpm build`; require both to exit `0` before using rebuilt artifacts.
- [ ] Run `node apps/cli/dist/main.js doctor --json` and `node apps/cli/dist/main.js status --json`; require `ready: true`, daemon state `ready`, Redis connected, and loopback endpoints.

### Task 2: Install and Authenticate Antigravity Safely

**Files:**

- Download temporarily: `C:\tmp\antigravity-install.ps1`
- Preserve: `C:\Users\umuts\.gemini\config\hooks.json`
- Inspect after installation: `C:\Users\umuts\.gemini\config\mcp_config.json`

**Interfaces:**

- Consumes: Google's official `https://antigravity.google/cli/install.ps1` installer and Windows Credential Manager.
- Produces: an authenticated `agy` executable without removing the legacy `gemini` command or the LUWI hook.

- [ ] Download the official script to `C:\tmp\antigravity-install.ps1`, inspect its origin/content, and calculate SHA-256 before execution.
- [ ] Execute the reviewed script with `--skip-aliases` so the legacy Gemini alias is preserved while Antigravity is added to the user PATH.
- [ ] Open a fresh process environment and run `agy --version`; require a version string and exit code `0`.
- [ ] Run `agy -p "Reply with exactly ANTIGRAVITY_AUTH_OK" --print-timeout 2m`; require the exact marker. If authentication is required, stop and open an interactive `agy` terminal for the user to complete Google sign-in, then repeat the bounded smoke command.
- [ ] Re-read `C:\Users\umuts\.gemini\config\hooks.json`; require the LUWI `PreInvocation` hook to remain present.

### Task 3: Register and Bind the Three Albanoosh Agent Identities

**Files:**

- Runtime state only: LUWI AgentDefinition and project-agent projections in Redis.

**Interfaces:**

- Consumes: global agent registry and Albanoosh project identity.
- Produces: exactly one enabled binding each for ids `codex`, `claude-code`, and `antigravity`.

- [ ] Register `codex` only if absent using kind `codex`, its verified executable, adapter `codex-native-v1`, `%USERPROFILE%\.codex`, and no secret metadata.
- [ ] Reuse the existing `claude-code` definition after verifying executable version `2.1.229`.
- [ ] Register `antigravity` only if absent using kind `other`, the verified `agy` executable, adapter `antigravity`, `%USERPROFILE%\.gemini`, and no secret metadata.
- [ ] Bind all three ids to Albanoosh with enabled state, empty profile/capability arrays, empty overrides, and the ownership roles from `C:\xampp\htdocs\albanoosh\AGENTS.md`.
- [ ] Run `node apps/cli/dist/main.js project agent list 1f840b3c-23ba-4e74-a33d-462d05cab33c`; require exactly the intended enabled bindings and no duplicate provider binding.

### Task 4: Configure LUWI MCP Without Static Session IDs

**Files:**

- Native configuration managed by vendor CLIs: `C:\Users\umuts\.codex\config.toml`, `C:\Users\umuts\.claude.json`, and `C:\Users\umuts\.gemini\config\mcp_config.json`.
- MCP executable: `C:\xampp\htdocs\luwiruntime\apps\mcp-server\dist\main.js`.

**Interfaces:**

- Consumes: fresh `LUWI_DAEMON_URL` and `LUWI_SESSION_ID` inherited from `luwi agent run`.
- Produces: a `luwi-runtime` stdio MCP entry in each client that launches the same validated server and never embeds a session id.

- [ ] Inspect each client for an existing `luwi-runtime` entry; update/reuse it instead of creating a duplicate.
- [ ] Configure the MCP command as `node C:\xampp\htdocs\luwiruntime\apps\mcp-server\dist\main.js`, with working directory `C:\xampp\htdocs\luwiruntime`, while forwarding inherited `LUWI_DAEMON_URL` and `LUWI_SESSION_ID` rather than storing their values.
- [ ] Keep MCP approval in prompt/ask mode; do not globally trust arbitrary MCP or shell tools.
- [ ] Start three bounded `session attach` helpers for `codex`, `claude-code`, and `antigravity`; capture their fresh session ids from LUWI output.
- [ ] For each session id, set it only in the current test process and run `node apps/mcp-server/dist/harness.js`; require the tool list and a successful `luwi_list_sessions` call.

### Task 5: Prove Three-Way Durable Request/Reply

**Files:**

- Runtime state only: three test sessions, messages, inbox records, and normalized events.

**Interfaces:**

- Consumes: the three online sessions and bound MCP harness from Task 4.
- Produces: three terminal `responded` messages proving `codex -> claude-code`, `claude-code -> antigravity`, and `antigravity -> codex` delivery.

- [ ] Generate one non-secret run id and use it in all three message subjects and answers.
- [ ] With the Codex-bound harness, call `luwi_ask_agent` targeting `claude-code`; with the Claude-bound harness, call `luwi_inbox_next`, `luwi_acknowledge_message`, `luwi_mark_message_processing`, and `luwi_respond_to_message`; with Codex, call `luwi_await_response` and require the matching marker.
- [ ] Repeat the same state sequence for `claude-code -> antigravity` and `antigravity -> codex`, using a unique bridge instance id per receiving session.
- [ ] Run `node apps/cli/dist/main.js message list --project 1f840b3c-23ba-4e74-a33d-462d05cab33c`; require all three correlations to be `responded` with the expected source and target agent ids.
- [ ] Close all three acceptance sessions and run `node apps/cli/dist/main.js session list --online`; require no acceptance session to remain online.

### Task 6: Run Native Client MCP Smoke Checks

**Files:**

- No repository files may change.

**Interfaces:**

- Consumes: verified native executables, dynamic LUWI launcher environment, and `luwi-runtime` MCP configuration.
- Produces: one read-only marker from each native client demonstrating it can see the Albanoosh LUWI sessions through MCP.

- [ ] Record `git status --short` in both repositories before the native runs.
- [ ] Launch Codex with `luwi agent run codex`, explicit `--agent-id codex`, Albanoosh working directory, and a bounded read-only prompt that calls only `luwi_list_sessions` and returns `CODEX_LUWI_OK`.
- [ ] Launch Claude Code with `luwi agent run claude`, explicit `--agent-id claude-code`, Albanoosh working directory, and a bounded read-only prompt that calls only `luwi_list_sessions` and returns `CLAUDE_LUWI_OK`.
- [ ] Launch Antigravity using the existing transitional provider command `luwi agent run gemini --agent-id antigravity --executable <verified-agy-path>`, a bounded read-only prompt, and require `ANTIGRAVITY_LUWI_OK`.
- [ ] Re-run `git status --short` in both repositories and require no new product-code or configuration drift from the smoke prompts.
- [ ] Report separately: daemon/Redis health, registered bindings, deterministic MCP round trips, native-client MCP results, any authentication block, and the exact limitation that `gemini` is a transitional launcher name until LUWI gains a first-class Antigravity provider.
