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
