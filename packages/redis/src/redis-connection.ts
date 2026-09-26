import { performance } from 'node:perf_hooks';

import { createClient, ErrorReply, TimeoutError } from 'redis';

import { RedisRepositoryError, type RedisCommandClient } from './runtime-repository.js';

export interface ManagedRedisConnection extends RedisCommandClient {
  readonly isOpen: boolean;
  readonly isReady: boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  connect(): Promise<void>;
  quit(): Promise<string>;
  disconnect(): void;
}

export type ManagedRedisConnectionOptions = {
  url: string;
  connectTimeoutMs?: number;
  /**
   * How long a connection may do nothing but time out before it is treated as lost.
   * node-redis times a command out only while it is still unwritten, so an unbroken run of
   * timeouts means the client has stopped writing, and nothing inside it will recover: it
   * stays `isReady` on a healthy socket and never emits `error` (measured 2026-09-25, when
   * a corrupted write queue timed every command out for 36 minutes). Healthy stalls on that
   * daemon completed a command within ~0.2 s of their first timeout.
   */
  stalledAfterMs?: number;
  onError?: (error: Error) => void;
};

export interface NodeRedisClientLike {
  readonly isOpen: boolean;
  readonly isReady: boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  connect(): Promise<unknown>;
  quit(): Promise<string>;
  disconnect(): Promise<void>;
  destroy(): void;
  sendCommand(arguments_: string[]): Promise<unknown>;
}

export type ManagedRedisConnectionDependencies = {
  createClient: (options: Parameters<typeof createClient>[0]) => NodeRedisClientLike;
  now: () => number;
};

const defaultDependencies: ManagedRedisConnectionDependencies = {
  createClient: (options) => createClient(options) as unknown as NodeRedisClientLike,
  now: () => performance.now(),
};

function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return (
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'].includes(code ?? '') ||
    /SocketClosed|ClientClosed|ConnectionTimeout/i.test(error.name) ||
    /socket (?:closed|unavailable)|client is closed|connection (?:closed|lost|timeout)/i.test(
      error.message,
    )
  );
}

export function createManagedRedisConnection(
  options: ManagedRedisConnectionOptions,
  dependencies: ManagedRedisConnectionDependencies = defaultDependencies,
): ManagedRedisConnection {
  const client = dependencies.createClient({
    url: options.url,
    socket: {
      connectTimeout: options.connectTimeoutMs ?? 2_000,
      reconnectStrategy: false,
    },
  });
  const onError = options.onError ?? (() => undefined);
  const stalledAfterMs = options.stalledAfterMs ?? 15_000;
  let timingOutSince: number | undefined;
  client.on('error', onError);
  const managed: ManagedRedisConnection = {
    get isOpen() {
      return client.isOpen;
    },
    get isReady() {
      return client.isReady;
    },
    on(event, listener) {
      client.on(event, listener);
      return managed;
    },
    async connect() {
      timingOutSince = undefined;
      await client.connect();
    },
    quit: () => client.quit(),
    disconnect: () => void client.disconnect(),
    async sendCommand(arguments_) {
      try {
        const reply = await client.sendCommand([...arguments_]);
        timingOutSince = undefined;
        return reply;
      } catch (error) {
        if (error instanceof ErrorReply) {
          timingOutSince = undefined;
        }
        if (error instanceof TimeoutError && client.isOpen) {
          const now = dependencies.now();
          timingOutSince ??= now;
          if (now - timingOutSince >= stalledAfterMs) {
            // Destroying drops the stuck queue and clears isReady, so the owner's
            // recovery reconnects instead of treating a ready client as healthy.
            timingOutSince = undefined;
            client.destroy();
            onError(new Error(`Redis commands stalled for ${stalledAfterMs} ms.`));
            throw new RedisRepositoryError('REDIS_UNAVAILABLE', 'Redis is unavailable.');
          }
        }
        if (!client.isReady || isConnectionFailure(error)) {
          throw new RedisRepositoryError('REDIS_UNAVAILABLE', 'Redis is unavailable.');
        }
        throw error;
      }
    },
  };
  return managed;
}
