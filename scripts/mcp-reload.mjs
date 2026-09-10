#!/usr/bin/env node
/**
 * Rebuild the LUWI MCP server and restart every agent's MCP so they all run the same
 * latest build.
 *
 * An MCP stdio server loads `apps/mcp-server/dist/main.js` once at start and never
 * hot-reloads, so a rebuild only reaches an agent when its server is relaunched. Killing
 * the running server + launcher makes each agent's client respawn it from the fresh dist
 * — that is the whole "update all agents" step. Windows-only for the restart (matches
 * processes by command line via Get-CimInstance); the rebuild runs everywhere.
 *
 *   node scripts/mcp-reload.mjs
 */
import { execFileSync, execSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

const root = join(import.meta.dirname, '..');

process.stdout.write('Rebuilding MCP server dist (tsc -b)…\n');
execSync('pnpm exec tsc -b', { cwd: root, stdio: 'inherit' });

if (process.platform !== 'win32') {
  process.stderr.write('mcp-reload: the process restart is Windows-only for now; dist rebuilt.\n');
  process.exit(0);
}

// One CIM snapshot, filtered to Node-hosted LUWI MCP servers and launchers by command
// line. The image-name guard also prevents this PowerShell query from matching its own
// command text. The daemon and native app/bridge parents do not match these globs.
const command =
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ($_.CommandLine -like '*mcp-server*dist*main*' -or $_.CommandLine -like '*mcp-launch.mjs*') } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; 'killed ' + $_.ProcessId } catch { } }";
const output = (() => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (error) {
    // PowerShell can exit non-zero even after a successful kill (a Stop-Process race, an
    // access-denied on some unrelated process); the stdout it produced still lists ours.
    return typeof error?.stdout === 'string' ? error.stdout : '';
  }
})();
const killed = output.split(/\r?\n/).filter((line) => line.startsWith('killed'));
process.stdout.write(
  `Restarted ${String(killed.length)} MCP process(es); each agent's client respawns its MCP on the latest dist.\n`,
);
