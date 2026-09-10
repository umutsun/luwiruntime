import { ApplicationError } from '@luwi/runtime';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import * as nodePath from 'node:path';

import {
  defaultLifecycleInstallationRoot,
  NodeLifecycleFileSystem,
  type LifecycleFileSystem,
  type LifecycleService,
  type LifecycleStatus,
} from './lifecycle.js';
import { sanitizeWakeChildEnvironment } from './wake-environment.js';

const RECORD_MAX_BYTES = 16 * 1024;
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
const DEFAULT_START_TIMEOUT_MS = 15_000;
// The dispatcher may spend one 5-second blocking claim plus bounded child and
// bridge cleanup before the managed serve lease can remove its receipt.
const DEFAULT_STOP_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_STALE_MS = 5_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RECLAIM_STALE_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const WAKE_CONTROL_TOKEN_ENV = 'LUWI_WAKE_CONTROL_TOKEN';
export const WAKE_INSTANCE_ID_ENV = 'LUWI_WAKE_INSTANCE_ID';

type PathApi = Pick<
  typeof nodePath,
  'dirname' | 'isAbsolute' | 'join' | 'normalize' | 'relative' | 'resolve'
>;

type WakeOwner = {
  schemaVersion: 1;
  token: string;
  instanceId: string;
  pid: number;
  installationRoot: string;
  startedAt: string;
};

type WakeHeartbeat = {
  schemaVersion: 1;
  instanceId: string;
  pid: number;
  heartbeatAt: string;
};

type WakeStopRequest = {
  schemaVersion: 1;
  token: string;
  instanceId: string;
  pid: number;
  requestedAt: string;
};

type WakeLifecycleLock = {
  pid: number;
  acquiredAt: string;
  token?: string;
};

type WakeStartIntent = {
  schemaVersion: 1;
  token: string;
  instanceId: string;
  pid: number;
  installationRoot: string;
  requestedAt: string;
};

type WakeStopFence = {
  schemaVersion: 1;
  token: string;
  pid: number;
  requestedAt: string;
  completedAt: string | null;
  cancelledStartToken: string | null;
};

export type WakeLockProcessState = 'alive' | 'dead' | 'unknown';

export type WakeLifecycleStatus = {
  state: 'running' | 'stopped' | 'stale' | 'invalid';
  managed: boolean;
  ownership: 'owned' | 'none' | 'stale' | 'invalid';
  pid?: number;
  instanceId?: string;
  startedAt?: string;
  heartbeatAt?: string;
};

export type WakeProcessLaunch = {
  executable: string;
  args: readonly string[];
  workingDirectory: string;
  logFile: string;
  environment: Readonly<Record<string, string | undefined>>;
  detached: true;
  shell: false;
  windowsHide: true;
};

export type SpawnedWake = { pid: number };

export type ManagedWakeServeLease = {
  stopRequested: Promise<void>;
  close(): Promise<void>;
};

export type WakeLifecycleDependencies = {
  fileSystem: LifecycleFileSystem;
  environment: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  nodeExecutable: string;
  processId: number;
  clock: () => number;
  now: () => Date;
  randomUUID: () => string;
  processState: (pid: number) => Promise<WakeLockProcessState>;
  tryAcquireMutex: (identity: string) => Promise<(() => Promise<void>) | undefined>;
  daemonStatus: () => Promise<LifecycleStatus>;
  spawnWake: (launch: WakeProcessLaunch) => Promise<SpawnedWake>;
  wait: (milliseconds: number) => Promise<void>;
  setInterval: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  clearInterval: (timer: NodeJS.Timeout) => void;
};

export interface WakeLifecycleService {
  start(): Promise<WakeLifecycleStatus>;
  stop(): Promise<WakeLifecycleStatus>;
  status(): Promise<WakeLifecycleStatus>;
  beginManagedServe(): Promise<ManagedWakeServeLease>;
}

export type WakeLifecycleServiceOptions = {
  installationRoot: string;
  homeDirectory?: string;
  dependencies: WakeLifecycleDependencies;
  pathApi?: PathApi;
  readinessTimeoutMs?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatStaleMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const sorted = [...expected].toSorted();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function boundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !Array.from(value).some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 0x1f || point === 0x7f);
    })
  );
}

function validIdentity(value: unknown): value is string {
  return boundedString(value, 128) && UUID.test(value);
}

function validPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validTimestamp(value: unknown): value is string {
  return boundedString(value, 64) && !Number.isNaN(Date.parse(value));
}

function parseOwner(value: unknown): WakeOwner {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'token',
      'instanceId',
      'pid',
      'installationRoot',
      'startedAt',
    ]) ||
    value['schemaVersion'] !== 1 ||
    !validIdentity(value['token']) ||
    !validIdentity(value['instanceId']) ||
    !validPid(value['pid']) ||
    !boundedString(value['installationRoot'], 32_767) ||
    !validTimestamp(value['startedAt'])
  ) {
    throw new ApplicationError(
      'WAKE_OWNERSHIP_INVALID',
      'The wake supervisor ownership record is invalid.',
      409,
    );
  }
  return value as WakeOwner;
}

