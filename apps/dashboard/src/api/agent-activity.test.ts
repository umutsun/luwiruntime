import { describe, expect, it, vi } from 'vitest';

import { createDaemonClient } from './client.js';
import { loadAgentActivity } from './agent-activity.js';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('loadAgentActivity', () => {
  it('lists online agents, marks working ones, dedupes by agent and sorts working first', async () => {
    const client = createDaemonClient(
      vi.fn().mockResolvedValue(
        jsonResponse({
          sessions: [
            { agentId: 'coder', status: 'tool_running', presence: 'online' },
            { agentId: 'coder', status: 'idle', presence: 'online' }, // same agent → still working
            { agentId: 'reviewer', status: 'idle', presence: 'online' },
            { agentId: 'ghost', status: 'idle', presence: 'offline' }, // dropped
          ],
        }),
      ) as unknown as typeof fetch,
    );

    expect(await loadAgentActivity(client, 'p1')).toEqual({
      state: 'ready',
      data: [
        { agentId: 'coder', working: true },
        { agentId: 'reviewer', working: false },
      ],
    });
  });

  it('reports a failed read as unavailable', async () => {
    const client = createDaemonClient(
      vi.fn().mockResolvedValue(jsonResponse({ error: 'x' }, 500)) as unknown as typeof fetch,
    );
    expect(await loadAgentActivity(client, 'p1')).toEqual({ state: 'unavailable' });
  });
});
