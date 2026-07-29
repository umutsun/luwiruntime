import { describe, expect, it } from 'vitest';

import {
  createRedisGateway,
  type RedisClientLike,
  type RedisGatewayDependencies,
} from './index.js';

class FakeRedisClient implements RedisClientLike {
  isOpen = false;
  isReady = false;
  connectError?: Error;
  pingError?: Error;
  quitCalls = 0;
  disconnectCalls = 0;

  on(_event: 'error', _listener: (error: Error) => void): this {
    void _event;
    void _listener;
    return this;
  }

  async connect(): Promise<void> {
    if (this.connectError !== undefined) {
      throw this.connectError;
    }

    this.isOpen = true;
    this.isReady = true;
  }

  async ping(): Promise<string> {
    if (this.pingError !== undefined) {
      throw this.pingError;
    }

    return 'PONG';
  }

  async quit(): Promise<string> {
    this.quitCalls += 1;
    this.isOpen = false;
    this.isReady = false;
    return 'OK';
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.isOpen = false;
    this.isReady = false;
  }
}

function dependenciesFor(
  client: FakeRedisClient,
  nowValues: readonly number[] = [100, 107],
): RedisGatewayDependencies {
  let nowIndex = 0;

  return {
    createClient: () => client,
    now: () => {
      const value = nowValues[nowIndex] ?? nowValues.at(-1);
      nowIndex += 1;
      return value ?? 0;
    },
    onError: () => undefined,
  };
}

describe('Redis gateway', () => {
  it('configures a finite initial connection attempt so degraded startup cannot retry forever', () => {
    const client = new FakeRedisClient();
    let clientOptions: unknown;

    createRedisGateway(
      { url: 'redis://127.0.0.1:6379' },
      {
        ...dependenciesFor(client),
        createClient: (options) => {
          clientOptions = options;
          return client;
        },
      },
    );

    expect(clientOptions).toEqual({
      url: 'redis://127.0.0.1:6379',
      socket: {
        connectTimeout: 2000,
        reconnectStrategy: false,
      },
    });
  });

  it('connects, pings, and closes the official-client boundary', async () => {
    const client = new FakeRedisClient();
    const gateway = createRedisGateway({ url: 'redis://127.0.0.1:6379' }, dependenciesFor(client));

    await expect(gateway.connect()).resolves.toBe(true);
    await expect(gateway.checkHealth()).resolves.toEqual({
      connected: true,
      status: 'connected',
      latencyMs: 7,
    });

    await gateway.close();
    expect(client.quitCalls).toBe(1);
    expect(client.disconnectCalls).toBe(0);
  });

  it('returns a safe disconnected result when the initial connection fails', async () => {
    const client = new FakeRedisClient();
    client.connectError = new Error('redis://default:secret@private-host:6379');
    const observedErrors: Error[] = [];
    const gateway = createRedisGateway(
      { url: 'redis://private-host:6379' },
      {
        ...dependenciesFor(client),
        onError: (error) => observedErrors.push(error),
      },
    );

    await expect(gateway.connect()).resolves.toBe(false);
    await expect(gateway.checkHealth()).resolves.toEqual({
      connected: false,
      status: 'disconnected',
      error: {
        code: 'REDIS_UNAVAILABLE',
        message: 'Redis is unavailable',
      },
    });
    expect(observedErrors).toHaveLength(1);
  });

  it('falls back to a forceful disconnect when graceful quit fails', async () => {
    const client = new FakeRedisClient();
    client.isOpen = true;
    client.isReady = true;
    client.quit = async () => {
      client.quitCalls += 1;
      throw new Error('connection closed during quit');
    };
    const gateway = createRedisGateway({ url: 'redis://127.0.0.1:6379' }, dependenciesFor(client));

    await gateway.close();

    expect(client.quitCalls).toBe(1);
    expect(client.disconnectCalls).toBe(1);
  });
});