function parseHeartbeat(value: unknown): WakeHeartbeat {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['schemaVersion', 'instanceId', 'pid', 'heartbeatAt']) ||
    value['schemaVersion'] !== 1 ||
    !validIdentity(value['instanceId']) ||
    !validPid(value['pid']) ||
    !validTimestamp(value['heartbeatAt'])
  ) {
    throw new ApplicationError(
      'WAKE_OWNERSHIP_INVALID',
      'The wake supervisor heartbeat record is invalid.',
      409,
    );
  }
  return value as WakeHeartbeat;
}

function parseStopRequest(value: unknown): WakeStopRequest {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['schemaVersion', 'token', 'instanceId', 'pid', 'requestedAt']) ||
    value['schemaVersion'] !== 1 ||
    !validIdentity(value['token']) ||
    !validIdentity(value['instanceId']) ||
    !validPid(value['pid']) ||
    !validTimestamp(value['requestedAt'])
  ) {
    throw new ApplicationError(
      'WAKE_STOP_REQUEST_INVALID',
      'The wake supervisor stop request is invalid.',
      409,
    );
  }
  return value as WakeStopRequest;
}

function parseLifecycleLock(value: unknown): WakeLifecycleLock {
  const keysAreValid =
    isRecord(value) &&
    (exactKeys(value, ['pid', 'acquiredAt']) ||
      (exactKeys(value, ['schemaVersion', 'token', 'pid', 'acquiredAt']) &&
        value['schemaVersion'] === 1 &&
        validIdentity(value['token'])));
  if (!keysAreValid || !validPid(value['pid']) || !validTimestamp(value['acquiredAt'])) {
    throw new ApplicationError(
      'WAKE_LIFECYCLE_LOCK_INVALID',
      'The wake supervisor lifecycle lock is invalid; refusing to replace it.',
      409,
    );
  }
  return value as WakeLifecycleLock;
}

function parseStartIntent(value: unknown): WakeStartIntent {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'token',
      'instanceId',
      'pid',
      'installationRoot',
      'requestedAt',
    ]) ||
    value['schemaVersion'] !== 1 ||
    !validIdentity(value['token']) ||
    !validIdentity(value['instanceId']) ||
    !validPid(value['pid']) ||
    !boundedString(value['installationRoot'], 32_767) ||
    !validTimestamp(value['requestedAt'])
  ) {
    throw new ApplicationError(
      'WAKE_START_INTENT_INVALID',
      'The wake supervisor start intent is invalid; refusing to replace it.',
      409,
    );
  }
  return value as WakeStartIntent;
}

function parseStopFence(value: unknown): WakeStopFence {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'token',
      'pid',
      'requestedAt',
      'completedAt',
      'cancelledStartToken',
    ]) ||
    value['schemaVersion'] !== 1 ||
    !validIdentity(value['token']) ||
    !validPid(value['pid']) ||
    !validTimestamp(value['requestedAt']) ||
    !(value['completedAt'] === null || validTimestamp(value['completedAt'])) ||
    !(value['cancelledStartToken'] === null || validIdentity(value['cancelledStartToken'])) ||
    (typeof value['completedAt'] === 'string' &&
      Date.parse(value['completedAt']) < Date.parse(value['requestedAt'] as string))
  ) {
    throw new ApplicationError(
      'WAKE_STOP_FENCE_INVALID',
      'The wake supervisor stop fence is invalid; refusing to replace it.',
      409,
    );
  }
  return value as WakeStopFence;
}

function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
  pathApi: PathApi,
): boolean {
  const normalize = (value: string): string => {
    const normalized = pathApi.normalize(value);
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function serialize(value: object): string {
  return `${JSON.stringify(value)}\n`;
}

function publicStatus(
  state: WakeLifecycleStatus['state'],
  ownership: WakeLifecycleStatus['ownership'],
  owner?: WakeOwner,
  heartbeat?: WakeHeartbeat,
): WakeLifecycleStatus {
  return {
    state,
    managed: state === 'running',
    ownership,
    ...(owner === undefined
      ? {}
      : {
          pid: owner.pid,
          instanceId: owner.instanceId,
          startedAt: owner.startedAt,
        }),
    ...(heartbeat === undefined ? {} : { heartbeatAt: heartbeat.heartbeatAt }),
  };
}

/**
 * Acquires the process-crash-safe Windows mutex used to serialize lifecycle
 * receipt inspection and replacement. A named pipe is owned by the kernel and
 * disappears when its server process exits, unlike a filesystem sidecar.
 */
export async function tryAcquireNodeWakeLifecycleMutex(
  identity: string,
  platform: NodeJS.Platform = process.platform,
): Promise<(() => Promise<void>) | undefined> {
  if (platform !== 'win32') return async () => undefined;

  const normalizedIdentity = identity.replaceAll('/', '\\').toLowerCase();
  const digest = createHash('sha256').update(normalizedIdentity).digest('hex');
  const pipeName = `\\\\.\\pipe\\luwi-wake-lifecycle-${digest}`;
  const server = createServer((socket) => socket.destroy());

  return await new Promise<(() => Promise<void>) | undefined>((resolve, reject) => {
    let settled = false;
    const onError = (error: NodeJS.ErrnoException): void => {
      if (settled) return;
      settled = true;
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve(undefined);
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    server.listen(pipeName, () => {
      if (settled) {
        server.close();
        return;
      }
      settled = true;
      server.off('error', onError);
      // An already-acquired mutex must remain fail-closed if the server emits a
      // late transport error; lifecycle receipt validation remains authoritative.
      server.on('error', () => undefined);
      server.unref();
      let released = false;
      resolve(async () => {
        if (released) return;
        released = true;
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => {
            if (error !== undefined) rejectClose(error);
            else resolveClose();
          });
        });
      });
    });
  });
}

