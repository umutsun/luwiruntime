import type { AgentMessage, InboxClaimResponse, Project, SessionView } from '@luwi/protocol';
import type { RedisGateway, RedisHealth } from '@luwi/redis';
import { createRuntimeReadiness } from '@luwi/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type DaemonApp } from './app.js';
import type { DaemonConfig } from './config.js';
import type { MessageService } from './message-service.js';
import type { ProjectService } from './project-service.js';
import type { SessionService } from './session-service.js';

const config: DaemonConfig = {
  host: '127.0.0.1',
  port: 80,
  redisUrl: 'redis://127.0.0.1:6379',
  logLevel: 'info',
  workspaceId: 'local',
};
const timestamp = '2026-07-29T12:00:00.000Z';
const project: Project = {
  id: 'project-1',
  name: 'LUWI',
  localPath: 'C:/workspace',
  canonicalPath: 'C:/workspace',
  createdAt: timestamp,
  updatedAt: timestamp,
};
const session: SessionView = {
  id: 'source',
  agentId: 'claude-sim',
  projectId: 'project-1',
  status: 'idle',
  workingDirectory: 'C:/workspace',
  startedAt: timestamp,
  lastHeartbeatAt: timestamp,
  metadata: {},
  presence: 'online',
};
const message: AgentMessage = {
  id: 'message-1',
  correlationId: 'correlation-1',
  projectId: 'project-1',
  sourceSessionId: 'source',
  sourceAgentId: 'claude-sim',
  targetSessionId: 'target',
  targetAgentId: 'gemini-sim',
  selectionReason: 'selected target',
  kind: 'question',
  content: 'Status?',
  evidenceRequirements: [],
  state: 'queued',
  createdAt: timestamp,
  updatedAt: timestamp,
  deadlineAt: '2026-07-29T12:02:00.000Z',
};

class HealthyRedis implements RedisGateway {
  async connect(): Promise<boolean> {
    return true;
  }
  async checkHealth(): Promise<RedisHealth> {
    return { connected: true, status: 'connected', latencyMs: 1 };
  }
  async close(): Promise<void> {}
}

function phase1Services(): { projects: ProjectService; sessions: SessionService } {
  return {
    projects: {
      register: async () => project,
      get: async () => project,
      list: async () => [project],
    },
    sessions: {
      register: async () => session,
      get: async () => session,
      list: async () => [session],
      heartbeat: async () => ({ status: 'renewed', eventEmitted: false }),
      updateStatus: async () => session,
      close: async () => session,
    },
  };
}

function messageService(): MessageService {
  return {
    ask: vi.fn(async () => ({
      message,
      selectedTargetSessionId: 'target',
      selectedTargetAgentId: 'gemini-sim',
      selectionReason: 'selected target',
      idempotent: false,
    })),
    get: vi.fn(async () => message),
    list: vi.fn(async () => ({ messages: [message] })),
    wait: vi.fn(async () => message),
    acknowledge: vi.fn(async () => ({ ...message, state: 'acknowledged' })),
    processing: vi.fn(async () => ({ ...message, state: 'processing' })),
    respond: vi.fn(async () => ({ ...message, state: 'responded' })),
    reject: vi.fn(async () => ({ ...message, state: 'rejected' })),
    fail: vi.fn(async () => ({ ...message, state: 'failed' })),
    claimInbox: vi.fn(async (): Promise<InboxClaimResponse> => ({
      items: [],
    })),
    timeoutMessage: vi.fn(async () => 'unchanged'),
  };
}

