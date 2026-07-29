import type { RedisGateway, RedisHealth } from '@luwi/redis';
import { describe, expect, it } from 'vitest';

import { buildDaemon } from './app.js';
import type { DaemonConfig } from './config.js';
import { installGracefulShutdown, type ShutdownSignal, type SignalSource } from './shutdown.js';

class FakeSignalSource implements SignalSource {
  readonly listeners = new Map<ShutdownSignal, () => Promise<void>>();

  once(signal: ShutdownSignal, listener: () => Promise<void>): this {
    this.listeners.set(signal, listener);
    return this;
  }

  off(signal: ShutdownSignal, listener: () => Promise<void>): this {
    if (this.listeners.get(signal) === listener) {
      this.listeners.delete(signal);
    }
    return this;
  }

  async emit(signal: ShutdownSignal): Promise<void> {
    await this.listeners.get(signal)?.();
  }
}

class ClosingRedisGateway implements RedisGateway {
  closeCalls = 0;

  async connect(): Promise<boolean> {
    return false;
  }

  async checkHealth(): Promise<RedisHealth> {
    return {
      connected: false,
      status: 'disconnected',
      error: {
        code: 'REDIS_UNAVAILABLE',
        message: 'Redis is unavailable',
      },
    };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

const config: DaemonConfig = {
  host: '127.0.0.1',
  port: 4782,
  redisUrl: 'redis://127.0.0.1:6379',
  logLevel: 'info',
  workspaceId: 'workspace-1',
};

describe('graceful shutdown', () => {
  it('closes the daemon exactly once when a termination signal arrives', async () => {
    const redis = new ClosingRedisGateway();
    const app = buildDaemon({
      config,
      redis,
      logger: false,
    });
    const signals = new FakeSignalSource();
    const controller = installGracefulShutdown(app, signals);
    await app.ready();

    expect(signals.listeners.has('SIGINT')).toBe(true);
    expect(signals.listeners.has('SIGTERM')).toBe(true);

    await signals.emit('SIGTERM');
    await controller.shutdown('SIGINT');

    expect(redis.closeCalls).toBe(1);

    controller.dispose();
    expect(signals.listeners.size).toBe(0);
  });
});
