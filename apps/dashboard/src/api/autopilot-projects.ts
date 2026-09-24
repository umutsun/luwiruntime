import { autopilotCollectionSchema } from '@luwi/protocol/browser';

import type { DaemonClient } from './client.js';

/*
 * The projects that have autopilot switched on (`mode !== 'off'`), so the LuwiBot
 * cockpit can surface the project doing work even when none is focused — the
 * cockpit follows the work instead of vanishing on the bare overview. Read-only,
 * one bounded GET; the widget only calls it while nothing is focused.
 */
export async function loadAutopilotProjects(
  client: DaemonClient,
  options: { signal?: AbortSignal } = {},
): Promise<string[]> {
  const signal = options.signal === undefined ? {} : { signal: options.signal };
  const result = await client.get('/api/v1/autopilot', autopilotCollectionSchema, signal);
  if (result.state !== 'ready') return [];
  return result.data.records
    .filter((record) => record.mode !== 'off')
    .map((record) => record.projectId);
}