async function spawnDetachedWake(launch: WakeProcessLaunch): Promise<SpawnedWake> {
  const log = await open(launch.logFile, 'a', 0o600);
  try {
    const child = spawn(launch.executable, [...launch.args], {
      cwd: launch.workingDirectory,
      env: launch.environment as NodeJS.ProcessEnv,
      detached: launch.detached,
      shell: launch.shell,
      stdio: ['ignore', log.fd, log.fd],
      windowsHide: launch.windowsHide,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    if (child.pid === undefined) {
      throw new ApplicationError(
        'WAKE_START_FAILED',
        'The wake supervisor process did not report an identity.',
        503,
      );
    }
    child.unref();
    return { pid: child.pid };
  } finally {
    await log.close();
  }
}

type Inspection = {
  status: WakeLifecycleStatus;
  owner?: WakeOwner;
  heartbeat?: WakeHeartbeat;
};

export function createWakeLifecycleService(
  options: WakeLifecycleServiceOptions,
): WakeLifecycleService {
  const dependencies = options.dependencies;
  const pathApi = options.pathApi ?? nodePath;
  const absolutePath = (value: string): string => {
    const absolute =
      dependencies.platform === 'win32'
        ? nodePath.win32.isAbsolute(value)
        : pathApi.isAbsolute(value);
    return absolute ? pathApi.normalize(value) : pathApi.resolve(value);
  };
  const installationRoot = absolutePath(options.installationRoot);
  const homeDirectory = absolutePath(
    options.homeDirectory ??
      dependencies.environment['LUWI_HOME'] ??
      pathApi.join(homedir(), '.luwi'),
  );
  const runtimeDirectory = pathApi.join(homeDirectory, 'runtime');
  const ownerPath = pathApi.join(runtimeDirectory, 'wake-owner.json');
  const heartbeatPath = pathApi.join(runtimeDirectory, 'wake-heartbeat.json');
  const stopRequestPath = pathApi.join(runtimeDirectory, 'wake-stop-request.json');
  const startIntentPath = pathApi.join(runtimeDirectory, 'wake-start-intent.json');
  const stopFencePath = pathApi.join(runtimeDirectory, 'wake-stop-fence.json');
  const lockPath = pathApi.join(runtimeDirectory, 'wake-lifecycle.lock');
  let mutexIdentity = lockPath;
  const logPath = pathApi.join(runtimeDirectory, 'wake.log');
  const cliEntry = pathApi.join(installationRoot, 'apps', 'cli', 'dist', 'main.js');
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatStaleMs = options.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS;

  const prepareHome = async (): Promise<void> => {
    await dependencies.fileSystem.ensureDirectory(homeDirectory);
    await dependencies.fileSystem.ensureDirectory(runtimeDirectory);
    const canonicalHome = await dependencies.fileSystem.canonicalize(homeDirectory);
    const canonicalRuntime = await dependencies.fileSystem.canonicalize(runtimeDirectory);
    mutexIdentity = pathApi.join(canonicalRuntime, 'wake-lifecycle.lock');
    const relative = pathApi.relative(canonicalHome, canonicalRuntime);
    if (
      relative === '..' ||
      relative.startsWith('../') ||
      relative.startsWith('..\\') ||
      pathApi.isAbsolute(relative)
    ) {
      throw new ApplicationError(
        'WAKE_HOME_INVALID',
        'The wake runtime directory resolves outside LUWI_HOME.',
        409,
      );
    }
  };

  const readJson = async (path: string): Promise<unknown | undefined> => {
    const content = await dependencies.fileSystem.readText(path, RECORD_MAX_BYTES);
    if (content === undefined) return undefined;
    try {
      return JSON.parse(content) as unknown;
    } catch {
      throw new ApplicationError(
        'WAKE_OWNERSHIP_INVALID',
        'A wake supervisor lifecycle record is invalid.',
        409,
      );
    }
  };

  const readOwner = async (): Promise<WakeOwner | undefined> => {
    const value = await readJson(ownerPath);
    if (value === undefined) return undefined;
    const owner = parseOwner(value);
    if (!samePath(owner.installationRoot, installationRoot, dependencies.platform, pathApi)) {
      throw new ApplicationError(
        'WAKE_OWNERSHIP_INVALID',
        'The wake supervisor ownership record belongs to another installation.',
        409,
      );
    }
    return owner;
  };

  const readHeartbeat = async (): Promise<WakeHeartbeat | undefined> => {
    const value = await readJson(heartbeatPath);
    return value === undefined ? undefined : parseHeartbeat(value);
  };

  const readStopRequest = async (): Promise<WakeStopRequest | undefined> => {
    const value = await readJson(stopRequestPath);
    return value === undefined ? undefined : parseStopRequest(value);
  };

  const assertBoundedFutureTimestamp = (
    value: string,
    code: 'WAKE_START_INTENT_INVALID' | 'WAKE_STOP_FENCE_INVALID',
    recordName: string,
  ): void => {
    if (Date.parse(value) <= dependencies.now().getTime() + LOCK_RECLAIM_STALE_MS) return;
    throw new ApplicationError(
      code,
      `The wake supervisor ${recordName} timestamp is too far in the future; refusing to replace it.`,
      409,
    );
  };

  const readStartIntent = async (): Promise<
    { content: string; intent: WakeStartIntent } | undefined
  > => {
    const content = await dependencies.fileSystem.readText(startIntentPath, RECORD_MAX_BYTES);
    if (content === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      throw new ApplicationError(
        'WAKE_START_INTENT_INVALID',
        'The wake supervisor start intent is invalid; refusing to replace it.',
        409,
      );
    }
    const intent = parseStartIntent(parsed);
    assertBoundedFutureTimestamp(intent.requestedAt, 'WAKE_START_INTENT_INVALID', 'start intent');
    if (!samePath(intent.installationRoot, installationRoot, dependencies.platform, pathApi)) {
      throw new ApplicationError(
        'WAKE_START_INTENT_INVALID',
        'The wake supervisor start intent belongs to another installation.',
        409,
      );
    }
    return { content, intent };
  };

  const readStopFence = async (): Promise<
    { content: string; fence: WakeStopFence } | undefined
  > => {
    const content = await dependencies.fileSystem.readText(stopFencePath, RECORD_MAX_BYTES);
    if (content === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      throw new ApplicationError(
        'WAKE_STOP_FENCE_INVALID',
        'The wake supervisor stop fence is invalid; refusing to replace it.',
        409,
      );
    }
    const fence = parseStopFence(parsed);
    assertBoundedFutureTimestamp(fence.requestedAt, 'WAKE_STOP_FENCE_INVALID', 'stop fence');
    if (fence.completedAt !== null) {
      assertBoundedFutureTimestamp(fence.completedAt, 'WAKE_STOP_FENCE_INVALID', 'stop fence');
    }
    return { content, fence };
  };

  const readLifecycleLock = async (): Promise<
    { content: string; owner: WakeLifecycleLock; observedAtMs: number } | undefined
  > => {
    const content = await dependencies.fileSystem.readText(lockPath, RECORD_MAX_BYTES);
    if (content === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      throw new ApplicationError(
        'WAKE_LIFECYCLE_LOCK_INVALID',
        'The wake supervisor lifecycle lock is invalid; refusing to replace it.',
        409,
      );
    }
    const owner = parseLifecycleLock(parsed);
    return { content, owner, observedAtMs: Date.parse(owner.acquiredAt) };
  };

  const inspect = async (): Promise<Inspection> => {
    let owner: WakeOwner | undefined;
    let heartbeat: WakeHeartbeat | undefined;
    try {
      owner = await readOwner();
      heartbeat = await readHeartbeat();
    } catch {
      return { status: publicStatus('invalid', 'invalid') };
    }
    if (owner === undefined) {
      return heartbeat === undefined
        ? { status: publicStatus('stopped', 'none') }
        : { status: publicStatus('stale', 'stale', undefined, heartbeat), heartbeat };
    }
    if (
      heartbeat === undefined ||
      heartbeat.instanceId !== owner.instanceId ||
      heartbeat.pid !== owner.pid
    ) {
      return {
        status: publicStatus(
          heartbeat === undefined ? 'stale' : 'invalid',
          heartbeat === undefined ? 'stale' : 'invalid',
          owner,
          heartbeat,
        ),
        owner,
        ...(heartbeat === undefined ? {} : { heartbeat }),
      };
    }
    const age = dependencies.now().getTime() - Date.parse(heartbeat.heartbeatAt);
    if (age < -heartbeatStaleMs) {
      return { status: publicStatus('invalid', 'invalid', owner, heartbeat), owner, heartbeat };
    }
    if (age > heartbeatStaleMs) {
      return { status: publicStatus('stale', 'stale', owner, heartbeat), owner, heartbeat };
    }
    return { status: publicStatus('running', 'owned', owner, heartbeat), owner, heartbeat };
  };

  const withLock = async <Result>(
    operation: () => Promise<Result>,
    timeoutMs = LOCK_TIMEOUT_MS,
  ): Promise<Result> => {
    const deadline = dependencies.clock() + timeoutMs;
    do {
      const releaseMutex = await dependencies.tryAcquireMutex(mutexIdentity);
      if (releaseMutex !== undefined) {
        try {
          let release = await dependencies.fileSystem.tryAcquireLock(lockPath);
          if (release === undefined) {
            const existing = await readLifecycleLock();
            if (existing !== undefined) {
              const ageMs = dependencies.now().getTime() - existing.observedAtMs;
              if (ageMs < -LOCK_RECLAIM_STALE_MS) {
                throw new ApplicationError(
                  'WAKE_LIFECYCLE_LOCK_INVALID',
                  'The wake supervisor lifecycle lock timestamp is invalid; refusing to replace it.',
                  409,
                );
              }
              if (ageMs >= LOCK_RECLAIM_STALE_MS) {
                const reclaimable =
                  dependencies.platform === 'win32' &&
                  (await dependencies.processState(existing.owner.pid)) === 'dead';
                if (
                  reclaimable &&
                  (await dependencies.fileSystem.tryReclaimLock(lockPath, existing.content))
                ) {
                  // The kernel mutex stays held across exact removal and receipt
                  // acquisition, so no canonical-path gap is visible to a peer.
                  release = await dependencies.fileSystem.tryAcquireLock(lockPath);
                }
              }
            }
          }
          if (release !== undefined) {
            try {
              return await operation();
            } finally {
              await release();
            }
          }
        } finally {
          await releaseMutex();
        }
      }
      const waitMs = Math.min(pollIntervalMs, Math.max(0, deadline - dependencies.clock()));
      if (waitMs > 0) await dependencies.wait(waitMs);
    } while (dependencies.clock() < deadline);
    throw new ApplicationError(
      'WAKE_LIFECYCLE_BUSY',
      'Another wake supervisor lifecycle operation is active.',
      409,
    );
  };

  const waitForDaemon = async (): Promise<void> => {
    const deadline = dependencies.clock() + readinessTimeoutMs;
    do {
      try {
        if ((await dependencies.daemonStatus()).daemon.state === 'ready') return;
      } catch {
        // The independent logon tasks may race; bounded retry is the expected path.
      }
      const waitMs = Math.min(pollIntervalMs, Math.max(0, deadline - dependencies.clock()));
      if (waitMs > 0) await dependencies.wait(waitMs);
    } while (dependencies.clock() < deadline);
    throw new ApplicationError(
      'WAKE_DAEMON_NOT_READY',
      'The LUWI daemon did not become ready before the wake startup deadline.',
      503,
    );
  };

  const removeArtifacts = async (): Promise<void> => {
    await dependencies.fileSystem.removeFile(ownerPath);
    await dependencies.fileSystem.removeFile(heartbeatPath);
    await dependencies.fileSystem.removeFile(stopRequestPath);
  };

  const sameOwner = (left: WakeOwner, right: WakeOwner): boolean =>
    left.token === right.token &&
    left.instanceId === right.instanceId &&
    left.pid === right.pid &&
    samePath(left.installationRoot, right.installationRoot, dependencies.platform, pathApi);

  const sameStartIntent = (left: WakeStartIntent, right: WakeStartIntent): boolean =>
    left.token === right.token &&
    left.instanceId === right.instanceId &&
    left.pid === right.pid &&
    left.requestedAt === right.requestedAt &&
    samePath(left.installationRoot, right.installationRoot, dependencies.platform, pathApi);

  const removeExactRecord = async (path: string, content: string): Promise<boolean> =>
    await dependencies.fileSystem.tryReclaimLock(path, content);

  const startCancelled = (): ApplicationError =>
    new ApplicationError(
      'WAKE_START_CANCELLED',
      'The wake supervisor start was cancelled by a concurrent stop request.',
      409,
    );

  const clearStopFenceForStart = async (startToken: string): Promise<void> => {
    const record = await readStopFence();
    if (record === undefined) return;
    if (record.fence.completedAt === null) {
      const ageMs = dependencies.now().getTime() - Date.parse(record.fence.requestedAt);
      if (
        ageMs >= LOCK_RECLAIM_STALE_MS &&
        (await dependencies.processState(record.fence.pid)) === 'dead' &&
        (await removeExactRecord(stopFencePath, record.content))
      ) {
        return;
      }
      throw startCancelled();
    }
    if (record.fence.cancelledStartToken === startToken) throw startCancelled();
    if (!(await removeExactRecord(stopFencePath, record.content))) {
      throw new ApplicationError(
        'WAKE_LIFECYCLE_BUSY',
        'The wake supervisor stop fence changed while a start was being prepared.',
        409,
      );
    }
  };

  const clearStaleStartIntent = async (): Promise<void> => {
    const record = await readStartIntent();
    if (record === undefined) return;
    const ageMs = dependencies.now().getTime() - Date.parse(record.intent.requestedAt);
    if (ageMs < -LOCK_RECLAIM_STALE_MS) {
      throw new ApplicationError(
        'WAKE_START_INTENT_INVALID',
        'The wake supervisor start intent timestamp is invalid; refusing to replace it.',
        409,
      );
    }
    if (
      ageMs >= LOCK_RECLAIM_STALE_MS &&
      (await dependencies.processState(record.intent.pid)) === 'dead' &&
      (await removeExactRecord(startIntentPath, record.content))
    ) {
      return;
    }
    throw new ApplicationError(
      'WAKE_START_BUSY',
      'Another wake supervisor start is already in progress.',
      409,
    );
  };

  const cleanupStartIntent = async (intent: WakeStartIntent, content: string): Promise<void> => {
    await withLock(async () => {
      const current = await readStartIntent();
      if (current === undefined || !sameStartIntent(current.intent, intent)) return;
      await removeExactRecord(startIntentPath, content);
    }, stopTimeoutMs);
  };

  return {
    async status() {
      await prepareHome();
      return (await inspect()).status;
    },

    async start() {
      await prepareHome();
      const requestedAt = dependencies.now().toISOString();
      const controlToken = dependencies.randomUUID();
      const instanceId = dependencies.randomUUID();
      if (!validIdentity(controlToken) || !validIdentity(instanceId)) {
        throw new ApplicationError(
          'WAKE_START_FAILED',
          'The wake supervisor could not create a valid process identity.',
          500,
        );
      }
      const prepared = await withLock(async (): Promise<WakeLifecycleStatus | WakeStartIntent> => {
        await clearStopFenceForStart(controlToken);
        const existing = await inspect();
        if (existing.status.state === 'running') return existing.status;
        if (existing.status.state === 'invalid') {
          throw new ApplicationError(
            'WAKE_OWNERSHIP_INVALID',
            'Wake supervisor ownership evidence is invalid; refusing to replace it.',
            409,
          );
        }
        await clearStaleStartIntent();
        const intent: WakeStartIntent = {
          schemaVersion: 1,
          token: controlToken,
          instanceId,
          pid: dependencies.processId,
          installationRoot,
          requestedAt,
        };
        await dependencies.fileSystem.writeAtomic(startIntentPath, serialize(intent));
        return intent;
      });
      if ('state' in prepared) return prepared;

      const intent = prepared;
      const intentContent = serialize(intent);
      try {
        await waitForDaemon();
        const launch = await withLock(async (): Promise<WakeLifecycleStatus | SpawnedWake> => {
          const currentIntent = await readStartIntent();
          if (currentIntent === undefined || !sameStartIntent(currentIntent.intent, intent)) {
            throw startCancelled();
          }
          await clearStopFenceForStart(intent.token);
          const existing = await inspect();
          if (existing.status.state === 'running') {
            await removeExactRecord(startIntentPath, intentContent);
            return existing.status;
          }
          if (existing.status.state === 'invalid') {
            throw new ApplicationError(
              'WAKE_OWNERSHIP_INVALID',
              'Wake supervisor ownership evidence is invalid; refusing to replace it.',
              409,
            );
          }
          await removeArtifacts();

          const environment: Record<string, string | undefined> = sanitizeWakeChildEnvironment(
            dependencies.environment,
          );
          environment[WAKE_CONTROL_TOKEN_ENV] = intent.token;
          environment[WAKE_INSTANCE_ID_ENV] = intent.instanceId;
          const launched = await dependencies.spawnWake({
            executable: dependencies.nodeExecutable,
            args: [cliEntry, 'wake', 'serve'],
            workingDirectory: installationRoot,
            logFile: logPath,
            environment,
            detached: true,
            shell: false,
            windowsHide: true,
          });
          if (!validPid(launched.pid)) {
            throw new ApplicationError(
              'WAKE_START_FAILED',
              'The wake supervisor process did not report an identity.',
              503,
            );
          }
          return launched;
        });
        if ('state' in launch) return launch;

        const deadline = dependencies.clock() + startTimeoutMs;
        while (true) {
          const observed = await withLock(async (): Promise<WakeLifecycleStatus | undefined> => {
            const current = await inspect();
            if (
              current.owner !== undefined &&
              (current.owner.token !== intent.token ||
                current.owner.instanceId !== intent.instanceId ||
                current.owner.pid !== launch.pid)
            ) {
              throw new ApplicationError(
                'WAKE_START_CONFLICT',
                'Another wake supervisor identity appeared during startup.',
                409,
              );
            }
            if (
              current.owner !== undefined &&
              current.heartbeat !== undefined &&
              current.status.state === 'running'
            ) {
              const currentIntent = await readStartIntent();
              if (currentIntent !== undefined && sameStartIntent(currentIntent.intent, intent)) {
                await removeExactRecord(startIntentPath, currentIntent.content);
              }
              return current.status;
            }
            const currentIntent = await readStartIntent();
            if (currentIntent === undefined || !sameStartIntent(currentIntent.intent, intent)) {
              throw startCancelled();
            }
            const fence = await readStopFence();
            if (
              fence !== undefined &&
              (fence.fence.completedAt === null || fence.fence.cancelledStartToken === intent.token)
            ) {
              throw startCancelled();
            }
            return undefined;
          });
          if (observed !== undefined) return observed;
          if (dependencies.clock() >= deadline) break;
          const waitMs = Math.min(pollIntervalMs, Math.max(0, deadline - dependencies.clock()));
          if (waitMs > 0) await dependencies.wait(waitMs);
        }

        await withLock(async () => {
          const currentIntent = await readStartIntent();
          if (currentIntent === undefined || !sameStartIntent(currentIntent.intent, intent)) {
            throw startCancelled();
          }
          const fence = await readStopFence();
          if (
            fence !== undefined &&
            (fence.fence.completedAt === null || fence.fence.cancelledStartToken === intent.token)
          ) {
            throw startCancelled();
          }
          await dependencies.fileSystem.writeAtomic(
            stopRequestPath,
            serialize({
              schemaVersion: 1,
              token: intent.token,
              instanceId: intent.instanceId,
              pid: launch.pid,
              requestedAt: dependencies.now().toISOString(),
            } satisfies WakeStopRequest),
          );
        });
        throw new ApplicationError(
          'WAKE_START_TIMEOUT',
          'The wake supervisor did not publish a healthy heartbeat before the startup deadline.',
          503,
        );
      } finally {
        await cleanupStartIntent(intent, intentContent);
      }
    },

    async stop() {
      await prepareHome();
      const requestedAt = dependencies.now().toISOString();
      const fenceToken = dependencies.randomUUID();
      if (!validIdentity(fenceToken)) {
        throw new ApplicationError(
          'WAKE_STOP_FAILED',
          'The wake supervisor could not create a valid stop identity.',
          500,
        );
      }
      let writtenFence: WakeStopFence | undefined;
      const finishFence = async (): Promise<void> => {
        if (writtenFence === undefined) return;
        await withLock(async () => {
          const current = await readStopFence();
          if (current === undefined || current.fence.token !== writtenFence?.token) return;
          await dependencies.fileSystem.writeAtomic(
            stopFencePath,
            serialize({ ...writtenFence, completedAt: dependencies.now().toISOString() }),
          );
        }, stopTimeoutMs);
      };

      try {
        const target = await withLock(async (): Promise<WakeOwner | undefined> => {
          const previousFence = await readStopFence();
          if (previousFence !== undefined) {
            if (previousFence.fence.completedAt === null) {
              const ageMs =
                dependencies.now().getTime() - Date.parse(previousFence.fence.requestedAt);
              const staleDead =
                ageMs >= LOCK_RECLAIM_STALE_MS &&
                (await dependencies.processState(previousFence.fence.pid)) === 'dead';
              if (!staleDead || !(await removeExactRecord(stopFencePath, previousFence.content))) {
                throw new ApplicationError(
                  'WAKE_LIFECYCLE_BUSY',
                  'Another wake supervisor stop is already in progress.',
                  409,
                );
              }
            } else if (!(await removeExactRecord(stopFencePath, previousFence.content))) {
              throw new ApplicationError(
                'WAKE_LIFECYCLE_BUSY',
                'The wake supervisor stop fence changed while stop was being prepared.',
                409,
              );
            }
          }
          const pendingStart = await readStartIntent();
          const fence: WakeStopFence = {
            schemaVersion: 1,
            token: fenceToken,
            pid: dependencies.processId,
            requestedAt,
            completedAt: null,
            cancelledStartToken: pendingStart?.intent.token ?? null,
          };
          await dependencies.fileSystem.writeAtomic(stopFencePath, serialize(fence));
          writtenFence = fence;
          if (
            pendingStart !== undefined &&
            !(await removeExactRecord(startIntentPath, pendingStart.content))
          ) {
            throw new ApplicationError(
              'WAKE_LIFECYCLE_BUSY',
              'The wake supervisor start intent changed while stop was cancelling it.',
              409,
            );
          }
          const observed = await inspect();
          if (observed.status.state === 'invalid') {
            throw new ApplicationError(
              'WAKE_OWNERSHIP_INVALID',
              'Wake supervisor ownership evidence is invalid; refusing to request a stop.',
              409,
            );
          }
          if (observed.owner === undefined) {
            await removeArtifacts();
            return undefined;
          }
          if (observed.status.state === 'stale') {
            await removeArtifacts();
            return undefined;
          }
          await dependencies.fileSystem.writeAtomic(
            stopRequestPath,
            serialize({
              schemaVersion: 1,
              token: observed.owner.token,
              instanceId: observed.owner.instanceId,
              pid: observed.owner.pid,
              requestedAt: dependencies.now().toISOString(),
            } satisfies WakeStopRequest),
          );
          return observed.owner;
        }, stopTimeoutMs);
        if (target === undefined) return (await inspect()).status;

        const deadline = dependencies.clock() + stopTimeoutMs;
        do {
          const current = await readOwner();
          if (current === undefined) return (await inspect()).status;
          if (!sameOwner(current, target)) {
            throw new ApplicationError(
              'WAKE_OWNERSHIP_CHANGED',
              'Wake supervisor ownership changed while the stop request was pending.',
              409,
            );
          }
          const waitMs = Math.min(pollIntervalMs, Math.max(0, deadline - dependencies.clock()));
          if (waitMs > 0) await dependencies.wait(waitMs);
        } while (dependencies.clock() < deadline);
        throw new ApplicationError(
          'WAKE_STOP_TIMEOUT',
          'The managed wake supervisor did not honor the cooperative stop request in time.',
          503,
        );
      } finally {
        await finishFence();
      }
    },

    async beginManagedServe() {
      await waitForDaemon();
      await prepareHome();
      const tokenValue = dependencies.environment[WAKE_CONTROL_TOKEN_ENV];
      const instanceValue = dependencies.environment[WAKE_INSTANCE_ID_ENV];
      if (!validIdentity(tokenValue) || !validIdentity(instanceValue)) {
        throw new ApplicationError(
          'WAKE_MANAGED_IDENTITY_REQUIRED',
          'Managed wake serve requires a valid private lifecycle identity.',
          409,
        );
      }
      const owner: WakeOwner = {
        schemaVersion: 1,
        token: tokenValue,
        instanceId: instanceValue,
        pid: dependencies.processId,
        installationRoot,
        startedAt: dependencies.now().toISOString(),
      };
      const writeHeartbeat = async (): Promise<void> => {
        await dependencies.fileSystem.writeAtomic(
          heartbeatPath,
          serialize({
            schemaVersion: 1,
            instanceId: owner.instanceId,
            pid: owner.pid,
            heartbeatAt: dependencies.now().toISOString(),
          } satisfies WakeHeartbeat),
        );
      };
      await withLock(async () => {
        const intent = await readStartIntent();
        const fence = await readStopFence();
        if (
          intent === undefined ||
          intent.intent.token !== tokenValue ||
          intent.intent.instanceId !== instanceValue ||
          !samePath(
            intent.intent.installationRoot,
            installationRoot,
            dependencies.platform,
            pathApi,
          ) ||
          (fence !== undefined &&
            (fence.fence.completedAt === null || fence.fence.cancelledStartToken === tokenValue))
        ) {
          throw startCancelled();
        }

        const current = await inspect();
        if (current.status.state === 'invalid') {
          throw new ApplicationError(
            'WAKE_OWNERSHIP_INVALID',
            'Wake supervisor ownership evidence is invalid; refusing to serve.',
            409,
          );
        }
        if (current.owner !== undefined && !sameOwner(current.owner, owner)) {
          throw new ApplicationError(
            'WAKE_ALREADY_RUNNING',
            'Another managed wake supervisor owns the lifecycle receipt.',
            409,
          );
        }

        await dependencies.fileSystem.writeAtomic(ownerPath, serialize(owner));
        await writeHeartbeat();
        if (!(await removeExactRecord(startIntentPath, intent.content))) {
          await dependencies.fileSystem.removeFile(heartbeatPath);
          await dependencies.fileSystem.removeFile(ownerPath);
          throw new ApplicationError(
            'WAKE_LIFECYCLE_BUSY',
            'The wake supervisor start intent changed during child admission.',
            409,
          );
        }
      });

      let closed = false;
      let settled = false;
      let resolveStop: (() => void) | undefined;
      let rejectStop: ((error: unknown) => void) | undefined;
      let tickInFlight: Promise<void> | undefined;
      const stopRequested = new Promise<void>((resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
      });
      const settleStop = (): void => {
        if (settled) return;
        settled = true;
        resolveStop?.();
      };
      const failStop = (error: unknown): void => {
        if (settled) return;
        settled = true;
        rejectStop?.(error);
      };
      const tick = async (): Promise<void> => {
        const observedOwner = await readOwner();
        if (observedOwner === undefined || !sameOwner(observedOwner, owner)) {
          throw new ApplicationError(
            'WAKE_OWNERSHIP_LOST',
            'The managed wake supervisor lifecycle identity was replaced.',
            409,
          );
        }
        await writeHeartbeat();
        const request = await readStopRequest();
        if (
          request !== undefined &&
          request.token === owner.token &&
          request.instanceId === owner.instanceId &&
          request.pid === owner.pid
        ) {
          settleStop();
        }
      };
      const scheduleTick = (): void => {
        if (closed || tickInFlight !== undefined) return;
        const operation = tick()
          .catch((error: unknown) => failStop(error))
          .finally(() => {
            if (tickInFlight === operation) tickInFlight = undefined;
          });
        tickInFlight = operation;
      };
      const timer = dependencies.setInterval(scheduleTick, heartbeatIntervalMs);

      return {
        stopRequested,
        async close() {
          if (closed) return;
          closed = true;
          dependencies.clearInterval(timer);
          await tickInFlight;
          settleStop();
          await withLock(async () => {
            const observedOwner = await readOwner().catch(() => undefined);
            if (observedOwner === undefined || !sameOwner(observedOwner, owner)) return;
            const request = await readStopRequest().catch(() => undefined);
            if (
              request?.token === owner.token &&
              request.instanceId === owner.instanceId &&
              request.pid === owner.pid
            ) {
              await dependencies.fileSystem.removeFile(stopRequestPath);
            }
            const observedHeartbeat = await readHeartbeat().catch(() => undefined);
            if (
              observedHeartbeat?.instanceId === owner.instanceId &&
              observedHeartbeat.pid === owner.pid
            ) {
              await dependencies.fileSystem.removeFile(heartbeatPath);
            }
            await dependencies.fileSystem.removeFile(ownerPath);
          });
        },
      };
    },
  };
}

export function createNodeWakeLifecycleService(options: {
  lifecycle: LifecycleService;
  installationRoot?: string;
  homeDirectory?: string;
}): WakeLifecycleService {
  const dependencies: WakeLifecycleDependencies = {
    fileSystem: new NodeLifecycleFileSystem(),
    environment: process.env,
    platform: process.platform,
    nodeExecutable: process.execPath,
    processId: process.pid,
    clock: Date.now,
    now: () => new Date(),
    randomUUID,
    processState: async (pid) => {
      try {
        process.kill(pid, 0);
        return 'alive';
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return 'dead';
        return 'unknown';
      }
    },
    tryAcquireMutex: (identity) => tryAcquireNodeWakeLifecycleMutex(identity),
    daemonStatus: () => options.lifecycle.status(),
    spawnWake: spawnDetachedWake,
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    setInterval,
    clearInterval,
  };
  return createWakeLifecycleService({
    installationRoot: options.installationRoot ?? defaultLifecycleInstallationRoot(),
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
    dependencies,
  });
}
