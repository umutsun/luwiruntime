import type { BridgeSlotView } from '@luwi/protocol';
import { ApplicationError } from '@luwi/runtime';
import { describe, expect, it, vi } from 'vitest';

import { createBridgeSlotOwner, type BridgeSlotClient } from './bridge-slot-owner.js';

const slotId = 'a'.repeat(64);
const slot: BridgeSlotView = {
  id: slotId,
  workspaceId: 'local',
  projectId: 'project-1',
  agentId: 'codex',
  provider: 'codex',
  executionProfile: 'workspace-write',
  state: 'active',
  revision: 1,
  expiresAt: '2026-09-09T12:00:15.000Z',
};
const tuple = {
  projectId: 'project-1',
  agentId: 'codex',
  provider: 'codex' as const,
  executionProfile: 'workspace-write' as const,
};

function harness(client: Partial<BridgeSlotClient>, overrides: Record<string, unknown> = {}) {
  const timers: Array<{ callback: () => void; intervalMs: number }> = [];
  const cleared: unknown[] = [];
  // Starts 15 s before the fixture slot's `expiresAt`, the deadline the owner trusts.
  let nowMs = Date.parse('2026-09-09T12:00:00.000Z');
  const lost: string[] = [];
  const errors: unknown[] = [];
  const owner = createBridgeSlotOwner({
    client: client as BridgeSlotClient,
    slot: tuple,
    ownerToken: 'token-1',
    renewIntervalMs: 5_000,
    now: () => nowMs,
    setInterval: ((callback: () => void, intervalMs: number) => {
      timers.push({ callback, intervalMs });
      return timers.length as unknown as NodeJS.Timeout;
    }) as never,
    clearInterval: ((timer: unknown) => {
      cleared.push(timer);
    }) as never,
    onLost: (reason: string) => lost.push(reason),
    onError: (error: unknown) => errors.push(error),
    ...overrides,
  });
  return {
    owner,
    timers,
    cleared,
    lost,
    errors,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('bridge slot owner', () => {
  it('acquires with its own token and arms renewal at the configured cadence', async () => {
    const acquire = vi.fn(async () => ({ status: 'acquired' as const, slot }));
    const { owner, timers } = harness({ acquire });

    await expect(owner.acquire()).resolves.toBe('acquired');

    expect(acquire).toHaveBeenCalledWith({ ...tuple, ownerToken: 'token-1' });
    expect(owner.declaration).toEqual({
      slotId,
      ownerToken: 'token-1',
      provider: 'codex',
      executionProfile: 'workspace-write',
    });
    expect(timers).toEqual([expect.objectContaining({ intervalMs: 5_000 })]);
  });

  /** A held slot means stand by: no timer, no declaration, nothing to release. */
  it('stands by on held without arming renewal', async () => {
    const { owner, timers } = harness({
      acquire: vi.fn(async () => ({ status: 'held' as const, slot })),
    });

    await expect(owner.acquire()).resolves.toBe('held');

    expect(owner.declaration).toBeUndefined();
    expect(timers).toHaveLength(0);
  });

  it('renews on each tick with the slot id and token', async () => {
    const renew = vi.fn(async () => ({ status: 'renewed' as const, slot }));
    const { owner, timers } = harness({
      acquire: vi.fn(async () => ({ status: 'acquired' as const, slot })),
      renew,
    });
    await owner.acquire();

    timers[0]!.callback();
    await flush();

    expect(renew).toHaveBeenCalledWith(slotId, 'token-1');
  });

  /**
   * A refused renewal is definitive: another owner holds the tuple. The
   * worker must stop, exactly once, and never renew again.
   */
  it('reports lost ownership once when a renewal is refused, and disarms', async () => {
    const renew = vi.fn(async () => {
      throw new ApplicationError('BRIDGE_SLOT_NOT_OWNER', 'not owner', 409);
    });
    const { owner, timers, cleared, lost } = harness({
      acquire: vi.fn(async () => ({ status: 'acquired' as const, slot })),
      renew,
    });
    await owner.acquire();

    timers[0]!.callback();
    await flush();
    timers[0]!.callback();
    await flush();

    expect(lost).toEqual(['refused']);
    expect(cleared).toHaveLength(1);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(owner.declaration).toBeUndefined();
  });

  /**
   * A transient failure is tolerated only while the last proven renewal is
   * still inside the 15 s TTL; past it, ownership is unprovable and the
   * worker must not keep claiming work under a token that may be dead.
   */
  it('treats renewal failures past the slot TTL as lost ownership', async () => {
    const renew = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const { owner, timers, lost, errors, advance } = harness({
      acquire: vi.fn(async () => ({ status: 'acquired' as const, slot })),
      renew,
    });
    await owner.acquire();

    advance(5_000);
    timers[0]!.callback();
    await flush();
    expect(lost).toEqual([]);
    expect(errors).toHaveLength(1);

    advance(10_000);
    timers[0]!.callback();
    await flush();
    expect(lost).toEqual(['unprovable']);
  });

  it('releases with the token, disarms, and forgets the declaration', async () => {
    const release = vi.fn(async () => ({ status: 'released' as const, slot }));
    const { owner, cleared } = harness({
      acquire: vi.fn(async () => ({ status: 'acquired' as const, slot })),
      release,
    });
    await owner.acquire();

    await owner.release();

    expect(release).toHaveBeenCalledWith(slotId, 'token-1');
    expect(cleared).toHaveLength(1);
    expect(owner.declaration).toBeUndefined();
  });

  it('release is a no-op when nothing is owned', async () => {
    const release = vi.fn();
    const { owner } = harness({ release });

    await owner.release();

    expect(release).not.toHaveBeenCalled();
  });
});
