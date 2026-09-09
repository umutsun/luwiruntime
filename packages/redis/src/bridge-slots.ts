import {
  bridgeSlotAcquireRequestSchema,
  bridgeSlotViewSchema,
  type BridgeSlotAcquireRequest,
  type BridgeSlotView,
} from '@luwi/protocol';
import { deriveBridgeSlotId } from '@luwi/runtime';

import type { RedisFunctionRegistry } from './function-registry.js';
import type { RedisKeys } from './redis-keys.js';
import { RedisRepositoryError, type RedisCommandClient } from './runtime-repository.js';

export const BRIDGE_SLOT_TTL_MS = 15_000;
export type BridgeSlotOwnerInput = BridgeSlotAcquireRequest;
export type BridgeSlotAcquireInput = BridgeSlotOwnerInput & {
  eventId: string;
  expiredEventId: string;
};
export type BridgeSlotResult =
  | {
      status: 'acquired' | 'held' | 'renewed' | 'attached' | 'released' | 'expired';
      slot: BridgeSlotView;
    }
  | { status: 'unchanged'; slot?: BridgeSlotView }
  | { status: 'not_owner' };

export interface BridgeSlotRepository {
  acquire(input: BridgeSlotAcquireInput): Promise<BridgeSlotResult>;
  renew(input: BridgeSlotOwnerInput): Promise<BridgeSlotResult>;
  attachSession(
    input: BridgeSlotOwnerInput & { sessionId: string; eventId: string },
  ): Promise<BridgeSlotResult>;
  release(input: BridgeSlotOwnerInput & { eventId: string }): Promise<BridgeSlotResult>;
  expire(input: { slot: BridgeSlotView; eventId: string }): Promise<BridgeSlotResult>;
  get(slotId: string): Promise<BridgeSlotView | null>;
  list(limit?: number): Promise<BridgeSlotView[]>;
  findDue(limit?: number): Promise<BridgeSlotView[]>;
}

function invalid(): never {
  throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned invalid bridge slot state.');
}

function parseSlot(value: unknown, slotId: string): BridgeSlotView {
  const parsed = bridgeSlotViewSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== slotId || deriveBridgeSlotId(parsed.data) !== slotId)
    return invalid();
  return parsed.data;
}

function decode(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return invalid();
  let result: unknown;
  try {
    result = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return invalid();
  return result as Record<string, unknown>;
}

function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new RangeError('Bridge slot limit is invalid.');
  return limit;
}

