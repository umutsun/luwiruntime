import { describe, expect, it } from 'vitest';

import {
  createDaemonClient,
  McpDaemonError,
  type McpFetch,
  type McpHttpResponse,
} from './daemon-client.js';

const timestamp = '2026-07-29T12:00:00.000Z';
const session = {
  id: 'session-1',
  agentId: 'claude-sim',
  projectId: 'project-1',
  status: 'idle',
  workingDirectory: 'C:/workspace',
  startedAt: timestamp,
  lastHeartbeatAt: timestamp,
  metadata: {},
  presence: 'online',
} as const;

function response(body: unknown, status = 200): McpHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('MCP daemon client', () => {
  it('verifies an online non-terminal bound session', async () => {
    const fetch: McpFetch = async () => response(session);
    const client = createDaemonClient({
      daemonUrl: 'http://127.0.0.1:4782',
      requestTimeoutMs: 30_000,
      fetch,
    });

    await expect(client.verifyBoundSession('session-1')).resolves.toEqual(session);
  });

  it.each([
    [{ ...session, presence: 'offline' }, 'BOUND_SESSION_OFFLINE'],
    [{ ...session, status: 'completed' }, 'BOUND_SESSION_TERMINAL'],
  ])('rejects an unavailable bound session', async (body, code) => {
    const client = createDaemonClient({
      daemonUrl: 'http://127.0.0.1:4782',
      requestTimeoutMs: 30_000,
      fetch: async () => response(body),
    });

    await expect(client.verifyBoundSession('session-1')).rejects.toMatchObject({ code });
  });

  it('maps safe daemon errors without including unvalidated response data', async () => {
    const client = createDaemonClient({
      daemonUrl: 'http://127.0.0.1:4782',
      requestTimeoutMs: 30_000,
      fetch: async () =>
        response(
          {
            error: {
              code: 'TARGET_SESSION_UNAVAILABLE',
              message: 'The target session is unavailable.',
            },
          },
          409,
        ),
    });

    await expect(client.getSession('missing')).rejects.toEqual(
      new McpDaemonError('TARGET_SESSION_UNAVAILABLE', 'The target session is unavailable.', 409),
    );
  });
});

describe('reader-owned session presence (ADR 0034)', () => {
  it('registers, heartbeats and closes a session through the session endpoints', async () => {
    const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    const fetch: McpFetch = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers['content-type']).toBe('application/json');
      calls.push({
        url,
        method: init?.method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (url.endsWith('/heartbeat')) return response({ status: 'renewed', eventEmitted: false });
      return response(session, url.endsWith('/api/v1/sessions') ? 201 : 200);
    };
    const client = createDaemonClient({
      daemonUrl: 'http://127.0.0.1:4782',
      requestTimeoutMs: 30_000,
      fetch,
    });

    await expect(
      client.registerSession({
        projectId: 'project-1',
        agentId: 'claude-sim',
        workingDirectory: 'C:/workspace',
        metadata: { revivedFrom: 'session-0' },
      }),
    ).resolves.toEqual(session);
    await client.heartbeat('session-1');
    await expect(client.closeSession('session-1')).resolves.toEqual(session);

    expect(calls.map(({ method, url }) => [method, url])).toEqual([
      ['POST', 'http://127.0.0.1:4782/api/v1/sessions'],
      ['POST', 'http://127.0.0.1:4782/api/v1/sessions/session-1/heartbeat'],
      ['POST', 'http://127.0.0.1:4782/api/v1/sessions/session-1/close'],
    ]);
    expect(calls[0]?.body).toEqual({
      projectId: 'project-1',
      agentId: 'claude-sim',
      workingDirectory: 'C:/workspace',
      metadata: { revivedFrom: 'session-0' },
    });
    expect(calls[1]?.body).toEqual({});
  });
});
