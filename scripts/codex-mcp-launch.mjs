#!/usr/bin/env node
/**
 * Codex MCP launcher: own the conversation's rotating LUWI attach process and
 * start the bound-session MCP server against its session file.
 *
 * `codex-attach-hook.mjs` has already resolved the attach request by the time
 * Codex starts its MCP servers (Codex runs SessionStart hooks first), and recorded
 *
 *   %TEMP%/luwi-attach-codex-<codexSid>.json → { request, codexSid, cwd }
 *
 * Codex hands MCP children its native `CODEX_SESSION_ID`/`CODEX_THREAD_ID`, but
 * no LUWI session id. This launcher claims only the exact hook record for that
 * native conversation, starts `session attach --session-out`, waits for its first
 * online session, and starts the MCP server with `LUWI_SESSION_FILE`. Immediately matters:
 * Codex's code-mode host freezes its tool catalogue when it initializes, so a
 * LUWI server that arrives seconds later is invisible to the model.
 *
 * The attach process owns heartbeat, terminal-session recovery, file rotation,
 * and close for as long as the MCP server lives. An inherited `LUWI_SESSION_ID` (the bridge's
 * `-c mcp_servers.luwi-runtime.env.LUWI_SESSION_ID`, `agent run`) short-circuits
 * the record lookup and owns no heartbeat: that session has its own holder.
 *
 * Register it in `~/.codex/config.toml`:
 *   [mcp_servers.luwi-runtime]
 *   command = "node"
 *   args = ['C:\xampp\htdocs\luwiruntime\scripts\codex-mcp-launch.mjs']
 */
import { spawn } from 'node:child_process';
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  codexAttachPlan,
  codexNativeSessionId,
  environmentSessionBinding,
  loopbackDaemonUrl,
  mcpServerEnvironment,
  readBoundedJsonFile,
  readSessionBindingFile,
  writePrivateJsonFile,
} from './native-mcp-binding.mjs';

const LUWI_CLI = join(import.meta.dirname, '..', 'apps', 'cli', 'dist', 'main.js');
const MCP_SERVER = join(import.meta.dirname, '..', 'apps', 'mcp-server', 'dist', 'main.js');
const WAIT_MS = 10_000;
const POLL_MS = 100;
const RECORD_PREFIX = 'luwi-attach-codex-';
/** Timeline for diagnosis only, opt-in through the MCP server's env; ids, never content. */
const DEBUG_LOG = process.env.LUWI_MCP_LAUNCH_DEBUG
  ? join(tmpdir(), 'luwi-codex-mcp-launch.log')
  : undefined;
const debug = (line) => {
  if (DEBUG_LOG === undefined) return;
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} pid ${String(process.pid)} ${line}\n`);
  } catch {
    // Diagnosis must never break the launch.
  }
};

const readJson = (path) => {
  try {
    return readBoundedJsonFile(path);
  } catch {
    return undefined;
  }
};

async function online(daemonUrl, sessionId) {
  try {
    const response = await fetch(`${daemonUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`);
    return response.ok && (await response.json()).presence === 'online';
  } catch {
    return false;
  }
}

function attachedSession(path) {
  try {
    return readSessionBindingFile(path);
  } catch {
    return undefined;
  }
}

/**
 * The newest unclaimed, fresh record. Claimed by renaming so a second launcher
 * under the same `codex.exe app-server` (the desktop app runs every conversation
 * from one process) cannot take the same session.
 */
async function claimRecord(deadline, codexSid) {
  const path = join(tmpdir(), `${RECORD_PREFIX}${codexSid}.json`);
  while (Date.now() < deadline) {
    try {
      if (Date.now() - statSync(path).mtimeMs >= WAIT_MS) throw new Error('stale record');
      const record = readJson(path);
      const plan = codexAttachPlan(record, tmpdir());
      if (record.codexSid !== codexSid) throw new Error('Codex conversation identity mismatch');
      const claimedPath = `${path}.claimed`;
      try {
        renameSync(path, claimedPath);
      } catch {
        throw new Error('Codex attach record was claimed by another launcher');
      }
      return { record, claimedPath, plan };
    } catch {
      // The exact hook record may not have been published completely yet.
    }
    await sleep(POLL_MS);
  }
  throw new Error('codex-attach-hook recorded no session for this Codex conversation');
}

async function main() {
  const daemonUrl = loopbackDaemonUrl(process.env.LUWI_DAEMON_URL ?? 'http://127.0.0.1:4782');
  let binding = environmentSessionBinding(process.env);
  let attach;
  const owned = binding === undefined;
  debug(`start inherited=${owned ? 'no' : 'yes'}`);
  if (owned) {
    const codexSid = codexNativeSessionId(process.env);
    if (codexSid === undefined) throw new Error('Codex MCP launcher received no conversation id');
    const { record, claimedPath, plan } = await claimRecord(Date.now() + WAIT_MS, codexSid);
    const { attachArguments, cwd, sessionFile } = plan;
    attach = spawn(process.execPath, [LUWI_CLI, ...attachArguments], {
      cwd,
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
    });
    writePrivateJsonFile(claimedPath, { ...record, attachPid: attach.pid, sessionFile });
    const deadline = Date.now() + WAIT_MS;
    let sessionId;
    while (Date.now() < deadline) {
      sessionId = attachedSession(sessionFile);
      if (sessionId && (await online(daemonUrl, sessionId))) break;
      await sleep(POLL_MS);
    }
    if (!sessionId || !(await online(daemonUrl, sessionId))) {
      attach.kill();
      throw new Error('Codex LUWI attach did not publish an online session in time');
    }
    binding = { sessionId, sessionFile };
    debug(`attach started session ${sessionId}`);
  }
  const server = spawn(process.execPath, [MCP_SERVER], {
    env: mcpServerEnvironment(process.env, binding),
    stdio: 'inherit',
    windowsHide: true,
  });
  debug(`mcp server spawned pid ${String(server.pid)}`);
  const stop = () => {
    attach?.kill();
    server.kill();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
  server.on('exit', (code) => {
    debug(`mcp server exited ${String(code)}`);
    attach?.kill();
    process.exit(code ?? 1);
  });
}

main().catch((error) => {
  debug(`failed: ${String(error.message ?? error)}`);
  process.stderr.write(
    `${JSON.stringify({ code: 'MCP_LAUNCH_FAILED', message: String(error.message ?? error) })}\n`,
  );
  process.exit(1);
});
