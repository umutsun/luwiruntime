import { posix } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { LifecycleFileSystem, LifecycleStatus } from './lifecycle.js';
import {
  createWakeLifecycleService,
  type WakeLifecycleDependencies,
  type WakeProcessLaunch,
} from './wake-lifecycle.js';

const installationRoot = 'C:/workspace/luwiruntime';
const homeDirectory = `${installationRoot}/.luwi`;
const runtimeDirectory = `${homeDirectory}/runtime`;
const ownerPath = `${runtimeDirectory}/wake-owner.json`;
const heartbeatPath = `${runtimeDirectory}/wake-heartbeat.json`;
const stopRequestPath = `${runtimeDirectory}/wake-stop-request.json`;
const startIntentPath = `${runtimeDirectory}/wake-start-intent.json`;
const stopFencePath = `${runtimeDirectory}/wake-stop-fence.json`;
const lockPath = `${runtimeDirectory}/wake-lifecycle.lock`;
const logPath = `${runtimeDirectory}/wake.log`;
const cliEntry = `${installationRoot}/apps/cli/dist/main.js`;
const token = '6ccfd2c0-e424-4a21-91db-30dc72092a01';
const instanceId = 'f2e95fa4-f12d-4a42-92bb-fba0bb5f938b';
const startedAt = '2026-09-10T08:00:00.000Z';

const daemonReady: LifecycleStatus = {
  daemon: { state: 'ready', managed: true, ownership: 'owned' },
  redis: { state: 'connected', compose: 'running' },
  endpoints: {
    daemon: 'http://127.0.0.1:4782',
    redis: 'redis://127.0.0.1:6379',
  },
};

function serialized(value: object): string {
  return `${JSON.stringify(value)}\n`;
}

function owner(overrides: Record<string, unknown> = {}): string {
  return serialized({
    schemaVersion: 1,
    token,
    instanceId,
    pid: 4242,
    installationRoot,
    startedAt,
    ...overrides,
  });
}

function heartbeat(overrides: Record<string, unknown> = {}): string {
  return serialized({
    schemaVersion: 1,
    instanceId,
    pid: 4242,
    heartbeatAt: startedAt,
    ...overrides,
  });
}

function lifecycleLock(overrides: Record<string, unknown> = {}): string {
  return serialized({
    pid: 9999,
    acquiredAt: '2026-09-10T07:00:00.000Z',
    ...overrides,
  });
}

function startIntent(overrides: Record<string, unknown> = {}): string {
  return serialized({
    schemaVersion: 1,
    token: 'c85949d8-13dd-4d6e-959f-05f67f4d453f',
    instanceId: '2da99872-087f-4873-a29f-b0d2765f21d8',
    pid: 9999,
    installationRoot,
    requestedAt: '2026-09-10T07:00:00.000Z',
    ...overrides,
  });
}

function stopFence(overrides: Record<string, unknown> = {}): string {
  return serialized({
    schemaVersion: 1,
    token: 'c85949d8-13dd-4d6e-959f-05f67f4d453f',
    pid: 9999,
    requestedAt: '2026-09-10T07:00:00.000Z',
    completedAt: null,
    cancelledStartToken: null,
    ...overrides,
  });
}

