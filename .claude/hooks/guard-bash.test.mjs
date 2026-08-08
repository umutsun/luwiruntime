/**
 * Standalone test for the PreToolUse shell guard.
 *
 * Run with: node .claude/hooks/guard-bash.test.mjs
 *
 * This is not part of `pnpm test`: vitest only collects from apps/ and
 * packages/. Run it directly after changing guard-bash.mjs. Exit code 0 means
 * every case matched its expected verdict.
 *
 * The ALLOW cases matter as much as the BLOCK cases — a guard that blocks
 * `rg "git reset --hard" docs/` is a guard people learn to work around.
 */

import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'guard-bash.mjs');

const cases = [
  // --- must BLOCK (exit 2) ---
  ['Bash', 'git reset --hard HEAD~1', 2],
  ['Bash', 'git reset --hard', 2],
  ['Bash', 'cd /c/xampp/htdocs/luwiruntime && git reset --hard origin/master', 2],
  ['Bash', 'git clean -fd', 2],
  ['Bash', 'git clean -xdf', 2],
  ['Bash', 'git push --force origin master', 2],
  ['Bash', 'git push -f origin master', 2],
  ['Bash', 'git stash', 2],
  ['Bash', 'git stash push -u', 2],
  ['Bash', 'git checkout -- .', 2],
  ['Bash', 'git restore .', 2],
  ['Bash', 'rm -rf .', 2],
  ['Bash', 'rm -rf /', 2],
  ['Bash', 'rm -rf c:/xampp/htdocs/luwiruntime', 2],
  ['Bash', 'redis-cli -n 15 flushdb', 2],
  ['Bash', 'memurai-cli FLUSHALL', 2],
  ['PowerShell', "& 'C:\\Program Files\\Memurai\\memurai-cli.exe' FLUSHALL", 2],
  ['PowerShell', "& 'C:\\Program Files\\Memurai\\memurai-cli.exe' FUNCTION FLUSH", 2],
  ['PowerShell', 'Remove-Item -Recurse -Force .', 2],

  // --- must ALLOW (exit 0) ---
  ['Bash', 'rg FLUSHALL .', 0],
  ['Bash', 'rg "git reset --hard" docs/', 0],
  ['Bash', 'grep -rn "git clean -fd" .claude/', 0],
  ['Bash', 'git status --short', 0],
  ['Bash', 'git stash list', 0],
  ['Bash', 'git stash show', 0],
  ['Bash', 'git push origin master', 0],
  ['Bash', 'git push --force-with-lease origin master', 0],
  ['Bash', 'git checkout -- apps/daemon/src/app.ts', 0],
  ['Bash', 'git restore apps/daemon/src/app.ts', 0],
  ['Bash', 'rm -rf node_modules/.vite', 0],
  ['Bash', 'rm -rf apps/dashboard/dist', 0],
  ['Bash', 'pnpm test', 0],
  ['Bash', 'pnpm build && pnpm lint', 0],
  ['PowerShell', "& 'C:\\Program Files\\Memurai\\memurai-cli.exe' FUNCTION LIST", 0],
  ['PowerShell', 'Remove-Item -Recurse -Force apps/dashboard/dist', 0],
  ['Bash', 'git log --oneline -5', 0],

  // --- non-guarded tools must pass through ---
  ['Edit', 'git reset --hard', 0],
  ['Read', 'git reset --hard', 0],
];

let pass = 0;
let fail = 0;

for (const [tool, command, expected] of cases) {
  const payload = JSON.stringify({
    session_id: 'test',
    cwd: 'c:/xampp/htdocs/luwiruntime',
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { command, description: 'test' },
  });
  const result = spawnSync(process.execPath, [GUARD], { input: payload, encoding: 'utf8' });
  const actual = result.status;
  const ok = actual === expected;
  if (ok) pass++;
  else fail++;
  const verdict = ok ? 'ok  ' : 'FAIL';
  const label = expected === 2 ? 'BLOCK' : 'ALLOW';
  console.log(`${verdict} [${label}] (${tool}) ${command}   -> exit ${actual}`);
  if (!ok && result.stderr) console.log(`      stderr: ${result.stderr.trim().split('\n')[0]}`);
}

// Malformed payload must fail open.
const bad = spawnSync(process.execPath, [GUARD], { input: 'not json', encoding: 'utf8' });
const badOk = bad.status === 0;
console.log(`${badOk ? 'ok  ' : 'FAIL'} [ALLOW] malformed stdin -> exit ${bad.status}`);
if (badOk) pass++;
else fail++;

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
