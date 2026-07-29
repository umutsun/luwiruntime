import type { ManagedRedisConnection } from '@luwi/redis';
import { describe, expect, it } from 'vitest';

import type { DaemonConfig } from './config.js';
import { startDaemon } from './runtime.js';
import type { ShutdownSignal, ShutdownSignalListener, SignalSource } from './shutdown.js';

class FailingConnection implements ManagedRedisConnection {
  isOpen = false;
  isReady = false;
  connectCalls = 0;

  on(): this {
    return this;
  }
  async connect(): Promise<void> {
    this.connectCalls += 1;
    throw new Error('Redis unavailable');
  }
  async sendCommand(): Promise<unknown> {
    throw new Error('Redis unavailable');
  }
  async quit(): Promise<string> {
    this.isOpen = false;
    this.isReady = false;
    return 'OK';
  }
  disconnect(): void {
    this.isOpen = false;
    this.isReady = false;
  }
}

class CapturingSignals implements SignalSource {
  readonly listeners = new Map<ShutdownSignal, ShutdownSignalListener>();

  once(signal: ShutdownSignal, listener: ShutdownSignalListener): this {
    this.listeners.set(signal, listener);
    return this;
  }

  off(signal: ShutdownSignal, listener: ShutdownSignalListener): this {
    if (this.listeners.get(signal) === listener) {
      this.listeners.delete(signal);
    }
    return this;
  }
}

const ephemeralConfig: DaemonConfig = {
  host: '127.0.0.1',
  port: 0,
  redisUrl: 'redis://127.0.0.1:6379',
  logLevel: 'info',
  workspaceId: 'workspace-1',
};

describe('daemon runtime', () => {
  it('does not open the listener or signal handlers when Redis bootstrap fails', async () => {
    const command = new FailingConnection();
    const admin = new FailingConnection();
    const relay = new FailingConnection();
    const signals = new CapturingSignals();

    await expect(
      startDaemon({
        config: ephemeralConfig,
        logger: false,
        signals,
        connections: { command, admin, relay },
      }),
    ).rejects.toThrow('Redis unavailable');

    expect(command.connectCalls).toBe(1);
    expect(admin.connectCalls).toBe(0);
    expect(relay.connectCalls).toBe(0);
    expect(signals.listeners.size).toBe(0);
  });
});
