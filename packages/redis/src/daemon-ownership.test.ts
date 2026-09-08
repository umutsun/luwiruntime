import { describe, expect, it, vi } from 'vitest';

import { createDaemonOwnershipLease, type RedisCommandClient } from './index.js';
import type { DaemonOwnershipError } from './index.js';

class FakeClient implements RedisCommandClient {
  readonly commands: string[][] = [];
  replies: unknown[] = [];

  async sendCommand(arguments_: readonly string[]): Promise<unknown> {
    this.commands.push([...arguments_]);
    return this.replies.shift();
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('daemon ownership lease', () => {
  it('acquires with SET NX PX and renews/releases by compare-token scripts', async () => {
    const client = new FakeClient();
    client.replies = ['OK', 1, 1];
    const lease = createDaemonOwnershipLease({
      client,
      key: 'luwi:v1:runtime:daemon-owner',
      runtimeInstanceId: 'runtime-1',
      ttlMs: 15_000,
      renewIntervalMs: 5_000,
      createNonce: () => 'nonce-1',
      setInterval: () => ({}) as NodeJS.Timeout,
      clearInterval: () => undefined,
      onLost: vi.fn(),
    });

    await lease.acquire();
    await expect(lease.renewOnce()).resolves.toBe(true);
    await expect(lease.release()).resolves.toBe(true);
    expect(client.commands[0]).toEqual([
      'SET',
      'luwi:v1:runtime:daemon-owner',
      lease.ownerToken,
      'NX',
      'PX',
      '15000',
    ]);
    expect(lease.ownerToken).toContain('runtime-1');
    expect(client.commands[1]?.[0]).toBe('EVAL');
    expect(client.commands[1]?.slice(-3)).toEqual([
      'luwi:v1:runtime:daemon-owner',
      lease.ownerToken,
      '15000',
    ]);
    expect(client.commands[2]?.[0]).toBe('EVAL');
  });

  it('fails without mutating bootstrap state when another owner exists', async () => {
    const client = new FakeClient();
    client.replies = [null];
    const lease = createDaemonOwnershipLease({
      client,
      key: 'luwi:v1:runtime:daemon-owner',
      runtimeInstanceId: 'runtime-2',
      ttlMs: 15_000,
      renewIntervalMs: 5_000,
      setInterval: () => ({}) as NodeJS.Timeout,
      clearInterval: () => undefined,
      onLost: vi.fn(),
    });

    await expect(lease.acquire()).rejects.toEqual(
      expect.objectContaining<Partial<DaemonOwnershipError>>({
        code: 'DAEMON_ALREADY_RUNNING',
      }),
    );
    expect(client.commands).toHaveLength(1);
  });

  it('notifies once when ownership renewal is lost', async () => {
    const client = new FakeClient();
    client.replies = ['OK', 0, 0];
    const onLost = vi.fn();
    const lease = createDaemonOwnershipLease({
      client,
      key: 'owner',
      runtimeInstanceId: 'runtime-3',
      ttlMs: 15_000,
      renewIntervalMs: 5_000,
      setInterval: () => ({}) as NodeJS.Timeout,
      clearInterval: () => undefined,
      onLost,
    });
    await lease.acquire();

    await lease.renewOnce();
    await lease.renewOnce();

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(lease.isOwned).toBe(false);
  });

  it('revalidates the owner token after a transient renewal failure', async () => {
    const client = new FakeClient();
    const lease = createDaemonOwnershipLease({
      client,
      key: 'owner',
      runtimeInstanceId: 'runtime-4',
      ttlMs: 15_000,
      renewIntervalMs: 5_000,
      createNonce: () => 'nonce-4',
      setInterval: () => ({}) as NodeJS.Timeout,
      clearInterval: () => undefined,
      onLost: vi.fn(),
    });
    client.replies = ['OK', 0, lease.ownerToken];
    await lease.acquire();
    await lease.renewOnce();

    await expect(lease.ownsLease()).resolves.toBe(true);
    expect(lease.isOwned).toBe(true);
  });

  it('notifies again after successful ownership revalidation and a second loss', async () => {
    const client = new FakeClient();
    const onLost = vi.fn();
    const lease = createDaemonOwnershipLease({
      client,
      key: 'owner',
      runtimeInstanceId: 'runtime-revalidated-loss',
      ttlMs: 15_000,
      renewIntervalMs: 5_000,
      createNonce: () => 'nonce-revalidated-loss',
      setInterval: () => ({}) as NodeJS.Timeout,
      clearInterval: () => undefined,
      onLost,
    });
    client.replies = ['OK', 0, lease.ownerToken, 0];

    await lease.acquire();
    await expect(lease.renewOnce()).resolves.toBe(false);
    expect(onLost).toHaveBeenCalledTimes(1);

    await expect(lease.ownsLease()).resolves.toBe(true);
    await expect(lease.renewOnce()).resolves.toBe(false);

    expect(onLost).toHaveBeenCalledTimes(2);
    expect(lease.isOwned).toBe(false);
  });

  it('reacquires an expired owner key with the same token and no second timer', async () => {
    const client = new FakeClient();
    client.replies = ['OK', 0, 'OK'];
    const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const setInterval = vi.fn(() => timer);
    const onLost = vi.fn();
    const lease = createDaemonOwnershipLease({
      client,
      key: 'owner',
      runtimeInstanceId: 'runtime-sleep',
      ttlMs: 15_000,
      renewIntervalMs: 5_000,
      createNonce: () => 'nonce-sleep',
      setInterval,
      clearInterval: vi.fn(),
      onLost,
    });

    await lease.acquire();
    await expect(lease.renewOnce()).resolves.toBe(false);
    await expect(lease.reacquire()).resolves.toBe(true);

    expect(lease.isOwned).toBe(true);
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(client.commands[2]).toEqual(['SET', 'owner', lease.ownerToken, 'NX', 'PX', '15000']);
  });

  it('does not overwrite a competing owner while trying to reacquire', async () => {
    const client = new FakeClient();
    client.replies = ['OK', 0, null];
    const lease = createDaemonOwnershipLease({
      client,
      key: 'owner',
      runtimeInstanceId: 'runtime-old',
      ttlMs: 15_000,
      renewIntervalMs: 5_000,
      setInterval: () => ({}) as NodeJS.Timeout,
      clearInterval: () => undefined,
      onLost: vi.fn(),
    });

    await lease.acquire();
    await lease.renewOnce();

    await expect(lease.reacquire()).resolves.toBe(false);
    expect(lease.isOwned).toBe(false);
    expect(client.commands[2]?.slice(0, 2)).toEqual(['SET', 'owner']);
    expect(client.commands[2]?.slice(-3)).toEqual(['NX', 'PX', '15000']);
  });

  it('refuses reacquisition outside an acquired lifecycle', async () => {
    const client = new FakeClient();
    const lease = createDaemonOwnershipLease({
      client,
      key: 'owner',
      runtimeInstanceId: 'runtime-never-started',
      ttlMs: 15_000,
      renewIntervalMs: 5_000,
      setInterval: () => ({}) as NodeJS.Timeout,
      clearInterval: () => undefined,
      onLost: vi.fn(),
    });

    await expect(lease.reacquire()).rejects.toThrow(/active ownership lifecycle/i);
    expect(client.commands).toEqual([]);
  });

  it('stays unowned when reacquisition cannot reach Redis', async () => {
    const sendCommand = vi
      .fn<RedisCommandClient['sendCommand']>()
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('Redis unavailable'));
    const lease = createDaemonOwnershipLease({
      client: { sendCommand },
      key: 'owner',
      runtimeInstanceId: 'runtime-error',
      ttlMs: 15_000,
      renewIntervalMs: 5_000,
      setInterval: () => ({}) as NodeJS.Timeout,
      clearInterval: () => undefined,
      onLost: vi.fn(),
    });

    await lease.acquire();
    await lease.renewOnce();
    await expect(lease.reacquire()).rejects.toThrow('Redis unavailable');
    expect(lease.isOwned).toBe(false);
  });

  it('can notify once again after ownership was reacquired', async () => {
    const client = new FakeClient();
    client.replies = ['OK', 0, 'OK', 0];
    const onLost = vi.fn();
    const lease = createDaemonOwnershipLease({
      client,
      key: 'owner',
      runtimeInstanceId: 'runtime-repeat-loss',
      ttlMs: 15_000,
      renewIntervalMs: 5_000,
      setInterval: () => ({}) as NodeJS.Timeout,
      clearInterval: () => undefined,
      onLost,
    });

    await lease.acquire();
    await lease.renewOnce();
    expect(onLost).toHaveBeenCalledTimes(1);

    await lease.reacquire();
    await lease.renewOnce();
    expect(onLost).toHaveBeenCalledTimes(2);
  });

  it('checks Redis when a stale local owner has been replaced without a renewal', async () => {
    const client = new FakeClient();
    client.replies = ['OK', null];
    const lease = createDaemonOwnershipLease({
      client,
      key: 'owner',
      runtimeInstanceId: 'runtime-stale',
      ttlMs: 15_000,
      renewIntervalMs: 5_000,
      setInterval: () => ({}) as NodeJS.Timeout,
      clearInterval: () => undefined,
      onLost: vi.fn(),
    });

    await lease.acquire();

    await expect(lease.reacquire()).resolves.toBe(false);
    expect(lease.isOwned).toBe(false);
    expect(client.commands[1]).toEqual(['SET', 'owner', lease.ownerToken, 'NX', 'PX', '15000']);
  });

  it('clears local ownership before its Redis release command completes', async () => {
    const release = createDeferred<unknown>();
    const lease = createDaemonOwnershipLease({
      client: {
        sendCommand(arguments_) {
          return arguments_[0] === 'SET' ? Promise.resolve('OK') : release.promise;
        },
      },
      key: 'owner',
      runtimeInstanceId: 'runtime-release-fence',
      ttlMs: 15_000,
      renewIntervalMs: 5_000,
      setInterval: () => ({}) as NodeJS.Timeout,
      clearInterval: () => undefined,
      onLost: vi.fn(),
    });

    await lease.acquire();
    const releaseResult = lease.release();

    expect(lease.isOwned).toBe(false);
    release.resolve(1);
    await expect(releaseResult).resolves.toBe(true);
  });

  it('rejects a later reacquire after release while an older claim is pending', async () => {
    const claim = createDeferred<unknown>();
    const commands: string[][] = [];
    let setCalls = 0;
    const lease = createDaemonOwnershipLease({
      client: {
        sendCommand(arguments_) {
          commands.push([...arguments_]);
          if (arguments_[0] === 'SET') {
            setCalls += 1;
            return setCalls === 1 ? Promise.resolve('OK') : claim.promise;
          }
          return Promise.resolve(0);
        },
      },
      key: 'owner',
      runtimeInstanceId: 'runtime-fenced-reacquire',
      ttlMs: 15_000,
      renewIntervalMs: 5_000,
      setInterval: () => ({}) as NodeJS.Timeout,
      clearInterval: () => undefined,
      onLost: vi.fn(),
    });

    await lease.acquire();
    await lease.renewOnce();
    const olderReacquire = lease.reacquire();
    await lease.release();
    const laterReacquire = lease.reacquire();

    expect(commands.filter((command) => command[0] === 'SET')).toHaveLength(2);
    claim.resolve(null);

    await expect(olderReacquire).resolves.toBe(false);
    await expect(laterReacquire).rejects.toThrow(/active ownership lifecycle/i);
  });

  it('cleans a claim that reaches Redis after release has completed', async () => {
    const commands: string[][] = [];
    const claim = createDeferred<unknown>();
    const release = createDeferred<unknown>();
    const cleanup = createDeferred<unknown>();
    let setCalls = 0;
    let evalCalls = 0;
    const lease = createDaemonOwnershipLease({
      client: {
        sendCommand(arguments_) {
          commands.push([...arguments_]);
          if (arguments_[0] === 'SET') {
            setCalls += 1;
            return setCalls === 1 ? Promise.resolve('OK') : claim.promise;
          }
          evalCalls += 1;
          if (evalCalls === 1) {
            return Promise.resolve(0);
          }
          return evalCalls === 2 ? release.promise : cleanup.promise;
        },
      },
      key: 'owner',
      runtimeInstanceId: 'runtime-release-first',
      ttlMs: 15_000,
      renewIntervalMs: 5_000,
      setInterval: () => ({}) as NodeJS.Timeout,
      clearInterval: () => undefined,
      onLost: vi.fn(),
    });

    await lease.acquire();
    await lease.renewOnce();
    const reacquire = lease.reacquire();
    const releaseResult = lease.release();
    expect(lease.isOwned).toBe(false);

    release.resolve(0);
    await expect(releaseResult).resolves.toBe(false);
    claim.resolve('OK');
    await vi.waitFor(() => expect(commands).toHaveLength(5));
    cleanup.resolve(1);

    await expect(reacquire).resolves.toBe(false);
    expect(lease.isOwned).toBe(false);
    expect(commands[4]?.[0]).toBe('EVAL');
  });

  it('does not restore local ownership when release deletes a completed reacquire claim', async () => {
    const commands: string[][] = [];
    const claim = createDeferred<unknown>();
    const release = createDeferred<unknown>();
    const cleanup = createDeferred<unknown>();
    let setCalls = 0;
    let evalCalls = 0;
    const lease = createDaemonOwnershipLease({
      client: {
        sendCommand(arguments_) {
          commands.push([...arguments_]);
          if (arguments_[0] === 'SET') {
            setCalls += 1;
            return setCalls === 1 ? Promise.resolve('OK') : claim.promise;
          }
          evalCalls += 1;
          if (evalCalls === 1) {
            return Promise.resolve(0);
          }
          return evalCalls === 2 ? release.promise : cleanup.promise;
        },
      },
      key: 'owner',
      runtimeInstanceId: 'runtime-claim-first',
      ttlMs: 15_000,
      renewIntervalMs: 5_000,
      setInterval: () => ({}) as NodeJS.Timeout,
      clearInterval: () => undefined,
      onLost: vi.fn(),
    });

    await lease.acquire();
    await lease.renewOnce();
    const reacquire = lease.reacquire();
    const releaseResult = lease.release();
    expect(lease.isOwned).toBe(false);

    claim.resolve('OK');
    await vi.waitFor(() => expect(commands).toHaveLength(5));
    release.resolve(1);
    cleanup.resolve(0);

    await expect(reacquire).resolves.toBe(false);
    await expect(releaseResult).resolves.toBe(true);
    expect(lease.isOwned).toBe(false);
    expect(commands[4]?.[0]).toBe('EVAL');
  });
});
