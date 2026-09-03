#!/usr/bin/env node
/**
 * Claude Code hook: attach the running session to LUWI automatically.
 *
 *   SessionStart → `claude-attach-hook.mjs start`  spawns a detached
 *                   `luwi session attach`, which heartbeats for the session's life
 *   SessionEnd   → `claude-attach-hook.mjs end`    stops that process
 *
 * Reads the hook's JSON from stdin. The attach resolves the Claude identity from
 * `CLAUDE_CODE_SESSION_ID`, which a hook subprocess is not documented to carry, so
 * the session id from stdin is forwarded as that variable; the child-session
 * markers are dropped so the session registers as the main one, not a subagent.
 * The project comes from the hook's `cwd`, the model from `model` when present —
 * nothing is inferred. A SessionEnd hook has 1.5 s, so `end` only signals.
 */
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const LUWI_CLI = join(import.meta.dirname, '..', 'apps', 'cli', 'dist', 'main.js');

const input = JSON.parse(readFileSync(0, 'utf8'));
const pidFile = join(tmpdir(), `luwi-attach-${input.session_id}.pid`);

if (process.argv[2] === 'start') {
  const environment = { ...process.env };
  delete environment.CLAUDE_CODE_CHILD_SESSION;
  delete environment.CLAUDE_PID;
  const child = spawn(
    process.execPath,
    [LUWI_CLI, 'session', 'attach', ...(input.model ? ['--model', input.model] : [])],
    {
      cwd: input.cwd,
      env: { ...environment, CLAUDE_CODE_SESSION_ID: input.session_id },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  writeFileSync(pidFile, String(child.pid));
  child.unref();
} else {
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')));
  } catch {
    // Already gone, or never started — nothing to stop.
  }
  try {
    unlinkSync(pidFile);
  } catch {
    // Nothing to remove.
  }
}
