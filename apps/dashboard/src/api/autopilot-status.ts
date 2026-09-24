import { autopilotStatusResponseSchema, type AutopilotMode } from '@luwi/protocol/browser';

import type { ResourceState } from '../components/panel.js';
import type { DaemonClient } from './client.js';

/**
 * One project's autopilot, read on focus (ADR 0035).
 *
 * The daemon always answers a status object; a project with no policy carries a
 * `null` record, which is an honest "off, unconfigured" — not a fault. So a
 * successful read is always `ready`: the mode defaults to `off` and `configured`
 * says whether a policy was ever written. Only a transport or validation failure
 * is `unavailable`. `coordinatorOnline` is the operator's cue that autopilot can
 * actually act, because a mode without a live coordinator dispatches nothing.
 */
export type AutopilotStatus = {
  mode: AutopilotMode;
  configured: boolean;
  coordinatorOnline: boolean;
};

export async function loadAutopilotStatus(
  client: DaemonClient,
  projectId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ResourceState<AutopilotStatus>> {
  const result = await client.get(
    `/api/v1/projects/${encodeURIComponent(projectId)}/autopilot`,
    autopilotStatusResponseSchema,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  if (result.state !== 'ready') return { state: 'unavailable' };
  const { record, coordinatorOnline } = result.data;
  return {
    state: 'ready',
    data: {
      mode: record?.mode ?? 'off',
      configured: record !== null,
      coordinatorOnline,
    },
  };
}
