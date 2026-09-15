import {
  PathExecutableResolver,
  SpawnCommandRunner,
  type AdapterCommandResult,
} from '@luwi/adapters';
import {
  lifecycleStopResponseSchema,
  runtimeInfoResponseSchema,
  type RuntimeInfoResponse,
} from '@luwi/protocol';
import { ApplicationError } from '@luwi/runtime';

import { createAutostart, type AutostartState } from './autostart.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_MAX_BYTES = 64 * 1024;
const OWNER_MAX_BYTES = 16 * 1024;
/**
 * The daemon appends pino to `daemon.log` with no rotation, and Fastify logs
 * every request at info, so a busy fleet grows it without bound (measured near
 * 1 GB). Rotating at start keeps the footprint to about twice this across
 * restarts without losing recent history.
 *
 * ponytail: startup rotation, one backup — the minimal size-cap. The real volume
 * driver is per-request logging; disabling it (Fastify `disableRequestLogging`)
 * is the upgrade path if a single run's growth ever matters.
 */
const DEFAULT_LOG_MAX_BYTES = 128 * 1024 * 1024;
const LOG_MAX_BYTES_ENV = 'LUWI_LOG_MAX_BYTES';

function logMaxBytes(environment: Readonly<Record<string, string | undefined>>): number {
  const raw = environment[LOG_MAX_BYTES_ENV];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LOG_MAX_BYTES;
}

/**
 * Rotates `daemon.log` to `daemon.log.1` when it exceeds `maxBytes`, replacing
 * any previous backup. Best-effort by construction: a missing log (nothing to
 * rotate) or a failed rename must never keep the daemon from starting.
 */
export async function rotateLogIfOversized(logFile: string, maxBytes: number): Promise<void> {
  let size: number;
  try {
    size = (await stat(logFile)).size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;
  try {
    await rename(logFile, `${logFile}.1`);
  } catch {
    // A busy or locked log stays; the next start retries.
  }
}
const REQUEST_TIMEOUT_MS = 2_000;
// A first start may rebuild the bounded operational graph before readiness.
// Ten local projects can legitimately exceed 30 seconds on Windows, while the
// graph rebuild itself remains bounded and separately guarded by a Redis lock.
const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 10_000;
const RESET_TIMEOUT_MS = 30_000;
const COMPOSE_TIMEOUT_MS = 60_000;
const LIFECYCLE_LOCK_TIMEOUT_MS = 5_000;
const LIFECYCLE_LOCK_RETRY_MS = 50;
const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';
const DEFAULT_COMPOSE_REDIS_URL = DEFAULT_REDIS_URL;

export type LifecycleHttpResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type LifecycleHttpInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

export type LifecycleCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  failure?: AdapterCommandResult['failure'];
};

export type LifecycleCommandOptions = {
  cwd: string;
  timeoutMs: number;
};

export interface LifecycleFileSystem {
  canonicalize(path: string): Promise<string>;
  ensureDirectory(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readText(path: string, maxBytes: number): Promise<string | undefined>;
  writeAtomic(path: string, content: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  tryAcquireLock(path: string): Promise<(() => Promise<void>) | undefined>;
}

export type SpawnedDaemon = {
  pid: number;
  terminate: () => Promise<void>;
};

export type SpawnDaemonInput = {
  daemonEntry: string;
  workingDirectory: string;
  logFile: string;
  environment: Readonly<Record<string, string | undefined>>;
};

export type LifecycleDependencies = {
  fileSystem: LifecycleFileSystem;
  environment: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  nodeVersion: string;
  nodeExecutable: string;
  clock: () => number;
  now: () => Date;
  randomUUID: () => string;
  confirm: (prompt: string) => Promise<boolean>;
  resolveExecutable: (name: string) => Promise<string | undefined>;
  runCommand: (
    executable: string,
    args: readonly string[],
    options: LifecycleCommandOptions,
  ) => Promise<LifecycleCommandResult>;
  spawnDaemon: (input: SpawnDaemonInput) => Promise<SpawnedDaemon>;
  fetch: (url: string, init?: LifecycleHttpInit) => Promise<LifecycleHttpResponse>;
  probePort: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  wait: (milliseconds: number) => Promise<void>;
};

type PathApi = Pick<
  typeof nodePath,
  'dirname' | 'isAbsolute' | 'join' | 'normalize' | 'relative' | 'resolve'
>;

type LifecycleConfig = {
  schemaVersion: 1;
  daemonUrl: string;
  redisUrl: string;
  installationRoot: string;
  composeFile: string;
  daemonEntry: string;
};

type DaemonOwner = {
  schemaVersion: 1;
  token: string;
  pid: number;
  runtimeInstanceId: string;
  daemonUrl: string;
  installationRoot: string;
  startedAt: string;
};

export type DoctorCheck = {
  id: string;
  status: 'ok' | 'warning' | 'error';
  summary: string;
  hint?: string;
};

export type DoctorReport = {
  ready: boolean;
  checks: DoctorCheck[];
  endpoints: {
    daemon: string;
    redis: string;
  };
  roots: {
    luwiHome: string;
    claude: string;
    codex: string;
    gemini: string;
  };
};

export type LifecycleStatus = {
  daemon: {
    state: 'ready' | 'degraded' | 'stopped' | 'foreign';
    managed: boolean;
    ownership: 'owned' | 'unmanaged' | 'stale' | 'invalid' | 'none';
    pid?: number;
    runtimeInstanceId?: string;
  };
  redis: {
    state: 'connected' | 'disconnected' | 'unknown';
    compose: 'running' | 'stopped' | 'unavailable' | 'external';
  };
  endpoints: {
    daemon: string;
    redis: string;
  };
};

export type SetupResult = {
  changed: boolean;
  target: string;
  hooks: string[];
  autostart: AutostartState;
};

export type RuntimeResetResult = {
  namespace: 'luwi:v1:';
  matched: number;
  deleted: number;
  status: 'confirmation_required' | 'cancelled' | 'reset' | 'empty';
};

export interface LifecycleService {
  doctor(): Promise<DoctorReport>;
  setup(options: {
    approved?: boolean;
    printHooks?: boolean;
    autostart?: boolean;
    noAutostart?: boolean;
  }): Promise<SetupResult>;
  start(options?: { readinessTimeoutMs?: number }): Promise<LifecycleStatus>;
  status(): Promise<LifecycleStatus>;
  stop(options?: { withRedis?: boolean }): Promise<LifecycleStatus>;
  resetRuntimeState(options: {
    approved: boolean;
    interactive: boolean;
  }): Promise<RuntimeResetResult>;
}

export type LifecycleServiceOptions = {
  installationRoot: string;
  homeDirectory?: string;
  dependencies?: LifecycleDependencies;
  pathApi?: PathApi;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 0x1f || point === 0x7f);
  });
}

function boundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !hasControlCharacter(value)
  );
}

function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
  pathApi: PathApi,
): boolean {
  const normalizedLeft = pathApi.normalize(left);
  const normalizedRight = pathApi.normalize(right);
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isWithin(root: string, target: string, pathApi: PathApi): boolean {
  const child = pathApi.relative(root, target);
  return child === '' || (!child.startsWith('..') && !pathApi.isAbsolute(child));
}

function parseLoopbackUrl(value: string, protocols: readonly string[], label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApplicationError('LIFECYCLE_CONFIG_INVALID', `${label} is invalid.`, 400);
  }
  const loopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '[::1]';
  if (
    !protocols.includes(parsed.protocol) ||
    !loopback ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new ApplicationError(
      'LIFECYCLE_CONFIG_INVALID',
      `${label} must be a credential-free loopback URL.`,
      400,
    );
  }
  return parsed;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseRuntimeResetOutput(
  output: string,
  mode: 'inspect' | 'apply',
): { namespace: 'luwi:v1:'; matched: number; deleted?: number; status?: 'reset' | 'empty' } {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw commandFailure('RUNTIME_RESET_OUTPUT_INVALID', 'Runtime reset returned invalid output.');
  }
  if (
    !isRecord(value) ||
    value['namespace'] !== 'luwi:v1:' ||
    !nonNegativeSafeInteger(value['matched'])
  ) {
    throw commandFailure('RUNTIME_RESET_OUTPUT_INVALID', 'Runtime reset returned invalid output.');
  }
  if (mode === 'inspect' && exactKeys(value, ['matched', 'namespace'])) {
    return { namespace: 'luwi:v1:', matched: value['matched'] };
  }
  if (
    mode === 'apply' &&
    exactKeys(value, ['deleted', 'matched', 'namespace', 'status']) &&
    nonNegativeSafeInteger(value['deleted']) &&
    (value['status'] === 'reset' || value['status'] === 'empty')
  ) {
    return {
      namespace: 'luwi:v1:',
      matched: value['matched'],
      deleted: value['deleted'],
      status: value['status'],
    };
  }
  throw commandFailure('RUNTIME_RESET_OUTPUT_INVALID', 'Runtime reset returned invalid output.');
}

function parseJson(text: string, code: string, message: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApplicationError(code, message, 500);
  }
}

function assertConfig(
  value: unknown,
  expectedRoot: string,
  platform: NodeJS.Platform,
  pathApi: PathApi,
): LifecycleConfig {
  const keys = [
    'composeFile',
    'daemonEntry',
    'daemonUrl',
    'installationRoot',
    'redisUrl',
    'schemaVersion',
  ];
  if (
    !isRecord(value) ||
    !exactKeys(value, keys) ||
    value['schemaVersion'] !== 1 ||
    !boundedString(value['daemonUrl'], 2_048) ||
    !boundedString(value['redisUrl'], 2_048) ||
    !boundedString(value['installationRoot'], 32_767) ||
    !boundedString(value['composeFile'], 32_767) ||
    !boundedString(value['daemonEntry'], 32_767)
  ) {
    throw new ApplicationError(
      'LIFECYCLE_CONFIG_INVALID',
      'The LUWI lifecycle configuration is invalid.',
      500,
    );
  }
  parseLoopbackUrl(value['daemonUrl'], ['http:'], 'The daemon URL');
  parseLoopbackUrl(value['redisUrl'], ['redis:', 'rediss:'], 'The Redis URL');
  const composeFile = pathApi.join(expectedRoot, 'compose.yaml');
  const daemonEntry = pathApi.join(expectedRoot, 'apps', 'daemon', 'dist', 'main.js');
  if (
    !samePath(value['installationRoot'], expectedRoot, platform, pathApi) ||
    !samePath(value['composeFile'], composeFile, platform, pathApi) ||
    !samePath(value['daemonEntry'], daemonEntry, platform, pathApi) ||
    !isWithin(expectedRoot, value['composeFile'], pathApi) ||
    !isWithin(expectedRoot, value['daemonEntry'], pathApi)
  ) {
    throw new ApplicationError(
      'LIFECYCLE_CONFIG_INVALID',
      'The LUWI lifecycle configuration points outside this installation.',
      500,
    );
  }
  return {
    schemaVersion: 1,
    daemonUrl: value['daemonUrl'],
    redisUrl: value['redisUrl'],
    installationRoot: expectedRoot,
    composeFile,
    daemonEntry,
  };
}

