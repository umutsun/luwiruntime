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
});