function memoryFileSystem(
  initial: Record<string, string> = {},
  options: { replaceLockBeforeReclaim?: string; lockModifiedAtMs?: number } = {},
): {
  fileSystem: LifecycleFileSystem;
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  const locks = new Set<string>();
  let racedReclaim = false;
  return {
    files,
    fileSystem: {
      canonicalize: vi.fn(async (path) => path.replaceAll('\\', '/')),
      ensureDirectory: vi.fn(async () => undefined),
      exists: vi.fn(async (path) => files.has(path.replaceAll('\\', '/'))),
      readText: vi.fn(async (path) => files.get(path.replaceAll('\\', '/'))),
      writeAtomic: vi.fn(async (path, content) => {
        files.set(path.replaceAll('\\', '/'), content);
      }),
      removeFile: vi.fn(async (path) => {
        files.delete(path.replaceAll('\\', '/'));
      }),
      modifiedAt: vi.fn(async (path: string) => {
        const normalized = path.replaceAll('\\', '/');
        if (!files.has(normalized)) return undefined;
        return options.lockModifiedAtMs ?? Date.parse('2026-09-10T07:00:00.000Z');
      }),
      tryAcquireLock: vi.fn(async (path) => {
        const normalized = path.replaceAll('\\', '/');
        if (locks.has(normalized) || files.has(normalized)) return undefined;
        locks.add(normalized);
        files.set(normalized, serialized({ pid: 7000, acquiredAt: '2026-09-10T08:00:00.000Z' }));
        return async () => {
          locks.delete(normalized);
          files.delete(normalized);
        };
      }),
      tryReclaimLock: vi.fn(async (path: string, expectedContent: string) => {
        const normalized = path.replaceAll('\\', '/');
        if (!racedReclaim && options.replaceLockBeforeReclaim !== undefined) {
          racedReclaim = true;
          files.set(normalized, options.replaceLockBeforeReclaim);
        }
        if (files.get(normalized) !== expectedContent) return false;
        files.delete(normalized);
        return true;
      }),
    },
  };
}

function fixture(
  options: {
    files?: Record<string, string>;
    daemonStates?: LifecycleStatus[];
    environment?: Readonly<Record<string, string | undefined>>;
    acknowledgeSpawn?: boolean;
    acknowledgeStop?: boolean;
    processId?: number;
    processState?: 'alive' | 'dead' | 'unknown';
    replaceLockBeforeReclaim?: string;
    useDefaultStopTimeout?: boolean;
    lockModifiedAtMs?: number;
  } = {},
) {
  const memory = memoryFileSystem(options.files, {
    ...(options.replaceLockBeforeReclaim === undefined
      ? {}
      : { replaceLockBeforeReclaim: options.replaceLockBeforeReclaim }),
    ...(options.lockModifiedAtMs === undefined
      ? {}
      : { lockModifiedAtMs: options.lockModifiedAtMs }),
  });
  let nowMs = Date.parse(startedAt);
  let uuidIndex = 0;
  let daemonIndex = 0;
  let mutexHeld = false;
  let pendingLaunch: WakeProcessLaunch | undefined;
  const intervalCallbacks: Array<() => void> = [];
  const spawnWake = vi.fn(async (launch: WakeProcessLaunch) => {
    pendingLaunch = launch;
    return { pid: 4242 };
  });
  const dependencies: WakeLifecycleDependencies = {
    fileSystem: memory.fileSystem,
    environment: options.environment ?? { PATH: 'C:/bin' },
    platform: 'win32',
    nodeExecutable: 'C:/Program Files/nodejs/node.exe',
    processId: options.processId ?? 7000,
    clock: () => nowMs,
    now: () => new Date(nowMs),
    randomUUID: () => (uuidIndex++ === 0 ? token : instanceId),
    processState: vi.fn(async () => options.processState ?? 'dead'),
    tryAcquireMutex: vi.fn(async () => {
      if (mutexHeld) return undefined;
      mutexHeld = true;
      return async () => {
        mutexHeld = false;
      };
    }),
    daemonStatus: vi.fn(async () => {
      const states = options.daemonStates ?? [daemonReady];
      const state = states[Math.min(daemonIndex, states.length - 1)]!;
      daemonIndex += 1;
      return state;
    }),
    spawnWake,
    wait: vi.fn(async (milliseconds) => {
      nowMs += milliseconds;
      if (options.acknowledgeSpawn !== false && pendingLaunch !== undefined) {
        const launch = pendingLaunch;
        pendingLaunch = undefined;
        const launchToken = launch.environment['LUWI_WAKE_CONTROL_TOKEN'];
        const launchInstance = launch.environment['LUWI_WAKE_INSTANCE_ID'];
        memory.files.set(
          ownerPath,
          owner({
            token: launchToken,
            instanceId: launchInstance,
            startedAt: new Date(nowMs).toISOString(),
          }),
        );
        memory.files.set(
          heartbeatPath,
          heartbeat({ instanceId: launchInstance, heartbeatAt: new Date(nowMs).toISOString() }),
        );
      }
      if (options.acknowledgeStop !== false && memory.files.has(stopRequestPath)) {
        memory.files.delete(ownerPath);
        memory.files.delete(heartbeatPath);
        memory.files.delete(stopRequestPath);
      }
    }),
    setInterval: vi.fn((callback) => {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length as unknown as NodeJS.Timeout;
    }),
    clearInterval: vi.fn(),
  };
  const service = createWakeLifecycleService({
    installationRoot,
    homeDirectory,
    dependencies,
    pathApi: posix,
    readinessTimeoutMs: 500,
    startTimeoutMs: 500,
    ...(options.useDefaultStopTimeout === true ? {} : { stopTimeoutMs: 500 }),
    pollIntervalMs: 50,
    heartbeatIntervalMs: 100,
    heartbeatStaleMs: 1_000,
  });
  return { ...memory, dependencies, intervalCallbacks, service, spawnWake };
}

