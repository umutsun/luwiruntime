import type { BridgeSlotView } from '@luwi/protocol';
import type { BridgeSlotRepository } from '@luwi/redis';
import { describe, expect, it, vi } from 'vitest';

import { createBridgeSlotService } from './bridge-slot-service.js';

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

const acquireBody = {
  projectId: 'project-1',
  agentId: 'codex',
  ownerToken: 'token-1',
  provider: 'codex' as const,
  executionProfile: 'workspace-write' as const,
};

function build(repository: Partial<BridgeSlotRepository>) {
  let ids = 0;
  return createBridgeSlotService({
    repository: repository as BridgeSlotRepository,
    workspaceId: 'local',
    createId: () => `event-${String((ids += 1))}`,
  });
}

describe('createBridgeSlotService acquire', () => {
  it('acquires under the daemon workspace with minted event ids', async () => {
    const acquire = vi.fn().mockResolvedValue({ status: 'acquired', slot });
    const service = build({ acquire });

    await expect(service.acquire(acquireBody)).resolves.toEqual({ status: 'acquired', slot });
    expect(acquire).toHaveBeenCalledWith({
      ...acquireBody,
      workspaceId: 'local',
      eventId: 'event-1',
      expiredEventId: 'event-2',
    });
  });

  /** A held slot is the runtime answering who owns it, not a fault. */
  it('returns held as an answer carrying the public slot', async () => {
    const service = build({ acquire: vi.fn().mockResolvedValue({ status: 'held', slot }) });

    await expect(service.acquire(acquireBody)).resolves.toEqual({ status: 'held', slot });
  });
});

describe('createBridgeSlotService owner transitions', () => {
  it('renews with the stored tuple and the caller token', async () => {
    const renewed = { ...slot, expiresAt: '2026-09-09T12:00:30.000Z' };
    const renew = vi.fn().mockResolvedValue({ status: 'renewed', slot: renewed });
    const service = build({ get: vi.fn().mockResolvedValue(slot), renew });

    await expect(service.renew(slotId, 'token-1')).resolves.toEqual({
      status: 'renewed',
      slot: renewed,
    });
    expect(renew).toHaveBeenCalledWith({
      workspaceId: 'local',
      projectId: 'project-1',
      agentId: 'codex',
      provider: 'codex',
      executionProfile: 'workspace-write',
      ownerToken: 'token-1',
    });
  });

  it('refuses a stale token as a conflict, never a server fault', async () => {
    const service = build({
      get: vi.fn().mockResolvedValue(slot),
      renew: vi.fn().mockResolvedValue({ status: 'not_owner' }),
    });

    await expect(service.renew(slotId, 'stale')).rejects.toMatchObject({
      code: 'BRIDGE_SLOT_NOT_OWNER',
      statusCode: 409,
    });
  });

  it('answers a missing slot with 404', async () => {
    const service = build({ get: vi.fn().mockResolvedValue(null), renew: vi.fn() });

    await expect(service.renew(slotId, 'token-1')).rejects.toMatchObject({
      code: 'BRIDGE_SLOT_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('attaches a session and re-reads an unchanged reply that carries no slot', async () => {
    const attachSession = vi.fn().mockResolvedValue({ status: 'unchanged' });
    const get = vi.fn().mockResolvedValue({ ...slot, sessionId: 'session-1' });
    const service = build({ get, attachSession });

    await expect(service.attach(slotId, 'token-1', 'session-1')).resolves.toEqual({
      status: 'unchanged',
      slot: { ...slot, sessionId: 'session-1' },
    });
    expect(attachSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        ownerToken: 'token-1',
        eventId: 'event-1',
      }),
    );
  });

  it('releases with an event id', async () => {
    const released = { ...slot, state: 'standby' as const, revision: 2 };
    const release = vi.fn().mockResolvedValue({ status: 'released', slot: released });
    const service = build({ get: vi.fn().mockResolvedValue(slot), release });

    await expect(service.release(slotId, 'token-1')).resolves.toEqual({
      status: 'released',
      slot: released,
    });
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'event-1' }));
  });
});

describe('createBridgeSlotService expiry sweep', () => {
  it('expires only an active slot and reports anything else unchanged', async () => {
    const expire = vi
      .fn()
      .mockResolvedValue({ status: 'expired', slot: { ...slot, state: 'expired' } });
    const active = build({ get: vi.fn().mockResolvedValue(slot), expire });
    const standby = build({
      get: vi.fn().mockResolvedValue({ ...slot, state: 'standby' }),
      expire: vi.fn(),
    });
    const gone = build({ get: vi.fn().mockResolvedValue(null), expire: vi.fn() });

    await expect(active.expire(slotId)).resolves.toBe('expired');
    expect(expire).toHaveBeenCalledWith({ slot, eventId: 'event-1' });
    await expect(standby.expire(slotId)).resolves.toBe('unchanged');
    await expect(gone.expire(slotId)).resolves.toBe('unchanged');
  });

  it('lists due slot ids from the repository deadline scan', async () => {
    const service = build({ findDue: vi.fn().mockResolvedValue([slot]) });

    await expect(service.findDue(25)).resolves.toEqual([slotId]);
  });
});
