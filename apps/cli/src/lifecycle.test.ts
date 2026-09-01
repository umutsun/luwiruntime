import { posix } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createLifecycleService,
  NodeLifecycleFileSystem,
  type LifecycleCommandResult,
  type LifecycleDependencies,
  type LifecycleFileSystem,
  type LifecycleHttpResponse,
} from './lifecycle.js';

const installationRoot = 'C:/workspace/luwiruntime';
const home = 'C:/workspace/luwiruntime/temp/luwi-home';
const runtimeDirectory = `${home}/runtime`;
const configPath = `${runtimeDirectory}/config.json`;
const ownerPath = `${runtimeDirectory}/daemon-owner.json`;
const lifecycleToken = '6ccfd2c0-e424-4a21-91db-30dc72092a01';
const runtimeInstanceId = 'f2e95fa4-f12d-4a42-92bb-fba0bb5f938b';

const runtime = {
  version: '0.1.0',
  protocolVersion: 1,
  runtimeState: 'ready',
  runtimeInstanceId,
  workspaceId: 'local',
  startedAt: '2026-08-24T12:00:00.000Z',
  uptimeMs: 100,
  host: '127.0.0.1',
  port: 4782,
  redis: { connected: true, status: 'connected', latencyMs: 1 },
  endpoints: { health: '/health', runtime: '/api/v1/runtime' },
};

function response(body: unknown, ok = true, status = 200): LifecycleHttpResponse {
  return { ok, status, json: async () => body };
}

function memoryFileSystem(initial: Record<string, string> = {}): {
  fileSystem: LifecycleFileSystem;
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  const directories = new Set([home, runtimeDirectory, installationRoot]);
  const locks = new Set<string>();
  return {
    files,
    fileSystem: {
      canonicalize: vi.fn(async (path) => path.replaceAll('\\', '/')),
      ensureDirectory: vi.fn(async (path) => {
        directories.add(path.replaceAll('\\', '/'));
      }),
      exists: vi.fn(async (path) => {
        const normalizedPath = path.replaceAll('\\', '/');
        return (
          files.has(normalizedPath) ||
          normalizedPath === `${installationRoot}/apps/daemon/dist/main.js` ||
          normalizedPath === `${installationRoot}/apps/daemon/dist/runtime-reset-main.js` ||
          normalizedPath === `${installationRoot}/compose.yaml`
        );
      }),
      readText: vi.fn(async (path) => files.get(path.replaceAll('\\', '/'))),
      writeAtomic: vi.fn(async (path, content) => {
        files.set(path.replaceAll('\\', '/'), content);
      }),
      removeFile: vi.fn(async (path) => {
        files.delete(path.replaceAll('\\', '/'));
      }),
      tryAcquireLock: vi.fn(async (path) => {
        const normalizedPath = path.replaceAll('\\', '/');
        if (locks.has(normalizedPath)) return undefined;
        locks.add(normalizedPath);
        return async () => {
          locks.delete(normalizedPath);
        };
      }),
    },
  };
}

function commandResult(overrides: Partial<LifecycleCommandResult> = {}): LifecycleCommandResult {
  return { exitCode: 0, stdout: '', stderr: '', ...overrides };
}

function fixture(
  options: {
    files?: Record<string, string>;
    fetch?: LifecycleDependencies['fetch'];
    portOpen?: boolean;
    redisPortOpen?: boolean;
    composeRunning?: boolean;
    confirm?: boolean;
    dockerAvailable?: boolean;
  } = {},
) {
  const { fileSystem, files } = memoryFileSystem(options.files);
  let composeRunning = options.composeRunning ?? false;
  const runCommand = vi.fn(
    async (_executable: string, args: readonly string[]): Promise<LifecycleCommandResult> => {
      if (
        args.includes('runtime-reset-main.js') ||
        args.some((arg) => arg.endsWith('runtime-reset-main.js'))
      ) {
        return args.includes('--inspect')
          ? commandResult({ stdout: '{"namespace":"luwi:v1:","matched":12}\n' })
          : commandResult({
              stdout: '{"namespace":"luwi:v1:","matched":12,"deleted":12,"status":"reset"}\n',
            });
      }
      if (args.includes('version'))
        return commandResult({ stdout: 'Docker Compose version v2.30' });
      if (args.includes('ps')) {
        return commandResult({ stdout: composeRunning ? 'redis\n' : '' });
      }
      if (args.includes('up')) composeRunning = true;
      if (args.includes('stop')) composeRunning = false;
      return commandResult();
    },
  );
  const fetch =
    options.fetch ??
    vi.fn(async () => {
      throw new Error('connection refused');
    });
  let clock = 0;
  let uuidCalls = 0;
  const dependencies: LifecycleDependencies = {
    fileSystem,
    environment: { PATH: 'C:/bin' },
    platform: 'win32',
    nodeVersion: '22.18.0',
    nodeExecutable: 'C:/bin/node.exe',
    clock: () => clock,
    now: () => new Date('2026-08-24T12:00:00.000Z'),
    randomUUID: () => (uuidCalls++ % 2 === 0 ? lifecycleToken : runtimeInstanceId),
    confirm: vi.fn(async () => options.confirm ?? true),
    resolveExecutable: vi.fn(async (name) =>
      name === 'docker' && options.dockerAvailable === false ? undefined : `C:/bin/${name}.exe`,
    ),
    runCommand,
    spawnDaemon: vi.fn(async () => ({
      pid: 4242,
      terminate: vi.fn(async () => undefined),
    })),
    fetch,
    probePort: vi.fn(async (_host, port) =>
      port === 6379 ? (options.redisPortOpen ?? false) : (options.portOpen ?? false),
    ),
    wait: vi.fn(async (milliseconds) => {
      clock += milliseconds;
    }),
  };
  const service = createLifecycleService({
    installationRoot,
    homeDirectory: home,
    dependencies,
    pathApi: posix,
  });
  return { service, dependencies, files, runCommand };
}

