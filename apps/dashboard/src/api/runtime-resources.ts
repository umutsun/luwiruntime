import { runtimeResourcesResponseSchema } from '@luwi/protocol/browser';

import type { ResourceState } from '../components/panel.js';
import type { DaemonClient } from './client.js';

/** The machine's figures and LUWI's own footprint, over `GET /api/v1/runtime/resources`. */
export type RuntimeResources = ReturnType<typeof runtimeResourcesResponseSchema.parse>;

export async function loadRuntimeResources(
  client: DaemonClient,
  options: { signal?: AbortSignal } = {},
): Promise<ResourceState<RuntimeResources>> {
  const result = await client.get(
    '/api/v1/runtime/resources',
    runtimeResourcesResponseSchema,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  return result.state === 'ready'
    ? { state: 'ready', data: result.data }
    : { state: 'unavailable' };
}
