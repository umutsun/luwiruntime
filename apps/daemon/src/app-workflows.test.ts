import type { AgentMessage, Project, WorkflowView } from '@luwi/protocol';
import type { RedisGateway, RedisHealth } from '@luwi/redis';
import { createRuntimeReadiness } from '@luwi/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type DaemonApp } from './app.js';
import type { ProjectService } from './project-service.js';
import type { SessionService } from './session-service.js';
import type { WorkflowService } from './workflow-service.js';

const timestamp = '2026-09-09T12:00:00.000Z';
const project: Project = {
  id: 'project-1',
  name: 'Fixture',
  localPath: 'C:/fixture',
  canonicalPath: 'C:/fixture',
  createdAt: timestamp,
  updatedAt: timestamp,
};
const workflow: WorkflowView = {
  id: 'workflow-1',
  projectId: 'project-1',
  coordinatorSessionId: 'session-coordinator',
  rootCorrelationId: 'correlation-root',
  objective: 'Complete the bounded workflow.',
  revision: 1,
  state: 'active',
  currentMessageId: 'message-1',
  createdAt: timestamp,
  updatedAt: timestamp,
};
const message: AgentMessage = {
  id: 'message-1',
  correlationId: 'correlation-root',
  projectId: 'project-1',
  sourceSessionId: 'session-coordinator',
  sourceAgentId: 'codex',
  targetSessionId: 'session-worker',
  targetAgentId: 'claude-code',
  selectionReason: 'selected agent claude-code session session-worker',
  kind: 'instruction',
  content: 'Implement the slice.',
  evidenceRequirements: [],
  state: 'queued',
  createdAt: timestamp,
  updatedAt: timestamp,
  deadlineAt: '2026-09-09T12:02:00.000Z',
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

function daemon(workflows: Partial<WorkflowService>): DaemonApp {
  const readiness = createRuntimeReadiness('recovering');
  readiness.transitionTo('ready');
  return buildDaemon({
    config: {
      host: '127.0.0.1',
      port: 80,
      redisUrl: 'redis://127.0.0.1:6379',
      logLevel: 'silent',
      workspaceId: 'local',
    },
    redis: new HealthyRedis(),
    logger: false,
    readiness,
    runtimeState: () => readiness.state,
    services: {
      projects: {
        register: async () => project,
        get: async () => project,
        list: async () => [project],
      } as ProjectService,
      sessions: { list: async () => [] } as unknown as SessionService,
      workflows: workflows as WorkflowService,
      listEvents: async () => [],
    },
  });
}

describe('workflow routes', () => {
  let app: DaemonApp | undefined;

  afterEach(async () => app?.close());

  it('lists oldest-first redacted workflow projections', async () => {
    const list = vi.fn().mockResolvedValue([workflow]);
    app = daemon({ list });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/workflows?projectId=project-1&limit=5',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ workflows: [workflow] });
    expect(response.body).not.toContain('decisionFingerprint');
    expect(response.body).not.toContain('dispatcherInstanceId');
    expect(list).toHaveBeenCalledWith({ projectId: 'project-1', limit: 5 });
  });

  it('creates a workflow with a location and distinguishes semantic replay', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ status: 'created', workflow, message })
      .mockResolvedValueOnce({ status: 'existing', workflow, message });
    app = daemon({ create });
    const payload = {
      objective: workflow.objective,
      coordinatorSessionId: 'session-coordinator',
      rootCorrelationId: 'correlation-root',
      firstMessage: {
        targetAgentId: 'claude-code',
        kind: 'instruction',
        content: 'Implement the slice.',
      },
    };

    const created = await app.inject({ method: 'POST', url: '/api/v1/workflows', payload });
    const replay = await app.inject({ method: 'POST', url: '/api/v1/workflows', payload });

    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe('/api/v1/workflows/workflow-1');
    expect(created.json()).toEqual({ status: 'created', workflow, message });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ status: 'existing', workflow, message });
  });

  it('binds continuation actor and workflow identities to the trusted route path', async () => {
    const continued = {
      ...workflow,
      revision: 2,
      state: 'completed' as const,
      currentMessageId: undefined,
    };
    const continueWorkflow = vi.fn().mockResolvedValue({ status: 'updated', workflow: continued });
    app = daemon({ continue: continueWorkflow });
    const body = {
      workflowId: 'workflow-1',
      expectedRevision: 1,
      proof: { kind: 'wake', wakeIntentId: 'message-1' },
      decision: { kind: 'complete' },
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/session-coordinator/workflows/workflow-1/continue',
      payload: body,
    });
    const smuggled = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/session-coordinator/workflows/workflow-1/continue',
      payload: { ...body, actorSessionId: 'session-other' },
    });

    expect(response.statusCode).toBe(200);
    expect(continueWorkflow).toHaveBeenCalledWith('session-coordinator', 'workflow-1', body);
    expect(smuggled.statusCode).toBe(400);
  });
});
