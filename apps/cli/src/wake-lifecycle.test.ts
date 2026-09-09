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

function memoryFileSystem(initial: Record<string, string> = {}): {
  fileSystem: LifecycleFileSystem;
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  const locks = new Set<string>();
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
      tryAcquireLock: vi.fn(async (path) => {
        const normalized = path.replaceAll('\\', '/');
        if (locks.has(normalized)) return undefined;
        locks.add(normalized);
        return async () => {
          locks.delete(normalized);
        };
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
    processId?: number;
  } = {},
) {
  const memory = memoryFileSystem(options.files);
  let nowMs = Date.parse(startedAt);
  let uuidIndex = 0;
  let daemonIndex = 0;
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
      if (memory.files.has(stopRequestPath)) {
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
    stopTimeoutMs: 500,
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
    const { service, spawnWake, dependencies } = fixture({ daemonStates: [degraded, daemonReady] });

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

  it('serves only under its managed identity and honors only a matching stop request', async () => {
    const environment = {
      PATH: 'C:/bin',
      LUWI_WAKE_CONTROL_TOKEN: token,
      LUWI_WAKE_INSTANCE_ID: instanceId,
    };
    const { service, files, intervalCallbacks } = fixture({ environment, processId: 4242 });

    const lease = await service.beginManagedServe();
    expect(files.get(ownerPath)).toBe(owner());
    expect(files.get(heartbeatPath)).toBe(heartbeat());

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
