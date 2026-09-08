#!/usr/bin/env node
/**
 * Antigravity Desktop MCP launcher: start LUWI's bound-session MCP server for an
 * Antigravity IDE/Desktop conversation.
 *
 * Antigravity spawns MCP servers at app start, once, shared across every
 * conversation (mcp_servers are global), and hands the child neither a
 * conversation id nor `LUWI_SESSION_ID`. LUWI's MCP server, by contrast, binds
 * to exactly one live session. `antigravity-attach-hook.mjs` records the session
 * it attaches for the active conversation in `%TEMP%/luwi-antigravity-current.json`;
 * this launcher waits for that file, verifies the session is online, then execs
 * the MCP server with `LUWI_SESSION_ID`.
 *
 * ponytail: single global "current conversation" file → the MCP binds to the
 * most-recently-active Antigravity conversation. Fine for one workspace at a
 * time (the Albanoosh case). Upgrade to a workspace- or conversation-keyed file
 * (and have the launcher pick by its own cwd) if concurrent Antigravity
 * conversations must each reach their own LUWI inbox — the diag file records
 * whether Antigravity passes anything (cwd/env) that would let us key on it.
 *
 * An inherited `LUWI_SESSION_ID` (`luwi agent run gemini`) short-circuits the
 * wait. Nothing is guessed: no current file, or a session that never comes
 * online, fails closed with the MCP unavailable.
 *
 * Register it in `~/.gemini/config/mcp_config.json` as the `luwi-runtime` stdio
 * command (see docs/ for the exact block).
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const MCP_SERVER = join(import.meta.dirname, '..', 'apps', 'mcp-server', 'dist', 'main.js');
const CURRENT_FILE = join(tmpdir(), 'luwi-antigravity-current.json');
const DIAG_FILE = join(tmpdir(), 'luwi-antigravity-mcp-launch.diag.json');
// Antigravity starts MCP servers at app launch, before the first message fires
// the attach hook, and keeps a slow-connecting stdio server alive for minutes,
// so wait generously for the hook to publish the current session.
const WAIT_MS = 5 * 60_000;
const POLL_MS = 500;

// One-shot diagnostics: what Antigravity actually hands an MCP child. Read it
// once (%TEMP%/luwi-antigravity-mcp-launch.diag.json) to decide whether a
// conversation-scoped binding is even possible here.
try {
  const relevant = Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      /ANTIGRAVITY|GEMINI|CONVERSAT|WORKSPACE|CODEIUM|CASCADE|LUWI/i.test(k),
    ),
  );
  writeFileSync(
    DIAG_FILE,
    JSON.stringify(
      { at: new Date().toISOString(), cwd: process.cwd(), argv: process.argv, env: relevant },
      null,
      2,
    ),
  );
} catch {
  // Diagnostics are best-effort; never block the launch on them.
}

async function online(sessionId, daemonUrl) {
  try {
    const response = await fetch(`${daemonUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`);
    return response.ok && (await response.json()).presence === 'online';
  } catch {
    return false;
  }
}

async function resolveSessionId() {
  if (process.env.LUWI_SESSION_ID) return process.env.LUWI_SESSION_ID;
  const daemonUrl = process.env.LUWI_DAEMON_URL ?? 'http://127.0.0.1:4782';
  const deadline = Date.now() + WAIT_MS;
  let seen;
  while (Date.now() < deadline) {
    try {
      seen = JSON.parse(readFileSync(CURRENT_FILE, 'utf8')).sessionId;
    } catch {
      seen = undefined;
    }
    if (seen && (await online(seen, daemonUrl))) return seen;
    await sleep(POLL_MS);
  }
  throw new Error(
    seen === undefined
      ? `antigravity-attach-hook published no current LUWI session within ${WAIT_MS} ms`
      : `LUWI session ${seen} did not come online within ${WAIT_MS} ms`,
  );
}

resolveSessionId().then(
  (sessionId) => {
    const server = spawn(process.execPath, [MCP_SERVER], {
      env: { ...process.env, LUWI_SESSION_ID: sessionId },
      stdio: 'inherit',
      windowsHide: true,
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill());
    server.on('exit', (code) => process.exit(code ?? 1));
  },
  (error) => {
    process.stderr.write(
      `${JSON.stringify({ code: 'MCP_LAUNCH_FAILED', message: String(error.message ?? error) })}\n`,
    );
    process.exitCode = 1;
  },
);
