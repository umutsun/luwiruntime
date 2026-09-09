import { randomUUID } from 'node:crypto';

import type { BridgeSlotAcquireBody, BridgeSlotView } from '@luwi/protocol';
import type { BridgeSlotRepository, BridgeSlotResult } from '@luwi/redis';
import { ApplicationError, type ExpireLeaseResult } from '@luwi/runtime';

/**
 * Bridge slot ownership (event-driven wake dispatcher, "supervised bridge
 * singleton").
 *
 * The Redis Function owns the compare-and-set: one owner token per
 * `(workspace, project, agent)` tuple, a 15 s owner key, fenced attach and
 * release. This service owns what the Function deliberately does not: the
 * daemon's workspace id (a caller never names another workspace), event ids,
 * and what each refusal means to an HTTP caller. The owner token passes
 * through untouched and is never part of a returned view.
 */

export type BridgeSlotTransition = {
  status: 'acquired' | 'held' | 'renewed' | 'attached' | 'released' | 'unchanged';
  slot: BridgeSlotView;
};

export type BridgeSlotService = {
  acquire(input: BridgeSlotAcquireBody): Promise<BridgeSlotTransition>;
  renew(slotId: string, ownerToken: string): Promise<BridgeSlotTransition>;
  attach(slotId: string, ownerToken: string, sessionId: string): Promise<BridgeSlotTransition>;
  release(slotId: string, ownerToken: string): Promise<BridgeSlotTransition>;
  get(slotId: string): Promise<BridgeSlotView>;
  list(limit: number): Promise<BridgeSlotView[]>;
  /** Used by the background sweep; never by an HTTP caller. */
  expire(slotId: string): Promise<ExpireLeaseResult>;
  findDue(limit: number): Promise<string[]>;
};

export function createBridgeSlotService(options: {
  repository: BridgeSlotRepository;
  workspaceId: string;
  createId?: () => string;
}): BridgeSlotService {
  const createId = options.createId ?? randomUUID;

  const requireSlot = async (slotId: string): Promise<BridgeSlotView> => {
    const slot = await options.repository.get(slotId);
    if (slot === null) {
      throw new ApplicationError('BRIDGE_SLOT_NOT_FOUND', 'Bridge slot not found.', 404);
    }
    return slot;
  };

  /** The stored tuple plus the caller's token: a body never re-declares the tuple. */
  const ownerInput = (slot: BridgeSlotView, ownerToken: string) => ({
    workspaceId: slot.workspaceId,
    projectId: slot.projectId,
    agentId: slot.agentId,
    provider: slot.provider,
    executionProfile: slot.executionProfile,
    ownerToken,
  });

  const settle = async (
    slotId: string,
    result: BridgeSlotResult,
  ): Promise<BridgeSlotTransition> => {
    if (result.status === 'not_owner') {
      throw new ApplicationError(
        'BRIDGE_SLOT_NOT_OWNER',
        'The bridge slot is not owned by this token.',
        409,
      );
    }
    if (result.status === 'unchanged') {
      return { status: 'unchanged', slot: result.slot ?? (await requireSlot(slotId)) };
    }
    if (result.status === 'expired') {
      throw new ApplicationError(
        'BRIDGE_SLOT_STATE_INVALID',
        'The bridge slot transition produced an unexpected state.',
        500,
      );
    }
    return { status: result.status, slot: result.slot };
  };

  return {
    async acquire(input) {
      const request = { ...input, workspaceId: options.workspaceId };
      const result = await options.repository.acquire({
        ...request,
        eventId: createId(),
        expiredEventId: createId(),
      });
      // The slot id is derived inside the repository; a refusal carries the
      // public slot, so `settle` can re-read by the id it reports.
      return settle(result.status === 'not_owner' ? '' : (result.slot?.id ?? ''), result);
    },

    async renew(slotId, ownerToken) {
      const slot = await requireSlot(slotId);
      return settle(slotId, await options.repository.renew(ownerInput(slot, ownerToken)));
    },

    async attach(slotId, ownerToken, sessionId) {
      const slot = await requireSlot(slotId);
      return settle(
        slotId,
        await options.repository.attachSession({
          ...ownerInput(slot, ownerToken),
          sessionId,
          eventId: createId(),
        }),
      );
    },

    async release(slotId, ownerToken) {
      const slot = await requireSlot(slotId);
      return settle(
        slotId,
        await options.repository.release({ ...ownerInput(slot, ownerToken), eventId: createId() }),
      );
    },

    get: requireSlot,

    list: (limit) => options.repository.list(limit),

    async expire(slotId) {
      const slot = await options.repository.get(slotId);
      if (slot === null || slot.state !== 'active') return 'unchanged';
      const result = await options.repository.expire({ slot, eventId: createId() });
      return result.status === 'expired' ? 'expired' : 'unchanged';
    },

    async findDue(limit) {
      return (await options.repository.findDue(limit)).map((slot) => slot.id);
    },
  };
}
