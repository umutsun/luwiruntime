import {
  LEASE_MAX_ACTIVE_PER_PROJECT,
  leaseConflictSchema,
  workLeaseSchema,
  type LeaseConflict,
  type RuntimeEvent,
  type WorkLease,
} from '@luwi/protocol';

import type { RedisFunctionRegistry } from './function-registry.js';
import type { RedisKeys } from './redis-keys.js';
import { RedisRepositoryError, type RedisCommandClient } from './runtime-repository.js';

/**
 * Advisory work leases.
 *
 * Every transition goes through a Redis Function because the conflict check,
 * the write, and the event append have to be one step: two sessions asking for
 * overlapping paths at the same instant must produce one grant and one denial,
 * never two grants.
 *
 * Redis data is untrusted on read (AGENTS.md section 7), so every record this
 * module returns is validated against `workLeaseSchema` — which re-derives the
 * match form from the path and rejects a record whose two disagree.
 */

export type AcquireLeaseResult =
  | { status: 'granted'; lease: WorkLease }
  | { status: 'denied'; conflict: LeaseConflict }
  /** The generated identifier already existed. The caller retries with a new one. */
  | { status: 'id_conflict' }
  | { status: 'limit_reached' };

export type LeaseTransitionResult =
  | { status: 'updated'; lease: WorkLease }
  | { status: 'not_found' }
  /** Already released or expired; the caller is not the reason it is gone. */
  | { status: 'state_conflict'; lease: WorkLease }
  | { status: 'not_holder'; lease: WorkLease };

export interface LeaseRepository {
  acquireLease(input: {
    lease: WorkLease;
    grantedEvent: RuntimeEvent;
    deniedEvent: RuntimeEvent;
    nowMs: number;
    expiresMs: number;
  }): Promise<AcquireLeaseResult>;
  renewLease(input: {
    lease: WorkLease;
    event: RuntimeEvent;
    holderSessionId: string;
    expiresMs: number;
  }): Promise<LeaseTransitionResult>;
  releaseLease(input: {
    lease: WorkLease;
    event: RuntimeEvent;
    /** Empty means the runtime itself is ending the lease, not a caller. */
    holderSessionId: string;
  }): Promise<LeaseTransitionResult>;
  expireLease(input: { lease: WorkLease; event: RuntimeEvent }): Promise<LeaseTransitionResult>;
  getLease(leaseId: string): Promise<WorkLease | null>;
  listProjectLeases(projectId: string, limit: number): Promise<WorkLease[]>;
  listSessionLeases(sessionId: string, limit: number): Promise<WorkLease[]>;
  findDueLeaseDeadlines(nowMs: number, limit: number): Promise<string[]>;
}

function invalid(detail: string): never {
  throw new RedisRepositoryError('REDIS_DATA_INVALID', `Redis lease ${detail} is invalid.`);
}

function decodeJsonReply(reply: unknown): Record<string, unknown> {
  if (typeof reply !== 'string') invalid('transition result');
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply) as unknown;
  } catch {
    invalid('transition result');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    invalid('transition result');
  }
  return parsed as Record<string, unknown>;
}

function parseLease(value: unknown): WorkLease {
  const parsed = workLeaseSchema.safeParse(value);
  if (!parsed.success) invalid('record');
  return parsed.data;
}

function storedLease(reply: unknown): WorkLease | null {
  if (reply === null || reply === undefined) return null;
  let json: unknown;
  if (Array.isArray(reply)) {
    if (reply.length === 0) return null;
    const index = reply.indexOf('json');
    if (index < 0) invalid('record');
    json = reply[index + 1];
  } else if (typeof reply === 'object') {
    json = (reply as Record<string, unknown>).json;
    if (json === undefined) return null;
  } else {
    invalid('record');
  }
  if (typeof json !== 'string') invalid('record');
  try {
    return parseLease(JSON.parse(json) as unknown);
  } catch (error) {
    if (error instanceof RedisRepositoryError) throw error;
    return invalid('record');
  }
}

function stringMembers(reply: unknown): string[] {
  if (!Array.isArray(reply)) invalid('index');
  return reply.map((entry) => {
    if (typeof entry !== 'string') invalid('index');
    return entry;
  });
}

