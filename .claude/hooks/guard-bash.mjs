#!/usr/bin/env node
/**
 * PreToolUse guard for shell tools in the LUWI Runtime repository.
 *
 * Why this exists: this repository has exactly one commit (Phase 1). Phases 2
 * through 5B — including all of apps/dashboard, apps/mcp-server,
 * packages/adapters, and ADRs 0006-0011 — are uncommitted working-tree state.
 * A single `git reset --hard`, `git clean -fd`, `git stash`, or `git checkout .`
 * destroys work that has no recovery path.
 *
 * It also guards the shared local Redis (Memurai) instance, which holds the
 * server-scoped `luwi_v1` Function library and ~1300 live `luwi:v1:*` keys.
 *
 * Contract: Claude Code writes a JSON payload on stdin. Exit code 2 blocks the
 * call and returns stderr to Claude. Any other exit code allows it.
 *
 * `jq` is not installed on this machine, and shell scripts are subject to CRLF
 * mangling under `core.autocrlf=true`, so this is deliberately plain Node.
 *
 * Failure posture: if the payload cannot be parsed or no command string can be
 * located, this guard ALLOWS the call and records a diagnostic. Fail-closed
 * would make the repository unusable on any contract change; the
 * `permissions.deny` rules in .claude/settings.json are the second layer.
 */

