import type { Project, WakeIntentView } from '@luwi/protocol';
import type { RedisGateway, RedisHealth } from '@luwi/redis';
import { createRuntimeReadiness } from '@luwi/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type DaemonApp } from './app.js';
import type { ProjectService } from './project-service.js';
import type { SessionService } from './session-service.js';
import type { WakeIntentService } from './wake-intent-service.js';

const timestamp = '2026-09-09T12:00:00.000Z';
const project: Project = {
  id: 'project-1',
  name: 'Fixture',
  localPath: 'C:/fixture',
  canonicalPath: 'C:/fixture',
  createdAt: timestamp,
  updatedAt: timestamp,
};
const intent: WakeIntentView = {
  id: 'message-1',
  messageId: 'message-1',
  workflowId: 'workflow-1',
  sourceSessionId: 'session-source',
  correlationId: 'correlation-1',
  terminalState: 'responded',
  adapter: 'codex-queue-v1',
  state: 'claimed',
  createdAt: timestamp,
  updatedAt: '2026-09-09T12:00:01.000Z',
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

function daemon(wakeIntents: Partial<WakeIntentService>): DaemonApp {
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
      wakeIntents: wakeIntents as WakeIntentService,
      listEvents: async () => [],
    },
  });
}

describe('wake intent routes', () => {
  let app: DaemonApp | undefined;

  afterEach(async () => app?.close());

  it('lists only the redacted public projection', async () => {
    const list = vi.fn().mockResolvedValue([intent]);
    app = daemon({ list });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/wake-intents?projectId=project-1&state=claimed&limit=5',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ wakeIntents: [intent] });
    expect(response.body).not.toContain('nativeSessionId');
    expect(response.body).not.toContain('launcherInstanceId');
    expect(list).toHaveBeenCalledWith({ projectId: 'project-1', state: 'claimed', limit: 5 });
  });

  it('serves private claim and recovery batches only on loopback POST routes', async () => {
    const batch = {
      items: [
        {
          intent,
          claimId: 'claim-1',
          target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-thread-1' },
        },
      ],
      recoveredDispatching: [],
      terminalAcknowledged: 0,
    } as const;
    const claim = vi.fn().mockResolvedValue(batch);
    const recover = vi.fn().mockResolvedValue(batch);
    const reclaim = vi.fn().mockResolvedValue(batch);
    app = daemon({ claim, recover, reclaim });

    const claimResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/wake-intents/claim',
      payload: { dispatcherInstanceId: 'dispatcher-1', limit: 1, blockMs: 0, minIdleMs: 15000 },
    });
    const recoveryResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/wake-intents/recover',
      payload: { dispatcherInstanceId: 'dispatcher-1', limit: 1, minIdleMs: 15000 },
    });
    const reclaimResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/wake-intents/reclaim',
      payload: { dispatcherInstanceId: 'dispatcher-1', limit: 1, minIdleMs: 15000 },
    });

    expect(claimResponse.statusCode).toBe(200);
    expect(claimResponse.json()).toEqual(batch);
    expect(recoveryResponse.json()).toEqual(batch);
    expect(reclaimResponse.json()).toEqual(batch);
  });

  it('takes transition identity from the path and rejects smuggled ids', async () => {
    const markDispatching = vi.fn().mockResolvedValue({
      status: 'updated',
      intent: { ...intent, state: 'dispatching' },
    });
    const complete = vi.fn().mockResolvedValue({
      status: 'updated',
      intent: { ...intent, state: 'dispatched', reasonCode: 'queue_accepted' },
    });
    app = daemon({ markDispatching, complete });

    const dispatching = await app.inject({
      method: 'POST',
      url: '/api/v1/wake-intents/message-1/dispatching',
      payload: {
        dispatcherInstanceId: 'dispatcher-1',
        claimId: 'claim-1',
        attemptId: 'attempt-1',
      },
    });
    const completed = await app.inject({
      method: 'POST',
      url: '/api/v1/wake-intents/message-1/complete',
      payload: {
        dispatcherInstanceId: 'dispatcher-1',
        claimId: 'claim-1',
        attemptId: 'attempt-1',
        state: 'dispatched',
        reasonCode: 'queue_accepted',
      },
    });
    const smuggled = await app.inject({
      method: 'POST',
      url: '/api/v1/wake-intents/message-1/dispatching',
      payload: {
        intentId: 'message-other',
        dispatcherInstanceId: 'dispatcher-1',
        claimId: 'claim-1',
        attemptId: 'attempt-1',
      },
    });

    expect(dispatching.statusCode).toBe(200);
    expect(markDispatching).toHaveBeenCalledWith('message-1', {
      dispatcherInstanceId: 'dispatcher-1',
      claimId: 'claim-1',
      attemptId: 'attempt-1',
    });
    expect(completed.statusCode).toBe(200);
    expect(complete).toHaveBeenCalledWith(
      'message-1',
      expect.objectContaining({
        state: 'dispatched',
      }),
    );
    expect(smuggled.statusCode).toBe(400);
  });

  it('rejects malformed bodies and non-loopback requests before service work', async () => {
    const claim = vi.fn();
    app = daemon({ claim });

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/wake-intents/claim',
      payload: { dispatcherInstanceId: 'bad id' },
    });
    const remote = await app.inject({
      method: 'POST',
      url: '/api/v1/wake-intents/claim',
      remoteAddress: '203.0.113.10',
      headers: { host: '127.0.0.1:80', 'content-type': 'application/json' },
      payload: { dispatcherInstanceId: 'dispatcher-1' },
    });

    expect(malformed.statusCode).toBe(400);
    expect(remote.statusCode).toBe(403);
    expect(claim).not.toHaveBeenCalled();
  });
});
