import {
  bridgeSlotCollectionSchema,
  wakeIntentCollectionSchema,
  workflowCollectionSchema,
} from '@luwi/protocol/browser';
import type { z } from 'zod';

import type { Availability } from '../pulse/model.js';
import type { DaemonClient, ResourceResult } from './client.js';

export type BridgeSlot = z.infer<typeof bridgeSlotCollectionSchema>['slots'][number];
export type WakeIntent = z.infer<typeof wakeIntentCollectionSchema>['wakeIntents'][number];
export type Workflow = z.infer<typeof workflowCollectionSchema>['workflows'][number];

export type RetainedWakeCollection<T> = {
  items: T[];
  truncated: boolean;
};

export type WakeScope = {
  bridgeSlots: Availability<RetainedWakeCollection<BridgeSlot>>;
  wakeIntents: Availability<RetainedWakeCollection<WakeIntent>>;
  workflows: Availability<RetainedWakeCollection<Workflow>>;
};

const HTTP_READ_LIMIT = 101;
const RETAINED_LIMIT = 100;

function retained<T>(values: T[]): RetainedWakeCollection<T> {
  return {
    items: values.slice(0, RETAINED_LIMIT),
    truncated: values.length > RETAINED_LIMIT,
  };
}

function availability<T, U>(result: ResourceResult<T>, select: (data: T) => U): Availability<U> {
  return result.state === 'ready'
    ? { state: 'ready', data: select(result.data) }
    : { state: 'unavailable' };
}

/**
 * Loads the three public wake resources independently. A failed read cannot
 * turn either of the other two into an unavailable observation, and the 101st
 * row is used only to disclose that the retained 100-row view is truncated.
 */
export async function loadWakeScope(
  client: DaemonClient,
  options: { signal?: AbortSignal } = {},
): Promise<WakeScope> {
  const [bridgeSlots, wakeIntents, workflows] = await Promise.all([
    client.get(
      `/api/v1/bridge-slots?limit=${String(HTTP_READ_LIMIT)}`,
      bridgeSlotCollectionSchema,
      options,
    ),
    client.get(
      `/api/v1/wake-intents?limit=${String(HTTP_READ_LIMIT)}`,
      wakeIntentCollectionSchema,
      options,
    ),
    client.get(
      `/api/v1/workflows?limit=${String(HTTP_READ_LIMIT)}`,
      workflowCollectionSchema,
      options,
    ),
  ]);

  return {
    bridgeSlots: availability(bridgeSlots, ({ slots }) => retained(slots)),
    wakeIntents: availability(wakeIntents, ({ wakeIntents: values }) => retained(values)),
    workflows: availability(workflows, ({ workflows: values }) => retained(values)),
  };
}
