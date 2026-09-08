# Native Inbox Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every
> task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve an agent's durable LUWI inbox unattended by running the native CLI headless once
per message, and stop native processes launched under a LUWI session from registering a second one.

**Spec:** `docs/superpowers/specs/2026-09-08-native-inbox-bridge-design.md` · **ADR:** 0031

**Constraints:** no daemon/protocol/redis change; no new dependency; no commit unless asked
(§13); every transition tested (§15); `/verify` green before claiming done (§19).

---

### Task 1: Attach-hook guard

- [ ] `apps/cli/src/attach-hook-guard.test.ts`: spawn both scripts with `LUWI_SESSION_ID=x`,
      a scratch `TEMP`/`TMP`, and hook JSON on stdin; expect exit 0, no files in the scratch dir,
      and `{}` from the Antigravity hook. Watch it fail.
- [ ] Add the early return to `scripts/claude-attach-hook.mjs` and
      `scripts/antigravity-attach-hook.mjs`. Watch it pass.

### Task 2: Output capture on the process runner

- [ ] `agent-runner.test.ts`: with `captureOutput`, spawn receives
      `stdio: ['ignore', 'pipe', 'pipe']` and chunks from both fake streams reach the callback.
- [ ] Implement in `agent-runner.ts` (optional `stdout`/`stderr` on the child interface).

### Task 3: Shared bridge daemon module

- [ ] Create `bridge-daemon.ts` with `BridgeDaemonClient`, `isTerminalMessageState`,
      `boundedAnswer`; make `deepseek-bridge.ts` import and re-export them. DeepSeek tests stay
      green unchanged.

### Task 4: `native-bridge.ts` (TDD, one behaviour per test)

- [ ] `nativeHeadlessArguments` for the three providers.
- [ ] `framePrompt` names correlation id, agent, session, reply tool, evidence, content.
- [ ] Happy path: child completes → bridge writes only status transitions.
- [ ] Exit 0 / non-zero / deadline / stopping → `fail` with the stated answers.
- [ ] Recovered processing → fail, not replayed. Terminal at claim → skipped. Response items
      ignored. Prompt too long → fail, executor not called. Executor throws → fail then rethrow.
- [ ] First-seen session id set `idle` (rotation).

### Task 5: CLI command

- [ ] Extract `createBridgeDaemonClient` from the DeepSeek command (pure move).
- [ ] `cli.test.ts`: `session bridge native claude -- --allowedTools mcp__luwi-runtime` registers
      with metadata, sets idle, claims with `blockMs`, runs the executor with `--print <prompt>`
      first and native args after, env carries `LUWI_SESSION_ID`, closes on SIGINT.
- [ ] Implement the command with the bootstrap, executor (deadline timer + signal relay +
      output tail), and per-message report lines.

### Task 6: Docs and gate

- [ ] README, CLAUDE.md status, AGENTS.md §12 sentence, overview.md sentence.
- [ ] `pnpm format:write`, then `/verify`.

### Task 7: Live proof on Albanoosh

- [ ] `pnpm build`; start the bridge for `claude-code` in `C:/xampp/htdocs/albanoosh`.
- [ ] `luwi message ask --target-agent claude-code --timeout-ms 120000` from another session;
      expect `responded` by the child; show `message list` and the bridge report line.
- [ ] Stop the bridge; confirm the session closed. Report what codex did if attempted.
