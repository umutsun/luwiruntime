import type {
  AgentDefinition,
  CapabilityPackage,
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
const capability: CapabilityPackage = {
  id: 'capability-1',
  kind: 'skill',
  name: 'Review',
  scope: 'global',
  source: 'luwi-global',
  checksum: 'a'.repeat(64),
  compatibleAgentKinds: ['codex'],
  requiredCapabilityIds: [],
  requiredMcpIds: [],
  enabled: true,
  manifest: {},
  createdAt: timestamp,
  updatedAt: timestamp,
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

  it('lists definitions with the version of the detected installation for their adapter', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    const detectAgentsCached = vi.fn(async () => [
      {
        kind: agent.kind,
        adapterId: agent.adapterId,
        executable: 'C:/tools/codex.exe',
        detectedVersion: '0.149.1',
        configRoots: [],
        supportLevel: 'full' as const,
        warnings: [],
      },
    ]);
    const controlPlane = {
      listAgents: vi.fn(async () => [agent, { ...agent, id: 'other-adapter', adapterId: 'x-v1' }]),
      detectAgentsCached,
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
        sessions: { list: async () => [] } as unknown as SessionService,
        controlPlane,
        listEvents: async () => [],
      },
    });

    const listed = await app.inject({ method: 'GET', url: '/api/v1/agents' });
    expect(listed.statusCode).toBe(200);
    const { agents } = listed.json<{ agents: Array<{ id: string; detectedVersion?: string }> }>();
    // The definition on the detected adapter carries its version; the one on
    // an adapter nothing detected stays without one rather than borrowing it.
    expect(agents.find(({ id }) => id === agent.id)?.detectedVersion).toBe('0.149.1');
    expect(agents.find(({ id }) => id === 'other-adapter')?.detectedVersion).toBeUndefined();
    // The cached read is what the list uses, never a fresh detection per read.
    expect(detectAgentsCached).toHaveBeenCalledTimes(1);

    // A detection that fails costs the versions, not the list.
    detectAgentsCached.mockRejectedValueOnce(new Error('spawn failed'));
    const degraded = await app.inject({ method: 'GET', url: '/api/v1/agents' });
    expect(degraded.statusCode).toBe(200);
    expect(
      degraded
        .json<{ agents: Array<{ detectedVersion?: string }> }>()
        .agents.every(({ detectedVersion }) => detectedVersion === undefined),
    ).toBe(true);
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

  /**
   * `listCapabilities` applies the page limit itself, so a route that asks for
   * exactly the limit cannot tell a full page from a cut one. It reported
   * `truncated: false` either way — a complete-looking list that is not.
   */
  it('reports capability truncation instead of asserting a completeness it cannot know', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    const listCapabilities = vi.fn(async (query: { limit?: number }) =>
      Array.from({ length: query.limit ?? 0 }, (_unused, index) => ({
        ...capability,
        id: `capability-${String(index)}`,
      })),
    );
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
        controlPlane: { listCapabilities } as unknown as ControlPlaneService,
        listEvents: async () => [],
      },
    });

    const full = await app.inject({ method: 'GET', url: '/api/v1/capabilities?limit=10' });

    expect(full.statusCode).toBe(200);
    // One more than the page is requested so the cut is observable at all.
    expect(listCapabilities).toHaveBeenCalledWith(expect.objectContaining({ limit: 11 }));
    expect(full.json().capabilities).toHaveLength(10);
    expect(full.json().truncated).toBe(true);
  });

  it('reports a short capability page as complete', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
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
        controlPlane: {
          listCapabilities: async () => [capability],
        } as unknown as ControlPlaneService,
        listEvents: async () => [],
      },
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/capabilities?limit=10' });

    expect(response.statusCode).toBe(200);
    expect(response.json().capabilities).toHaveLength(1);
    expect(response.json().truncated).toBe(false);
  });

  it('runs passive capability observation as an explicit mutation with diagnostics', async () => {
    const readiness = createRuntimeReadiness('recovering');
    readiness.transitionTo('ready');
    const scanCapabilities = vi.fn(async () => ({
      capabilities: [capability],
      diagnostics: {
        rootsScanned: 2,
        rootsUnavailable: 3,
        malformedManifests: 4,
        ignoredEntries: 5,
        conflictsSkipped: 6,
        truncated: false,
      },
    }));
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
        controlPlane: { scanCapabilities } as unknown as ControlPlaneService,
        listEvents: async () => [],
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/capabilities/scan',
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(scanCapabilities).toHaveBeenCalledTimes(1);
    expect(response.json()).toEqual({
      capabilities: [capability],
      diagnostics: {
        rootsScanned: 2,
        rootsUnavailable: 3,
        malformedManifests: 4,
        ignoredEntries: 5,
        conflictsSkipped: 6,
        truncated: false,
      },
    });
  });
});
