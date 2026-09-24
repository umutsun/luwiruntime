import { z } from 'zod';

import type { ResourceState } from '../components/panel.js';
import type { DaemonClient } from './client.js';

/**
 * A compact live view of who is active on a project right now, for the LuwiBot
 * widget's activity strip: one row per online agent with whether it is working
 * (any of its sessions past idle) so the operator can watch the fleet move.
 * Read-only; a display-only subset of the session record, so a lenient local
 * schema rather than the full protocol shape.
 */
export type AgentActivity = { agentId: string; working: boolean };

const activitySchema = z.object({
  sessions: z.array(z.object({ agentId: z.string(), status: z.string(), presence: z.string() })),
});

export async function loadAgentActivity(
  client: DaemonClient,
  projectId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ResourceState<AgentActivity[]>> {
  const signal = options.signal === undefined ? {} : { signal: options.signal };
  const result = await client.get(
    `/api/v1/sessions?projectId=${encodeURIComponent(projectId)}`,
    activitySchema,
    signal,
  );
  if (result.state !== 'ready') return { state: 'unavailable' };
  // Several sessions can share an agent (a bridge and a GUI); the agent is
  // working if any of them is past idle.
  const working = new Map<string, boolean>();
  for (const session of result.data.sessions) {
    if (session.presence === 'offline') continue;
    working.set(
      session.agentId,
      (working.get(session.agentId) ?? false) || session.status !== 'idle',
    );
  }
  const agents = [...working.entries()]
    .map(([agentId, isWorking]) => ({ agentId, working: isWorking }))
    .sort((a, b) => Number(b.working) - Number(a.working) || a.agentId.localeCompare(b.agentId));
  return { state: 'ready', data: agents };
}
