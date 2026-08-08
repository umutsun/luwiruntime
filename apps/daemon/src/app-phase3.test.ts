import type {
  AgentDefinition,
  ContextFootprint,
  EffectiveAgentConfiguration,
  Project,
} from '@luwi/protocol';
import type { RedisGateway, RedisHealth } from '@luwi/redis';
import { createRuntimeReadiness } from '@luwi/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, type DaemonApp } from './app.js';
import type { ConfigControlService } from './config-control-service.js';
import type { ControlPlaneService } from './control-plane-service.js';
import type { ProjectService } from './project-service.js';
import type { SessionService } from './session-service.js';

const timestamp = '2026-07-29T12:00:00.000Z';
const project: Project = {
  id: 'project-1',
  name: 'Fixture',
  localPath: 'C:/fixture',
  canonicalPath: 'C:/fixture',
  createdAt: timestamp,
  updatedAt: timestamp,
};
const agent: AgentDefinition = {
  id: 'codex-main',
  kind: 'codex',
  displayName: 'Codex',
  enabled: true,
  adapterId: 'codex-native-v1',
  nativeConfigRoots: ['C:/fake/.codex'],
  createdAt: timestamp,
  updatedAt: timestamp,
  metadata: {},
};
const footprint: ContextFootprint = {
  projectId: project.id,
  agentId: agent.id,
  source: 'estimated',
  method: 'generic-character-estimate',
  totalBytes: 0,
  totalLines: 0,
  estimatedTokens: 0,
  categories: {},
  exactDuplicateGroups: [],
  measuredAt: timestamp,
};
const effective: EffectiveAgentConfiguration = {
  projectId: project.id,
  agentId: agent.id,
  agentKind: agent.kind,
  valid: true,
  capabilities: [],
  profileIds: [],
  settings: {},
  provenance: [],
  conflicts: [],
  missingDependencies: [],
  unsupportedCapabilities: [],
  nativeCapabilitySupport: [],
  estimatedContextFootprint: footprint,
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

describe('Phase 3 HTTP routes', () => {
  let app: DaemonApp | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('validates and exposes agent registration and effective configuration', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    const controlPlane = {
      createAgent: vi.fn(async () => agent),
      detectAgents: vi.fn(async () => []),
      getEffectiveConfiguration: vi.fn(async () => effective),
    } as unknown as ControlPlaneService;
    app = buildDaemon({
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
        sessions: {
          list: async () => [],
        } as unknown as SessionService,
        controlPlane,
        listEvents: async () => [],
      },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: {
        id: agent.id,
        kind: agent.kind,
        displayName: agent.displayName,
        enabled: true,
        adapterId: agent.adapterId,
        nativeConfigRoots: agent.nativeConfigRoots,
        metadata: {},
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe('/api/v1/agents/codex-main');

    const detected = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/detect',
      payload: { projectId: project.id },
    });
    expect(detected.statusCode).toBe(200);
    expect(detected.json()).toEqual({ installations: [] });

    const resolved = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/project-1/agents/codex-main/effective-config',
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual(effective);
  });

  it('rejects config apply without the one-time approval token', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    const applyPlan = vi.fn();
    app = buildDaemon({
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
        configControl: { applyPlan } as unknown as ConfigControlService,
        listEvents: async () => [],
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/config/plans/plan-1/apply',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(applyPlan).not.toHaveBeenCalled();
  });

  it('treats config inspection as a mutation and rejects it while draining', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    readiness.beginDraining();
    const inspect = vi.fn();
    app = buildDaemon({
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
        configControl: { inspect } as unknown as ConfigControlService,
        listEvents: async () => [],
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/config/inspect',
      payload: { agentId: agent.id },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'RUNTIME_NOT_READY' } });
    expect(inspect).not.toHaveBeenCalled();
  });
});
