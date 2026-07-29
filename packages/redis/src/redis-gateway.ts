import { createClient as createNodeRedisClient } from 'redis';

export type RedisGatewayOptions = {
  url: string;
};

export type RedisClientOptions = RedisGatewayOptions & {
  socket: {
    connectTimeout: number;
    reconnectStrategy: false;
  };
};

export type RedisHealth =
  | {
      connected: true;
      status: 'connected';
      latencyMs: number;
    }
  | {
      connected: false;
      status: 'disconnected';
      error: {
        code: 'REDIS_UNAVAILABLE';
        message: 'Redis is unavailable';
      };
    };

export interface RedisClientLike {
  readonly isOpen: boolean;
  readonly isReady: boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  connect(): Promise<void>;
  ping(): Promise<string>;
  quit(): Promise<string>;
  disconnect(): void;
}

export type RedisGatewayDependencies = {
  createClient: (options: RedisClientOptions) => RedisClientLike;
  now: () => number;
  onError: (error: Error) => void;
};

export interface RedisGateway {
  connect(): Promise<boolean>;
  checkHealth(): Promise<RedisHealth>;
  close(): Promise<void>;
}

const unavailableHealth = (): RedisHealth => ({
  connected: false,
  status: 'disconnected',
  error: {
    code: 'REDIS_UNAVAILABLE',
    message: 'Redis is unavailable',
  },
});

const defaultDependencies: RedisGatewayDependencies = {
  createClient: (options) => createNodeRedisClient(options) as unknown as RedisClientLike,
  now: Date.now,
  onError: () => undefined,
};

class NodeRedisGateway implements RedisGateway {
  readonly #client: RedisClientLike;
  readonly #now: () => number;
  readonly #onError: (error: Error) => void;

  constructor(options: RedisClientOptions, dependencies: RedisGatewayDependencies) {
    this.#client = dependencies.createClient(options);
    this.#now = dependencies.now;
    this.#onError = dependencies.onError;
    this.#client.on('error', (error) => this.#onError(error));
  }

  async connect(): Promise<boolean> {
    if (this.#client.isReady) {
      return true;
    }

    try {
      await this.#client.connect();
      return this.#client.isReady;
    } catch (error: unknown) {
      this.#onError(error instanceof Error ? error : new Error('Unknown Redis connection error'));
      return false;
    }
  }

  async checkHealth(): Promise<RedisHealth> {
    if (!this.#client.isReady) {
      return unavailableHealth();
    }

    const startedAt = this.#now();

    try {
      const response = await this.#client.ping();
      if (response !== 'PONG') {
        return unavailableHealth();
      }

      return {
        connected: true,
        status: 'connected',
        latencyMs: Math.max(0, this.#now() - startedAt),
      };
    } catch (error: unknown) {
      this.#onError(error instanceof Error ? error : new Error('Unknown Redis ping error'));
      return unavailableHealth();
    }
  }

  async close(): Promise<void> {
    if (!this.#client.isOpen) {
      return;
    }

    try {
      await this.#client.quit();
    } catch (error: unknown) {
      this.#onError(error instanceof Error ? error : new Error('Unknown Redis shutdown error'));
      this.#client.disconnect();
    }
  }
}

export function createRedisGateway(
  options: RedisGatewayOptions,
  dependencies: Partial<RedisGatewayDependencies> = {},
): RedisGateway {
  return new NodeRedisGateway(
    {
      ...options,
      socket: {
        connectTimeout: 2000,
        reconnectStrategy: false,
      },
    },
    {
      ...defaultDependencies,
      ...dependencies,
    },
  );
}
