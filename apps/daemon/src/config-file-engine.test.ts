import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { ApplicationError } from '@luwi/runtime';

import {
  clearStaleConfigFileLocks,
  createConfigFileEngine,
  hashFileContent,
} from './config-file-engine.js';

const roots: string[] = [];

async function fixture(): Promise<{ root: string; stateRoot: string; target: string }> {
  const root = await mkdtemp(join(tmpdir(), 'luwi-config-engine-'));
  roots.push(root);
  const stateRoot = join(root, '.luwi');
  const target = join(root, '.claude', 'settings.json');
  await mkdir(join(root, '.claude'), { recursive: true });
  return { root, stateRoot, target };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('config file transaction engine', () => {
  it('snapshots, atomically replaces, and rolls back a managed file', async () => {
    const { root, stateRoot, target } = await fixture();
    const original = '{"model":"old"}\n';
    const updated = '{"model":"new"}\n';
    await writeFile(target, original);
    let snapshotId = 0;
    const engine = createConfigFileEngine({
      allowedRoots: [root],
      stateRoot,
      id: () => `snapshot-${String(++snapshotId)}`,
      now: () => new Date('2026-07-29T12:00:00.000Z'),
    });

    const applied = await engine.apply({
      operationId: 'operation-1',
      planId: 'plan-1',
      agentId: 'claude-test',
      adapterVersion: 'claude-code-native-v1',
      files: [{ path: target, content: updated, managementMode: 'managed-file' }],
      preconditionHashes: { [target]: hashFileContent(original) },
    });

    expect(await readFile(target, 'utf8')).toBe(updated);
    expect(applied.committedHashes[target]).toBe(hashFileContent(updated));
    expect(JSON.stringify(applied.snapshot.redactedManifest)).not.toContain(original);
    await expect(stat(applied.snapshot.files[0]?.snapshotPath ?? '')).resolves.toBeDefined();

    const rolledBack = await engine.rollback({
      sourceSnapshot: applied.snapshot,
      operationId: 'operation-rollback-1',
      planId: 'plan-rollback-1',
      agentId: 'claude-test',
      adapterVersion: 'claude-code-native-v1',
      expectedCurrentHashes: applied.committedHashes,
    });
    expect(await readFile(target, 'utf8')).toBe(original);
    expect(rolledBack.snapshot.id).not.toBe(applied.snapshot.id);
    expect(rolledBack.snapshot.files[0]?.originalHash).toBe(hashFileContent(updated));
  });

  it('rejects a precondition mismatch before writing any target', async () => {
    const { root, stateRoot, target } = await fixture();
    await writeFile(target, 'external change');
    const engine = createConfigFileEngine({
      allowedRoots: [root],
      stateRoot,
      id: () => 'snapshot-2',
    });

    await expect(
      engine.apply({
        operationId: 'operation-2',
        planId: 'plan-2',
        agentId: 'codex-test',
        adapterVersion: 'codex-native-v1',
        files: [{ path: target, content: 'planned', managementMode: 'managed-file' }],
        preconditionHashes: { [target]: hashFileContent('expected') },
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_PLAN_PRECONDITION_FAILED' });
    expect(await readFile(target, 'utf8')).toBe('external change');
  });

  it('rejects path escape after resolving the nearest existing parent', async () => {
    const { root, stateRoot } = await fixture();
    const engine = createConfigFileEngine({
      allowedRoots: [root],
      stateRoot,
      id: () => 'snapshot-3',
    });

    await expect(
      engine.apply({
        operationId: 'operation-3',
        planId: 'plan-3',
        agentId: 'codex-test',
        adapterVersion: 'codex-native-v1',
        files: [
          {
            path: join(root, '..', 'escaped.toml'),
            content: 'model = "unsafe"\n',
            managementMode: 'managed-file',
          },
        ],
        preconditionHashes: { [join(root, '..', 'escaped.toml')]: null },
      }),
    ).rejects.toBeInstanceOf(ApplicationError);
  });

  it('refuses rollback when the committed file drifted', async () => {
    const { root, stateRoot, target } = await fixture();
    await writeFile(target, 'before');
    const engine = createConfigFileEngine({
      allowedRoots: [root],
      stateRoot,
      id: () => 'snapshot-4',
    });
    const applied = await engine.apply({
      operationId: 'operation-4',
      planId: 'plan-4',
      agentId: 'claude-test',
      adapterVersion: 'claude-code-native-v1',
      files: [{ path: target, content: 'after', managementMode: 'managed-file' }],
      preconditionHashes: { [target]: hashFileContent('before') },
    });
    await writeFile(target, 'external drift');

    await expect(
      engine.rollback({
        sourceSnapshot: applied.snapshot,
        operationId: 'operation-rollback-drift',
        planId: 'plan-rollback-drift',
        agentId: 'claude-test',
        adapterVersion: 'claude-code-native-v1',
        expectedCurrentHashes: applied.committedHashes,
      }),
    ).rejects.toMatchObject({ code: 'ROLLBACK_PRECONDITION_FAILED' });
    expect(await readFile(target, 'utf8')).toBe('external drift');
  });

  it('verifies every snapshot payload before mutating a rollback target', async () => {
    const { root, stateRoot, target } = await fixture();
    await writeFile(target, 'before');
    const engine = createConfigFileEngine({
      allowedRoots: [root],
      stateRoot,
      id: () => 'snapshot-corrupt',
    });
    const applied = await engine.apply({
      operationId: 'operation-corrupt',
      planId: 'plan-corrupt',
      agentId: 'claude-test',
      adapterVersion: 'claude-code-native-v1',
      files: [{ path: target, content: 'after', managementMode: 'managed-file' }],
      preconditionHashes: { [target]: hashFileContent('before') },
    });
    await writeFile(applied.snapshot.files[0]?.snapshotPath ?? '', 'tampered snapshot');

    await expect(
      engine.rollback({
        sourceSnapshot: applied.snapshot,
        operationId: 'operation-rollback-corrupt',
        planId: 'plan-rollback-corrupt',
        agentId: 'claude-test',
        adapterVersion: 'claude-code-native-v1',
        expectedCurrentHashes: applied.committedHashes,
      }),
    ).rejects.toMatchObject({ code: 'ROLLBACK_PRECONDITION_FAILED' });
    expect(await readFile(target, 'utf8')).toBe('after');
  });

  it('stages all temporary files and preserves originals when failure occurs before rename', async () => {
    const { root, stateRoot, target } = await fixture();
    await writeFile(target, 'before');
    const engine = createConfigFileEngine({
      allowedRoots: [root],
      stateRoot,
      id: () => 'snapshot-before-rename',
    });

    await expect(
      engine.apply({
        operationId: 'operation-before-rename',
        planId: 'plan-before-rename',
        agentId: 'codex-test',
        adapterVersion: 'codex-native-v1',
        files: [{ path: target, content: 'after', managementMode: 'managed-file' }],
        preconditionHashes: { [target]: hashFileContent('before') },
        onProgress: async ({ state }) => {
          if (state === 'writing') throw new Error('simulated crash before rename');
        },
      }),
    ).rejects.toThrow('simulated crash before rename');

    expect(await readFile(target, 'utf8')).toBe('before');
    expect((await readdir(dirname(target))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves a partial commit for explicit reconciliation after a rename failure', async () => {
    const { root, stateRoot, target } = await fixture();
    const secondTarget = join(dirname(target), 'instructions.md');
    await writeFile(target, 'first-before');
    await writeFile(secondTarget, 'second-before');
    const engine = createConfigFileEngine({
      allowedRoots: [root],
      stateRoot,
      id: () => 'snapshot-after-rename',
    });
    let writingProgress = 0;

    await expect(
      engine.apply({
        operationId: 'operation-after-rename',
        planId: 'plan-after-rename',
        agentId: 'codex-test',
        adapterVersion: 'codex-native-v1',
        files: [
          { path: target, content: 'first-after', managementMode: 'managed-file' },
          { path: secondTarget, content: 'second-after', managementMode: 'managed-file' },
        ],
        preconditionHashes: {
          [target]: hashFileContent('first-before'),
          [secondTarget]: hashFileContent('second-before'),
        },
        onProgress: async ({ state }) => {
          if (state === 'writing' && ++writingProgress === 2) {
            throw new Error('simulated crash after first rename');
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_RECONCILIATION_REQUIRED' });

    expect(await readFile(target, 'utf8')).toBe('first-after');
    expect(await readFile(secondTarget, 'utf8')).toBe('second-before');
  });

  it('preserves existing file permissions where the platform exposes POSIX modes', async () => {
    if (process.platform === 'win32') return;
    const { root, stateRoot, target } = await fixture();
    await writeFile(target, 'before');
    await chmod(target, 0o640);
    const engine = createConfigFileEngine({
      allowedRoots: [root],
      stateRoot,
      id: () => 'snapshot-permissions',
    });

    await engine.apply({
      operationId: 'operation-permissions',
      planId: 'plan-permissions',
      agentId: 'claude-test',
      adapterVersion: 'claude-code-native-v1',
      files: [{ path: target, content: 'after', managementMode: 'managed-file' }],
      preconditionHashes: { [target]: hashFileContent('before') },
    });

    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  it('rejects a target reached through a symlink or junction outside the allowed root', async () => {
    const { root, stateRoot } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'luwi-config-outside-'));
    roots.push(outside);
    const redirected = join(root, 'redirected');
    try {
      await symlink(outside, redirected, 'junction');
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'EACCES')
      ) {
        return;
      }
      throw error;
    }
    const target = join(redirected, 'settings.json');
    const engine = createConfigFileEngine({
      allowedRoots: [root],
      stateRoot,
      id: () => 'snapshot-symlink',
    });

    await expect(
      engine.apply({
        operationId: 'operation-symlink',
        planId: 'plan-symlink',
        agentId: 'claude-test',
        adapterVersion: 'claude-code-native-v1',
        files: [{ path: target, content: '{}\n', managementMode: 'managed-file' }],
        preconditionHashes: { [target]: null },
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_PLAN_PATH_ESCAPE' });
  });

  it('rejects an allowed root that is itself redirected outside the controlled path', async () => {
    const { root, stateRoot } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'luwi-config-root-outside-'));
    roots.push(outside);
    const redirectedRoot = join(root, 'redirected-root');
    try {
      await symlink(outside, redirectedRoot, 'junction');
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'EACCES')
      ) {
        return;
      }
      throw error;
    }
    const target = join(redirectedRoot, 'settings.json');
    const engine = createConfigFileEngine({
      allowedRoots: [redirectedRoot],
      stateRoot,
      id: () => 'snapshot-root-symlink',
    });

    await expect(
      engine.apply({
        operationId: 'operation-root-symlink',
        planId: 'plan-root-symlink',
        agentId: 'claude-test',
        adapterVersion: 'claude-code-native-v1',
        files: [{ path: target, content: '{}\n', managementMode: 'managed-file' }],
        preconditionHashes: { [target]: null },
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_PLAN_PATH_ESCAPE' });
  });

  it('uses filesystem locks to reject overlapping writes from separate engines', async () => {
    const { root, stateRoot, target } = await fixture();
    await writeFile(target, 'before');
    const firstEngine = createConfigFileEngine({
      allowedRoots: [root],
      stateRoot,
      id: () => 'snapshot-lock-first',
    });
    const secondEngine = createConfigFileEngine({
      allowedRoots: [root],
      stateRoot,
      id: () => 'snapshot-lock-second',
    });
    let releaseFirst = (): void => undefined;
    const holdFirst = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    let firstLocked = (): void => undefined;
    const firstHasLock = new Promise<void>((resolvePromise) => {
      firstLocked = resolvePromise;
    });
    const first = firstEngine.apply({
      operationId: 'operation-lock-first',
      planId: 'plan-lock-first',
      agentId: 'codex-test',
      adapterVersion: 'codex-native-v1',
      files: [{ path: target, content: 'first', managementMode: 'managed-file' }],
      preconditionHashes: { [target]: hashFileContent('before') },
      onProgress: async ({ state }) => {
        if (state === 'snapshotted') {
          firstLocked();
          await holdFirst;
        }
      },
    });
    await firstHasLock;

    await expect(
      secondEngine.apply({
        operationId: 'operation-lock-second',
        planId: 'plan-lock-second',
        agentId: 'codex-test',
        adapterVersion: 'codex-native-v1',
        files: [{ path: target, content: 'second', managementMode: 'managed-file' }],
        preconditionHashes: { [target]: hashFileContent('before') },
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_APPLY_FAILED' });

    releaseFirst();
    await first;
    expect(await readFile(target, 'utf8')).toBe('first');
  });

  it('clears only generated stale lock files during owned startup recovery', async () => {
    const { stateRoot } = await fixture();
    const lockRoot = join(stateRoot, 'state', 'config-locks');
    await mkdir(lockRoot, { recursive: true });
    await writeFile(join(lockRoot, 'stale.lock'), '{}\n');
    await writeFile(join(lockRoot, 'keep.txt'), 'not a generated lock');

    await expect(clearStaleConfigFileLocks(stateRoot)).resolves.toBe(1);
    await expect(readFile(join(lockRoot, 'keep.txt'), 'utf8')).resolves.toBe(
      'not a generated lock',
    );
    expect(await readdir(lockRoot)).toEqual(['keep.txt']);
  });

  it('prunes completed snapshots to the configured local retention bound', async () => {
    const { root, stateRoot, target } = await fixture();
    await writeFile(target, 'zero');
    let snapshot = 0;
    const engine = createConfigFileEngine({
      allowedRoots: [root],
      stateRoot,
      id: () => `snapshot-retained-${String(++snapshot)}`,
      now: () => new Date(`2026-07-29T12:00:0${String(snapshot)}.000Z`),
      snapshotRetentionCount: 2,
    });
    let current = 'zero';
    for (const next of ['one', 'two', 'three']) {
      await engine.apply({
        operationId: `operation-${next}`,
        planId: `plan-${next}`,
        agentId: 'codex-test',
        adapterVersion: 'codex-native-v1',
        files: [{ path: target, content: next, managementMode: 'managed-file' }],
        preconditionHashes: { [target]: hashFileContent(current) },
      });
      current = next;
    }

    expect((await readdir(join(stateRoot, 'snapshots'))).sort()).toEqual([
      'snapshot-retained-2',
      'snapshot-retained-3',
    ]);
  });
});
