#!/usr/bin/env node
/**
 * Codex MCP launcher that binds the MCP server to the current native Codex
 * conversation. It prefers a fresh SessionStart hook record and falls back to
 * resolving the exact conversation id plus inherited working directory.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveCodexAttach } from './codex-attach-resolution.mjs';
import {
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
const DEBUG_LOG = process.env.LUWI_MCP_LAUNCH_DEBUG
  ? join(tmpdir(), 'luwi-codex-mcp-launch.log')
  : undefined;

function debug(line) {
  if (DEBUG_LOG === undefined) return;
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} pid ${String(process.pid)} ${line}\n`);
  } catch {
    // Diagnosis must never break launch.
  }
}

function readJson(path) {
  try {
    return readBoundedJsonFile(path);
  } catch {
    return undefined;
  }
}

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

function claimRecord(codexSid) {
  const path = join(tmpdir(), `${RECORD_PREFIX}${codexSid}.json`);
  try {
    if (Date.now() - statSync(path).mtimeMs >= WAIT_MS) throw new Error('stale record');
    const record = readJson(path);
    if (record.codexSid !== codexSid) throw new Error('Codex conversation identity mismatch');
    const { plan } = resolveCodexAttach({
      codexSid,
      cwd: process.cwd(),
      temporaryDirectory: tmpdir(),
      environment: process.env,
      record,
    });
    const claimedPath = `${path}.claimed`;
    renameSync(path, claimedPath);
    return { record, claimedPath, plan };
  } catch {
    return undefined;
  }
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
    const claimed = claimRecord(codexSid);
    const resolved =
      claimed ??
      resolveCodexAttach({
        codexSid,
        cwd: process.cwd(),
        temporaryDirectory: tmpdir(),
        environment: process.env,
      });
    const { record, plan } = resolved;
    const claimedPath =
      claimed?.claimedPath ?? join(tmpdir(), `${RECORD_PREFIX}${codexSid}.json.claimed`);
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
