import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalizeProjectPath, canonicalizeWorkingDirectory } from './index.js';

function fakePathDependencies(options: {
  platform?: NodeJS.Platform;
  cwd?: string;
  realPath?: string;
  isDirectory?: boolean;
}) {
  const platform = options.platform ?? 'linux';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const cwd = options.cwd ?? (platform === 'win32' ? 'C:\\workspace' : '/workspace');

  return {
    platform,
    resolve: (input: string) => pathApi.resolve(cwd, input),
    realpath: async (_input: string) => options.realPath ?? pathApi.resolve(cwd, _input),
    isDirectory: async () => options.isDirectory ?? true,
  };
}

describe('canonical project paths', () => {
  it('normalizes relative input and resolves a canonical display path', async () => {
    await expect(
      canonicalizeProjectPath(
        './luwi/',
        fakePathDependencies({
          realPath: '/workspace/real/luwi/',
        }),
      ),
    ).resolves.toMatchObject({
      localPath: '/workspace/luwi',
      canonicalPath: '/workspace/real/luwi',
      identityPath: '/workspace/real/luwi',
    });
  });

  it('preserves filesystem roots while removing other trailing separators', async () => {
    await expect(
      canonicalizeProjectPath(
        '/',
        fakePathDependencies({
          realPath: '/',
        }),
      ),
    ).resolves.toMatchObject({
      localPath: '/',
      canonicalPath: '/',
      identityPath: '/',
    });
  });

  it('normalizes Windows drive case and compares identity case-insensitively', async () => {
    const result = await canonicalizeProjectPath(
      'c:\\Workspace\\LUWI\\',
      fakePathDependencies({
        platform: 'win32',
        cwd: 'C:\\',
        realPath: 'c:\\Workspace\\LUWI\\',
      }),
    );

    expect(result).toMatchObject({
      localPath: 'C:/Workspace/LUWI',
      canonicalPath: 'C:/Workspace/LUWI',
      identityPath: 'c:/workspace/luwi',
    });
    expect(result.pathIdentityHash).toMatch(/^[a-f0-9]{64}$/);

    const caseVariant = await canonicalizeProjectPath(
      'C:\\WORKSPACE\\luwi',
      fakePathDependencies({
        platform: 'win32',
        cwd: 'C:\\',
        realPath: 'C:\\WORKSPACE\\luwi',
      }),
    );
    expect(caseVariant.pathIdentityHash).toBe(result.pathIdentityHash);
  });

  it('resolves supported symlink or junction aliases to the same path identity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'luwi-path-test-'));
    const target = path.join(root, 'target');
    const alias = path.join(root, 'alias');
    try {
      await mkdir(target);
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const direct = await canonicalizeProjectPath(target);
      const linked = await canonicalizeProjectPath(alias);
      expect(linked.pathIdentityHash).toBe(direct.pathIdentityHash);
      expect(linked.canonicalPath).toBe(direct.canonicalPath);
    } catch (error) {
      const code =
        error !== null && typeof error === 'object'
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTSUP') {
        throw error;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects missing or non-directory project paths safely', async () => {
    await expect(
      canonicalizeProjectPath(
        './missing',
        fakePathDependencies({
          isDirectory: false,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'PROJECT_PATH_INVALID',
      statusCode: 400,
    });
  });

  it('uses a session-specific safe error for an invalid working directory', async () => {
    await expect(
      canonicalizeWorkingDirectory(
        './missing',
        fakePathDependencies({
          isDirectory: false,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'SESSION_WORKING_DIRECTORY_INVALID',
      statusCode: 400,
    });
  });
});