describe('Phase 2 HTTP routes', () => {
  let app: DaemonApp | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('creates, lists, gets, and bounded-waits for messages', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    const messages = messageService();
    app = buildDaemon({
      config,
      redis: new HealthyRedis(),
      logger: false,
      runtimeState: () => readiness.state,
      readiness,
      services: {
        ...phase1Services(),
        messages,
        listEvents: async () => [],
      },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/messages',
      headers: { 'idempotency-key': 'retry-1' },
      payload: {
        sourceSessionId: 'source',
        targetAgentId: 'gemini-sim',
        kind: 'question',
        content: 'Status?',
      },
    });
    expect(created.statusCode).toBe(202);
    expect(created.headers.location).toBe('/api/v1/messages/correlation-1');
    expect(messages.ask).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSessionId: 'source' }),
      'retry-1',
    );

    expect((await app.inject({ method: 'GET', url: '/api/v1/messages' })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/messages/correlation-1' })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/messages/correlation-1/wait?waitMs=30',
        })
      ).statusCode,
    ).toBe(200);
    expect(messages.wait).toHaveBeenCalledWith('correlation-1', 30);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/messages/correlation-1/wait?waitMs=30001',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('exposes responder transitions and durable inbox claims as mutations', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    const messages = messageService();
    app = buildDaemon({
      config,
      redis: new HealthyRedis(),
      logger: false,
      runtimeState: () => readiness.state,
      readiness,
      services: {
        ...phase1Services(),
        messages,
        listEvents: async () => [],
      },
    });

    for (const action of ['acknowledge', 'processing'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/messages/correlation-1/${action}`,
        payload: { responderSessionId: 'target' },
      });
      expect(response.statusCode).toBe(200);
    }
    for (const action of ['respond', 'reject', 'fail'] as const) {
      const status =
        action === 'respond' ? 'answered' : action === 'reject' ? 'rejected' : 'failed';
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/messages/correlation-1/${action}`,
        payload: {
          responderSessionId: 'target',
          response: {
            status,
            answer: `Simulated ${status}.`,
            evidence: [],
            verifiedAt: timestamp,
          },
        },
      });
      expect(response.statusCode).toBe(200);
    }
    const mismatched = await app.inject({
      method: 'POST',
      url: '/api/v1/messages/correlation-1/respond',
      payload: {
        responderSessionId: 'target',
        response: {
          status: 'rejected',
          answer: 'Wrong action.',
          evidence: [],
          verifiedAt: timestamp,
        },
      },
    });
    expect(mismatched.statusCode).toBe(409);
    expect(mismatched.json()).toMatchObject({
      error: { code: 'MESSAGE_TRANSITION_INVALID' },
    });
    const claim = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/target/inbox/claim',
      payload: {
        bridgeInstanceId: 'bridge-1',
        limit: 10,
        blockMs: 0,
        minIdleMs: 0,
      },
    });
    expect(claim.statusCode).toBe(200);
    expect(messages.claimInbox).toHaveBeenCalledWith(
      'target',
      expect.objectContaining({ bridgeInstanceId: 'bridge-1' }),
    );
  });

  it('rejects Phase 2 mutations while the runtime is draining', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    readiness.beginDraining();
    const messages = messageService();
    app = buildDaemon({
      config,
      redis: new HealthyRedis(),
      logger: false,
      runtimeState: () => readiness.state,
      readiness,
      services: {
        ...phase1Services(),
        messages,
        listEvents: async () => [],
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/messages',
      payload: {
        sourceSessionId: 'source',
        targetSessionId: 'target',
        kind: 'question',
        content: 'Status?',
      },
    });
    expect(response.statusCode).toBe(503);
    expect(messages.ask).not.toHaveBeenCalled();
  });

  it('returns Phase 2 error codes for configured message limits', async () => {
    const messages = messageService();
    app = buildDaemon({
      config: {
        ...config,
        messageMaxContentBytes: 4,
        messageMaxTimeoutMs: 1_000,
      },
      redis: new HealthyRedis(),
      logger: false,
      services: {
        ...phase1Services(),
        messages,
        listEvents: async () => [],
      },
    });

    const oversized = await app.inject({
      method: 'POST',
      url: '/api/v1/messages',
      payload: {
        sourceSessionId: 'source',
        targetSessionId: 'target',
        kind: 'question',
        content: 'five!',
      },
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({
      error: { code: 'MESSAGE_CONTENT_TOO_LARGE' },
    });

    const invalidTimeout = await app.inject({
      method: 'POST',
      url: '/api/v1/messages',
      payload: {
        sourceSessionId: 'source',
        targetSessionId: 'target',
        kind: 'question',
        content: 'ok',
        timeoutMs: 1_001,
      },
    });
    expect(invalidTimeout.statusCode).toBe(400);
    expect(invalidTimeout.json()).toMatchObject({
      error: { code: 'MESSAGE_TIMEOUT_INVALID' },
    });
    expect(messages.ask).not.toHaveBeenCalled();
  });
});
