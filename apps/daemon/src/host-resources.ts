import { statfs } from 'node:fs/promises';
import { cpus, freemem, platform, totalmem } from 'node:os';

import {
  PathExecutableResolver,
  SpawnCommandRunner,
  type AdapterCommandRunner,
  type AdapterExecutableResolver,
} from '@luwi/adapters';
import type { RuntimeResourcesResponse } from '@luwi/protocol';
import type { RedisCommandClient } from '@luwi/redis';

/**
 * What the machine has and what LUWI costs on it, for
 * `GET /api/v1/runtime/resources`.
 *
 * A tool that calls itself lightweight should be able to show its own weight.
 * Everything here is read from the standard library, this process, and two
 * Redis replies. The one external command is `nvidia-smi` with a fixed query —
 * the same class of fixed system utility as `git` and `schtasks`, never
 * anything discovered in a project. A source that is not there leaves its
 * field absent: no zero is reported that was not measured.
 */

const GPU_CACHE_MS = 10_000;
const GPU_COMMAND_TIMEOUT_MS = 3_000;
const GPU_QUERY = [
  '--query-gpu=name,memory.used,memory.total,utilization.gpu',
  '--format=csv,noheader,nounits',
] as const;
const MEBIBYTE = 1024 * 1024;

export type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number };

export type HostResourcesOptions = {
  /** The volume whose free space matters: where LUWI keeps its own state. */
  diskPath: string;
  redis?: RedisCommandClient;
  commandRunner?: AdapterCommandRunner;
  /** Finds `nvidia-smi` on PATH; the runner spawns absolute paths only. */
  executableResolver?: AdapterExecutableResolver;
  now?: () => Date;
  /** Seams for tests; the defaults read the real machine. */
  readCpus?: () => { model: string; times: CpuTimes }[];
  readMemory?: () => { totalBytes: number; freeBytes: number };
  readDisk?: (path: string) => Promise<{ totalBytes: number; freeBytes: number }>;
  readProcess?: () => { pid: number; rssBytes: number; heapUsedBytes: number; cpuMicros: number };
};

export interface HostResourcesReader {
  read(): Promise<RuntimeResourcesResponse>;
}

type CpuSample = { busy: number; idle: number };
type DaemonSample = { cpuMicros: number; atMs: number };
type Gpu = NonNullable<RuntimeResourcesResponse['host']['gpus']>[number];

