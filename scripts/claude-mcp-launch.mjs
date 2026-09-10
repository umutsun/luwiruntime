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
 * `LUWI_SESSION_FILE` over inherited stdio. The server re-reads that atomically
 * replaced file for every tool call. An inherited `LUWI_SESSION_ID`
 * (`luwi agent run`) short-circuits all of that. Nothing is guessed: no mapping,
 * or a session that never comes online, fails closed with the MCP unavailable.
 *
 * Register it in `~/.claude.json` as the `luwi-runtime` stdio command:
 *   node C:/xampp/htdocs/luwiruntime/scripts/claude-mcp-launch.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  environmentSessionBinding,
  loopbackDaemonUrl,
  mcpServerEnvironment,
  readBoundedTextFile,
  readSessionBindingFile,
} from './native-mcp-binding.mjs';

export { mcpServerEnvironment };

const MCP_SERVER = join(import.meta.dirname, '..', 'apps', 'mcp-server', 'dist', 'main.js');
const WAIT_MS = 20_000;
const POLL_MS = 250;

/** Nearest ancestor process named `claude` (the Claude Code process), or undefined. */
export function claudeProcessId() {
  return ancestorProcessId(/^claude(\.exe)?$/i);
}

/** Nearest ancestor whose image name matches `pattern`, or undefined. Shared with the Codex pair. */
export function ancestorProcessId(pattern) {
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
    if (pattern.test(row.name)) return pid;
    pid = row.parent;
  }
  return undefined;
}

const readText = (path) => {
  try {
    return readBoundedTextFile(path).trim();
  } catch {
    return undefined;
  }
};

async function sessionState(sessionId, daemonUrl) {
  try {
    const response = await fetch(`${daemonUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`);
    if (!response.ok) return { online: false, terminal: false };
    const session = await response.json();
    return {
      online: session.presence === 'online',
      terminal: session.status === 'completed' || session.status === 'disconnected',
    };
  } catch {
    return { online: false, terminal: false };
  }
}

async function resolveSessionBinding() {
  const configured = environmentSessionBinding(process.env);
  if (configured !== undefined) return configured;
  const claudePid = claudeProcessId();
  if (claudePid === undefined)
    throw new Error('no Claude Code process among the ancestors of this launcher');
  const daemonUrl = loopbackDaemonUrl(process.env.LUWI_DAEMON_URL ?? 'http://127.0.0.1:4782');
  const deadline = Date.now() + WAIT_MS;
  let seen;
  let sessionFile;
  while (Date.now() < deadline) {
    // Re-read every turn: `session attach --session-out` atomically rewrites this file
    // with the current session id, so a daemon-restart rotation is picked up right here.
    const claudeSid = readText(join(tmpdir(), `luwi-attach-pid-${claudePid}`));
    sessionFile = claudeSid && join(tmpdir(), `luwi-attach-${claudeSid}.out`);
    try {
      seen = sessionFile ? readSessionBindingFile(sessionFile) : undefined;
    } catch {
      seen = undefined;
    }
    if (seen && sessionFile && (await sessionState(seen, daemonUrl)).online) {
      return { sessionId: seen, sessionFile };
    }
    await sleep(POLL_MS);
  }
  // ponytail: presence is heartbeat-derived and often not yet 'online' in a
  // session's first seconds — exactly when this launcher runs — so on timeout we
  // start anyway with a hook-recorded id (read, not guessed); the MCP server
  // reconnects to the daemon itself. But NEVER bind a *terminal* id: a daemon
  // restart makes the recorded session `disconnected`, and binding it only makes
  // the MCP server exit at once, leaving a heartbeating session with no reader.
  // Fail closed instead — the attach process rewrites --session-out with the
  // rotated id, so the next launcher run recovers. Upgrade path: have the MCP
  // server block on presence itself.
  if (seen) {
    if (!(await sessionState(seen, daemonUrl)).terminal) {
      process.stderr.write(
        `${JSON.stringify({ code: 'MCP_PRESENCE_TIMEOUT', message: `LUWI session ${seen} not online within ${WAIT_MS} ms; starting MCP anyway` })}\n`,
      );
      return { sessionId: seen, sessionFile };
    }
    throw new Error(
      `recorded LUWI session ${seen} is terminal (a daemon restart likely rotated it); not binding a dead session`,
    );
  }
  throw new Error(
    `claude-attach-hook recorded no LUWI session for Claude process ${claudePid} within ${WAIT_MS} ms`,
  );
}

if (process.argv[1] === import.meta.filename) {
  resolveSessionBinding().then(
    (binding) => {
      const server = spawn(process.execPath, [MCP_SERVER], {
        env: mcpServerEnvironment(process.env, binding),
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
