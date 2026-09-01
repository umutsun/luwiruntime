import { randomUUID } from 'node:crypto';

import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetRuntimeNamespace, type RedisCommandClient } from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;

describe.skipIf(testRedisUrl === undefined)('runtime namespace reset integration', () => {
  const runId = randomUUID().replaceAll('-', '');
  const namespace = `luwi:test:reset:${runId}:`;
  const first = `${namespace}first`;
  const second = `${namespace}second`;
  const sentinel = `other-app:test-sentinel:${runId}`;
  const sentinelValue = `preserve-${runId}`;
  let client: RedisClientType;
  let commandClient: RedisCommandClient;

  beforeAll(async () => {
    client = createClient({ url: testRedisUrl });
    client.on('error', () => undefined);
    await client.connect();
    commandClient = { sendCommand: (arguments_) => client.sendCommand([...arguments_]) };
    await client.set(first, 'one');
    await client.hSet(second, { value: 'two' });
    await client.set(sentinel, sentinelValue);
  });

  afterAll(async () => {
    if (!client?.isOpen) return;
    await client.del(first, second, sentinel);
    await client.quit();
  });

  it('removes only matching keys and preserves a same-database sentinel', async () => {
    await expect(resetRuntimeNamespace(commandClient, { namespace })).resolves.toEqual({
      namespace,
      matched: 2,
      deleted: 2,
      status: 'reset',
    });

    await expect(client.exists(first, second)).resolves.toBe(0);
    await expect(client.get(sentinel)).resolves.toBe(sentinelValue);
  });
});
