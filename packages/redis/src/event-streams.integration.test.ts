import { randomUUID } from 'node:crypto';

import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureRealtimeStreamGroup, type RedisCommandClient } from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;

describe.skipIf(testRedisUrl === undefined)('event Stream bootstrap integration', () => {
  const stream = `luwi:test:${randomUUID()}:events`;
  const group = 'luwi-realtime-v1';
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
      await client.del(stream);
      await client.quit();
    }
  });

  it('creates at $ and preserves the group position across restart bootstrap', async () => {
    await client.xAdd(stream, '*', { event: '{"id":"before-group"}' });
    await expect(ensureRealtimeStreamGroup(commandClient, stream, group)).resolves.toEqual({
      created: true,
    });
    await client.xAdd(stream, '*', { event: '{"id":"after-group"}' });
    const before = await client.xInfoGroups(stream);

    await expect(ensureRealtimeStreamGroup(commandClient, stream, group)).resolves.toEqual({
      created: false,
    });
    const after = await client.xInfoGroups(stream);

    expect(after).toEqual(before);
    expect(after[0]?.['last-delivered-id']).not.toBe('0-0');
  });
});
