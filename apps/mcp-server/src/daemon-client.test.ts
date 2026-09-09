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

  it('uses the bound workflow HTTP routes without adding process or Redis behavior', async () => {
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    const workflow = {
      id: 'workflow-1',
      projectId: 'project-1',
      coordinatorSessionId: 'session-1',
      rootCorrelationId: 'correlation-root',
      objective: 'Finish the durable workflow.',
      revision: 1,
      state: 'active',
      currentMessageId: 'message-1',
      createdAt: timestamp,
      updatedAt: timestamp,
    } as const;
    const message = {
      id: 'message-1',
      correlationId: 'correlation-root',
      projectId: 'project-1',
      sourceSessionId: 'session-1',
      sourceAgentId: 'claude-sim',
      targetSessionId: 'session-target',
      targetAgentId: 'gemini',
      selectionReason: 'selected target',
      kind: 'instruction',
      content: 'Implement the task.',
      evidenceRequirements: [],
      state: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      deadlineAt: timestamp,
    } as const;
    const fetch: McpFetch = async (url, init) => {
      requests.push({
        url,
        method: init?.method,
        ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) }),
      });
      return url.endsWith('/continue')
        ? response({
            status: 'updated',
            workflow: { ...workflow, revision: 2, state: 'completed' },
          })
        : response({ status: 'created', workflow, message }, 201);
    };
    const client = createDaemonClient({
      daemonUrl: 'http://127.0.0.1:4782',
      requestTimeoutMs: 30_000,
      fetch,
    });
    const create = {
      objective: workflow.objective,
      coordinatorSessionId: 'session-1',
      rootCorrelationId: 'correlation-root',
      firstMessage: {
        targetAgentId: 'gemini',
        kind: 'instruction' as const,
        content: 'Implement the task.',
      },
    };
    const continuation = {
      workflowId: 'workflow-1',
      expectedRevision: 1,
      proof: { kind: 'wake' as const, wakeIntentId: 'wake-1' },
      decision: { kind: 'complete' as const },
    };

    await expect(client.createWorkflow(create)).resolves.toMatchObject({ status: 'created' });
    await expect(
      client.continueWorkflow('session-1', 'workflow-1', continuation),
    ).resolves.toMatchObject({ status: 'updated' });

    expect(requests).toEqual([
      {
        url: 'http://127.0.0.1:4782/api/v1/workflows',
        method: 'POST',
        body: create,
      },
      {
        url: 'http://127.0.0.1:4782/api/v1/sessions/session-1/workflows/workflow-1/continue',
        method: 'POST',
        body: continuation,
      },
    ]);
  });
});
