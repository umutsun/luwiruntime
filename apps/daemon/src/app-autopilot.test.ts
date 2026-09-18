import type { Project, Task } from '@luwi/protocol';
import type { RedisGateway, RedisHealth } from '@luwi/redis';
import { ApplicationError, createRuntimeReadiness } from '@luwi/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type DaemonApp } from './app.js';
import type { AutopilotService } from './autopilot-service.js';
import type { ProjectService } from './project-service.js';
import type { SessionService } from './session-service.js';

const timestamp = '2026-09-17T10:00:00.000Z';
const project: Project = {
  id: 'project-1',
  name: 'Fixture',
  localPath: '/fixture',
  canonicalPath: '/fixture',
  createdAt: timestamp,
  updatedAt: timestamp,
};
const task: Task = {
  id: 'task-1',
  projectId: 'project-1',
  goalId: 'goal-1',
  title: 'Add the route',
  brief: 'Add it.',
  agentId: 'claude-code',
  paths: ['apps/daemon/src/app.ts'],
  matchPaths: ['apps/daemon/src/app.ts/'],
  dependsOn: [],
  evidenceRequirements: [],
  timeoutMs: 600_000,
  kind: 'work',
  reworkCount: 0,
  state: 'ready',
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
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

function daemon(autopilot: Partial<AutopilotService>): DaemonApp {
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
      autopilot: autopilot as AutopilotService,
      listEvents: async () => [],
    },
  });
}

describe('autopilot routes', () => {
  let app: DaemonApp | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('answers the project status with the coordinator presence derived from sessions', async () => {
    app = daemon({
      get: vi.fn().mockResolvedValue(null),
      coordinatorSessions: vi.fn().mockResolvedValue([]),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/project-1/autopilot',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      record: null,
      coordinatorOnline: false,
      coordinatorSessionIds: [],
    });
  });

  it('validates the mode body and maps a service refusal to its status', async () => {
    app = daemon({
      setMode: vi
        .fn()
        .mockRejectedValue(new ApplicationError('AUTOPILOT_NOT_CONFIGURED', 'no policy', 409)),
    });
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/project-1/autopilot/mode',
      payload: { mode: 'turbo' },
    });
    expect(invalid.statusCode).toBe(400);
    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/project-1/autopilot/mode',
      payload: { mode: 'autopilot' },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'AUTOPILOT_NOT_CONFIGURED' } });
  });

  it('returns a refused dispatch as a 200 carrying the reason', async () => {
    const dispatchTask = vi
      .fn()
      .mockResolvedValue({ outcome: 'denied', task, reason: 'in_flight_limit', detail: '2 of 2' });
    app = daemon({ dispatchTask });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/task-1/dispatch',
      payload: { sessionId: 'coord-1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'denied', reason: 'in_flight_limit' });
    expect(dispatchTask).toHaveBeenCalledWith('task-1', 'coord-1');
  });

  it('creates a goal with its location header and lists tasks with truncation', async () => {
    const goal = {
      id: 'goal-1',
      projectId: 'project-1',
      title: 'Ship',
      objective: 'Ship it.',
      acceptanceCriteria: [],
      createdBy: { kind: 'operator' },
      budget: {
        maxTasks: 12,
        maxReworksPerTask: 1,
        maxReplans: 2,
        maxWallClockMs: 14_400_000,
        minConfidence: 0.6,
      },
      state: 'proposed',
      planVersion: 0,
      taskIds: [],
      usage: { tasks: 0, reworks: 0, replans: 0, judgments: 0, invalidJudgments: 0 },
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    app = daemon({
      createGoal: vi.fn().mockResolvedValue(goal),
      listTasks: vi.fn().mockResolvedValue([task, { ...task, id: 'task-2' }]),
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/project-1/goals',
      payload: { title: 'Ship', objective: 'Ship it.' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe('/api/v1/goals/goal-1');
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/project-1/tasks?limit=1',
    });
    expect(listed.json()).toMatchObject({ tasks: [{ id: 'task-1' }], truncated: true });
  });
});