export function createLeaseRepository(options: {
  client: RedisCommandClient;
  keys: RedisKeys;
  functions: RedisFunctionRegistry;
}): LeaseRepository {
  const getLease = async (leaseId: string): Promise<WorkLease | null> =>
    storedLease(await options.client.sendCommand(['HGETALL', options.keys.lease(leaseId)]));

  const loadAll = async (ids: readonly string[], limit: number): Promise<WorkLease[]> => {
    const leases: WorkLease[] = [];
    for (const id of ids.slice(0, limit)) {
      const lease = await getLease(id);
      // A member with no record is a projection the sweep has not caught up
      // with, not corruption; it is skipped rather than treated as a fault.
      if (lease !== null) leases.push(lease);
    }
    return leases;
  };

  /**
   * The six keys every lease function declares, in the order the Lua expects:
   * the record, the project's held-lease details, the session's lease set, the
   * global expiry index, and the two Streams.
   */
  const leaseKeys = (lease: WorkLease): string[] => [
    options.keys.lease(lease.id),
    options.keys.projectLeases(lease.projectId),
    options.keys.sessionLeases(lease.sessionId),
    options.keys.leaseDeadlines,
    options.keys.globalEvents,
    options.keys.projectEvents(lease.projectId),
  ];

  const transition = async (
    functionName: string,
    input: {
      lease: WorkLease;
      event: RuntimeEvent;
      holderSessionId: string;
      expiresMs: number | undefined;
    },
  ): Promise<LeaseTransitionResult> => {
    const reply = decodeJsonReply(
      await options.client.sendCommand([
        'FCALL',
        functionName,
        '6',
        ...leaseKeys(input.lease),
        input.holderSessionId,
        JSON.stringify(input.lease),
        JSON.stringify(input.event),
        String(input.expiresMs ?? 0),
        input.lease.id,
      ]),
    );

    if (reply.status === 'updated') return { status: 'updated', lease: parseLease(reply.lease) };
    if (reply.status === 'not_found') return { status: 'not_found' };
    if (reply.status === 'state_conflict') {
      return { status: 'state_conflict', lease: parseLease(reply.lease) };
    }
    if (reply.status === 'not_holder') {
      return { status: 'not_holder', lease: parseLease(reply.lease) };
    }
    return invalid('transition result');
  };

  return {
    async acquireLease(input) {
      const reply = decodeJsonReply(
        await options.client.sendCommand([
          'FCALL',
          options.functions.functions.leaseAcquire,
          '6',
          ...leaseKeys(input.lease),
          JSON.stringify(input.lease),
          JSON.stringify(input.grantedEvent),
          JSON.stringify(input.deniedEvent),
          String(input.nowMs),
          String(input.expiresMs),
          String(LEASE_MAX_ACTIVE_PER_PROJECT),
        ]),
      );

      if (reply.status === 'granted') return { status: 'granted', lease: parseLease(reply.lease) };
      if (reply.status === 'denied') {
        const conflict = leaseConflictSchema.safeParse(reply.conflict);
        if (!conflict.success) invalid('conflict record');
        return { status: 'denied', conflict: conflict.data };
      }
      if (reply.status === 'conflict') return { status: 'id_conflict' };
      if (reply.code === 'LEASE_LIMIT_REACHED') return { status: 'limit_reached' };
      return invalid('acquire result');
    },

    renewLease: (input) =>
      transition(options.functions.functions.leaseRenew, {
        lease: input.lease,
        event: input.event,
        holderSessionId: input.holderSessionId,
        expiresMs: input.expiresMs,
      }),

    releaseLease: (input) =>
      transition(options.functions.functions.leaseRelease, {
        lease: input.lease,
        event: input.event,
        holderSessionId: input.holderSessionId,
        expiresMs: undefined,
      }),

    expireLease: (input) =>
      transition(options.functions.functions.leaseExpire, {
        lease: input.lease,
        event: input.event,
        // Expiry is the runtime's own transition, so it passes no holder.
        holderSessionId: '',
        expiresMs: undefined,
      }),

    getLease,

    async listProjectLeases(projectId, limit) {
      const ids = stringMembers(
        await options.client.sendCommand(['HKEYS', options.keys.projectLeases(projectId)]),
      );
      return loadAll(ids, limit);
    },

    async listSessionLeases(sessionId, limit) {
      const ids = stringMembers(
        await options.client.sendCommand(['SMEMBERS', options.keys.sessionLeases(sessionId)]),
      );
      return loadAll(ids, limit);
    },

    async findDueLeaseDeadlines(nowMs, limit) {
      return stringMembers(
        await options.client.sendCommand([
          'ZRANGEBYSCORE',
          options.keys.leaseDeadlines,
          '-inf',
          String(nowMs),
          'LIMIT',
          '0',
          String(limit),
        ]),
      );
    },
  };
}
