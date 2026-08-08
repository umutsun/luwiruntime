import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as packageInventory from './package-inventory.js';
import { createPackageInventoryScanner } from './package-inventory.js';
import type { PackageInventoryError } from './package-inventory.js';

type TestManifestIdentity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  isFile: () => boolean;
};

type TestManifestHandle = {
  stat: () => Promise<TestManifestIdentity>;
  read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesRead: number }>;
  close: () => Promise<void>;
};

type TestManifestOperations = {
  lstat: (path: string) => Promise<void>;
  realpath: (path: string) => Promise<string>;
  open: (path: string) => Promise<TestManifestHandle>;
  stat: (path: string) => Promise<TestManifestIdentity>;
};

const readBoundedManifest = (
  packageInventory as unknown as {
    readBoundedManifest?: (
      root: string,
      path: string,
      operations: TestManifestOperations,
    ) => Promise<Buffer>;
  }
).readBoundedManifest;

function identity(overrides: Partial<TestManifestIdentity> = {}): TestManifestIdentity {
  return {
    dev: 10n,
    ino: 20n,
    size: 2n,
    isFile: () => true,
    ...overrides,
  };
}

describe('package and technology inventory', () => {
  let root: string;
  const additionalRoots: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'luwi-package-inventory-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await Promise.all(
      additionalRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function createDirectoryLink(target: string, path: string): Promise<string | undefined> {
    try {
      await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
      return undefined;
    } catch (error) {
      const code =
        error !== null && typeof error === 'object'
          ? (error as { code?: unknown }).code
          : undefined;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        return `Directory-link security fixture is unavailable on ${process.platform}: ${String(code)}`;
      }
      throw error;
    }
  }

  it('scans Node/pnpm and Flutter manifests without executing a package manager', async () => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'sandbox-node',
        packageManager: 'pnpm@11.9.0',
        dependencies: { fastify: '^5.0.0', redis: '^6.0.0' },
        devDependencies: { typescript: '^6.0.0', vitest: '^4.0.0' },
      }),
      'utf8',
    );
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n', 'utf8');
    await writeFile(join(root, 'main.ts'), 'export {};\n', 'utf8');
    await mkdir(join(root, 'flutter_app'));
    await writeFile(
      join(root, 'flutter_app', 'pubspec.yaml'),
      [
        'name: sandbox_flutter',
        'dependencies:',
        '  flutter:',
        '    sdk: flutter',
        '  http: ^1.2.0',
        'dev_dependencies:',
        '  flutter_test:',
        '    sdk: flutter',
      ].join('\n'),
      'utf8',
    );
    await writeFile(join(root, 'flutter_app', 'main.dart'), 'void main() {}\n', 'utf8');

    const result = await createPackageInventoryScanner().scan({
      projectId: 'project-1',
      localPath: root,
    });

    expect(
      result.packages.map(({ ecosystem, packageName, dependencyType }) => [
        ecosystem,
        packageName,
        dependencyType,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['node', 'fastify', 'production'],
        ['node', 'vitest', 'development'],
        ['dart', 'flutter', 'production'],
        ['dart', 'flutter_test', 'development'],
      ]),
    );
    expect(result.technologies.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'TypeScript',
        'Dart',
        'Flutter',
        'Fastify',
        'Redis',
        'Vitest',
        'pnpm',
      ]),
    );
  });

  it('scans Python, PHP, Rust, and Go manifests as direct declarations', async () => {
    await writeFile(join(root, 'requirements.txt'), 'django==5.1\npytest>=8\n', 'utf8');
    await writeFile(
      join(root, 'composer.json'),
      JSON.stringify({
        require: { php: '^8.3', 'laravel/framework': '^12' },
        'require-dev': { 'phpunit/phpunit': '^11' },
      }),
      'utf8',
    );
    await writeFile(
      join(root, 'Cargo.toml'),
      '[package]\nname = "sandbox"\n[dependencies]\ntokio = "1"\n[dev-dependencies]\npretty_assertions = "1"\n',
      'utf8',
    );
    await writeFile(
      join(root, 'go.mod'),
      'module example.invalid/sandbox\n\ngo 1.24\n\nrequire github.com/redis/go-redis/v9 v9.7.0\n',
      'utf8',
    );

    const result = await createPackageInventoryScanner().scan({
      projectId: 'project-1',
      localPath: root,
    });

    expect(result.packages.map(({ ecosystem }) => ecosystem)).toEqual(
      expect.arrayContaining(['python', 'php', 'rust', 'go']),
    );
    expect(result.packages.every(({ direct }) => direct === true)).toBe(true);
    expect(result.packages.find(({ packageName }) => packageName === 'pytest')).toMatchObject({
      declaredVersion: '>=8',
    });
  });

  it('returns a safe parse error for a malformed supported manifest', async () => {
    await writeFile(join(root, 'package.json'), '{"dependencies":', 'utf8');
    await expect(
      createPackageInventoryScanner().scan({ projectId: 'project-1', localPath: root }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PackageInventoryError>>({
        code: 'PACKAGE_MANIFEST_PARSE_FAILED',
      }),
    );
  });

  it('uses project-scoped identities for identical package and technology manifests', async () => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { fastify: '^5.0.0' } }),
      'utf8',
    );
    const scanner = createPackageInventoryScanner();
    const first = await scanner.scan({ projectId: 'project-1', localPath: root });
    const second = await scanner.scan({ projectId: 'project-2', localPath: root });

    expect(second.packages[0]?.id).not.toBe(first.packages[0]?.id);
    expect(second.technologies.find(({ name }) => name === 'Fastify')?.id).not.toBe(
      first.technologies.find(({ name }) => name === 'Fastify')?.id,
    );
  });

  it('reports a bounded tracked-file sample instead of presenting it as complete', async () => {
    await writeFile(join(root, 'one.ts'), 'export {};\n', 'utf8');
    await writeFile(join(root, 'two.ts'), 'export {};\n', 'utf8');
    const result = await createPackageInventoryScanner({ maximumFiles: 1 }).scan({
      projectId: 'project-1',
      localPath: root,
      trackedPaths: ['one.ts', 'two.ts'],
    });

    expect(result).toMatchObject({
      fileCount: 1,
      truncated: true,
      evidenceScope: 'git-tracked',
    });
  });

  it('rejects a tracked manifest symlink whose canonical target escapes the project', async ({
    skip,
  }) => {
    const outside = await mkdtemp(join(tmpdir(), 'luwi-package-outside-'));
    additionalRoots.push(outside);
    const externalManifest = join(outside, 'package.json');
    await writeFile(
      externalManifest,
      JSON.stringify({ dependencies: { 'external-secret-package': '1.0.0' } }),
      'utf8',
    );
    const redirected = join(root, 'redirected');
    const skipReason = await createDirectoryLink(outside, redirected);
    if (skipReason !== undefined) skip(skipReason);

    await expect(
      createPackageInventoryScanner().scan({
        projectId: 'project-1',
        localPath: root,
        trackedPaths: ['redirected/package.json'],
      }),
    ).rejects.toMatchObject({ code: 'PACKAGE_SCAN_FAILED' });
    await expect(
      createPackageInventoryScanner().scan({
        projectId: 'project-1',
        localPath: root,
        trackedPaths: ['redirected/package.json'],
      }),
    ).rejects.not.toThrow('external-secret-package');
  });

  it('allows a tracked manifest symlink only when its canonical target remains in-root', async ({
    skip,
  }) => {
    const target = join(root, 'manifest-source');
    await mkdir(target);
    await writeFile(
      join(target, 'package.json'),
      JSON.stringify({ dependencies: { fastify: '^5.0.0' } }),
      'utf8',
    );
    const redirected = join(root, 'redirected');
    const skipReason = await createDirectoryLink(target, redirected);
    if (skipReason !== undefined) skip(skipReason);

    const result = await createPackageInventoryScanner().scan({
      projectId: 'project-1',
      localPath: root,
      trackedPaths: ['redirected/package.json'],
    });

    expect(result.packages).toEqual([
      expect.objectContaining({
        packageName: 'fastify',
        manifestPath: 'redirected/package.json',
      }),
    ]);
  });

  it('rejects broken tracked manifest symlinks safely', async ({ skip }) => {
    const target = join(root, 'temporary-target');
    await mkdir(target);
    await writeFile(join(target, 'package.json'), '{}', 'utf8');
    const redirected = join(root, 'broken');
    const skipReason = await createDirectoryLink(target, redirected);
    if (skipReason !== undefined) skip(skipReason);
    await rm(target, { recursive: true, force: true });

    await expect(
      createPackageInventoryScanner().scan({
        projectId: 'project-1',
        localPath: root,
        trackedPaths: ['broken/package.json'],
      }),
    ).rejects.toMatchObject({ code: 'PACKAGE_SCAN_FAILED' });
  });

  it('rejects a tracked manifest whose canonical target is a directory', async ({ skip }) => {
    const directoryTarget = join(root, 'manifest-directory');
    await mkdir(directoryTarget);
    const trackedManifest = join(root, 'package.json');
    const skipReason = await createDirectoryLink(directoryTarget, trackedManifest);
    if (skipReason !== undefined) skip(skipReason);

    await expect(
      createPackageInventoryScanner().scan({
        projectId: 'project-1',
        localPath: root,
        trackedPaths: ['package.json'],
      }),
    ).rejects.toMatchObject({ code: 'PACKAGE_SCAN_FAILED' });
  });

  it('keeps tracked manifest paths relative to a nested registered project root', async () => {
    const nested = join(root, 'nested-project');
    await mkdir(nested);
    await writeFile(
      join(nested, 'package.json'),
      JSON.stringify({ dependencies: { fastify: '^5.0.0' } }),
      'utf8',
    );

    const result = await createPackageInventoryScanner().scan({
      projectId: 'nested-project',
      localPath: nested,
      trackedPaths: ['package.json'],
    });

    expect(result.packages).toEqual([
      expect.objectContaining({ projectId: 'nested-project', manifestPath: 'package.json' }),
    ]);
  });

  it('rejects an ABA swap when canonical path strings match but opened identity differs', async () => {
    expect(readBoundedManifest).toBeTypeOf('function');
    const candidate = join(root, 'package.json');
    const close = vi.fn(async () => undefined);
    const handle: TestManifestHandle = {
      stat: async () => identity({ ino: 21n }),
      read: async () => ({ bytesRead: 0 }),
      close,
    };
    const operations: TestManifestOperations = {
      lstat: async () => undefined,
      realpath: vi.fn(async () => candidate),
      open: async () => handle,
      stat: async () => identity({ ino: 20n }),
    };

    await expect(readBoundedManifest?.(root, candidate, operations)).rejects.toMatchObject({
      code: 'PACKAGE_SCAN_FAILED',
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects growth beyond the manifest limit even when the opened stat is initially small', async () => {
    expect(readBoundedManifest).toBeTypeOf('function');
    const candidate = join(root, 'package.json');
    const close = vi.fn(async () => undefined);
    let remaining = 2 * 1024 * 1024 + 1;
    const handle: TestManifestHandle = {
      stat: async () => identity({ size: 2n }),
      read: async (buffer, offset, length) => {
        const bytesRead = Math.min(length, remaining);
        buffer.fill(120, offset, offset + bytesRead);
        remaining -= bytesRead;
        return { bytesRead };
      },
      close,
    };
    const operations: TestManifestOperations = {
      lstat: async () => undefined,
      realpath: vi.fn(async () => candidate),
      open: async () => handle,
      stat: async () => identity(),
    };

    await expect(readBoundedManifest?.(root, candidate, operations)).rejects.toMatchObject({
      code: 'PACKAGE_SCAN_FAILED',
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('returns stable matching identity content and closes the handle', async () => {
    expect(readBoundedManifest).toBeTypeOf('function');
    const candidate = join(root, 'package.json');
    const content = Buffer.from('{}');
    const close = vi.fn(async () => undefined);
    const handle: TestManifestHandle = {
      stat: async () => identity(),
      read: async (buffer, offset, length, position) => {
        const bytesRead = Math.min(length, Math.max(0, content.length - position));
        content.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead };
      },
      close,
    };
    const operations: TestManifestOperations = {
      lstat: async () => undefined,
      realpath: vi.fn(async () => candidate),
      open: async () => handle,
      stat: async () => identity(),
    };

    await expect(readBoundedManifest?.(root, candidate, operations)).resolves.toEqual(content);
    expect(close).toHaveBeenCalledOnce();
  });
});