function sumCpu(times: readonly CpuTimes[]): CpuSample {
  let busy = 0;
  let idle = 0;
  for (const value of times) {
    busy += value.user + value.nice + value.sys + value.irq;
    idle += value.idle;
  }
  return { busy, idle };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

/** `INFO memory` is `key:value` lines; only two of them are read. */
function infoField(info: string, key: string): number | undefined {
  const match = new RegExp(`^${key}:(\\d+)\\r?$`, 'm').exec(info);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function mebibytes(value: string): number | undefined {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * MEBIBYTE) : undefined;
}

function percent(value: string): number | undefined {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? clampPercent(parsed) : undefined;
}

/** One `name, used, total, utilization` line per device; a field the tool reports as `[N/A]` is left absent. */
export function parseGpuQuery(stdout: string): Gpu[] {
  const gpus: Gpu[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [name, used, total, utilization] = line.split(',').map((field) => field.trim());
    if (name === undefined || name.length === 0) continue;
    const memoryUsedBytes = used === undefined ? undefined : mebibytes(used);
    const memoryTotalBytes = total === undefined ? undefined : mebibytes(total);
    const utilizationPercent = utilization === undefined ? undefined : percent(utilization);
    gpus.push({
      name: name.slice(0, 256),
      ...(memoryUsedBytes === undefined ? {} : { memoryUsedBytes }),
      ...(memoryTotalBytes === undefined ? {} : { memoryTotalBytes }),
      ...(utilizationPercent === undefined ? {} : { utilizationPercent }),
    });
    if (gpus.length === 16) break;
  }
  return gpus;
}

export function createHostResourcesReader(options: HostResourcesOptions): HostResourcesReader {
  const now = options.now ?? (() => new Date());
  const readCpus = options.readCpus ?? (() => cpus().map(({ model, times }) => ({ model, times })));
  const readMemory =
    options.readMemory ?? (() => ({ totalBytes: totalmem(), freeBytes: freemem() }));
  const readDisk =
    options.readDisk ??
    (async (path: string) => {
      const stats = await statfs(path);
      return {
        totalBytes: Number(stats.bsize) * Number(stats.blocks),
        freeBytes: Number(stats.bsize) * Number(stats.bavail),
      };
    });
  const readProcess =
    options.readProcess ??
    (() => {
      const usage = process.cpuUsage();
      const memory = process.memoryUsage();
      return {
        pid: process.pid,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        cpuMicros: usage.user + usage.system,
      };
    });
  const commandRunner =
    options.commandRunner ?? new SpawnCommandRunner({ timeoutMs: GPU_COMMAND_TIMEOUT_MS });
  const executableResolver = options.executableResolver ?? new PathExecutableResolver();

  let previousCpu: CpuSample | undefined;
  let previousDaemon: DaemonSample | undefined;
  let gpuCache: { atMs: number; gpus: Gpu[] | undefined } | undefined;

  const readGpus = async (atMs: number): Promise<Gpu[] | undefined> => {
    if (gpuCache !== undefined && atMs - gpuCache.atMs < GPU_CACHE_MS) return gpuCache.gpus;
    let gpus: Gpu[] | undefined;
    try {
      // The runner refuses a bare name on Windows (it canonicalizes the path
      // first), so the tool is located on PATH before it is asked anything.
      const executable = await executableResolver.resolve('nvidia-smi');
      const result =
        executable === undefined ? undefined : await commandRunner.run(executable, GPU_QUERY);
      gpus =
        result !== undefined && result.failure === undefined && result.exitCode === 0
          ? parseGpuQuery(result.stdout)
          : undefined;
    } catch {
      gpus = undefined;
    }
    gpuCache = { atMs, gpus };
    return gpus;
  };

  const readRedis = async (): Promise<RuntimeResourcesResponse['redis']> => {
    if (options.redis === undefined) return undefined;
    try {
      const info = String(await options.redis.sendCommand(['INFO', 'memory']));
      const keyCount = Number(await options.redis.sendCommand(['DBSIZE']));
      const usedMemoryBytes = infoField(info, 'used_memory');
      if (usedMemoryBytes === undefined || !Number.isSafeInteger(keyCount)) return undefined;
      return { usedMemoryBytes, maxMemoryBytes: infoField(info, 'maxmemory') ?? 0, keyCount };
    } catch {
      return undefined;
    }
  };

  return {
    async read() {
      const observedAt = now();
      const atMs = observedAt.getTime();
      const cores = readCpus();
      const cpu = sumCpu(cores.map(({ times }) => times));
      const busyDelta = previousCpu === undefined ? undefined : cpu.busy - previousCpu.busy;
      const idleDelta = previousCpu === undefined ? undefined : cpu.idle - previousCpu.idle;
      const utilizationPercent =
        busyDelta === undefined || idleDelta === undefined || busyDelta + idleDelta <= 0
          ? undefined
          : clampPercent((busyDelta / (busyDelta + idleDelta)) * 100);
      previousCpu = cpu;

      const daemon = readProcess();
      const elapsedMs = previousDaemon === undefined ? undefined : atMs - previousDaemon.atMs;
      const cpuPercent =
        previousDaemon === undefined || elapsedMs === undefined || elapsedMs <= 0
          ? undefined
          : clampPercent(
              ((daemon.cpuMicros - previousDaemon.cpuMicros) /
                (elapsedMs * 1000 * Math.max(1, cores.length))) *
                100,
            );
      previousDaemon = { cpuMicros: daemon.cpuMicros, atMs };

      let disk: RuntimeResourcesResponse['host']['disk'];
      try {
        disk = { path: options.diskPath, ...(await readDisk(options.diskPath)) };
      } catch {
        disk = undefined;
      }
      const [gpus, redis] = await Promise.all([readGpus(atMs), readRedis()]);
      const memory = readMemory();
      const model = cores[0]?.model.trim();

      return {
        observedAt: observedAt.toISOString(),
        host: {
          platform: platform(),
          cpu: {
            ...(model === undefined || model.length === 0 ? {} : { model: model.slice(0, 256) }),
            cores: Math.max(1, cores.length),
            ...(utilizationPercent === undefined ? {} : { utilizationPercent }),
          },
          memory,
          ...(disk === undefined ? {} : { disk }),
          ...(gpus === undefined ? {} : { gpus }),
        },
        daemon: {
          pid: daemon.pid,
          rssBytes: daemon.rssBytes,
          heapUsedBytes: daemon.heapUsedBytes,
          ...(cpuPercent === undefined ? {} : { cpuPercent }),
        },
        ...(redis === undefined ? {} : { redis }),
      };
    },
  };
}
