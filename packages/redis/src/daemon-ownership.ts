import { randomUUID } from 'node:crypto';

import type { RedisCommandClient } from './runtime-repository.js';

const renewScript =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";
const releaseScript =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

export class DaemonOwnershipError extends Error {
  readonly code: 'DAEMON_ALREADY_RUNNING';

  constructor() {
    super('Another LUWI Runtime daemon already owns this Redis runtime.');
    this.name = 'DaemonOwnershipError';
    this.code = 'DAEMON_ALREADY_RUNNING';
  }
}

export interface DaemonOwnershipLease {
  readonly ownerToken: string;
  readonly isOwned: boolean;
  acquire(): Promise<void>;
  renewOnce(): Promise<boolean>;
  ownsLease(): Promise<boolean>;
  release(): Promise<boolean>;
}

export type DaemonOwnershipOptions = {
  client: RedisCommandClient;
  key: string;
  runtimeInstanceId: string;
  ttlMs: number;
  renewIntervalMs: number;
  onLost: () => void;
  createNonce?: () => string;
  setInterval?: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
};

class RedisDaemonOwnershipLease implements DaemonOwnershipLease {
  readonly ownerToken: string;
  readonly #options: Required<
    Pick<DaemonOwnershipOptions, 'createNonce' | 'setInterval' | 'clearInterval'>
  > &
    Omit<DaemonOwnershipOptions, 'createNonce' | 'setInterval' | 'clearInterval'>;
  #isOwned = false;
  #lostNotified = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: DaemonOwnershipOptions) {
    this.#options = {
      ...options,
      createNonce: options.createNonce ?? randomUUID,
      setInterval: options.setInterval ?? setInterval,
      clearInterval: options.clearInterval ?? clearInterval,
    };
    this.ownerToken = `${options.runtimeInstanceId}:${this.#options.createNonce()}`;
  }

  get isOwned(): boolean {
    return this.#isOwned;
  }

  #markLost(): void {
    this.#isOwned = false;
    if (!this.#lostNotified) {
      this.#lostNotified = true;
      this.#options.onLost();
    }
  }

  async acquire(): Promise<void> {
    const reply = await this.#options.client.sendCommand([
      'SET',
      this.#options.key,
      this.ownerToken,
      'NX',
      'PX',
      String(this.#options.ttlMs),
    ]);
    if (reply !== 'OK') {
      throw new DaemonOwnershipError();
    }
    this.#isOwned = true;
    this.#lostNotified = false;
    this.#timer = this.#options.setInterval(() => {
      void this.renewOnce().catch(() => this.#markLost());
    }, this.#options.renewIntervalMs);
    this.#timer.unref?.();
  }

  async renewOnce(): Promise<boolean> {
    if (!this.#isOwned) {
      return false;
    }
    try {
      const reply = await this.#options.client.sendCommand([
        'EVAL',
        renewScript,
        '1',
        this.#options.key,
        this.ownerToken,
        String(this.#options.ttlMs),
      ]);
      const renewed = Number(reply) === 1;
      if (!renewed) {
        this.#markLost();
      }
      return renewed;
    } catch (error) {
      this.#markLost();
      throw error;
    }
  }

  async ownsLease(): Promise<boolean> {
    try {
      const reply = await this.#options.client.sendCommand(['GET', this.#options.key]);
      const owned = reply === this.ownerToken;
      if (owned) {
        this.#isOwned = true;
      } else {
        this.#markLost();
      }
      return owned;
    } catch (error) {
      this.#markLost();
      throw error;
    }
  }

  async release(): Promise<boolean> {
    if (this.#timer !== undefined) {
      this.#options.clearInterval(this.#timer);
      this.#timer = undefined;
    }
    try {
      const reply = await this.#options.client.sendCommand([
        'EVAL',
        releaseScript,
        '1',
        this.#options.key,
        this.ownerToken,
      ]);
      return Number(reply) === 1;
    } finally {
      this.#isOwned = false;
    }
  }
}

export function createDaemonOwnershipLease(options: DaemonOwnershipOptions): DaemonOwnershipLease {
  return new RedisDaemonOwnershipLease(options);
}