describe('CLI lifecycle', () => {
  it('previews and applies the fixed runtime reset only while the daemon is stopped', async () => {
    const { service, dependencies, runCommand } = fixture({ confirm: true });
    await service.setup({ approved: true });

    await expect(
      service.resetRuntimeState({ approved: false, interactive: true }),
    ).resolves.toEqual({
      namespace: 'luwi:v1:',
      matched: 12,
      deleted: 12,
      status: 'reset',
    });
    expect(dependencies.confirm).toHaveBeenCalledWith(expect.stringContaining('luwi:v1:'));
    expect(runCommand).toHaveBeenCalledWith(
      expect.stringMatching(/node/i),
      expect.arrayContaining(['--inspect', '--redis-url', 'redis://127.0.0.1:6379']),
      expect.objectContaining({ cwd: installationRoot }),
    );
    expect(runCommand).toHaveBeenCalledWith(
      expect.stringMatching(/node/i),
      expect.arrayContaining(['--apply', '--redis-url', 'redis://127.0.0.1:6379']),
      expect.objectContaining({ cwd: installationRoot }),
    );
  });

  it('atomically creates and replaces a bounded Node lifecycle file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luwi-lifecycle-files-'));
    try {
      const fileSystem = new NodeLifecycleFileSystem();
      const path = join(directory, 'owner.json');

      await fileSystem.writeAtomic(path, '{"version":1}\n');
      await fileSystem.writeAtomic(path, '{"version":2}\n');

      const release = await fileSystem.tryAcquireLock(join(directory, 'lifecycle.lock'));
      expect(release).toBeTypeOf('function');
      expect(await fileSystem.tryAcquireLock(join(directory, 'lifecycle.lock'))).toBeUndefined();
      await release?.();
      const reacquired = await fileSystem.tryAcquireLock(join(directory, 'lifecycle.lock'));
      expect(reacquired).toBeTypeOf('function');
      await reacquired?.();

      expect(await readFile(path, 'utf8')).toBe('{"version":2}\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('writes only the approved LUWI-owned configuration and is idempotent', async () => {
    const { service, dependencies, files } = fixture();

    const first = await service.setup({ printHooks: true });
    const second = await service.setup({ approved: true });

    expect(first).toMatchObject({ changed: true, target: configPath });
    expect(first.hooks.join('\n')).toContain('luwi agent run');
    expect(second).toMatchObject({ changed: false, target: configPath });
    expect(dependencies.confirm).toHaveBeenCalledWith(expect.stringContaining(configPath));
    expect(dependencies.fileSystem.writeAtomic).toHaveBeenCalledTimes(1);
    expect([...files.keys()]).toEqual([configPath]);
    expect(JSON.parse(files.get(configPath)!)).toMatchObject({
      schemaVersion: 1,
      daemonUrl: 'http://127.0.0.1:4782',
      redisUrl: 'redis://127.0.0.1:6379',
      installationRoot,
      composeFile: `${installationRoot}/compose.yaml`,
      daemonEntry: `${installationRoot}/apps/daemon/dist/main.js`,
    });
  });

  it('does not write setup state when approval is denied', async () => {
    const { service, dependencies } = fixture({ confirm: false });

    await expect(service.setup({})).rejects.toMatchObject({ code: 'SETUP_CANCELLED' });

    expect(dependencies.fileSystem.writeAtomic).not.toHaveBeenCalled();
  });

  it('rejects corrupt or non-loopback lifecycle configuration as untrusted input', async () => {
    const invalid = JSON.stringify({
      schemaVersion: 1,
      daemonUrl: 'http://example.com:4782',
      redisUrl: 'redis://127.0.0.1:6379',
      installationRoot,
      composeFile: `${installationRoot}/compose.yaml`,
      daemonEntry: `${installationRoot}/apps/daemon/dist/main.js`,
    });
    const { service } = fixture({ files: { [configPath]: invalid } });

    await expect(service.status()).rejects.toMatchObject({ code: 'LIFECYCLE_CONFIG_INVALID' });
  });

  it('starts Compose Redis and writes ownership only after the daemon is healthy', async () => {
    let runtimeReads = 0;
    const { service, dependencies, files, runCommand } = fixture({
      fetch: vi.fn(async (url) => {
        if (!url.endsWith('/api/v1/runtime')) throw new Error('unexpected URL');
        runtimeReads += 1;
        if (runtimeReads === 1) throw new Error('not started');
        return response(runtime);
      }),
    });

    const result = await service.start();

    expect(result.daemon).toMatchObject({ state: 'ready', managed: true, pid: 4242 });
    expect(runCommand).toHaveBeenCalledWith(
      'C:/bin/docker.exe',
      ['compose', '-f', `${installationRoot}/compose.yaml`, 'up', '-d', '--wait', 'redis'],
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
    expect(dependencies.spawnDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonEntry: `${installationRoot}/apps/daemon/dist/main.js`,
        environment: expect.objectContaining({
          HOST: '127.0.0.1',
          PORT: '4782',
          REDIS_URL: 'redis://127.0.0.1:6379',
          LUWI_HOME: home,
          LUWI_LIFECYCLE_TOKEN: lifecycleToken,
          LUWI_RUNTIME_INSTANCE_ID: runtimeInstanceId,
        }),
      }),
    );
    expect(JSON.parse(files.get(ownerPath)!)).toMatchObject({
      token: lifecycleToken,
      runtimeInstanceId,
      pid: 4242,
    });
  });

  it('treats an already compatible daemon as success without adopting or starting resources', async () => {
    const { service, dependencies, runCommand } = fixture({
      fetch: vi.fn(async () => response(runtime)),
    });

    const result = await service.start();

    expect(result.daemon).toMatchObject({ state: 'ready', managed: false });
    expect(runCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['up']),
      expect.anything(),
    );
    expect(dependencies.spawnDaemon).not.toHaveBeenCalled();
  });

  it('serializes concurrent starts and spawns the daemon only once', async () => {
    let runtimeReads = 0;
    const shared = fixture({
      dockerAvailable: false,
      redisPortOpen: true,
      fetch: vi.fn(async () => {
        runtimeReads += 1;
        if (runtimeReads <= 2) throw new Error('daemon not started');
        return response(runtime);
      }),
    });
    const second = createLifecycleService({
      installationRoot,
      homeDirectory: home,
      dependencies: shared.dependencies,
      pathApi: posix,
    });

    const [firstResult, secondResult] = await Promise.all([shared.service.start(), second.start()]);

    expect(firstResult.daemon).toMatchObject({ state: 'ready', managed: true });
    expect(secondResult.daemon).toMatchObject({ state: 'ready', managed: true });
    expect(shared.dependencies.spawnDaemon).toHaveBeenCalledTimes(1);
  });

  it('refuses to claim a ready runtime whose startup identity does not match', async () => {
    let runtimeReads = 0;
    const foreignRuntime = {
      ...runtime,
      runtimeInstanceId: 'f82adf54-8d47-4b7d-b60b-26049e6f4893',
    };
    const { service, dependencies, files } = fixture({
      dockerAvailable: false,
      redisPortOpen: true,
      fetch: vi.fn(async () => {
        runtimeReads += 1;
        if (runtimeReads === 1) throw new Error('daemon not started');
        return response(foreignRuntime);
      }),
    });

    await expect(service.start()).rejects.toMatchObject({ code: 'DAEMON_START_RACE' });

    const handle = await vi.mocked(dependencies.spawnDaemon).mock.results[0]!.value;
    expect(handle.terminate).toHaveBeenCalledTimes(1);
    expect(files.has(ownerPath)).toBe(false);
  });

  it('uses an existing default-port Redis listener without claiming Compose ownership', async () => {
    let runtimeReads = 0;
    const { service, dependencies, runCommand } = fixture({
      dockerAvailable: false,
      redisPortOpen: true,
      fetch: vi.fn(async () => {
        runtimeReads += 1;
        if (runtimeReads === 1) throw new Error('daemon not started');
        return response(runtime);
      }),
    });

    await expect(service.start()).resolves.toMatchObject({
      daemon: { state: 'ready', managed: true },
    });

    expect(dependencies.spawnDaemon).toHaveBeenCalledTimes(1);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('allows a bounded slow first graph rebuild to finish before timing out startup', async () => {
    let runtimeReads = 0;
    const { service } = fixture({
      dockerAvailable: false,
      redisPortOpen: true,
      fetch: vi.fn(async () => {
        runtimeReads += 1;
        if (runtimeReads <= 310) throw new Error('daemon still rebuilding projections');
        return response(runtime);
      }),
    });

    await expect(service.start()).resolves.toMatchObject({
      daemon: { state: 'ready', managed: true },
    });
  });

  it('refuses an occupied daemon port that does not speak the LUWI protocol', async () => {
    const { service, dependencies } = fixture({ portOpen: true });

    await expect(service.start()).rejects.toMatchObject({ code: 'DAEMON_PORT_CONFLICT' });

    expect(dependencies.spawnDaemon).not.toHaveBeenCalled();
  });

  it('rolls back only resources started by the failed start invocation', async () => {
    const { service, dependencies, runCommand } = fixture();

    await expect(service.start({ readinessTimeoutMs: 1 })).rejects.toMatchObject({
      code: 'DAEMON_START_TIMEOUT',
    });

    const handle = await vi.mocked(dependencies.spawnDaemon).mock.results[0]!.value;
    expect(handle.terminate).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(
      'C:/bin/docker.exe',
      ['compose', '-f', `${installationRoot}/compose.yaml`, 'stop', 'redis'],
      expect.anything(),
    );
  });

  it('stops only the matching owned runtime and preserves Redis by default', async () => {
    const owner = JSON.stringify({
      schemaVersion: 1,
      token: lifecycleToken,
      pid: 4242,
      runtimeInstanceId,
      daemonUrl: 'http://127.0.0.1:4782',
      installationRoot,
      startedAt: '2026-08-24T12:00:00.000Z',
    });
    let running = true;
    const fetch = vi.fn(async (url: string, init) => {
      if (url.endsWith('/stop')) {
        expect(init?.headers).toMatchObject({
          'x-luwi-lifecycle-token': lifecycleToken,
        });
        running = false;
        return response({ status: 'stopping' }, true, 202);
      }
      if (!running) throw new Error('closed');
      return response(runtime);
    });
    const { service, files, runCommand } = fixture({
      files: { [ownerPath]: owner },
      fetch,
      composeRunning: true,
    });

    const result = await service.stop();

    expect(result.daemon).toMatchObject({ state: 'stopped', managed: false });
    expect(files.has(ownerPath)).toBe(false);
    expect(runCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['stop']),
      expect.anything(),
    );
  });

  it('stops Compose Redis without deleting its volume only when explicitly requested', async () => {
    const { service, runCommand } = fixture({ composeRunning: true });

    await service.stop({ withRedis: true });

    expect(runCommand).toHaveBeenCalledWith(
      'C:/bin/docker.exe',
      ['compose', '-f', `${installationRoot}/compose.yaml`, 'stop', 'redis'],
      expect.anything(),
    );
    expect(runCommand.mock.calls.flatMap((call) => call[1])).not.toContain('down');
  });

  it('reports corrupt ownership and refuses to stop from it', async () => {
    const { service } = fixture({ files: { [ownerPath]: '{"pid":42}' } });

    await expect(service.status()).resolves.toMatchObject({
      daemon: { state: 'stopped', managed: false, ownership: 'invalid' },
    });
    await expect(service.stop()).rejects.toMatchObject({ code: 'DAEMON_OWNERSHIP_INVALID' });
  });

  it('reports readiness without opening a Redis protocol connection', async () => {
    const { service } = fixture({
      fetch: vi.fn(async () => response(runtime)),
      composeRunning: true,
    });

    const report = await service.doctor();

    expect(report.ready).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'node', status: 'ok' }),
        expect.objectContaining({ id: 'docker-compose', status: 'ok' }),
        expect.objectContaining({ id: 'redis-functions', status: 'ok' }),
        expect.objectContaining({ id: 'agent-claude', status: 'ok' }),
        expect.objectContaining({ id: 'agent-codex', status: 'ok' }),
        expect.objectContaining({ id: 'agent-gemini', status: 'ok' }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain('6ccfd2c0');
  });

  it('accepts an existing loopback Redis listener when Docker is unavailable', async () => {
    const { service } = fixture({ dockerAvailable: false, redisPortOpen: true });

    const report = await service.doctor();

    expect(report.ready).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'docker-compose', status: 'warning' }),
        expect.objectContaining({ id: 'redis-listener', status: 'ok' }),
      ]),
    );
  });
});
