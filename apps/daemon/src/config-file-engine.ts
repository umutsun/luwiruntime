import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

import { configSnapshotSchema, type ConfigSnapshot } from '@luwi/protocol';
import { ApplicationError } from '@luwi/runtime';

import type { ProposedNativeFile } from '@luwi/adapters';

export type ConfigFileEngineOptions = {
  allowedRoots: string[];
  stateRoot: string;
  id?: () => string;
  now?: () => Date;
  snapshotRetentionCount?: number;
};

export type ApplyConfigFilesInput = {
  operationId: string;
  planId: string;
  agentId: string;
  projectId?: string;
  adapterVersion: string;
  files: ProposedNativeFile[];
  preconditionHashes: Record<string, string | null>;
  onProgress?: (progress: ConfigFileProgress) => Promise<void>;
};

export type ConfigFileProgress = {
  state: 'snapshotted' | 'writing' | 'files_committed';
  snapshot: ConfigSnapshot;
  intendedHashes: Record<string, string | null>;
};

export type ApplyConfigFilesResult = {
  snapshot: ConfigSnapshot;
  committedHashes: Record<string, string | null>;
};

export type RollbackConfigFilesInput = {
  sourceSnapshot: ConfigSnapshot;
  operationId: string;
  planId: string;
  agentId: string;
  projectId?: string;
  adapterVersion: string;
  expectedCurrentHashes: Record<string, string | null>;
  onProgress?: (progress: ConfigFileProgress) => Promise<void>;
};

export interface ConfigFileEngine {
  apply(input: ApplyConfigFilesInput): Promise<ApplyConfigFilesResult>;
  rollback(input: RollbackConfigFilesInput): Promise<ApplyConfigFilesResult>;
}

type PreparedTarget = {
  path: string;
  existingContent: Buffer | undefined;
  existingHash: string | null;
  permissions: number | undefined;
};