describe('wake process lifecycle', () => {
  it('waits for daemon readiness and launches one hidden fixed-argv managed serve', async () => {
    const degraded: LifecycleStatus = {
      ...daemonReady,
      daemon: { state: 'stopped', managed: false, ownership: 'none' },
    };
    const { service, spawnWake, dependencies } = fixture({
      daemonStates: [degraded, daemonReady],
      environment: {
        PATH: 'C:/bin',
        LUWI_HOME: homeDirectory,
        REDIS_URL: 'redis://private',
        LUWI_SESSION_ID: 'parent-session',
        LUWI_LIFECYCLE_TOKEN: 'daemon-stop-capability',
        LUWI_RUNTIME_INSTANCE_ID: 'runtime-instance',
        CODEX_APP_TOOLS_PIPE_PATH: 'private-pipe',
        CODEX_HOME: 'C:/codex-home',
      },
    });

    const status = await service.start();

    expect(dependencies.daemonStatus).toHaveBeenCalledTimes(2);
    expect(spawnWake).toHaveBeenCalledWith({
      executable: 'C:/Program Files/nodejs/node.exe',
      args: [cliEntry, 'wake', 'serve'],
      workingDirectory: installationRoot,
      logFile: logPath,
      environment: expect.objectContaining({
        LUWI_WAKE_CONTROL_TOKEN: token,
        LUWI_WAKE_INSTANCE_ID: instanceId,
      }),
      detached: true,
      shell: false,
      windowsHide: true,
    });
    expect(status).toMatchObject({
      state: 'running',
      managed: true,
      ownership: 'owned',
      pid: 4242,
      instanceId,
    });
    expect(JSON.stringify(status)).not.toContain(token);
    const launchEnvironment = spawnWake.mock.calls[0]?.[0].environment;
    expect(launchEnvironment).toMatchObject({
      PATH: 'C:/bin',
      LUWI_HOME: homeDirectory,
      CODEX_HOME: 'C:/codex-home',
      LUWI_WAKE_CONTROL_TOKEN: token,
      LUWI_WAKE_INSTANCE_ID: instanceId,
    });
    expect(launchEnvironment).not.toHaveProperty('REDIS_URL');
    expect(launchEnvironment).not.toHaveProperty('LUWI_SESSION_ID');
    expect(launchEnvironment).not.toHaveProperty('LUWI_LIFECYCLE_TOKEN');
    expect(launchEnvironment).not.toHaveProperty('LUWI_RUNTIME_INSTANCE_ID');
    expect(launchEnvironment).not.toHaveProperty('CODEX_APP_TOOLS_PIPE_PATH');
    expect(dependencies.fileSystem.tryAcquireLock).toHaveBeenCalledWith(lockPath);
  });

  it('is idempotent for a fresh identity-matched heartbeat', async () => {
    const degraded: LifecycleStatus = {
      ...daemonReady,
      daemon: { state: 'stopped', managed: false, ownership: 'none' },
    };
    const { service, spawnWake, dependencies } = fixture({
      files: { [ownerPath]: owner(), [heartbeatPath]: heartbeat() },
      daemonStates: [degraded],
    });

    await expect(service.start()).resolves.toMatchObject({ state: 'running', pid: 4242 });
    expect(spawnWake).not.toHaveBeenCalled();
    expect(dependencies.daemonStatus).not.toHaveBeenCalled();
  });

  it('writes an identity-matched cooperative stop request and never exposes a kill surface', async () => {
    const { service, files, dependencies } = fixture({
      files: { [ownerPath]: owner(), [heartbeatPath]: heartbeat() },
    });

    await expect(service.stop()).resolves.toMatchObject({ state: 'stopped', ownership: 'none' });

    const writes = (dependencies.fileSystem.writeAtomic as ReturnType<typeof vi.fn>).mock.calls;
    const requestWrite = writes.find(([path]) => path === stopRequestPath);
    expect(requestWrite).toBeDefined();
    expect(JSON.parse(requestWrite![1])).toEqual({
      schemaVersion: 1,
      token,
      instanceId,
      pid: 4242,
      requestedAt: startedAt,
    });
    expect(files.has(ownerPath)).toBe(false);
    expect('kill' in dependencies).toBe(false);
  });

  it('refuses a mismatched heartbeat without writing a stop request', async () => {
    const { service, dependencies } = fixture({
      files: {
        [ownerPath]: owner(),
        [heartbeatPath]: heartbeat({ instanceId: '3d20abfa-e34b-40a7-a3c8-e20cfe813d6d' }),
      },
    });

    await expect(service.stop()).rejects.toMatchObject({ code: 'WAKE_OWNERSHIP_INVALID' });
    expect(dependencies.fileSystem.writeAtomic).not.toHaveBeenCalledWith(
      stopRequestPath,
      expect.anything(),
    );
  });

  it('fails bounded readiness without spawning', async () => {
    const degraded: LifecycleStatus = {
      ...daemonReady,
      daemon: { state: 'stopped', managed: false, ownership: 'none' },
    };
    const { service, spawnWake } = fixture({ daemonStates: [degraded] });

    await expect(service.start()).rejects.toMatchObject({ code: 'WAKE_DAEMON_NOT_READY' });
    expect(spawnWake).not.toHaveBeenCalled();
  });

  it('reclaims an exact stale lifecycle lock after its owner is proven dead', async () => {
    const staleLock = lifecycleLock();
    const { service, files, spawnWake, dependencies } = fixture({
      files: { [lockPath]: staleLock },
      processState: 'dead',
    });

    await expect(service.start()).resolves.toMatchObject({ state: 'running', pid: 4242 });

    expect(dependencies.processState).toHaveBeenCalledWith(9999);
    expect(dependencies.fileSystem.tryReclaimLock).toHaveBeenCalledWith(lockPath, staleLock);
    expect(files.has(lockPath)).toBe(false);
    expect(spawnWake).toHaveBeenCalledTimes(1);
  });

  it('never reclaims a stale lifecycle lock held by a live process', async () => {
    const staleLock = lifecycleLock();
    const { service, files, spawnWake, dependencies } = fixture({
      files: { [lockPath]: staleLock },
      processState: 'alive',
    });

    await expect(service.start()).rejects.toMatchObject({ code: 'WAKE_LIFECYCLE_BUSY' });

    expect(dependencies.processState).toHaveBeenCalledWith(9999);
    expect(dependencies.fileSystem.tryReclaimLock).not.toHaveBeenCalled();
    expect(files.get(lockPath)).toBe(staleLock);
    expect(spawnWake).not.toHaveBeenCalled();
  });

  it('does not reclaim a recent lock before the stale-owner threshold', async () => {
    const recentLock = lifecycleLock({ acquiredAt: startedAt });
    const { service, files, spawnWake, dependencies } = fixture({
      files: { [lockPath]: recentLock },
      processState: 'dead',
    });

    await expect(service.start()).rejects.toMatchObject({ code: 'WAKE_LIFECYCLE_BUSY' });

    expect(dependencies.processState).not.toHaveBeenCalled();
    expect(dependencies.fileSystem.tryReclaimLock).not.toHaveBeenCalled();
    expect(files.get(lockPath)).toBe(recentLock);
    expect(spawnWake).not.toHaveBeenCalled();
  });

  it('fails closed for a stale empty lock without owner-liveness evidence', async () => {
    const { service, files, spawnWake, dependencies } = fixture({
      files: { [lockPath]: '' },
      lockModifiedAtMs: Date.parse('2026-09-10T07:00:00.000Z'),
    });

    await expect(service.start()).rejects.toMatchObject({
      code: 'WAKE_LIFECYCLE_LOCK_INVALID',
    });

    expect(dependencies.processState).not.toHaveBeenCalled();
    expect(dependencies.fileSystem.tryReclaimLock).not.toHaveBeenCalled();
    expect(files.get(lockPath)).toBe('');
    expect(spawnWake).not.toHaveBeenCalled();
  });

  it('fails closed for a fresh empty lock whose acquisition may still be in progress', async () => {
    const { service, files, spawnWake, dependencies } = fixture({
      files: { [lockPath]: '' },
      lockModifiedAtMs: Date.parse(startedAt),
    });

    await expect(service.start()).rejects.toMatchObject({
      code: 'WAKE_LIFECYCLE_LOCK_INVALID',
    });

    expect(dependencies.fileSystem.tryReclaimLock).not.toHaveBeenCalled();
    expect(files.get(lockPath)).toBe('');
    expect(spawnWake).not.toHaveBeenCalled();
  });

  it('fails closed for malformed or ambiguous lifecycle lock evidence', async () => {
    const malformed = fixture({ files: { [lockPath]: '{}\n' }, processState: 'dead' });
    await expect(malformed.service.start()).rejects.toMatchObject({
      code: 'WAKE_LIFECYCLE_LOCK_INVALID',
    });
    expect(malformed.dependencies.processState).not.toHaveBeenCalled();
    expect(malformed.dependencies.fileSystem.tryReclaimLock).not.toHaveBeenCalled();

    const ambiguous = fixture({
      files: { [lockPath]: lifecycleLock() },
      processState: 'unknown',
    });
    await expect(ambiguous.service.start()).rejects.toMatchObject({ code: 'WAKE_LIFECYCLE_BUSY' });
    expect(ambiguous.dependencies.fileSystem.tryReclaimLock).not.toHaveBeenCalled();
  });

  it('does not remove a replacement lock that wins the reclamation race', async () => {
    const staleLock = lifecycleLock();
    const replacement = lifecycleLock({
      pid: 8888,
      acquiredAt: '2026-09-10T08:00:00.000Z',
    });
    const { service, files, spawnWake, dependencies } = fixture({
      files: { [lockPath]: staleLock },
      processState: 'dead',
      replaceLockBeforeReclaim: replacement,
    });

    await expect(service.start()).rejects.toMatchObject({ code: 'WAKE_LIFECYCLE_BUSY' });

    expect(dependencies.fileSystem.tryReclaimLock).toHaveBeenCalledWith(lockPath, staleLock);
    expect(files.get(lockPath)).toBe(replacement);
    expect(spawnWake).not.toHaveBeenCalled();
  });

  it('allows the default 30-second shutdown budget for bounded dispatcher cleanup', async () => {
    const { service, dependencies } = fixture({
      files: { [ownerPath]: owner(), [heartbeatPath]: heartbeat() },
      acknowledgeStop: false,
      useDefaultStopTimeout: true,
    });

    await expect(service.stop()).rejects.toMatchObject({ code: 'WAKE_STOP_TIMEOUT' });

    const waits = (dependencies.wait as ReturnType<typeof vi.fn>).mock.calls.map(
      ([milliseconds]) => milliseconds,
    );
    expect(waits.reduce((total, milliseconds) => total + milliseconds, 0)).toBe(30_000);
  });

  it('lets stop cancel an earlier start that is waiting for daemon readiness', async () => {
    const { service, files, spawnWake, dependencies } = fixture();
    let reportReady!: (status: LifecycleStatus) => void;
    const readiness = new Promise<LifecycleStatus>((resolve) => {
      reportReady = resolve;
    });
    (dependencies.daemonStatus as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      return await readiness;
    });

    const starting = service.start();
    await vi.waitFor(() => expect(dependencies.daemonStatus).toHaveBeenCalledTimes(1));

    await expect(service.stop()).resolves.toMatchObject({ state: 'stopped' });
    expect(spawnWake).not.toHaveBeenCalled();

    reportReady(daemonReady);
    await expect(starting).rejects.toMatchObject({ code: 'WAKE_START_CANCELLED' });
    expect(spawnWake).not.toHaveBeenCalled();
    expect(files.has(startIntentPath)).toBe(false);
    expect(JSON.parse(files.get(stopFencePath)!)).toMatchObject({
      schemaVersion: 1,
      completedAt: startedAt,
      cancelledStartToken: token,
    });
  });

  it('rejects delayed child admission after stop has cancelled its exact start token', async () => {
    const parent = fixture({ acknowledgeSpawn: false });
    let releaseParentPoll!: () => void;
    const parentPoll = new Promise<void>((resolve) => {
      releaseParentPoll = resolve;
    });
    const baseWait = (
      parent.dependencies.wait as ReturnType<typeof vi.fn>
    ).getMockImplementation()!;
    (parent.dependencies.wait as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (milliseconds: number) => {
        await parentPoll;
        await baseWait(milliseconds);
      },
    );

    const starting = parent.service.start();
    await vi.waitFor(() => expect(parent.spawnWake).toHaveBeenCalledTimes(1));
    await expect(parent.service.stop()).resolves.toMatchObject({ state: 'stopped' });

    const child = createWakeLifecycleService({
      installationRoot,
      homeDirectory,
      dependencies: {
        ...parent.dependencies,
        environment: {
          PATH: 'C:/bin',
          LUWI_WAKE_CONTROL_TOKEN: token,
          LUWI_WAKE_INSTANCE_ID: instanceId,
        },
        processId: 4242,
      },
      pathApi: posix,
      readinessTimeoutMs: 500,
      startTimeoutMs: 500,
      stopTimeoutMs: 500,
      pollIntervalMs: 50,
      heartbeatIntervalMs: 100,
      heartbeatStaleMs: 1_000,
    });

    await expect(child.beginManagedServe()).rejects.toMatchObject({
      code: 'WAKE_START_CANCELLED',
    });
    expect(parent.files.has(ownerPath)).toBe(false);
    expect(parent.files.has(heartbeatPath)).toBe(false);

    releaseParentPoll();
    await expect(starting).rejects.toMatchObject({ code: 'WAKE_START_CANCELLED' });
  });

  it('lets an in-progress stop cancel a concurrently requested start', async () => {
    const { service, files, spawnWake, dependencies } = fixture({
      files: { [ownerPath]: owner(), [heartbeatPath]: heartbeat() },
      acknowledgeStop: false,
    });
    let releaseStopWait!: () => void;
    const stopWait = new Promise<void>((resolve) => {
      releaseStopWait = resolve;
    });
    const baseWait = (dependencies.wait as ReturnType<typeof vi.fn>).getMockImplementation()!;
    (dependencies.wait as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (milliseconds: number) => {
        await stopWait;
        await baseWait(milliseconds);
      },
    );

    const stopping = service.stop();
    await vi.waitFor(() => expect(files.has(stopFencePath)).toBe(true));

    await expect(service.start()).rejects.toMatchObject({ code: 'WAKE_START_CANCELLED' });
    expect(spawnWake).not.toHaveBeenCalled();

    files.delete(ownerPath);
    files.delete(heartbeatPath);
    files.delete(stopRequestPath);
    releaseStopWait();
    await expect(stopping).resolves.toMatchObject({ state: 'stopped' });
    expect(spawnWake).not.toHaveBeenCalled();
  });

  it('recovers a stale start intent only after its process is proven dead', async () => {
    const staleIntent = startIntent();
    const { service, files, spawnWake, dependencies } = fixture({
      files: { [startIntentPath]: staleIntent },
      processState: 'dead',
    });

    await expect(service.start()).resolves.toMatchObject({ state: 'running', pid: 4242 });

    expect(dependencies.processState).toHaveBeenCalledWith(9999);
    expect(dependencies.fileSystem.tryReclaimLock).toHaveBeenCalledWith(
      startIntentPath,
      staleIntent,
    );
    expect(files.has(startIntentPath)).toBe(false);
    expect(spawnWake).toHaveBeenCalledTimes(1);
  });

  it('recovers an unfinished stale stop fence only after its process is proven dead', async () => {
    const staleFence = stopFence();
    const { service, files, spawnWake, dependencies } = fixture({
      files: { [stopFencePath]: staleFence },
      processState: 'dead',
    });

    await expect(service.start()).resolves.toMatchObject({ state: 'running', pid: 4242 });

    expect(dependencies.processState).toHaveBeenCalledWith(9999);
    expect(dependencies.fileSystem.tryReclaimLock).toHaveBeenCalledWith(stopFencePath, staleFence);
    expect(files.has(stopFencePath)).toBe(false);
    expect(spawnWake).toHaveBeenCalledTimes(1);
  });

  it('starts after a completed stop in the same millisecond using token ordering', async () => {
    const completedFence = stopFence({
      requestedAt: startedAt,
      completedAt: startedAt,
      cancelledStartToken: null,
    });
    const { service, files, spawnWake } = fixture({
      files: { [stopFencePath]: completedFence },
    });

    await expect(service.start()).resolves.toMatchObject({ state: 'running', pid: 4242 });

    expect(files.has(stopFencePath)).toBe(false);
    expect(spawnWake).toHaveBeenCalledTimes(1);
  });

  it('fails closed for malformed start and stop coordination records', async () => {
    const malformedFence = fixture({ files: { [stopFencePath]: '{}\n' } });
    await expect(malformedFence.service.start()).rejects.toMatchObject({
      code: 'WAKE_STOP_FENCE_INVALID',
    });
    expect(malformedFence.spawnWake).not.toHaveBeenCalled();

    const malformedIntent = fixture({ files: { [startIntentPath]: '{}\n' } });
    await expect(malformedIntent.service.stop()).rejects.toMatchObject({
      code: 'WAKE_START_INTENT_INVALID',
    });
    expect(malformedIntent.files.get(startIntentPath)).toBe('{}\n');
  });

  it('fails closed for coordination timestamps beyond the allowed clock-skew bound', async () => {
    const futureIntent = fixture({
      files: {
        [startIntentPath]: startIntent({ requestedAt: '2026-09-10T09:00:00.000Z' }),
      },
    });
    await expect(futureIntent.service.stop()).rejects.toMatchObject({
      code: 'WAKE_START_INTENT_INVALID',
    });

    const futureFence = fixture({
      files: {
        [stopFencePath]: stopFence({
          requestedAt: '2026-09-10T09:00:00.000Z',
          completedAt: '2026-09-10T09:00:01.000Z',
        }),
      },
    });
    await expect(futureFence.service.start()).rejects.toMatchObject({
      code: 'WAKE_STOP_FENCE_INVALID',
    });
  });

  it('serves only under its managed identity and honors only a matching stop request', async () => {
    const environment = {
      PATH: 'C:/bin',
      LUWI_WAKE_CONTROL_TOKEN: token,
      LUWI_WAKE_INSTANCE_ID: instanceId,
    };
    const { service, files, intervalCallbacks } = fixture({
      environment,
      processId: 4242,
      files: {
        [startIntentPath]: startIntent({
          token,
          instanceId,
          pid: 7000,
          requestedAt: startedAt,
        }),
      },
    });

    const lease = await service.beginManagedServe();
    expect(files.get(ownerPath)).toBe(owner());
    expect(files.get(heartbeatPath)).toBe(heartbeat());
    expect(files.has(startIntentPath)).toBe(false);

    let stopped = false;
    void lease.stopRequested.then(() => {
      stopped = true;
    });
    files.set(
      stopRequestPath,
      serialized({
        schemaVersion: 1,
        token: 'b4949b7f-3e92-4fd1-b98c-9945d115c1b2',
        instanceId,
        pid: 4242,
        requestedAt: startedAt,
      }),
    );
    intervalCallbacks[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);

    files.set(
      stopRequestPath,
      serialized({ schemaVersion: 1, token, instanceId, pid: 4242, requestedAt: startedAt }),
    );
    intervalCallbacks[0]!();
    await expect(lease.stopRequested).resolves.toBeUndefined();
    await lease.close();
    expect(files.has(ownerPath)).toBe(false);
    expect(files.has(heartbeatPath)).toBe(false);
    expect(files.has(stopRequestPath)).toBe(false);
  });
});
