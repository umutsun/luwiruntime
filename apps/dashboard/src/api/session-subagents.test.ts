import { describe, expect, it, vi } from 'vitest';

import { createDaemonClient } from './client.js';
import { loadProjectSubagents, loadSessionSubagents } from './session-subagents.js';

const AT = '2026-09-25T10:00:00.000Z';

const sessionBody = (sessionId: string) => ({
  sessionId,
  status: 'observed',
  subagents: [
    {
      agentId: 'a1b2c3',
      agentType: 'reviewer',
      description: 'Review the diff',
      state: 'running',
      lastActivityAt: AT,
      lastToolName: 'Read',
      workingDirectory: 'C:/work/project',
    },
  ],
  truncated: false,
  observedAt: AT,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('session sub-agents', () => {
  it('reads one session by its encoded id and hands back the validated listing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(sessionBody('s/1')));
    const client = createDaemonClient(fetchImpl as unknown as typeof fetch);

    const result = await loadSessionSubagents(client, 's/1');

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/sessions/s%2F1/subagents');
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    expect(result).toEqual({ state: 'ready', data: sessionBody('s/1') });
  });

  it('reads one project by its encoded id', async () => {
    const body = {
      projectId: 'p 1',
      sessions: [sessionBody('s1')],
      truncated: true,
      observedAt: AT,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body));
    const client = createDaemonClient(fetchImpl as unknown as typeof fetch);

    const result = await loadProjectSubagents(client, 'p 1');

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/projects/p%201/subagents');
    expect(result).toEqual({ state: 'ready', data: body });
  });

  it('is unavailable on an error status or a body the schema refuses', async () => {
    const failing = createDaemonClient(
      vi.fn().mockResolvedValue(jsonResponse({ error: 'x' }, 404)) as unknown as typeof fetch,
    );
    expect(await loadSessionSubagents(failing, 's1')).toEqual({ state: 'unavailable' });

    const invalid = createDaemonClient(
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ ...sessionBody('s1'), status: 'guessed' }),
        ) as unknown as typeof fetch,
    );
    expect(await loadSessionSubagents(invalid, 's1')).toEqual({ state: 'unavailable' });
  });
});
