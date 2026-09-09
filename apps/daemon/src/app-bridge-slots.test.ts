import type { BridgeSlotView, Project } from '@luwi/protocol';
import type { RedisGateway, RedisHealth } from '@luwi/redis';
import { ApplicationError, createRuntimeReadiness } from '@luwi/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type DaemonApp } from './app.js';
import type { BridgeSlotService } from './bridge-slot-service.js';
import type { ProjectService } from './project-service.js';
import type { SessionService } from './session-service.js';

const timestamp = '2026-09-09T12:00:00.000Z';
const slotId = 'a'.repeat(64);
const project: Project = {
  id: 'project-1',
  name: 'Fixture',
  localPath: 'C:/fixture',
  canonicalPath: 'C:/fixture',
  createdAt: timestamp,
  updatedAt: timestamp,
};
const slot: BridgeSlotView = {
  id: slotId,
  workspaceId: 'local',
  projectId: 'project-1',
  agentId: 'codex',
  provider: 'codex',
  executionProfile: 'workspace-write',
  state: 'active',
  revision: 1,
  expiresAt: '2026-09-09T12:00:15.000Z',
};
const acquireBody = {
  projectId: 'project-1',
  agentId: 'codex',
  ownerToken: 'token-1',
  provider: 'codex',
  executionProfile: 'workspace-write',
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

function daemon(bridgeSlots: Partial<BridgeSlotService>): DaemonApp {
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
      bridgeSlots: bridgeSlots as BridgeSlotService,
      listEvents: async () => [],
    },
  });
}

describe('bridge slot routes', () => {
  let app: DaemonApp | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('acquires a slot with its location header', async () => {
    const acquire = vi.fn().mockResolvedValue({ status: 'acquired', slot });
    app = daemon({ acquire });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bridge-slots/acquire',
      payload: acquireBody,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe(`/api/v1/bridge-slots/${slotId}`);
    expect(response.json()).toEqual({ status: 'acquired', slot });
    expect(acquire).toHaveBeenCalledWith(acquireBody);
  });

  /** A held slot is the runtime answering who owns it: a 200 body, not a fault. */
  it('returns held as a successful answer', async () => {
    app = daemon({ acquire: vi.fn().mockResolvedValue({ status: 'held', slot }) });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bridge-slots/acquire',
      payload: acquireBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'held', slot });
  });

  it('refuses a caller-supplied workspace id at the protocol', async () => {
    app = daemon({ acquire: vi.fn() });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bridge-slots/acquire',
      payload: { ...acquireBody, workspaceId: 'other' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'REQUEST_VALIDATION_FAILED' } });
  });

  it('routes renew, attach and release by slot id with the token from the body', async () => {
    const renew = vi.fn().mockResolvedValue({ status: 'renewed', slot });
    const attach = vi.fn().mockResolvedValue({ status: 'attached', slot });
    const release = vi.fn().mockResolvedValue({ status: 'released', slot });
    app = daemon({ renew, attach, release });

    const renewed = await app.inject({
      method: 'POST',
      url: `/api/v1/bridge-slots/${slotId}/renew`,
      payload: { ownerToken: 'token-1' },
    });
    const attached = await app.inject({
      method: 'POST',
      url: `/api/v1/bridge-slots/${slotId}/attach`,
      payload: { ownerToken: 'token-1', sessionId: 'session-1' },
    });
    const released = await app.inject({
      method: 'POST',
      url: `/api/v1/bridge-slots/${slotId}/release`,
      payload: { ownerToken: 'token-1' },
    });

    expect(renewed.statusCode).toBe(200);
    expect(renew).toHaveBeenCalledWith(slotId, 'token-1');
    expect(attached.json()).toEqual({ status: 'attached', slot });
    expect(attach).toHaveBeenCalledWith(slotId, 'token-1', 'session-1');
    expect(released.json()).toEqual({ status: 'released', slot });
    expect(release).toHaveBeenCalledWith(slotId, 'token-1');
  });

  /** A slot id that is not a SHA-256 digest never reaches the key layer (ADR 0015). */
  it('rejects a malformed slot id as a request error', async () => {
    const renew = vi.fn();
    app = daemon({ renew });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bridge-slots/not-a-digest/renew',
      payload: { ownerToken: 'token-1' },
    });

    expect(response.statusCode).toBe(400);
    expect(renew).not.toHaveBeenCalled();
  });

  it('passes an ownership refusal through as its own conflict', async () => {
    app = daemon({
      renew: vi
        .fn()
        .mockRejectedValue(
          new ApplicationError('BRIDGE_SLOT_NOT_OWNER', 'The bridge slot is not owned.', 409),
        ),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/bridge-slots/${slotId}/renew`,
      payload: { ownerToken: 'stale' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'BRIDGE_SLOT_NOT_OWNER' } });
  });

  it('lists and reads redacted slots', async () => {
    const list = vi.fn().mockResolvedValue([slot]);
    app = daemon({ list, get: vi.fn().mockResolvedValue(slot) });

    const collection = await app.inject({ method: 'GET', url: '/api/v1/bridge-slots?limit=5' });
    const single = await app.inject({ method: 'GET', url: `/api/v1/bridge-slots/${slotId}` });

    expect(collection.statusCode).toBe(200);
    expect(collection.json()).toEqual({ slots: [slot] });
    expect(collection.body).not.toContain('ownerToken');
    expect(list).toHaveBeenCalledWith(5);
    expect(single.json()).toEqual(slot);
  });
});