function assertOwner(value: unknown): DaemonOwner {
  const keys = [
    'daemonUrl',
    'installationRoot',
    'pid',
    'runtimeInstanceId',
    'schemaVersion',
    'startedAt',
    'token',
  ];
  if (
    !isRecord(value) ||
    !exactKeys(value, keys) ||
    value['schemaVersion'] !== 1 ||
    !boundedString(value['token'], 128) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value['token'],
    ) ||
    typeof value['pid'] !== 'number' ||
    !Number.isSafeInteger(value['pid']) ||
    value['pid'] <= 0 ||
    !boundedString(value['runtimeInstanceId'], 128) ||
    !boundedString(value['daemonUrl'], 2_048) ||
    !boundedString(value['installationRoot'], 32_767) ||
    !boundedString(value['startedAt'], 64) ||
    Number.isNaN(Date.parse(value['startedAt']))
  ) {
    throw new ApplicationError(
      'DAEMON_OWNERSHIP_INVALID',
      'The daemon ownership record is invalid.',
      500,
    );
  }
  return value as DaemonOwner;
}

export class NodeLifecycleFileSystem implements LifecycleFileSystem {
  async canonicalize(path: string): Promise<string> {
    return await realpath(path);
  }

  async ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async readText(path: string, maxBytes: number): Promise<string | undefined> {
    let file;
    try {
      file = await open(path, 'r');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > maxBytes) {
        throw new ApplicationError(
          'LIFECYCLE_FILE_INVALID',
          'A LUWI lifecycle file is invalid or exceeds its size bound.',
          500,
        );
      }
      return await readFile(file, 'utf8');
    } finally {
      await file.close();
    }
  }

  async writeAtomic(path: string, content: string): Promise<void> {
    const temporary = `${path}.tmp-${randomUUID()}`;
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(content, 'utf8');
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporary, path);
    } finally {
      await file?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async removeFile(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  async tryAcquireLock(path: string): Promise<(() => Promise<void>) | undefined> {
    let lock;
    try {
      lock = await open(path, 'wx', 0o600);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        // ponytail: a crashed lifecycle op leaves this lock forever (no TTL). If the pid
        // that wrote it is gone, reclaim it once and retry; a live owner — or an
        // unreadable in-progress write — stays blocked, so a real lock is never stolen.
        if (!(await this.reclaimStaleLock(path))) return undefined;
        try {
          lock = await open(path, 'wx', 0o600);
        } catch {
          return undefined;
        }
      } else {
        throw error;
      }
    }
    try {
      await lock.writeFile(
        `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        'utf8',
      );
      await lock.sync();
    } catch (error) {
      await lock.close().catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await lock.close();
      await rm(path, { force: true });
    };
  }

  async reclaimStaleLock(path: string): Promise<boolean> {
    let pid: number;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as { pid?: unknown }).pid !== 'number'
      ) {
        return false;
      }
      pid = (parsed as { pid: number }).pid;
    } catch {
      // Missing or half-written by an in-progress acquire — never steal it.
      return false;
    }
    try {
      process.kill(pid, 0);
      return false; // the recorded owner is alive; a real lifecycle op holds the lock.
    } catch (error) {
      // EPERM: the process exists under another owner (alive). ESRCH (or other): it is
      // gone, so the lock is stale and safe to reclaim.
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') return false;
    }
    await rm(path, { force: true }).catch(() => undefined);
    return true;
  }
}

async function probeTcpPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const { createConnection } = await import('node:net');
  return await new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (open: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(open);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function spawnDetachedDaemon(input: SpawnDaemonInput): Promise<SpawnedDaemon> {
  await rotateLogIfOversized(input.logFile, logMaxBytes(input.environment));
  const log = await open(input.logFile, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [input.daemonEntry], {
      cwd: input.workingDirectory,
      env: input.environment as NodeJS.ProcessEnv,
      detached: true,
      shell: false,
      stdio: ['ignore', log.fd, log.fd],
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child!.once('spawn', resolve);
      child!.once('error', reject);
    });
    if (child.pid === undefined) throw new Error('The daemon process did not report a PID.');
    const pid = child.pid;
    child.unref();
    return {
      pid,
      terminate: async () => {
        try {
          child!.kill('SIGTERM');
        } catch {
          // The exact child handle may already have exited.
        }
      },
    };
  } finally {
    await log.close();
  }
}

function defaultDependencies(): LifecycleDependencies {
  const environment = process.env;
  const platform = process.platform;
  const resolver = new PathExecutableResolver(environment['PATH'] ?? '', platform);
  return {
    fileSystem: new NodeLifecycleFileSystem(),
    environment,
    platform,
    nodeVersion: process.versions.node,
    nodeExecutable: process.execPath,
    clock: Date.now,
    now: () => new Date(),
    randomUUID,
    confirm: async () => false,
    resolveExecutable: (name) => resolver.resolve(name),
    runCommand: async (executable, args, options) => {
      const result = await new SpawnCommandRunner({
        timeoutMs: options.timeoutMs,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
      }).run(executable, args);
      return result;
    },
    spawnDaemon: spawnDetachedDaemon,
    fetch: (url, init) => fetch(url, init as RequestInit),
    probePort: probeTcpPort,
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

function commandFailure(code: string, message: string): ApplicationError {
  return new ApplicationError(code, message, 503);
}

export function createLifecycleService(options: LifecycleServiceOptions): LifecycleService {
  const dependencies = options.dependencies ?? defaultDependencies();
  const pathApi = options.pathApi ?? nodePath;
  const absolutePath = (value: string): string => {
    const absolute =
      dependencies.platform === 'win32'
        ? nodePath.win32.isAbsolute(value)
        : pathApi.isAbsolute(value);
    return absolute ? pathApi.normalize(value) : pathApi.resolve(value);
  };
  const configuredHome =
    options.homeDirectory ??
    dependencies.environment['LUWI_HOME'] ??
    pathApi.join(homedir(), '.luwi');
  const installationRoot = absolutePath(options.installationRoot);
  const homeDirectory = absolutePath(configuredHome);
  const runtimeDirectory = pathApi.join(homeDirectory, 'runtime');
  const configPath = pathApi.join(runtimeDirectory, 'config.json');
  const ownerPath = pathApi.join(runtimeDirectory, 'daemon-owner.json');
  const lifecycleLockPath = pathApi.join(runtimeDirectory, 'lifecycle.lock');
  const logFile = pathApi.join(runtimeDirectory, 'daemon.log');

  const withLifecycleLock = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const deadline = dependencies.clock() + LIFECYCLE_LOCK_TIMEOUT_MS;
    do {
      const release = await dependencies.fileSystem.tryAcquireLock(lifecycleLockPath);
      if (release !== undefined) {
        try {
          return await operation();
        } finally {
          await release();
        }
      }
      const waitMs = Math.min(
        LIFECYCLE_LOCK_RETRY_MS,
        Math.max(0, deadline - dependencies.clock()),
      );
      if (waitMs > 0) await dependencies.wait(waitMs);
    } while (dependencies.clock() < deadline);
    throw new ApplicationError(
      'LIFECYCLE_BUSY',
      'Another LUWI lifecycle operation is active or left a stale lifecycle lock.',
      409,
    );
  };

  const proposedConfig = (): LifecycleConfig => {
    const rawPort = dependencies.environment['PORT'] ?? '4782';
    const port = Number(rawPort);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new ApplicationError('LIFECYCLE_CONFIG_INVALID', 'PORT is invalid.', 400);
    }
    const daemonUrl = `http://127.0.0.1:${String(port)}`;
    const redisUrl = dependencies.environment['REDIS_URL'] ?? DEFAULT_REDIS_URL;
    return assertConfig(
      {
        schemaVersion: 1,
        daemonUrl,
        redisUrl,
        installationRoot,
        composeFile: pathApi.join(installationRoot, 'compose.yaml'),
        daemonEntry: pathApi.join(installationRoot, 'apps', 'daemon', 'dist', 'main.js'),
      },
      installationRoot,
      dependencies.platform,
      pathApi,
    );
  };

  const prepareHome = async (): Promise<void> => {
    await dependencies.fileSystem.ensureDirectory(homeDirectory);
    const canonicalHome = await dependencies.fileSystem.canonicalize(homeDirectory);
    if (!samePath(canonicalHome, homeDirectory, dependencies.platform, pathApi)) {
      throw new ApplicationError(
        'LIFECYCLE_HOME_INVALID',
        'LUWI_HOME must resolve to the configured canonical directory.',
        400,
      );
    }
    await dependencies.fileSystem.ensureDirectory(runtimeDirectory);
    const canonicalRuntime = await dependencies.fileSystem.canonicalize(runtimeDirectory);
    if (!isWithin(canonicalHome, canonicalRuntime, pathApi)) {
      throw new ApplicationError(
        'LIFECYCLE_HOME_INVALID',
        'The lifecycle runtime directory resolves outside LUWI_HOME.',
        400,
      );
    }
  };

  const loadConfig = async (): Promise<LifecycleConfig> => {
    const content = await dependencies.fileSystem.readText(configPath, CONFIG_MAX_BYTES);
    if (content === undefined) return proposedConfig();
    return assertConfig(
      parseJson(content, 'LIFECYCLE_CONFIG_INVALID', 'The lifecycle configuration is invalid.'),
      installationRoot,
      dependencies.platform,
      pathApi,
    );
  };

  const loadOwner = async (): Promise<{ owner?: DaemonOwner; invalid: boolean }> => {
    try {
      const content = await dependencies.fileSystem.readText(ownerPath, OWNER_MAX_BYTES);
      if (content === undefined) return { invalid: false };
      return {
        owner: assertOwner(
          parseJson(content, 'DAEMON_OWNERSHIP_INVALID', 'The daemon ownership record is invalid.'),
        ),
        invalid: false,
      };
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        (error.code === 'DAEMON_OWNERSHIP_INVALID' || error.code === 'LIFECYCLE_FILE_INVALID')
      ) {
        return { invalid: true };
      }
      throw error;
    }
  };

  const fetchRuntime = async (
    daemonUrl: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<RuntimeInfoResponse | undefined> => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timeout'));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      const response = await Promise.race([
        dependencies.fetch(`${daemonUrl}/api/v1/runtime`, { signal: controller.signal }),
        timeout,
      ]);
      if (!response.ok) return undefined;
      return runtimeInfoResponseSchema.parse(await response.json());
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const endpointPortOpen = async (daemonUrl: string): Promise<boolean> => {
    const url = parseLoopbackUrl(daemonUrl, ['http:'], 'The daemon URL');
    const port = Number(url.port === '' ? '80' : url.port);
    return await dependencies.probePort(url.hostname.replace(/^\[|\]$/gu, ''), port, 500);
  };

  const redisEndpointPortOpen = async (redisUrl: string): Promise<boolean> => {
    const url = parseLoopbackUrl(redisUrl, ['redis:', 'rediss:'], 'The Redis URL');
    const port = Number(url.port === '' ? '6379' : url.port);
    return await dependencies.probePort(url.hostname.replace(/^\[|\]$/gu, ''), port, 500);
  };

  const dockerExecutable = async (): Promise<string | undefined> =>
    dependencies.resolveExecutable('docker');

  const runDocker = async (
    config: LifecycleConfig,
    args: readonly string[],
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<LifecycleCommandResult> => {
    const executable = await dockerExecutable();
    if (executable === undefined) {
      throw commandFailure('DOCKER_UNAVAILABLE', 'Docker could not be resolved on PATH.');
    }
    return await dependencies.runCommand(executable, args, {
      cwd: config.installationRoot,
      timeoutMs,
    });
  };

  const composeState = async (
    config: LifecycleConfig,
  ): Promise<'running' | 'stopped' | 'unavailable' | 'external'> => {
    if (config.redisUrl !== DEFAULT_COMPOSE_REDIS_URL) return 'external';
    try {
      const result = await runDocker(config, [
        'compose',
        '-f',
        config.composeFile,
        'ps',
        '--status',
        'running',
        '--services',
        'redis',
      ]);
      if (result.exitCode !== 0 || result.failure !== undefined) return 'unavailable';
      return result.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .includes('redis')
        ? 'running'
        : 'stopped';
    } catch {
      return 'unavailable';
    }
  };

  const statusFrom = async (
    config: LifecycleConfig,
    runtime: RuntimeInfoResponse | undefined,
  ): Promise<LifecycleStatus> => {
    const ownerResult = await loadOwner();
    const portOpen = runtime === undefined && (await endpointPortOpen(config.daemonUrl));
    const owner = ownerResult.owner;
    const ownerMatches =
      owner !== undefined &&
      runtime !== undefined &&
      owner.runtimeInstanceId === runtime.runtimeInstanceId &&
      owner.daemonUrl === config.daemonUrl &&
      samePath(owner.installationRoot, installationRoot, dependencies.platform, pathApi);
    const ownership: LifecycleStatus['daemon']['ownership'] = ownerResult.invalid
      ? 'invalid'
      : ownerMatches
        ? 'owned'
        : owner !== undefined
          ? 'stale'
          : runtime !== undefined
            ? 'unmanaged'
            : 'none';
    const state: LifecycleStatus['daemon']['state'] =
      runtime === undefined
        ? portOpen
          ? 'foreign'
          : 'stopped'
        : runtime.runtimeState === 'ready'
          ? 'ready'
          : 'degraded';
    return {
      daemon: {
        state,
        managed: ownerMatches,
        ownership,
        ...(ownerMatches && owner !== undefined ? { pid: owner.pid } : {}),
        ...(runtime === undefined ? {} : { runtimeInstanceId: runtime.runtimeInstanceId }),
      },
      redis: {
        state:
          runtime === undefined
            ? 'unknown'
            : runtime.redis.connected
              ? 'connected'
              : 'disconnected',
        compose: await composeState(config),
      },
      endpoints: { daemon: config.daemonUrl, redis: config.redisUrl },
    };
  };

  const waitForRuntime = async (
    config: LifecycleConfig,
    timeoutMs: number,
    expectedRuntimeInstanceId: string,
  ): Promise<RuntimeInfoResponse | undefined> => {
    const deadline = dependencies.clock() + timeoutMs;
    do {
      const remaining = Math.max(1, deadline - dependencies.clock());
      const runtime = await fetchRuntime(config.daemonUrl, Math.min(REQUEST_TIMEOUT_MS, remaining));
      if (runtime !== undefined && runtime.runtimeInstanceId !== expectedRuntimeInstanceId) {
        throw new ApplicationError(
          'DAEMON_START_RACE',
          'A different LUWI daemon reached the configured endpoint during startup.',
          409,
        );
      }
      if (runtime?.runtimeState === 'ready' && runtime.redis.connected) return runtime;
      const waitMs = Math.min(100, Math.max(0, deadline - dependencies.clock()));
      if (waitMs > 0) await dependencies.wait(waitMs);
    } while (dependencies.clock() < deadline);
    return undefined;
  };

  const stopCompose = async (config: LifecycleConfig): Promise<void> => {
    if (config.redisUrl !== DEFAULT_COMPOSE_REDIS_URL) return;
    const result = await runDocker(
      config,
      ['compose', '-f', config.composeFile, 'stop', 'redis'],
      COMPOSE_TIMEOUT_MS,
    );
    if (result.exitCode !== 0 || result.failure !== undefined) {
      throw commandFailure('COMPOSE_STOP_FAILED', 'The Compose Redis service could not stop.');
    }
  };

  const requestLifecycleStop = async (
    config: LifecycleConfig,
    owner: DaemonOwner,
  ): Promise<void> => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new ApplicationError(
            'DAEMON_STOP_TIMEOUT',
            'The owned daemon did not accept shutdown before the request deadline.',
            503,
          ),
        );
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      const response = await Promise.race([
        dependencies.fetch(`${config.daemonUrl}/api/v1/runtime/stop`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-luwi-lifecycle-token': owner.token,
          },
          body: '{}',
          signal: controller.signal,
        }),
        timeout,
      ]);
      if (!response.ok) {
        throw new ApplicationError(
          'DAEMON_STOP_REJECTED',
          'The owned daemon rejected the graceful-stop request.',
          response.status,
        );
      }
      lifecycleStopResponseSchema.parse(await response.json());
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const runRuntimeReset = async (
    config: LifecycleConfig,
    mode: 'inspect' | 'apply',
  ): Promise<ReturnType<typeof parseRuntimeResetOutput>> => {
    const entry = pathApi.join(pathApi.dirname(config.daemonEntry), 'runtime-reset-main.js');
    if (!(await dependencies.fileSystem.exists(entry))) {
      throw new ApplicationError(
        'DAEMON_BUILD_MISSING',
        'The built runtime reset entry is missing. Run pnpm build first.',
        404,
      );
    }
    const result = await dependencies.runCommand(
      dependencies.nodeExecutable,
      [entry, `--${mode}`, '--redis-url', config.redisUrl],
      { cwd: config.installationRoot, timeoutMs: RESET_TIMEOUT_MS },
    );
    if (result.exitCode !== 0 || result.failure !== undefined) {
      throw commandFailure('RUNTIME_RESET_FAILED', 'The LUWI runtime reset command failed.');
    }
    return parseRuntimeResetOutput(result.stdout.trim(), mode);
  };

  return {
    async setup(setupOptions) {
      await prepareHome();
      const config = proposedConfig();

      // Autostart is independent of the config file, so it is acted on first: an
      // already-current config still toggles autostart, and `setup` with neither
      // flag just reports the state (ADR 0027).
      const autostart = createAutostart({
        platform: dependencies.platform,
        runCommand: (executable, args) =>
          dependencies.runCommand(executable, args, {
            cwd: config.installationRoot,
            timeoutMs: 15_000,
          }),
        nodeExecutable: dependencies.nodeExecutable,
        cliEntry: pathApi.join(config.installationRoot, 'apps', 'cli', 'dist', 'main.js'),
      });
      const autostartState: AutostartState =
        setupOptions.autostart === true
          ? await autostart.enable()
          : setupOptions.noAutostart === true
            ? await autostart.disable()
            : await autostart.status();

      const content = serialize(config);
      const current = await dependencies.fileSystem.readText(configPath, CONFIG_MAX_BYTES);
      const hooks = setupOptions.printHooks
        ? [
            'luwi agent run claude -- <native arguments>',
            'luwi agent run codex -- <native arguments>',
            'luwi agent run gemini -- <native arguments>',
          ]
        : [];
      if (current === content) {
        return { changed: false, target: configPath, hooks, autostart: autostartState };
      }
      if (
        setupOptions.approved !== true &&
        !(await dependencies.confirm(`Write LUWI lifecycle configuration to ${configPath}?`))
      ) {
        throw new ApplicationError('SETUP_CANCELLED', 'LUWI setup was cancelled.', 409);
      }
      await dependencies.fileSystem.writeAtomic(configPath, content);
      return { changed: true, target: configPath, hooks, autostart: autostartState };
    },

    async status() {
      const config = await loadConfig();
      return await statusFrom(config, await fetchRuntime(config.daemonUrl));
    },

    async start(startOptions = {}) {
      await prepareHome();
      return await withLifecycleLock(async () => {
        const config = await loadConfig();
        const existingRuntime = await fetchRuntime(config.daemonUrl);
        if (existingRuntime !== undefined) return await statusFrom(config, existingRuntime);
        if (await endpointPortOpen(config.daemonUrl)) {
          throw new ApplicationError(
            'DAEMON_PORT_CONFLICT',
            'The configured daemon port is occupied by an incompatible listener.',
            409,
          );
        }

        let composeStarted = false;
        let daemon: SpawnedDaemon | undefined;
        let owner: DaemonOwner | undefined;
        try {
          if (config.redisUrl === DEFAULT_COMPOSE_REDIS_URL) {
            const existingRedisListener = await redisEndpointPortOpen(config.redisUrl);
            const before = await composeState(config);
            if (before === 'unavailable' && !existingRedisListener) {
              throw commandFailure(
                'DOCKER_COMPOSE_UNAVAILABLE',
                'Docker Compose state could not be inspected.',
              );
            }
            if (before === 'stopped' && !existingRedisListener) {
              const result = await runDocker(
                config,
                ['compose', '-f', config.composeFile, 'up', '-d', '--wait', 'redis'],
                COMPOSE_TIMEOUT_MS,
              );
              if (result.exitCode !== 0 || result.failure !== undefined) {
                throw commandFailure(
                  'COMPOSE_START_FAILED',
                  'The Compose Redis service could not start.',
                );
              }
              composeStarted = true;
            }
          }
          if (!(await dependencies.fileSystem.exists(config.daemonEntry))) {
            throw new ApplicationError(
              'DAEMON_BUILD_MISSING',
              'The built daemon entry is missing. Run pnpm build first.',
              404,
            );
          }
          const token = dependencies.randomUUID();
          const expectedRuntimeInstanceId = dependencies.randomUUID();
          const daemonUrl = parseLoopbackUrl(config.daemonUrl, ['http:'], 'The daemon URL');
          daemon = await dependencies.spawnDaemon({
            daemonEntry: config.daemonEntry,
            workingDirectory: config.installationRoot,
            logFile,
            environment: {
              ...dependencies.environment,
              HOST: '127.0.0.1',
              PORT: daemonUrl.port === '' ? '80' : daemonUrl.port,
              REDIS_URL: config.redisUrl,
              LUWI_HOME: homeDirectory,
              LUWI_LIFECYCLE_TOKEN: token,
              LUWI_RUNTIME_INSTANCE_ID: expectedRuntimeInstanceId,
            },
          });
          const runtime = await waitForRuntime(
            config,
            startOptions.readinessTimeoutMs ?? START_TIMEOUT_MS,
            expectedRuntimeInstanceId,
          );
          if (runtime === undefined) {
            throw new ApplicationError(
              'DAEMON_START_TIMEOUT',
              'The LUWI daemon did not become ready before the startup deadline.',
              503,
            );
          }
          owner = {
            schemaVersion: 1,
            token,
            pid: daemon.pid,
            runtimeInstanceId: runtime.runtimeInstanceId,
            daemonUrl: config.daemonUrl,
            installationRoot,
            startedAt: dependencies.now().toISOString(),
          };
          await dependencies.fileSystem.writeAtomic(ownerPath, serialize(owner));
          return await statusFrom(config, runtime);
        } catch (error) {
          if (owner !== undefined) await requestLifecycleStop(config, owner).catch(() => undefined);
          await daemon?.terminate().catch(() => undefined);
          if (composeStarted) await stopCompose(config).catch(() => undefined);
          throw error;
        }
      });
    },

    async stop(stopOptions = {}) {
      await prepareHome();
      return await withLifecycleLock(async () => {
        const config = await loadConfig();
        const ownerResult = await loadOwner();
        if (ownerResult.invalid) {
          throw new ApplicationError(
            'DAEMON_OWNERSHIP_INVALID',
            'The daemon ownership record is invalid; refusing to stop a process.',
            409,
          );
        }
        const runtime = await fetchRuntime(config.daemonUrl);
        if (runtime === undefined) {
          if (await endpointPortOpen(config.daemonUrl)) {
            throw new ApplicationError(
              'DAEMON_PORT_CONFLICT',
              'The configured daemon port is occupied by an incompatible listener.',
              409,
            );
          }
          if (ownerResult.owner !== undefined) await dependencies.fileSystem.removeFile(ownerPath);
          if (stopOptions.withRedis === true) await stopCompose(config);
          return await statusFrom(config, undefined);
        }
        const owner = ownerResult.owner;
        if (
          owner === undefined ||
          owner.runtimeInstanceId !== runtime.runtimeInstanceId ||
          owner.daemonUrl !== config.daemonUrl ||
          !samePath(owner.installationRoot, installationRoot, dependencies.platform, pathApi)
        ) {
          throw new ApplicationError(
            'DAEMON_OWNERSHIP_MISMATCH',
            'The running daemon does not match LUWI lifecycle ownership evidence.',
            409,
          );
        }
        await requestLifecycleStop(config, owner);
        const deadline = dependencies.clock() + STOP_TIMEOUT_MS;
        let closed = false;
        do {
          if (
            (await fetchRuntime(
              config.daemonUrl,
              Math.min(REQUEST_TIMEOUT_MS, Math.max(1, deadline - dependencies.clock())),
            )) === undefined &&
            !(await endpointPortOpen(config.daemonUrl))
          ) {
            closed = true;
            break;
          }
          const waitMs = Math.min(100, Math.max(0, deadline - dependencies.clock()));
          if (waitMs > 0) await dependencies.wait(waitMs);
        } while (dependencies.clock() < deadline);
        if (!closed) {
          throw new ApplicationError(
            'DAEMON_STOP_TIMEOUT',
            'The owned daemon did not close before the shutdown deadline.',
            503,
          );
        }
        await dependencies.fileSystem.removeFile(ownerPath);
        if (stopOptions.withRedis === true) await stopCompose(config);
        return await statusFrom(config, undefined);
      });
    },

    async resetRuntimeState(resetOptions) {
      await prepareHome();
      return await withLifecycleLock(async () => {
        const config = await loadConfig();
        const runtime = await fetchRuntime(config.daemonUrl);
        if (runtime !== undefined || (await endpointPortOpen(config.daemonUrl))) {
          throw new ApplicationError(
            'DAEMON_MUST_BE_STOPPED',
            'Stop the LUWI daemon before resetting runtime state.',
            409,
          );
        }
        const ownerResult = await loadOwner();
        if (ownerResult.invalid || ownerResult.owner !== undefined) {
          throw new ApplicationError(
            'DAEMON_OWNERSHIP_INVALID',
            'Resolve the daemon ownership record before resetting runtime state.',
            409,
          );
        }
        const preview = await runRuntimeReset(config, 'inspect');
        if (!resetOptions.approved && !resetOptions.interactive) {
          return { ...preview, deleted: 0, status: 'confirmation_required' };
        }
        if (
          !resetOptions.approved &&
          !(await dependencies.confirm(
            `Delete ${preview.matched} keys from ${preview.namespace} while preserving LUWI_HOME and every other Redis key?`,
          ))
        ) {
          return { ...preview, deleted: 0, status: 'cancelled' };
        }
        const applied = await runRuntimeReset(config, 'apply');
        return {
          namespace: applied.namespace,
          matched: applied.matched,
          deleted: applied.deleted ?? 0,
          status: applied.status ?? 'empty',
        };
      });
    },

    async doctor() {
      const checks: DoctorCheck[] = [];
      const config = await loadConfig();
      const initialRedisListener = await redisEndpointPortOpen(config.redisUrl);
      const nodeMajor = Number(dependencies.nodeVersion.split('.')[0]);
      checks.push(
        Number.isInteger(nodeMajor) && nodeMajor >= 22
          ? { id: 'node', status: 'ok', summary: `Node.js ${dependencies.nodeVersion}` }
          : {
              id: 'node',
              status: 'error',
              summary: 'Node.js 22 or newer is required.',
              hint: 'Install a supported Node.js release.',
            },
      );

      const pnpm = await dependencies.resolveExecutable('pnpm');
      if (pnpm === undefined) {
        checks.push({
          id: 'pnpm',
          status: 'error',
          summary: 'pnpm was not found.',
          hint: 'Install pnpm 11.9.0.',
        });
      } else {
        const version = await dependencies.runCommand(pnpm, ['--version'], {
          cwd: installationRoot,
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        checks.push({
          id: 'pnpm',
          status: version.exitCode === 0 && version.failure === undefined ? 'ok' : 'error',
          summary:
            version.exitCode === 0 && version.failure === undefined
              ? `pnpm ${version.stdout.trim() || 'available'}`
              : 'pnpm could not run.',
        });
      }

      const docker = await dockerExecutable();
      if (docker === undefined) {
        checks.push({
          id: 'docker-compose',
          status:
            config.redisUrl === DEFAULT_COMPOSE_REDIS_URL && !initialRedisListener
              ? 'error'
              : 'warning',
          summary: 'Docker was not found.',
          hint: 'Install Docker with the Compose plugin or configure external loopback Redis.',
        });
      } else {
        const version = await dependencies.runCommand(docker, ['compose', 'version'], {
          cwd: installationRoot,
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        checks.push({
          id: 'docker-compose',
          status:
            version.exitCode === 0 && version.failure === undefined
              ? 'ok'
              : initialRedisListener
                ? 'warning'
                : 'error',
          summary:
            version.exitCode === 0 && version.failure === undefined
              ? 'Docker Compose is available.'
              : 'Docker Compose could not run.',
        });
      }

      const installationFilesPresent =
        (await dependencies.fileSystem.exists(config.composeFile)) &&
        (await dependencies.fileSystem.exists(config.daemonEntry));
      checks.push(
        installationFilesPresent
          ? {
              id: 'installation',
              status: 'ok',
              summary: 'The Compose file and built daemon entry are present.',
            }
          : {
              id: 'installation',
              status: 'error',
              summary: 'The Compose file or built daemon entry is missing.',
              hint: 'Run pnpm build from the LUWI Runtime installation root.',
            },
      );

      const runtime = await fetchRuntime(config.daemonUrl);
      const daemonPortOpen = runtime === undefined && (await endpointPortOpen(config.daemonUrl));
      checks.push(
        runtime?.runtimeState === 'ready'
          ? { id: 'daemon', status: 'ok', summary: 'The LUWI daemon is ready and compatible.' }
          : daemonPortOpen
            ? {
                id: 'daemon',
                status: 'error',
                summary: 'The daemon port is occupied by an incompatible listener.',
              }
            : {
                id: 'daemon',
                status: 'warning',
                summary: 'The LUWI daemon is not running.',
                hint: 'Run luwi start.',
              },
      );
      const currentComposeState = await composeState(config);
      checks.push({
        id: 'compose-redis',
        status:
          currentComposeState === 'running' || currentComposeState === 'external'
            ? 'ok'
            : currentComposeState === 'stopped'
              ? 'warning'
              : initialRedisListener
                ? 'warning'
                : 'error',
        summary:
          currentComposeState === 'external'
            ? 'Redis is externally managed and will not be controlled by LUWI.'
            : `The Compose Redis service is ${currentComposeState}.`,
        ...(currentComposeState === 'stopped' ? { hint: 'Run luwi start.' } : {}),
      });
      const redisListener = runtime?.redis.connected === true || initialRedisListener;
      checks.push(
        redisListener
          ? {
              id: 'redis-listener',
              status: 'ok',
              summary: 'A loopback Redis listener is reachable.',
            }
          : {
              id: 'redis-listener',
              status: 'warning',
              summary: 'No loopback Redis listener is currently reachable.',
              hint: 'Run luwi start or start the configured external Redis server.',
            },
      );
      checks.push(
        runtime?.runtimeState === 'ready' && runtime.redis.connected
          ? {
              id: 'redis-functions',
              status: 'ok',
              summary: 'Redis connectivity and Function compatibility were verified by the daemon.',
            }
          : {
              id: 'redis-functions',
              status: 'warning',
              summary: 'Redis Function compatibility is unknown until the daemon becomes ready.',
            },
      );

      for (const agent of ['claude', 'codex', 'gemini'] as const) {
        const executable = await dependencies.resolveExecutable(agent);
        checks.push(
          executable === undefined
            ? {
                id: `agent-${agent}`,
                status: 'warning',
                summary: `${agent} was not found on PATH.`,
                hint: `Install ${agent} or use luwi agent run ${agent} --executable <path>.`,
              }
            : {
                id: `agent-${agent}`,
                status: 'ok',
                summary: `${agent} is available.`,
              },
        );
      }

      const nativeHome = dependencies.environment['LUWI_NATIVE_HOME'] ?? homedir();
      return {
        ready: !checks.some((check) => check.status === 'error'),
        checks,
        endpoints: { daemon: config.daemonUrl, redis: config.redisUrl },
        roots: {
          luwiHome: homeDirectory,
          claude: pathApi.join(nativeHome, '.claude'),
          codex: pathApi.join(nativeHome, '.codex'),
          gemini: pathApi.join(nativeHome, '.gemini'),
        },
      };
    },
  };
}

export function defaultLifecycleInstallationRoot(pathApi: PathApi = nodePath): string {
  return pathApi.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function createNodeLifecycleService(options: {
  installationRoot?: string;
  homeDirectory?: string;
  confirm: (prompt: string) => Promise<boolean>;
}): LifecycleService {
  const dependencies = defaultDependencies();
  dependencies.confirm = options.confirm;
  return createLifecycleService({
    installationRoot: options.installationRoot ?? defaultLifecycleInstallationRoot(),
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
    dependencies,
  });
}
