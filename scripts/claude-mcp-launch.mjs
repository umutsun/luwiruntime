#!/usr/bin/env node
/**
 * Claude Code MCP launcher: start LUWI's bound-session MCP server for a Claude
 * session that was NOT launched through `luwi agent run`.
 *
 * The MCP server hard-requires `LUWI_SESSION_ID` and Claude Code hands its MCP
 * children neither its session id nor its pid (anthropics/claude-code#25642), so
 * the id is recovered from the session's `claude-attach-hook.mjs`, which records
 * the LUWI session it attached under the Claude process (`claude.exe`) pid:
 *
 *   %TEMP%/luwi-attach-pid-<claudePid>   → Claude session id
 *   %TEMP%/luwi-attach-<claudeSid>.out   → `luwi session attach` stdout ({ attached })
 *
 * This launcher walks its own ancestry to the nearest `claude` process, follows
 * those two files, waits until the daemon reports that session online (the hook
 * and the MCP spawn race at SessionStart), then execs the MCP server with
 * `LUWI_SESSION_ID` over inherited stdio. An inherited `LUWI_SESSION_ID`
 * (`luwi agent run`) short-circuits all of that. Nothing is guessed: no mapping,
 * or a session that never comes online, fails closed with the MCP unavailable.
 *
 * Register it in `~/.claude.json` as the `luwi-runtime` stdio command:
 *   node C:/xampp/htdocs/luwiruntime/scripts/claude-mcp-launch.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const MCP_SERVER = join(import.meta.dirname, '..', 'apps', 'mcp-server', 'dist', 'main.js');
const WAIT_MS = 20_000;
const POLL_MS = 250;

/** Nearest ancestor process named `claude` (the Claude Code process), or undefined. */
export function claudeProcessId() {
  // ponytail: Windows only (one WMI snapshot, walked in JS); add `ps -o ppid=,comm=`
  // when a hook on macOS/Linux needs this.
  if (process.platform !== 'win32') return undefined;
  const rows = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.Name)" }',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  const byPid = new Map();
  for (const line of rows.split(/\r?\n/)) {
    const [pid, parent, name] = line.split(',');
    if (pid) byPid.set(Number(pid), { parent: Number(parent), name: name ?? '' });
  }
  let pid = byPid.get(process.pid)?.parent;
  for (let depth = 0; pid && depth < 8; depth += 1) {
    const row = byPid.get(pid);
    if (!row) return undefined;
    if (/^claude(\.exe)?$/i.test(row.name)) return pid;
    pid = row.parent;
  }
  return undefined;
}

const readText = (path) => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
};

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
  const claudePid = claudeProcessId();
  if (claudePid === undefined)
    throw new Error('no Claude Code process among the ancestors of this launcher');
  const daemonUrl = process.env.LUWI_DAEMON_URL ?? 'http://127.0.0.1:4782';
  const deadline = Date.now() + WAIT_MS;
  let seen;
  while (Date.now() < deadline) {
    // Re-read every turn: the hook truncates and rewrites these files at SessionStart.
    const claudeSid = readText(join(tmpdir(), `luwi-attach-pid-${claudePid}`));
    const out = claudeSid && readText(join(tmpdir(), `luwi-attach-${claudeSid}.out`));
    try {
      seen = JSON.parse(out).attached;
    } catch {
      seen = undefined;
    }
    if (seen && (await online(seen, daemonUrl))) return seen;
    await sleep(POLL_MS);
  }
  throw new Error(
    seen === undefined
      ? `claude-attach-hook recorded no LUWI session for Claude process ${claudePid} within ${WAIT_MS} ms`
      : `LUWI session ${seen} did not come online within ${WAIT_MS} ms`,
  );
}

if (process.argv[1] === import.meta.filename) {
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
}
