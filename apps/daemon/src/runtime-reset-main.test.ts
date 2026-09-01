import { describe, expect, it, vi } from 'vitest';

import type { ManagedRedisConnection } from '@luwi/redis';

import { PRODUCTION_RUNTIME_NAMESPACE, runRuntimeResetMain } from './runtime-reset-main.js';

function connection(replies: unknown[]): ManagedRedisConnection {
  const queue = [...replies];
  return {
    isOpen: true,
    isReady: true,
    on() {
      return this;
    },
    connect: vi.fn(async () => undefined),
    sendCommand: vi.fn(async () => queue.shift()),
    quit: vi.fn(async () => 'OK'),
    disconnect: vi.fn(),
  };
}

describe('daemon runtime reset maintenance entry', () => {
  it('inspects only the fixed production namespace and closes the connection', async () => {
    const redis = connection([['0', ['luwi:v1:events:global']]]);
    let output = '';

    await runRuntimeResetMain({
      argv: ['--inspect'],
      environment: { REDIS_URL: 'redis://127.0.0.1:6379' },
      createConnection: () => redis,
      stdout: { write: (value) => (output += value) },
    });

    expect(PRODUCTION_RUNTIME_NAMESPACE).toBe('luwi:v1:');
    expect(JSON.parse(output)).toEqual({ namespace: 'luwi:v1:', matched: 1 });
    expect(redis.sendCommand).toHaveBeenCalledWith([
      'SCAN',
      '0',
      'MATCH',
      'luwi:v1:*',
      'COUNT',
      '500',
    ]);
    expect(redis.quit).toHaveBeenCalledOnce();
  });

  it('rejects unknown arguments before opening Redis', async () => {
    const createConnection = vi.fn(() => connection([]));

    await expect(
      runRuntimeResetMain({
        argv: ['--apply', '--namespace', 'other:'],
        environment: { REDIS_URL: 'redis://127.0.0.1:6379' },
        createConnection,
        stdout: { write: vi.fn() },
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_RESET_ARGUMENT_INVALID' });
    expect(createConnection).not.toHaveBeenCalled();
  });
});
