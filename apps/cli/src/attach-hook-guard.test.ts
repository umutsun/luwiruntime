import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * ADR 0031: a native process launched under a LUWI session (`agent run`, the
 * native inbox bridge) inherits `LUWI_SESSION_ID`. Its vendor hooks still fire —
 * Claude runs `SessionStart` in `--print` mode too — and must not register a
 * second, reader-less LUWI session. Both hooks exit before touching anything.
 */
const run = promisify(execFile);
const scripts = join(import.meta.dirname, '..', '..', '..', 'scripts');

describe('attach hooks under an inherited LUWI session', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'luwi-hook-guard-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const environment = () => ({
    ...process.env,
    LUWI_SESSION_ID: 'session-from-bridge',
    TEMP: scratch,
    TMP: scratch,
    TMPDIR: scratch,
  });

  it('claude-attach-hook start writes nothing and spawns no attach', async () => {
    const { stdout } = await run(
      process.execPath,
      [join(scripts, 'claude-attach-hook.mjs'), 'start'],
      { env: environment(), input: JSON.stringify({ session_id: 'claude-sid', cwd: scratch }) },
    );
    expect(stdout).toBe('');
    expect(await readdir(scratch)).toEqual([]);
  });

  it('antigravity-attach-hook still answers {} and writes nothing', async () => {
    const { stdout } = await run(process.execPath, [join(scripts, 'antigravity-attach-hook.mjs')], {
      env: environment(),
      input: JSON.stringify({ conversationId: 'conv-1', workspacePaths: [scratch] }),
    });
    expect(stdout).toBe('{}');
    expect(await readdir(scratch)).toEqual([]);
  });
});
