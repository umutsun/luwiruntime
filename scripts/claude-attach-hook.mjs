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
 *
 * `session attach --session-out` atomically rewrites
 * `%TEMP%/luwi-attach-<claudeSid>.out` with { attached: <luwiSessionId> } on every
 * (re)registration — so a daemon-restart rotation is reflected instead of the first,
 * now-terminal id — and `%TEMP%/luwi-attach-pid-<claudePid>` names the Claude session
 * running under that Claude process, so `claude-mcp-launch.mjs` — which Claude Code
 * starts without any session id — can bind the LUWI MCP server to this current session.
 */
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { claudeProcessId } from './claude-mcp-launch.mjs';
import { writePrivateTextFile } from './native-mcp-binding.mjs';

const LUWI_CLI = join(import.meta.dirname, '..', 'apps', 'cli', 'dist', 'main.js');

// ADR 0031: this Claude process was launched under a LUWI session (`agent run`,
// the native inbox bridge), so it already has one. Registering a second — the
// hook fires in `claude -p` mode too — created reader-less ghost sessions.
// LUWI_ATTACH_SKIP marks an autopilot brain judgment: no session at all.
if (process.env.LUWI_SESSION_ID || process.env.LUWI_ATTACH_SKIP) process.exit(0);

const input = JSON.parse(readFileSync(0, 'utf8'));
const pidFile = join(tmpdir(), `luwi-attach-${input.session_id}.pid`);
const outFile = join(tmpdir(), `luwi-attach-${input.session_id}.out`);
const claudePid = claudeProcessId() ?? process.env.CLAUDE_PID;
const mapFile =
  claudePid === undefined ? undefined : join(tmpdir(), `luwi-attach-pid-${claudePid}`);

const remove = (path) => {
  try {
    if (path !== undefined) unlinkSync(path);
  } catch {
    // Already gone, or never written — nothing to remove.
  }
};

if (process.argv[2] === 'start') {
  const environment = { ...process.env };
  delete environment.CLAUDE_CODE_CHILD_SESSION;
  delete environment.CLAUDE_PID;
  const child = spawn(
    process.execPath,
    [
      LUWI_CLI,
      'session',
      'attach',
      '--session-out',
      outFile,
      ...(input.model ? ['--model', input.model] : []),
    ],
    {
      cwd: input.cwd,
      env: { ...environment, CLAUDE_CODE_SESSION_ID: input.session_id },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  writePrivateTextFile(pidFile, String(child.pid));
  if (mapFile !== undefined) writePrivateTextFile(mapFile, input.session_id);
  child.unref();
} else {
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')));
  } catch {
    // Already gone, or never started — nothing to stop.
  }
  remove(pidFile);
  remove(outFile);
  remove(mapFile);
}
