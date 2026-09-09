import { ApplicationError } from '@luwi/runtime';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as nodePath from 'node:path';

import {
  defaultLifecycleInstallationRoot,
  NodeLifecycleFileSystem,
  type LifecycleFileSystem,
  type LifecycleService,
  type LifecycleStatus,
} from './lifecycle.js';

const RECORD_MAX_BYTES = 16 * 1024;
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_STALE_MS = 5_000;
const LOCK_TIMEOUT_MS = 5_000;
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
  const lockPath = pathApi.join(runtimeDirectory, 'wake-lifecycle.lock');
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

  const withLock = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const deadline = dependencies.clock() + LOCK_TIMEOUT_MS;
    do {
      const release = await dependencies.fileSystem.tryAcquireLock(lockPath);
      if (release !== undefined) {
        try {
          return await operation();
        } finally {
          await release();
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

  return {
    async status() {
      await prepareHome();
      return (await inspect()).status;
    },

    async start() {
      await prepareHome();
      const beforeReadiness = await inspect();
      if (beforeReadiness.status.state === 'running') return beforeReadiness.status;
      if (beforeReadiness.status.state === 'invalid') {
        throw new ApplicationError(
          'WAKE_OWNERSHIP_INVALID',
          'Wake supervisor ownership evidence is invalid; refusing to replace it.',
          409,
        );
      }
      await waitForDaemon();
      return await withLock(async () => {
        const existing = await inspect();
        if (existing.status.state === 'running') return existing.status;
        if (existing.status.state === 'invalid') {
          throw new ApplicationError(
            'WAKE_OWNERSHIP_INVALID',
            'Wake supervisor ownership evidence is invalid; refusing to replace it.',
            409,
          );
        }
        await removeArtifacts();

        const controlToken = dependencies.randomUUID();
        const instanceId = dependencies.randomUUID();
        if (!validIdentity(controlToken) || !validIdentity(instanceId)) {
          throw new ApplicationError(
            'WAKE_START_FAILED',
            'The wake supervisor could not create a valid process identity.',
            500,
          );
        }
        const environment: Record<string, string | undefined> = { ...dependencies.environment };
        delete environment[WAKE_CONTROL_TOKEN_ENV];
        delete environment[WAKE_INSTANCE_ID_ENV];
        environment[WAKE_CONTROL_TOKEN_ENV] = controlToken;
        environment[WAKE_INSTANCE_ID_ENV] = instanceId;
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

        const deadline = dependencies.clock() + startTimeoutMs;
        do {
          const observed = await inspect();
          if (
            observed.owner !== undefined &&
            (observed.owner.token !== controlToken ||
              observed.owner.instanceId !== instanceId ||
              observed.owner.pid !== launched.pid)
          ) {
            throw new ApplicationError(
              'WAKE_START_CONFLICT',
              'Another wake supervisor identity appeared during startup.',
              409,
            );
          }
          if (
            observed.owner !== undefined &&
            observed.heartbeat !== undefined &&
            observed.status.state === 'running'
          ) {
            return observed.status;
          }
          const waitMs = Math.min(pollIntervalMs, Math.max(0, deadline - dependencies.clock()));
          if (waitMs > 0) await dependencies.wait(waitMs);
        } while (dependencies.clock() < deadline);

        await dependencies.fileSystem.writeAtomic(
          stopRequestPath,
          serialize({
            schemaVersion: 1,
            token: controlToken,
            instanceId,
            pid: launched.pid,
            requestedAt: dependencies.now().toISOString(),
          } satisfies WakeStopRequest),
        );
        throw new ApplicationError(
          'WAKE_START_TIMEOUT',
          'The wake supervisor did not publish a healthy heartbeat before the startup deadline.',
          503,
        );
      });
    },

    async stop() {
      await prepareHome();
      const target = await withLock(async (): Promise<WakeOwner | undefined> => {
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
      });
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
      await dependencies.fileSystem.writeAtomic(ownerPath, serialize(owner));
      await writeHeartbeat();

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
