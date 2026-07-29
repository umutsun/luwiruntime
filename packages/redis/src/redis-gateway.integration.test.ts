import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRedisGateway, type RedisGateway } from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;

describe.skipIf(testRedisUrl === undefined)('Redis gateway integration', () => {
  let gateway: RedisGateway;

  beforeAll(async () => {
    gateway = createRedisGateway({
      url: testRedisUrl ?? 'redis://127.0.0.1:6379/15',
    });
    await gateway.connect();
  });

  afterAll(async () => {
    await gateway.close();
  });

  it('pings only the explicitly configured test Redis instance', async () => {
    await expect(gateway.checkHealth()).resolves.toMatchObject({
      connected: true,
      status: 'connected',
    });
  });
});
