#!/usr/bin/env node
/**
 * Codex hook: publish the running conversation's validated LUWI attach request.
 *
 *   SessionStart → `codex-attach-hook.mjs start`  resolves and writes the record
 *   SessionEnd   → `codex-attach-hook.mjs end`    stops the attach owner
 *
 * Measured on codex-cli 0.153.4 (2026-09-10). Codex hooks use the Claude Code
 * contract (`~/.codex/hooks.json`, JSON on stdin with `session_id`, `cwd`,
 * `model`), but two things differ from Claude and shape this file:
 *
 * - Codex ends the hook's process tree when the hook returns, so nothing
 *   long-lived can be spawned here. The long-lived part (heartbeat, MCP server)
 *   is `codex-mcp-launch.mjs`, which Codex keeps alive for the conversation.
 * - Codex starts its MCP servers only after SessionStart hooks return, and its
 *   code-mode host freezes the tool catalogue the moment it initializes. A LUWI
 *   MCP server that appears seconds later is invisible to the model. So the
 *   attach request must already be resolved when the hook returns: this hook
 *   runs `session attach --dry-run` and writes
 *
 *     %TEMP%/luwi-attach-codex-<codexSid>.json → { request, codexSid, cwd }
 *
 *   for the launcher, which takes the newest unclaimed record and owns the real
 *   `session attach --session-out` process. Nothing is
 *   inferred: the project comes from `cwd`, the identity from the Codex
 *   session id forwarded as `CODEX_SESSION_ID`.
 *
 * A failure here is silent to Codex (exit 0, no record): an unbound Codex is a
 * working Codex without LUWI tools, never a broken one.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { writePrivateJsonFile } from './native-mcp-binding.mjs';

const LUWI_CLI = join(import.meta.dirname, '..', 'apps', 'cli', 'dist', 'main.js');
const DAEMON_URL = process.env.LUWI_DAEMON_URL ?? 'http://127.0.0.1:4782';

// ADR 0031: this Codex process was launched under a LUWI session (`agent run`,
// the native inbox bridge, the wake dispatcher's `codex resume`), so it already
// has one. `codex exec` fires SessionStart too; a second registration would be a
// reader-less ghost session.
if (process.env.LUWI_SESSION_ID) process.exit(0);

const input = JSON.parse(readFileSync(0, 'utf8'));
const recordFile = join(tmpdir(), `luwi-attach-codex-${input.session_id}.json`);

const post = async (path, body) => {
  const response = await fetch(`${DAEMON_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} answered ${String(response.status)}`);
  return response.json();
};

if (process.argv[2] === 'start') {
  const environment = { ...process.env, CODEX_SESSION_ID: input.session_id };
  // A Codex opened from inside a Claude Code shell inherits Claude's session
  // markers; --agent-kind makes detection ignore them, and dropping them keeps
  // the registration from being read as a Claude subagent.
  delete environment.CLAUDE_CODE_CHILD_SESSION;
  delete environment.CLAUDE_CODE_SESSION_ID;
  delete environment.CLAUDE_PID;
  const resolved = spawnSync(
    process.execPath,
    [
      LUWI_CLI,
      'session',
      'attach',
      '--agent-kind',
      'codex',
      '--dry-run',
      ...(input.model ? ['--model', input.model] : []),
    ],
    { cwd: input.cwd, env: environment, encoding: 'utf8', windowsHide: true, timeout: 8_000 },
  );
  if (resolved.status === 0) {
    try {
      const request = JSON.parse(resolved.stdout);
      writePrivateJsonFile(recordFile, { request, codexSid: input.session_id, cwd: input.cwd });
    } catch {
      // Invalid dry-run output: no record, Codex runs unbound.
    }
  }
} else {
  // The launcher renames a record it took to `.claimed` and records the attach
  // PID. Stop that owner; it closes its current LUWI session and removes the
  // rotating binding file. Legacy records retain the old close fallback.
  let record;
  for (const path of [`${recordFile}.claimed`, recordFile]) {
    try {
      record = JSON.parse(readFileSync(path, 'utf8'));
      break;
    } catch {
      record = undefined;
    }
  }
  if (record?.attachPid) {
    try {
      process.kill(Number(record.attachPid));
    } catch {
      // Already gone.
    }
  } else if (record?.luwiSessionId) {
    await post(`/api/v1/sessions/${encodeURIComponent(record.luwiSessionId)}/close`, {}).catch(
      () => undefined,
    );
  }
  try {
    unlinkSync(recordFile);
  } catch {
    // Already gone.
  }
  try {
    unlinkSync(`${recordFile}.claimed`);
  } catch {
    // Never claimed.
  }
}
