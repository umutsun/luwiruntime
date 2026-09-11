import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionBindingResolver, createSessionIdResolver } from './session-binding.js';

describe('MCP session binding resolver', () => {
  const scratch: string[] = [];

  afterEach(async () => {
    await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
    scratch.length = 0;
  });

  const directory = async () => {
    const path = await mkdtemp(join(tmpdir(), 'luwi-mcp-binding-'));
    scratch.push(path);
    return path;
  };

  const writeBinding = (path: string, attached: string) =>
    writeFile(path, `${JSON.stringify({ attached })}\n`, { encoding: 'utf8', mode: 0o600 });

  it('keeps the environment binding backward compatible', async () => {
    const resolveSessionId = createSessionIdResolver({ kind: 'static', sessionId: 'session-1' });
    await expect(resolveSessionId()).resolves.toBe('session-1');
  });

  it('reads the atomically replaced file again for every resolution', async () => {
    const root = await directory();
    const active = join(root, 'session.json');
    const replacement = join(root, 'replacement.json');
    await writeBinding(active, 'session-1');
    const resolveSessionId = createSessionIdResolver({ kind: 'file', path: active });

    await expect(resolveSessionId()).resolves.toBe('session-1');
    await writeBinding(replacement, 'session-2');
    await rename(replacement, active);
    await expect(resolveSessionId()).resolves.toBe('session-2');
  });

  it.each([
    ['', 'empty'],
    ['not json', 'malformed'],
    [JSON.stringify({ attached: '' }), 'empty id'],
    [JSON.stringify({ attached: 'session-1', projectId: 'forged' }), 'extra fields'],
  ])('rejects %s session binding content (%s)', async (content) => {
    const root = await directory();
    const path = join(root, 'session.json');
    await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
    const resolveSessionId = createSessionIdResolver({ kind: 'file', path });
    await expect(resolveSessionId()).rejects.toThrow('session binding file');
  });

  it('rejects oversized and non-regular binding files', async () => {
    const root = await directory();
    const oversized = join(root, 'oversized.json');
    await writeFile(oversized, 'x'.repeat(4097), { encoding: 'utf8', mode: 0o600 });
    await expect(createSessionIdResolver({ kind: 'file', path: oversized })()).rejects.toThrow(
      'session binding file',
    );
    await expect(createSessionIdResolver({ kind: 'file', path: root })()).rejects.toThrow(
      'session binding file',
    );
  });

  it('rejects a symbolic-link binding path', async () => {
    const root = await directory();
    const target = join(root, 'target');
    const linked = join(root, 'linked');
    await mkdir(target);
    await symlink(target, linked, 'junction');
    await expect(createSessionIdResolver({ kind: 'file', path: linked })()).rejects.toThrow(
      'session binding file',
    );
  });

  it.runIf(process.platform !== 'win32')('rejects group- or world-readable files', async () => {
    const root = await directory();
    const path = join(root, 'session.json');
    await writeBinding(path, 'session-1');
    await chmod(path, 0o644);
    await expect(createSessionIdResolver({ kind: 'file', path })()).rejects.toThrow(
      'session binding file',
    );
  });
});

describe('MCP session binding record (ADR 0034)', () => {
  it('carries the native reference the attach wrote, and the id resolver still answers the id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luwi-mcp-binding-'));
    try {
      const path = join(root, 'session.json');
      const native = { adapterId: 'claude-code', nativeSessionId: 'native-1' };
      await writeFile(path, `${JSON.stringify({ attached: 'session-1', native })}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await expect(createSessionBindingResolver({ kind: 'file', path })()).resolves.toEqual({
        attached: 'session-1',
        native,
      });
      await expect(createSessionIdResolver({ kind: 'file', path })()).resolves.toBe('session-1');
      await expect(
        createSessionBindingResolver({ kind: 'static', sessionId: 'session-2' })(),
      ).resolves.toEqual({ attached: 'session-2' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
