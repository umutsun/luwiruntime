import { leaseCollectionSchema } from '@luwi/protocol/browser';

import type { ResourceState } from '../components/panel.js';
import type { DaemonClient } from './client.js';

/**
 * Held work leases for one project.
 *
 * A lease is short-lived and presence-shaped, so it belongs beside the project
 * rather than on a route of its own: the question it answers — which paths are
 * spoken for right now — is only interesting while looking at that project.
 *
 * The list is scoped because it has to be. Leases are indexed by project and by
 * session and there is no global index, so a request without a scope has no
 * bounded answer.
 */

const PAGE_SIZE = 100;

export type LeaseState = 'held' | 'released' | 'expired';

export type ProjectLease = {
  id: string;
  sessionId: string;
  agentId: string;
  path: string;
  reason: string;
  state: LeaseState;
  acquiredAt: string;
  expiresAt: string;
  renewedAt?: string;
};

export type Bounded<T> = { items: T[]; truncated: boolean };

export type LeaseResources = {
  leases: ResourceState<Bounded<ProjectLease>>;
};

export type LeaseResourceKey = keyof LeaseResources;

export const leaseResourceKeys: readonly LeaseResourceKey[] = ['leases'];

/**
 * Every lease transition changes the list, including `lease.denied` — which
 * changes no record but is the strongest signal that someone is looking at
 * this project right now.
 */
export function leaseResourcesForEvent(eventType: string): LeaseResourceKey[] {
  if (eventType.startsWith('runtime.') || eventType.startsWith('lease.')) {
    return [...leaseResourceKeys];
  }
  return [];
}

export async function loadLeaseScope(
  client: DaemonClient,
  projectId: string,
  keys: readonly LeaseResourceKey[],
  options: { signal?: AbortSignal } = {},
): Promise<Partial<LeaseResources>> {
  if (!keys.includes('leases')) return {};
  const get = options.signal === undefined ? {} : { signal: options.signal };

  const result = await client.get(
    `/api/v1/leases?projectId=${encodeURIComponent(projectId)}&limit=${String(PAGE_SIZE)}`,
    leaseCollectionSchema,
    get,
  );

  if (result.state !== 'ready') return { leases: { state: 'unavailable' } };

  return {
    leases: {
      state: 'ready',
      data: {
        items: result.data.leases.map((lease) => ({
          id: lease.id,
          sessionId: lease.sessionId,
          agentId: lease.agentId,
          path: lease.path,
          reason: lease.reason,
          state: lease.state,
          acquiredAt: lease.acquiredAt,
          expiresAt: lease.expiresAt,
          ...(lease.renewedAt === undefined ? {} : { renewedAt: lease.renewedAt }),
        })),
        truncated: result.data.truncated,
      },
    },
  };
}

/**
 * How long a held lease has left, at the moment it is rendered.
 *
 * Returns `undefined` for a lease whose expiry the runtime never recorded
 * legibly, so the view can say so instead of showing a computed zero.
 */
export function remainingMs(lease: ProjectLease, nowMs: number): number | undefined {
  const expires = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expires)) return undefined;
  return Math.max(0, expires - nowMs);
}