/** The tuple is always re-derived here; callers never supply raw Redis keys. */
export function createBridgeSlotRepository(options: {
  client: RedisCommandClient;
  keys: RedisKeys;
  functions: RedisFunctionRegistry;
}): BridgeSlotRepository {
  const { client, keys, functions } = options;
  const commandKeys = (slot: {
    workspaceId: string;
    projectId: string;
    agentId: string;
  }): string[] => {
    const id = deriveBridgeSlotId(slot);
    return [
      keys.bridgeSlot(id),
      keys.bridgeSlotOwner(id),
      keys.bridgeSlotsIndex,
      keys.bridgeSlotDeadlines,
      keys.globalEvents,
      keys.projectEvents(slot.projectId),
    ];
  };
  const transition = async (
    name: string,
    input: Record<string, unknown>,
    declaredKeys: string[],
  ): Promise<BridgeSlotResult> => {
    const value = decode(
      await client.sendCommand([
        'FCALL',
        name,
        String(declaredKeys.length),
        ...declaredKeys,
        JSON.stringify(input),
      ]),
    );
    if (value.status === 'error' && typeof value.code === 'string')
      throw new RedisRepositoryError(value.code, 'Redis rejected the bridge slot transition.');
    if (value.status === 'not_owner') return { status: 'not_owner' };
    if (value.status === 'unchanged')
      return {
        status: 'unchanged',
        ...(value.slot === undefined ? {} : { slot: parseSlot(value.slot, String(input.slotId)) }),
      };
    if (
      value.status === 'acquired' ||
      value.status === 'held' ||
      value.status === 'renewed' ||
      value.status === 'attached' ||
      value.status === 'released' ||
      value.status === 'expired'
    ) {
      return { status: value.status, slot: parseSlot(value.slot, String(input.slotId)) };
    }
    return invalid();
  };
  const owner = (input: BridgeSlotOwnerInput) => {
    const parsed = bridgeSlotAcquireRequestSchema.safeParse({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      agentId: input.agentId,
      provider: input.provider,
      executionProfile: input.executionProfile,
      ownerToken: input.ownerToken,
    });
    if (!parsed.success)
      throw new RedisRepositoryError(
        'REDIS_ARGUMENT_INVALID',
        'Bridge owner declaration is invalid.',
      );
    return { ...parsed.data, slotId: deriveBridgeSlotId(parsed.data), ttlMs: BRIDGE_SLOT_TTL_MS };
  };
  const get = async (id: string): Promise<BridgeSlotView | null> => {
    const value = await client.sendCommand(['HGET', keys.bridgeSlot(id), 'json']);
    return value === null ? null : parseSlot(decode(value), id);
  };
  const readMembers = async (reply: unknown, limit: number): Promise<BridgeSlotView[]> => {
    if (
      !Array.isArray(reply) ||
      !reply.every((id): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))
    )
      return invalid();
    const slots: BridgeSlotView[] = [];
    for (const id of reply.slice(0, limit)) {
      const slot = await get(id);
      if (slot === null) return invalid();
      slots.push(slot);
    }
    return slots;
  };
  return {
    acquire: (input) =>
      transition(
        functions.functions.bridgeSlotAcquire,
        { ...owner(input), eventId: input.eventId, expiredEventId: input.expiredEventId },
        commandKeys(input),
      ),
    renew: (input) =>
      transition(
        functions.functions.bridgeSlotRenew,
        { ...owner(input), eventId: 'renew' },
        commandKeys(input),
      ),
    attachSession: (input) =>
      transition(
        functions.functions.bridgeSlotAttach,
        { ...owner(input), sessionId: input.sessionId, eventId: input.eventId },
        [...commandKeys(input), keys.session(input.sessionId)],
      ),
    release: (input) =>
      transition(
        functions.functions.bridgeSlotRelease,
        { ...owner(input), eventId: input.eventId },
        commandKeys(input),
      ),
    expire: ({ slot, eventId }) =>
      transition(
        functions.functions.bridgeSlotExpire,
        {
          slotId: slot.id,
          workspaceId: slot.workspaceId,
          projectId: slot.projectId,
          agentId: slot.agentId,
          provider: slot.provider,
          executionProfile: slot.executionProfile,
          expectedRevision: slot.revision,
          expectedExpiresAt: slot.expiresAt,
          eventId,
        },
        commandKeys(slot),
      ),
    get,
    async list(limit = 1000) {
      boundedLimit(limit);
      return readMembers(
        await client.sendCommand([
          'SORT',
          keys.bridgeSlotsIndex,
          'ALPHA',
          'LIMIT',
          '0',
          String(limit),
        ]),
        limit,
      );
    },
    async findDue(limit = 100) {
      boundedLimit(limit);
      const now = await client.sendCommand(['TIME']);
      if (
        !Array.isArray(now) ||
        now.length !== 2 ||
        !now.every((part) => typeof part === 'string' && /^\d+$/.test(part))
      )
        return invalid();
      const milliseconds = Number(now[0]) * 1000 + Math.floor(Number(now[1]) / 1000);
      return readMembers(
        await client.sendCommand([
          'ZRANGE',
          keys.bridgeSlotDeadlines,
          '-inf',
          String(milliseconds),
          'BYSCORE',
          'LIMIT',
          '0',
          String(limit),
        ]),
        limit,
      );
    },
  };
}