import { Buffer } from 'node:buffer';
import { appendFileSync, readSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const DIAGNOSTIC_PATH = join(tmpdir(), 'luwi-guard-shell-diagnostics.jsonl');

const GUARDED_TOOLS = new Set(['Bash', 'PowerShell']);

/** Optional leading `VAR=value` assignments before the real binary. */
const ENV_PREFIX = String.raw`(?:\w+=\S+\s+)*`;

/**
 * Anchored rules run against a single command segment and require the guarded
 * binary to be what the segment actually invokes. This is what keeps
 * `rg "git reset --hard" docs/` from being blocked: there, `git` appears inside
 * an argument rather than at the head of the segment.
 */
const ANCHORED_RULES = [
  {
    id: 'git-reset-hard',
    pattern: new RegExp(`^${ENV_PREFIX}git\\s+(?:-\\S+\\s+)*reset\\b.*--hard`, 'i'),
    reason:
      'git reset --hard would discard 43 modified files and is unrecoverable here: only Phase 1 is committed.',
  },
  {
    id: 'git-clean-force',
    pattern: new RegExp(`^${ENV_PREFIX}git\\s+(?:-\\S+\\s+)*clean\\b.*\\s-[a-z]*f`, 'i'),
    reason:
      'git clean -f would delete 188 untracked files, including apps/dashboard, apps/mcp-server, packages/adapters, and ADRs 0006-0011.',
  },
  {
    id: 'git-push-force',
    pattern: new RegExp(
      `^${ENV_PREFIX}git\\s+(?:-\\S+\\s+)*push\\b.*(--force(?!-with-lease)|(?<![\\w-])-f(?![\\w-]))`,
      'i',
    ),
    reason: 'Force push is prohibited by AGENTS.md section 13 unless explicitly requested.',
  },
  {
    id: 'git-stash',
    pattern: new RegExp(`^${ENV_PREFIX}git\\s+(?:-\\S+\\s+)*stash\\b(?!\\s+(list|show))`, 'i'),
    reason:
      'git stash would move the entire uncommitted Phase 2-5B working tree out of view. `git stash list` and `git stash show` remain allowed.',
  },
  {
    id: 'git-discard-worktree',
    pattern: new RegExp(
      `^${ENV_PREFIX}git\\s+(?:-\\S+\\s+)*(checkout|restore)\\b.*(--\\s+\\.|\\s\\.\\s*$)`,
      'i',
    ),
    reason:
      'Discarding the whole working tree would destroy uncommitted Phase 2-5B work. Target a specific file instead.',
  },
  {
    id: 'recursive-delete-broad',
    // Fires only when the target is the repository root, cwd, parent, home,
    // filesystem root, or a bare glob. `rm -rf node_modules/.vite` stays allowed.
    pattern: new RegExp(
      `^${ENV_PREFIX}rm\\s+(?:-[a-z]+\\s+)*-[a-z]*(?:rf|fr)[a-z]*\\s+["']?(?:\\.\\.?|\\/|~|\\*|[a-z]:[\\\\/]xampp[\\\\/]htdocs[\\\\/]luwiruntime[\\\\/]?)["']?\\s*$`,
      'i',
    ),
    reason: 'Recursive delete of the repository root, cwd, home, or filesystem root is blocked.',
  },
  {
    id: 'powershell-recursive-delete-broad',
    pattern:
      /^Remove-Item\b(?=.*-Recurse\b)(?=.*-Force\b).*\s["']?(?:\.|\.\.|~|\*|[a-z]:[\\/]xampp[\\/]htdocs[\\/]luwiruntime[\\/]?)["']?(\s|$)/i,
    reason: 'Recursive force delete of the repository root or cwd would destroy uncommitted work.',
  },
];

/**
 * Unanchored rules. The Redis CLI is normally invoked through a quoted absolute
 * path (`& 'C:\\Program Files\\Memurai\\memurai-cli.exe'`), which no start
 * anchor can match. The false-positive risk is negligible — nobody greps for
 * `memurai-cli flushall` — while the blast radius of a real hit is total.
 */
const UNANCHORED_RULES = [
  {
    id: 'redis-flush',
    pattern: /\b(memurai-cli|redis-cli)(\.exe)?["']?\s[^|;&]*\bflush(all|db)\b/i,
    reason:
      'FLUSHALL/FLUSHDB on the shared Memurai instance would erase ~1300 live luwi:v1:* keys. AGENTS.md section 15 forbids flushing unrelated keys.',
  },
  {
    id: 'redis-function-flush',
    pattern: /\b(memurai-cli|redis-cli)(\.exe)?["']?\s[^|;&]*\bfunction\s+flush\b/i,
    reason:
      'FUNCTION FLUSH would unload the server-scoped luwi_v1 library that the running daemon depends on.',
  },
];

function readStdin() {
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  for (;;) {
    let bytes;
    try {
      bytes = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error && error.code === 'EAGAIN') continue;
      break;
    }
    if (bytes === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Locate the command string without hard-coding one field path, so a harness
 * contract change degrades to "allow plus diagnostic" rather than a silent
 * pass-through.
 */
function findCommand(payload) {
  const direct = payload?.tool_input?.command;
  if (typeof direct === 'string') return { command: direct, source: 'tool_input.command' };

  const input = payload?.tool_input;
  if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string' && value.trim() !== '') {
        return { command: value, source: `tool_input.${key}` };
      }
    }
  }
  return { command: null, source: null };
}

/** Split a compound command into independently invoked segments. */
function segments(command) {
  return command
    .split(/(?:\|\||&&|[;&|\n])+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
}

function evaluate(command) {
  const normalized = command.replace(/[ \t]+/g, ' ').trim();

  for (const rule of UNANCHORED_RULES) {
    if (rule.pattern.test(normalized)) return rule;
  }

  for (const segment of segments(normalized)) {
    // Strip PowerShell's call operator and a leading `sudo`/`command` wrapper.
    const head = segment.replace(/^&\s*/, '').replace(/^(sudo|command)\s+/i, '');
    for (const rule of ANCHORED_RULES) {
      if (rule.pattern.test(head)) return rule;
    }
  }

  return null;
}

function diagnose(entry) {
  try {
    appendFileSync(DIAGNOSTIC_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Diagnostics must never block a tool call.
  }
}

function main() {
  const raw = readStdin();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    diagnose({ event: 'unparsable-stdin', bytes: raw.length, sample: raw.slice(0, 400) });
    return 0;
  }

  if (!GUARDED_TOOLS.has(payload?.tool_name)) return 0;

  const { command, source } = findCommand(payload);
  if (typeof command !== 'string') {
    diagnose({ event: 'no-command-field', keys: Object.keys(payload?.tool_input ?? {}) });
    return 0;
  }
  if (source !== 'tool_input.command') {
    diagnose({ event: 'unexpected-command-field', source });
  }

  const violated = evaluate(command);
  if (!violated) return 0;

  process.stderr.write(
    `Blocked by LUWI repository guard [${violated.id}].\n${violated.reason}\n` +
      'See CLAUDE.md "Repository state" and AGENTS.md section 13.\n',
  );
  return 2;
}

process.exitCode = main();
