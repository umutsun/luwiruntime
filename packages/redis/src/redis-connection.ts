import { createClient } from 'redis';

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
  onError?: (error: Error) => void;
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
): ManagedRedisConnection {
  const client = createClient({
    url: options.url,
    socket: {
      connectTimeout: options.connectTimeoutMs ?? 2_000,
      reconnectStrategy: false,
    },
  });
  client.on('error', options.onError ?? (() => undefined));
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
      await client.connect();
    },
    quit: () => client.quit(),
    disconnect: () => client.disconnect(),
    async sendCommand(arguments_) {
      try {
        return await client.sendCommand([...arguments_]);
      } catch (error) {
        if (!client.isReady || isConnectionFailure(error)) {
          throw new RedisRepositoryError('REDIS_UNAVAILABLE', 'Redis is unavailable.');
        }
        throw error;
      }
    },
  };
  return managed;
}
