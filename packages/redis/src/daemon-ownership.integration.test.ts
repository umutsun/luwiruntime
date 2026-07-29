import { randomUUID } from 'node:crypto';

import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDaemonOwnershipLease, type RedisCommandClient } from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;

describe.skipIf(testRedisUrl === undefined)('daemon ownership integration', () => {
  const key = `luwi:test:${randomUUID()}:daemon-owner`;
  let client: RedisClientType;
  let commandClient: RedisCommandClient;

  beforeAll(async () => {
    client = createClient({ url: testRedisUrl });
    client.on('error', () => undefined);
    await client.connect();
    commandClient = { sendCommand: (arguments_) => client.sendCommand([...arguments_]) };
  });

  afterAll(async () => {
    if (client?.isOpen) {
      await client.del(key);
      await client.quit();
    }
  });

  it('enforces one owner and never deletes a replacement owner token', async () => {
    const options = {
      client: commandClient,
      key,
      ttlMs: 15_000,
      renewIntervalMs: 5_000,
      setInterval: () => ({}) as NodeJS.Timeout,
      clearInterval: () => undefined,
      onLost: vi.fn(),
    };
    const first = createDaemonOwnershipLease({
      ...options,
      runtimeInstanceId: 'runtime-first',
    });
    const second = createDaemonOwnershipLease({
      ...options,
      runtimeInstanceId: 'runtime-second',
    });

    await first.acquire();
    await expect(second.acquire()).rejects.toMatchObject({ code: 'DAEMON_ALREADY_RUNNING' });
    await expect(first.renewOnce()).resolves.toBe(true);
    await client.set(key, second.ownerToken);
    await expect(first.release()).resolves.toBe(false);
    await expect(client.get(key)).resolves.toBe(second.ownerToken);
  });
});
