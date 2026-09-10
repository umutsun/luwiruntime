#!/usr/bin/env node
/**
 * Antigravity hook: attach the active conversation to LUWI automatically.
 *
 * Antigravity fires `PreInvocation` before every model call and has no session
 * start or end event, so this hook is idempotent per conversation: the first
 * invocation spawns a detached supervisor (this file in `supervise` mode) that
 * runs `luwi session attach` for the conversation's life; every later invocation
 * finds the supervisor's pid file and does nothing. The supervisor stops the
 * attach once the conversation's transcript has not changed for IDLE_MS —
 * Antigravity signals no end, so idleness is the only honest proxy — and the
 * next invocation attaches again as a new LUWI session.
 *
 * Identity is declared, not resolved: the `conversationId` on stdin becomes the
 * native reference (`--native-adapter antigravity --native-session <id>`), the
 * project comes from `workspacePaths[0]`, and the model — absent from the hook's
 * input — is not guessed. Reads the hook JSON from stdin and answers `{}`.
 *
 * Register it in `~/.gemini/config/hooks.json` under `PreInvocation`.
 */
import { spawn } from 'node:child_process';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';
import {
  conversationPidFile,
  conversationSessionFile,
  writePrivateTextFile,
} from './native-mcp-binding.mjs';

const LUWI_CLI = join(import.meta.dirname, '..', 'apps', 'cli', 'dist', 'main.js');
// ponytail: a fixed idle window; make it a setting if conversations regularly
// pause longer than this and come back.
const IDLE_MS = 30 * 60_000;
const POLL_MS = 60_000;

const pidFileFor = (conversationId) => conversationPidFile(tmpdir(), 'antigravity', conversationId);

function alive(pidFile) {
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')), 0);
    return true;
  } catch {
    return false;
  }
}

// Records the session Antigravity's app-start MCP launcher must bind to. See
// `antigravity-mcp-launch.mjs`: a single global "current conversation" file,
// so the launched LUWI MCP server binds to the most-recently-active Antigravity
// conversation (fine for one workspace at a time).
const currentFile = join(tmpdir(), 'luwi-antigravity-current.json');
const lastFile = join(tmpdir(), 'luwi-antigravity-last.json');

if (process.argv[2] === 'supervise') {
  const [conversationId, workspace, transcriptPath] = process.argv.slice(3);
  const sessionFile = conversationSessionFile(tmpdir(), 'antigravity', conversationId);
  const startedAt = Date.now();
  const attach = spawn(
    process.execPath,
    [
      LUWI_CLI,
      'session',
      'attach',
      '--agent',
      'antigravity',
      '--agent-kind',
      'other',
      '--native-adapter',
      'antigravity',
      '--native-session',
      conversationId,
      '--working-directory',
      workspace,
      '--session-out',
      sessionFile,
    ],
    { cwd: workspace, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  );
  // `session attach` prints one `{ attached: <luwiSessionId>, ... }` object once
  // it registers, then heartbeats quietly. Capture that id for the MCP launcher.
  let buffer = '';
  let published = false;
  attach.stdout.on('data', (chunk) => {
    if (published) return;
    buffer += chunk;
    try {
      const attached = JSON.parse(buffer).attached;
      if (attached !== undefined) {
        const payload = JSON.stringify({
          sessionId: attached,
          conversationId,
          workspace,
          transcriptPath,
          sessionFile,
          at: new Date().toISOString(),
        });
        writePrivateTextFile(currentFile, payload);
        writePrivateTextFile(lastFile, payload);
        published = true;
      }
    } catch {
      // Object not fully buffered yet — wait for the next chunk.
    }
  });
  const idle = () => {
    try {
      return Date.now() - statSync(transcriptPath).mtimeMs > IDLE_MS;
    } catch {
      // No transcript yet (a brand-new conversation) or it is gone: judge by
      // the supervisor's own age instead of killing a session that just began.
      return Date.now() - startedAt > IDLE_MS;
    }
  };
  const timer = setInterval(() => {
    if (idle()) attach.kill();
  }, POLL_MS);
  attach.on('exit', () => {
    clearInterval(timer);
    try {
      // Only clear the shared current-session file if it still names this
      // conversation; a newer conversation may have taken it over.
      if (JSON.parse(readFileSync(currentFile, 'utf8')).conversationId === conversationId)
        unlinkSync(currentFile);
    } catch {
      // No current file, or it belongs to another conversation — leave it.
    }
    try {
      unlinkSync(pidFileFor(conversationId));
    } catch {
      // Already removed.
    }
    process.exit(0);
  });
} else if (process.env.LUWI_SESSION_ID) {
  // ADR 0031: launched under a LUWI session already — do not attach a second.
  process.stdout.write('{}');
} else {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const { conversationId, workspacePaths, transcriptPath } = input;
  const workspace = Array.isArray(workspacePaths) ? workspacePaths[0] : undefined;
  if (typeof conversationId === 'string' && typeof workspace === 'string') {
    const pidFile = pidFileFor(conversationId);
    if (!alive(pidFile)) {
      const supervisor = spawn(
        process.execPath,
        [
          import.meta.filename,
          'supervise',
          conversationId,
          workspace,
          typeof transcriptPath === 'string' ? transcriptPath : '',
        ],
        { cwd: workspace, detached: true, stdio: 'ignore', windowsHide: true },
      );
      writePrivateTextFile(pidFile, String(supervisor.pid));
      supervisor.unref();
    }
  }
  process.stdout.write('{}');
}