export function hashFileContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function readExisting(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function existingParent(path: string): Promise<{ existing: string; suffix: string[] }> {
  const suffix: string[] = [];
  let candidate = resolve(path);
  while (true) {
    try {
      await lstat(candidate);
      return { existing: candidate, suffix: suffix.reverse() };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      suffix.push(candidate.slice(parent.length).replace(/^[/\\]+/, ''));
      candidate = parent;
    }
  }
}

function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

async function canonicalFuturePath(path: string): Promise<string> {
  const parent = await existingParent(path);
  return resolve(await realpath(parent.existing), ...parent.suffix);
}

async function atomicWrite(
  path: string,
  content: string | Buffer,
  operationId: string,
  permissions?: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.luwi-${operationId}-${randomUUID().replaceAll('-', '')}.tmp`,
  );
  try {
    await writeFile(temporary, content, {
      flag: 'wx',
      mode: permissions ?? 0o600,
    });
    const handle = await open(temporary, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    if (permissions !== undefined) {
      await chmod(path, permissions);
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

type StagedWrite = {
  targetPath: string;
  temporaryPath: string;
  permissions: number | undefined;
};

async function stageWrite(
  path: string,
  content: string | Buffer,
  operationId: string,
  permissions?: number,
): Promise<StagedWrite> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.luwi-${operationId}-${randomUUID().replaceAll('-', '')}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, {
      flag: 'wx',
      mode: permissions ?? 0o600,
    });
    const handle = await open(temporaryPath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { targetPath: path, temporaryPath, permissions };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

type HeldFileLock = {
  handle: FileHandle;
  path: string;
};

function lockIdentity(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function releaseFileLocks(locks: HeldFileLock[]): Promise<void> {
  for (const lock of [...locks].reverse()) {
    await lock.handle.close().catch(() => undefined);
    await unlink(lock.path).catch(() => undefined);
  }
}

async function acquireFileLocks(
  stateRoot: string,
  paths: string[],
  operationId: string,
): Promise<HeldFileLock[]> {
  const lockRoot = join(stateRoot, 'state', 'config-locks');
  await mkdir(lockRoot, { recursive: true });
  const locks: HeldFileLock[] = [];
  try {
    for (const targetPath of [...paths].sort()) {
      const lockPath = join(lockRoot, `${hashFileContent(lockIdentity(targetPath))}.lock`);
      let handle: FileHandle;
      try {
        handle = await open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
          throw new ApplicationError(
            'CONFIG_APPLY_FAILED',
            'Another configuration operation owns a target file.',
            409,
            { path: targetPath },
          );
        }
        throw error;
      }
      locks.push({ handle, path: lockPath });
      await handle.writeFile(
        `${JSON.stringify({ operationId, targetPath, acquiredAt: new Date().toISOString() })}\n`,
      );
      await handle.sync();
    }
    return locks;
  } catch (error) {
    await releaseFileLocks(locks);
    throw error;
  }
}

export async function clearStaleConfigFileLocks(stateRoot: string): Promise<number> {
  const lockRoot = join(stateRoot, 'state', 'config-locks');
  let entries;
  try {
    entries = await readdir(lockRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0;
    throw error;
  }
  const staleLocks = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.lock'));
  await Promise.all(staleLocks.map((entry) => unlink(join(lockRoot, entry.name))));
  return staleLocks.length;
}

async function pruneSnapshots(
  snapshotRoot: string,
  currentSnapshotId: string,
  retentionCount: number,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(snapshotRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const snapshots: Array<{ id: string; createdAt: string }> = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    try {
      const parsed = configSnapshotSchema.safeParse(
        JSON.parse(
          await readFile(join(snapshotRoot, entry.name, 'manifest.json'), 'utf8'),
        ) as unknown,
      );
      if (parsed.success) snapshots.push({ id: entry.name, createdAt: parsed.data.createdAt });
    } catch {
      // An incomplete or foreign directory is not safe for automated deletion.
    }
  }
  const retained = new Set(
    [
      { id: currentSnapshotId, createdAt: '' },
      ...snapshots
        .filter(({ id }) => id !== currentSnapshotId)
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
        ),
    ]
      .slice(0, retentionCount)
      .map(({ id }) => id),
  );
  await Promise.all(
    snapshots
      .filter(({ id }) => !retained.has(id))
      .map(({ id }) => rm(join(snapshotRoot, id), { recursive: true, force: true })),
  );
}

export function createConfigFileEngine(options: ConfigFileEngineOptions): ConfigFileEngine {
  if (options.allowedRoots.length === 0) {
    throw new Error('At least one configuration root must be allowed.');
  }
  const nextId = options.id ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const snapshotRetentionCount = options.snapshotRetentionCount ?? 50;
  if (!Number.isInteger(snapshotRetentionCount) || snapshotRetentionCount < 1) {
    throw new Error('Snapshot retention count must be a positive integer.');
  }

  const assertAllowed = async (path: string): Promise<void> => {
    const canonicalTarget = await canonicalFuturePath(path);
    const roots = options.allowedRoots.map((root) => resolve(root));
    if (!roots.some((root) => isWithin(root, canonicalTarget))) {
      throw new ApplicationError(
        'CONFIG_PLAN_PATH_ESCAPE',
        'A configuration target escapes the allowed roots.',
        400,
        { path },
      );
    }
  };

  const prepareTarget = async (path: string): Promise<PreparedTarget> => {
    await assertAllowed(path);
    const content = await readExisting(path);
    const fileStat = content === undefined ? undefined : await stat(path);
    return {
      path,
      existingContent: content,
      existingHash: content === undefined ? null : hashFileContent(content),
      permissions: fileStat?.mode,
    };
  };

  const verifySnapshotPayloads = async (snapshot: ConfigSnapshot): Promise<Map<string, Buffer>> => {
    const verifiedPayloads = new Map<string, Buffer>();
    for (const file of snapshot.files) {
      if (!file.existed) continue;
      if (file.snapshotPath === undefined) {
        throw new ApplicationError('SNAPSHOT_NOT_FOUND', 'A snapshot payload is missing.', 409);
      }
      let payload: Buffer;
      try {
        payload = await readFile(file.snapshotPath);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          throw new ApplicationError('SNAPSHOT_NOT_FOUND', 'A snapshot payload is missing.', 409);
        }
        throw error;
      }
      if (file.originalHash === null || hashFileContent(payload) !== file.originalHash) {
        throw new ApplicationError(
          'ROLLBACK_PRECONDITION_FAILED',
          'A snapshot payload failed its integrity check.',
          409,
          { path: file.targetPath },
        );
      }
      verifiedPayloads.set(file.targetPath, payload);
    }
    return verifiedPayloads;
  };

  return {
    async apply(input): Promise<ApplyConfigFilesResult> {
      const uniquePaths = new Set(input.files.map((file) => resolve(file.path)));
      if (uniquePaths.size !== input.files.length) {
        throw new ApplicationError(
          'CONFIG_APPLY_FAILED',
          'A configuration plan contains duplicate target paths.',
          400,
        );
      }
      const locks = await acquireFileLocks(options.stateRoot, [...uniquePaths], input.operationId);
      try {
        const prepared = await Promise.all(input.files.map((file) => prepareTarget(file.path)));
        for (const target of prepared) {
          const expected = input.preconditionHashes[target.path] ?? null;
          if (target.existingHash !== expected) {
            throw new ApplicationError(
              'CONFIG_PLAN_PRECONDITION_FAILED',
              'A native configuration file changed after the plan was created.',
              409,
              { path: target.path },
            );
          }
        }

        const snapshotId = nextId();
        const snapshotDirectory = join(options.stateRoot, 'snapshots', snapshotId);
        await mkdir(snapshotDirectory, { recursive: true });
        const files: ConfigSnapshot['files'] = [];
        for (const target of prepared) {
          if (target.existingContent === undefined) {
            files.push({
              targetPath: target.path,
              existed: false,
              originalHash: null,
            });
            continue;
          }
          const snapshotPath = join(snapshotDirectory, `${hashFileContent(target.path)}.snapshot`);
          await copyFile(target.path, snapshotPath);
          await chmod(snapshotPath, 0o600);
          files.push({
            targetPath: target.path,
            existed: true,
            originalHash: target.existingHash,
            snapshotPath,
            ...(target.permissions === undefined ? {} : { permissions: target.permissions }),
          });
        }
        const intendedHashes: Record<string, string | null> = Object.fromEntries(
          input.files.map((file) => [file.path, hashFileContent(file.content)]),
        );
        const snapshot: ConfigSnapshot = {
          id: snapshotId,
          operationId: input.operationId,
          planId: input.planId,
          agentId: input.agentId,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          createdAt: now().toISOString(),
          schemaVersion: 1,
          adapterVersion: input.adapterVersion,
          files,
          redactedManifest: {
            targetPaths: input.files.map((file) => file.path),
            contentHashes: intendedHashes,
          },
        };
        await writeFile(
          join(snapshotDirectory, 'manifest.json'),
          `${JSON.stringify(snapshot, null, 2)}\n`,
          { flag: 'wx', mode: 0o600 },
        );
        await pruneSnapshots(
          join(options.stateRoot, 'snapshots'),
          snapshot.id,
          snapshotRetentionCount,
        );
        await input.onProgress?.({ state: 'snapshotted', snapshot, intendedHashes });

        const staged: StagedWrite[] = [];
        let committedCount = 0;
        try {
          for (let index = 0; index < input.files.length; index += 1) {
            const file = input.files[index];
            const target = prepared[index];
            if (file === undefined || target === undefined) {
              throw new Error('Configuration plan indexes diverged.');
            }
            staged.push(
              await stageWrite(target.path, file.content, input.operationId, target.permissions),
            );
          }
          await input.onProgress?.({ state: 'writing', snapshot, intendedHashes });
          for (const stagedFile of staged) {
            await rename(stagedFile.temporaryPath, stagedFile.targetPath);
            committedCount += 1;
            if (stagedFile.permissions !== undefined) {
              await chmod(stagedFile.targetPath, stagedFile.permissions);
            }
            await input.onProgress?.({ state: 'writing', snapshot, intendedHashes });
          }
          await input.onProgress?.({ state: 'files_committed', snapshot, intendedHashes });
        } catch (error) {
          if (committedCount > 0) {
            throw new ApplicationError(
              'CONFIG_RECONCILIATION_REQUIRED',
              'A configuration operation stopped after one or more target files committed.',
              503,
              { operationId: input.operationId },
            );
          }
          throw error;
        } finally {
          await Promise.all(
            staged.map(({ temporaryPath }) =>
              rm(temporaryPath, { force: true }).catch(() => undefined),
            ),
          );
        }
        return { snapshot, committedHashes: intendedHashes };
      } finally {
        await releaseFileLocks(locks);
      }
    },

    async rollback(input) {
      const snapshot = input.sourceSnapshot;
      const locks = await acquireFileLocks(
        options.stateRoot,
        snapshot.files.map(({ targetPath }) => targetPath),
        input.operationId,
      );
      try {
        const prepared: PreparedTarget[] = [];
        for (const file of snapshot.files) {
          const target = await prepareTarget(file.targetPath);
          if (target.existingHash !== (input.expectedCurrentHashes[file.targetPath] ?? null)) {
            throw new ApplicationError(
              'ROLLBACK_PRECONDITION_FAILED',
              'A managed configuration file changed after it was applied.',
              409,
              { path: file.targetPath },
            );
          }
          prepared.push(target);
        }
        const verifiedPayloads = await verifySnapshotPayloads(snapshot);
        const rollbackSnapshotId = nextId();
        const snapshotDirectory = join(options.stateRoot, 'snapshots', rollbackSnapshotId);
        await mkdir(snapshotDirectory, { recursive: true });
        const rollbackFiles: ConfigSnapshot['files'] = [];
        for (const target of prepared) {
          if (target.existingContent === undefined) {
            rollbackFiles.push({
              targetPath: target.path,
              existed: false,
              originalHash: null,
            });
            continue;
          }
          const snapshotPath = join(snapshotDirectory, `${hashFileContent(target.path)}.snapshot`);
          await copyFile(target.path, snapshotPath);
          await chmod(snapshotPath, 0o600);
          rollbackFiles.push({
            targetPath: target.path,
            existed: true,
            originalHash: target.existingHash,
            snapshotPath,
            ...(target.permissions === undefined ? {} : { permissions: target.permissions }),
          });
        }
        const intendedHashes = Object.fromEntries(
          snapshot.files.map((file) => [file.targetPath, file.originalHash]),
        );
        const rollbackSnapshot: ConfigSnapshot = {
          id: rollbackSnapshotId,
          operationId: input.operationId,
          planId: input.planId,
          agentId: input.agentId,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          createdAt: now().toISOString(),
          schemaVersion: 1,
          adapterVersion: input.adapterVersion,
          files: rollbackFiles,
          redactedManifest: {
            targetPaths: snapshot.files.map(({ targetPath }) => targetPath),
            contentHashes: intendedHashes,
            sourceSnapshotId: snapshot.id,
          },
        };
        await writeFile(
          join(snapshotDirectory, 'manifest.json'),
          `${JSON.stringify(rollbackSnapshot, null, 2)}\n`,
          { flag: 'wx', mode: 0o600 },
        );
        await pruneSnapshots(
          join(options.stateRoot, 'snapshots'),
          rollbackSnapshot.id,
          snapshotRetentionCount,
        );
        await input.onProgress?.({
          state: 'snapshotted',
          snapshot: rollbackSnapshot,
          intendedHashes,
        });
        await input.onProgress?.({
          state: 'writing',
          snapshot: rollbackSnapshot,
          intendedHashes,
        });
        let committedCount = 0;
        try {
          for (const file of snapshot.files) {
            if (!file.existed) {
              await unlink(file.targetPath).catch((error: unknown) => {
                if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
                  throw error;
                }
              });
            } else {
              const payload = verifiedPayloads.get(file.targetPath);
              if (payload === undefined) {
                throw new ApplicationError(
                  'SNAPSHOT_NOT_FOUND',
                  'A snapshot payload is missing.',
                  409,
                );
              }
              await atomicWrite(file.targetPath, payload, input.operationId, file.permissions);
            }
            committedCount += 1;
            await input.onProgress?.({
              state: 'writing',
              snapshot: rollbackSnapshot,
              intendedHashes,
            });
          }
        } catch (error) {
          if (committedCount > 0) {
            throw new ApplicationError(
              'CONFIG_RECONCILIATION_REQUIRED',
              'A rollback stopped after one or more target files committed.',
              503,
              { operationId: input.operationId },
            );
          }
          throw error;
        }
        await input.onProgress?.({
          state: 'files_committed',
          snapshot: rollbackSnapshot,
          intendedHashes,
        });
        return { snapshot: rollbackSnapshot, committedHashes: intendedHashes };
      } finally {
        await releaseFileLocks(locks);
      }
    },
  };
}
