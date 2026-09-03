import type { AdapterCommandResult } from '@luwi/adapters';
import { runtimeResourcesResponseSchema } from '@luwi/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createHostResourcesReader, parseGpuQuery, type CpuTimes } from './host-resources.js';

const times = (busy: number, idle: number): CpuTimes => ({
  user: busy,
  nice: 0,
  sys: 0,
  idle,
  irq: 0,
});

function reader(
  overrides: Parameters<typeof createHostResourcesReader>[0] extends infer O
    ? Partial<O>
    : never = {},
) {
  let tick = 0;
  const clock = [
    '2026-09-02T10:00:00.000Z',
    '2026-09-02T10:00:10.000Z',
    '2026-09-02T10:00:20.000Z',
  ];
  const cpuSamples = [
    [times(100, 900), times(100, 900)],
    [times(150, 950), times(250, 850)],
    [times(150, 1950), times(250, 1850)],
  ];
  const cpuMicros = [0, 400_000, 400_000];
  const run = vi.fn(async (): Promise<AdapterCommandResult> => ({
    exitCode: 0,
    stdout: 'NVIDIA GeForce RTX 4070 Laptop GPU, 1234, 8188, 7\n',
    stderr: '',
  }));
  const sendCommand = vi.fn(async (command: readonly string[]) =>
    command[0] === 'INFO'
      ? 'used_memory:284430000\r\nused_memory_human:271M\r\nmaxmemory:0\r\n'
      : 131_508,
  );
  const value = createHostResourcesReader({
    diskPath: 'C:/Users/dev/.luwi',
    now: () => new Date(clock[Math.min(tick, clock.length - 1)] ?? clock[0]!),
    readCpus: () => {
      const sample = cpuSamples[Math.min(tick, cpuSamples.length - 1)] ?? [];
      return sample.map((value) => ({ model: 'Fake CPU  ', times: value }));
    },
    readMemory: () => ({ totalBytes: 64 * 1024 ** 3, freeBytes: 12 * 1024 ** 3 }),
    readDisk: async () => ({ totalBytes: 2_000_000_000_000, freeBytes: 1_474_000_000_000 }),
    readProcess: () => ({
      pid: 4242,
      rssBytes: 64 * 1024 ** 2,
      heapUsedBytes: 20 * 1024 ** 2,
      cpuMicros: cpuMicros[Math.min(tick, cpuMicros.length - 1)] ?? 0,
    }),
    commandRunner: { run },
    executableResolver: { resolve: async () => 'C:/Windows/System32/nvidia-smi.exe' },
    redis: { sendCommand },
    ...overrides,
  });
  return {
    read: async () => {
      const result = await value.read();
      tick += 1;
      return result;
    },
    run,
    sendCommand,
  };
}

describe('host resources reader', () => {
  it('measures the machine, the daemon and Redis, and validates against the protocol', async () => {
    const { read } = reader();

    const first = await read();

    expect(runtimeResourcesResponseSchema.parse(first)).toEqual(first);
    expect(first).toMatchObject({
      observedAt: '2026-09-02T10:00:00.000Z',
      host: {
        cpu: { model: 'Fake CPU', cores: 2 },
        memory: { totalBytes: 64 * 1024 ** 3, freeBytes: 12 * 1024 ** 3 },
        disk: { path: 'C:/Users/dev/.luwi', totalBytes: 2_000_000_000_000 },
        gpus: [
          {
            name: 'NVIDIA GeForce RTX 4070 Laptop GPU',
            memoryUsedBytes: 1234 * 1024 * 1024,
            memoryTotalBytes: 8188 * 1024 * 1024,
            utilizationPercent: 7,
          },
        ],
      },
      daemon: { pid: 4242, rssBytes: 64 * 1024 ** 2, heapUsedBytes: 20 * 1024 ** 2 },
      redis: { usedMemoryBytes: 284_430_000, maxMemoryBytes: 0, keyCount: 131_508 },
    });
    // A rate needs two samples; the first read claims none rather than a zero.
    expect(first.host.cpu).not.toHaveProperty('utilizationPercent');
    expect(first.daemon).not.toHaveProperty('cpuPercent');
  });

  it('reports utilization as the busy share since the previous read', async () => {
    const { read } = reader();
    await read();

    const second = await read();

    // Core 1: +50 busy / +50 idle; core 2: +150 busy / -50 idle → summed +200 busy, 0 idle? No:
    // idle went 900→950 and 900→850, so the summed idle delta is 0 and busy is 200 of 200.
    expect(second.host.cpu.utilizationPercent).toBe(100);
    // 400 000 µs of CPU over 10 s on 2 cores is 2% of the machine.
    expect(second.daemon.cpuPercent).toBe(2);

    const third = await read();
    // Nothing but idle time passed: 0 busy of 2000.
    expect(third.host.cpu.utilizationPercent).toBe(0);
    expect(third.daemon.cpuPercent).toBe(0);
  });

  it('leaves a source absent when it is not there, never reporting a zero it did not measure', async () => {
    const { read, run } = reader({
      readDisk: async () => {
        throw new Error('ENOENT');
      },
      // No NVIDIA tool on PATH: nothing is spawned and no device is claimed.
      executableResolver: { resolve: async () => undefined },
      redis: undefined,
    });

    const result = await read();

    expect(result.host).not.toHaveProperty('disk');
    expect(result.host).not.toHaveProperty('gpus');
    expect(run).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('redis');
    expect(runtimeResourcesResponseSchema.parse(result)).toEqual(result);
  });

  it('treats an unreadable Redis reply as absent rather than failing the read', async () => {
    const { read } = reader({
      redis: {
        sendCommand: async () => {
          throw new Error('Redis is unavailable.');
        },
      },
    });

    expect(await read()).not.toHaveProperty('redis');
  });

  it('asks the GPU tool at most once per cache window', async () => {
    let atMs = Date.parse('2026-09-02T10:00:00.000Z');
    const { read, run } = reader({ now: () => new Date(atMs) });

    await read();
    atMs += 5_000;
    await read();
    expect(run).toHaveBeenCalledTimes(1);

    atMs += 5_000;
    await read();
    // The third read is 10 s after the first, at the end of the window.
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith('C:/Windows/System32/nvidia-smi.exe', [
      '--query-gpu=name,memory.used,memory.total,utilization.gpu',
      '--format=csv,noheader,nounits',
    ]);
  });
});

describe('parseGpuQuery', () => {
  it('reads one device per line and leaves an unreported field absent', () => {
    expect(parseGpuQuery('NVIDIA A, 100, 1000, 50\nNVIDIA B, [N/A], [N/A], [N/A]\n\n')).toEqual([
      {
        name: 'NVIDIA A',
        memoryUsedBytes: 100 * 1024 * 1024,
        memoryTotalBytes: 1000 * 1024 * 1024,
        utilizationPercent: 50,
      },
      { name: 'NVIDIA B' },
    ]);
  });

  it('bounds the device list at sixteen', () => {
    expect(parseGpuQuery(Array.from({ length: 20 }, () => 'GPU, 1, 2, 3').join('\n'))).toHaveLength(
      16,
    );
  });
});
